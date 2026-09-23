# Design — PO-to-SO Automation Cockpit

| Field | Value |
|---|---|
| Document ID | SPEC-002 |
| Status | Living — reflects what is built |
| Version | 0.1.0 |
| Last updated | 2026-09-21 |
| Phase | Design (Requirements → **Design** → Tasks) |
| Implements | [`01-requirements.md`](01-requirements.md) milestone 1 |

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19 + Vite + TypeScript | Requested. Vite dev proxy avoids CORS during development. |
| Data fetching | TanStack Query | Status changes arrive asynchronously (extraction, SAP results); polling with cache invalidation covers FR-12.7 without a websocket. |
| Backend | Node + Express 4 + TypeScript | Requested. |
| ORM / migrations | Prisma 6 | Declarative schema maps directly onto §7; migrations are checked in. |
| Database | PostgreSQL 16 (Docker) | Requested. `docker-compose.yml`, host port **5439**. |
| Auth | JWT + bcrypt | Sufficient for NFR-3.1; roles resolved from the DB per request, not from the token. |
| Extraction | Gemini via `@google/genai`, structured output | FR-4.7. Mock provider behind `EXTRACTION_PROVIDER=mock`. |
| Validation | Zod | Same schema guards the HTTP boundary and the model's response (FR-4.13). |
| Tests | Vitest | Unit tests on the invariants; see §7. |

**TypeScript throughout.** The status machine, the extraction contract and the CSV column order are all places where a silent shape change becomes a wrong Sales Order; these are exactly the errors a compiler catches for free.

---

## 2. Shape

```
┌─────────────┐   HTTP /api    ┌──────────────────────────────────────┐
│  React SPA  │ ──────────────▶│            Express API               │
│  (Vite)     │◀────────────── │  routes → services → Prisma          │
└─────────────┘   JSON + PDF   └───────┬──────────────────────┬───────┘
                                       │                      │
                            ┌──────────▼─────────┐  ┌─────────▼──────────┐
                            │  in-process workers│  │   PostgreSQL 16    │
                            │  (polling loops)   │  │   (Docker)         │
                            └──────────┬─────────┘  └────────────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              │                        │                         │
     ┌────────▼────────┐   ┌───────────▼──────────┐   ┌──────────▼────────┐
     │ Gemini API      │   │ integration/outbound │   │ integration/inbound│
     │ (extraction)    │   │ (cockpit writes)     │   │ (SAP writes)       │
     └─────────────────┘   └───────────┬──────────┘   └──────────▲────────┘
                                       │                         │
                                  ┌────▼─────────────────────────┴────┐
                                  │  SAP S/4HANA polling job          │
                                  │  (simulated: src/simulator)       │
                                  └───────────────────────────────────┘
```

### 2.1 Backend layout

```
backend/src/
  config/env.ts            all configuration, validated at boot (IC-10, FR-15.1)
  domain/
    status.ts              the status machine — declared once (NFR-6.3)
    types.ts               header/line field lists + the extraction contract
    validation.ts          FR-6 rules, with a MasterDataChecker seam
  services/
    records.ts             lifecycle: upload, publish, edit, approve, resubmit
    extraction/            provider abstraction, Gemini client, mock, prompts
    sap/                   csv, outbound (atomic write), resultParser, resultWatcher, errorMap
    storage.ts             PDF storage
    audit.ts               append-only audit writes
  workers/index.ts         polling loops (extraction, outbound, results, SLA)
  simulator/               stand-in for the SAP job — NOT part of the cockpit
```

Routes do HTTP concerns only; every rule that protects correctness lives in `domain/` or `services/` so it cannot be bypassed by calling a different endpoint.

---

## 3. Decisions

### D-1 — The database is the queue

Workers poll Postgres on an interval rather than running on Redis/BullMQ. A record's **status is the work item**: `PUBLISHED` means "needs extraction", `APPROVED` means "needs an outbound file". A crash mid-job resumes correctly on restart (NFR-2.4) with one less service in the stack.

*Limit:* this is single-instance. Running two API processes would double-process, since there is no row lock. Multi-instance needs `SELECT … FOR UPDATE SKIP LOCKED` or a real queue — recorded in `03-tasks.md`.

### D-2 — Correlation ID = `PO-` + the record UUID, plus an attempt number

FR-8.1. The UUID is allocated *before* the record row is written, so the correlation ID never depends on anything the vendor supplies. Files are named `PO_<correlationId>_<attempt>.csv`.

The attempt number is not in the requirements' original sketch but is load-bearing: without it, a late result from attempt 1 arriving after a resubmission would mark the record `SO_CREATED` against a Sales Order that does not correspond to the data currently on screen. `FR-10.8` and its test cover this.

### D-3 — Both CSV layouts, both completeness conventions, behind configuration

`OQ-03` and `OQ-04` are owned by the SAP team and still open. Rather than block, both options are implemented and selected by `CSV_LAYOUT` and `COMPLETENESS_CONVENTION`. Confirming the real contract becomes an env change.

`CSV_HEADER_ROW` defaults to **false** for the single-file layout: `H` and `L` rows carry different columns, so any single column-name row would describe at most one of them and mislead whoever wires up the SAP side.

**Newlines inside values are collapsed to spaces.** RFC 4180 permits a quoted field to span physical lines, but the consumer is a legacy job whose parser we do not control; a line-by-line reader would see a multi-line ship-to address as a truncated record followed by a garbage one. Losing line breaks in an address costs nothing. This is asserted by a test.

### D-4 — Atomic handoff in both directions

FR-9.6. `rename` writes into `outbound/.staging` on the same filesystem, `fsync`s, then renames — the rename is atomic, so the file appears whole or not at all. `done_marker` writes the data file, `fsync`s, then writes a zero-byte `.done` sentinel last. The reader mirrors whichever is configured, plus a stable-size check as a backstop.

### D-5 — Approval commits before the file is written

`submitToSap` runs after the approval transaction commits, not inside it. A slow or unwritable filesystem must not roll back an approval a human just made. If the write then fails, the record returns to `NEEDS_REVIEW` with the reason (FR-9.10) and the partial artefacts are removed.

### D-6 — Current values and provenance are stored separately

`POHeader`/`POLineItem` hold the values used for validation and CSV generation. `FieldExtraction` holds, per field path, what the model said and how confident it was, plus who edited it and when. A human correction changes the current value and never overwrites the extracted one, which is what makes FR-7.6 and the audit trail possible.

### D-7 — Misconfiguration fails at boot, never silently

If `EXTRACTION_PROVIDER=gemini` and no API key is set, the server refuses to start with an actionable message. Falling back to the mock would put invented data in front of a reviewer with no way to tell it apart from a real reading — precisely the failure the approval checkpoint exists to prevent.

### D-8 — PDFs are served through an authorised endpoint

`GET /api/records/:id/document` checks the session per request; the frontend fetches it as a blob and renders it via an object URL. No guessable or public storage path (NFR-3.5).

The review pane uses the browser's built-in PDF viewer inside an `<iframe>`, which gives page navigation, zoom and text search for free. Per-field source highlighting (FR-7.4) needs bounding boxes the extractor does not currently return, and is deferred.

---

## 4. Extraction

1. `matchVendorProfile` checks the user's hint, then scans the PDF bytes for each active profile's markers. Text-bearing PDFs match; pure scans do not, and fall through to the generic prompt. That is the right failure direction — an unmatched profile costs quality, a wrongly matched one costs correctness.
2. The prompt is built from the profile (or the generic fallback) and sent with the PDF as `inlineData`, `temperature: 0`, and a `responseSchema` requiring `{value, confidence}` for every field.
3. The response is parsed, then validated with Zod. **A response that does not match the schema is a failed attempt, never reviewable data** (FR-4.13).
4. Transient failures retry with exponential backoff up to `EXTRACTION_MAX_ATTEMPTS`; the record then lands in `EXTRACTION_FAILED` with a retry and a manual-entry path.
5. Line items are renumbered sequentially on persist, so a model that repeats or skips a line number cannot collide on `(headerId, lineNumber)`.

The prompt's confidence instruction is deliberately explicit that confidence means *"how sure am I that I read this correctly"*, not *"does this look plausible"*. A model that reports 0.99 on a guess defeats the entire review screen.

---

## 5. Data model

Implemented in `backend/prisma/schema.prisma`, following §7 of the requirements. Constraints that carry weight:

| Constraint | Enforces |
|---|---|
| `PORecord.correlationId` unique | DM-01 |
| `Submission @@unique([recordId, attempt])` | DM-02 / FR-9.11 — one file set per attempt |
| `SapResult.sourceFilename` unique | FR-10.9 — reprocessing a result file is a no-op |
| `FieldExtraction @@unique([recordId, fieldPath])` | one provenance row per field |
| `POLineItem @@unique([headerId, lineNumber])` | no duplicate line numbers |
| `AuditEvent.recordId` nullable, no cascade | DM-04 — audit survives record deletion |

---

## 6. API

| Method | Path | Requirement |
|---|---|---|
| `POST` | `/api/auth/login` · `GET /api/auth/me` | NFR-3.1 |
| `GET` | `/api/health` | NFR-5.1 |
| `GET` | `/api/records` · `/api/records/counts` | FR-12.1–12.4 |
| `POST` | `/api/records` (multipart) | FR-1 |
| `GET` | `/api/records/:id` | FR-12.5 |
| `GET` | `/api/records/:id/document` | FR-1.9, NFR-3.5 |
| `PATCH` | `/api/records/:id` | FR-2.1 |
| `POST` | `/api/records/:id/publish` | FR-3 |
| `PATCH` | `/api/records/:id/fields` | FR-7.5 |
| `POST` `DELETE` | `/api/records/:id/lines[/:n]` | FR-7.5 |
| `POST` | `/api/records/:id/acknowledge` | FR-6.9 |
| `POST` | `/api/records/:id/approve` · `/reject` | FR-7.9–7.12 |
| `POST` | `/api/records/:id/resubmit` | FR-11.4 |
| `POST` | `/api/records/:id/retry-extraction` · `/manual-entry` | FR-4.12, FR-5.7 |
| `POST` | `/api/records/:id/cancel` · `DELETE /api/records/:id` | FR-2.3, T-14 |

Errors return `{ error: { code, message, details } }`. `code` is stable for the UI; `message` names the field and the remedy (NFR-4.3).

---

## 7. What the tests cover

`npm test` — 38 unit tests on the parts where a silent error becomes a wrong Sales Order:

- **`status.test.ts`** — every undeclared transition is rejected; terminal states are terminal; nothing reaches `SENT_TO_SAP` except from `APPROVED`; `FAILED` can never transition straight back to SAP.
- **`ids.test.ts`** — correlation IDs are filename-safe, unique, and independent of the vendor PO number.
- **`validation.test.ts`** — required fields, ISO currency, positive quantities, date parsing in three conventions, decimal parsing in both European and US conventions, total reconciliation, and the blocking/warning split.
- **`resultParser.test.ts`** — CSV and JSON result forms, quoted messages containing the delimiter, column reordering, and refusal of a `SUCCESS` with no SO number.
- **`csv.test.ts`** — escaping, correlation ID on every row, line ordering, and the one-physical-line-per-record guarantee.

Not covered: the Gemini client against the live API (no key available at build time), and the worker loops end to end. Both were exercised manually — see `03-tasks.md` §3.

---

## 8. Known limitations

| # | Limitation | Consequence | Tracked |
|---|---|---|---|
| L-1 | Workers assume a single API instance | Two instances would double-process | `03-tasks.md` M2 |
| L-2 | Gemini client unverified against the live API | Needs a key and one real PDF to confirm | `03-tasks.md` M2 |
| L-3 | No master-data validation (FR-6.3–6.5) | Bad material/customer codes only fail at SAP | `OQ-11` |
| L-4 | No notifications (FR-14) | Records rely on someone watching the worklist | `03-tasks.md` M2 |
| L-5 | No admin UI (FR-15) | Vendor profiles are seeded/DB-edited | `03-tasks.md` M2 |
| L-6 | No concurrent-edit lock (FR-7.8) | Two reviewers can overwrite each other | `03-tasks.md` M2 |
| L-7 | No per-field source highlighting (FR-7.4) | Reviewer scrolls the PDF themselves | needs extractor coordinates |
| L-8 | Autosave is on blur, not continuous (FR-7.7) | An abandoned tab loses the field being typed | minor |
