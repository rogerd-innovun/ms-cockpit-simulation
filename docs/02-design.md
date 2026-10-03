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

**Dates and numbers are normalised on the way out, not on the way in.** The record keeps what the PO said (`SEP 17, 2026`, `1,599.50`) so the reviewer can check it against the PDF; the CSV gets `CSV_DATE_FORMAT` (default ISO) and plain decimals with `CSV_DECIMAL_SEPARATOR`. This only works if approval has already proved every date and figure readable, so validation blocks an unreadable or impossible one (`09/18/2026` is not day-first-valid and is refused, rather than rolling into next year) and warns on the two readings it has to choose between (`03/04/2026`, `1,000`). Dates are parsed without `new Date(text)`, which reads non-ISO text in the server's timezone. A value that still cannot be read at write time throws, and the record returns to review with the reason.

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

### D-9 — ZEE_API_LOG: one direct SAP call, keyed by Sales Order

Added 2026-09-30 at the SAP team's request, and a deliberate exception to `IC-01`. It does not replace the folder drop, which still creates the order. The only contract given so far is table `IT_SALEORDERS` with field `VBELN` (CHAR10). The endpoint, transport, auth and response are all unconfirmed, so all of them are configuration (`SAP_LOG_API_*`, `SAP_CLIENT`), in the same spirit as D-3.

- **VBELN mapping** (`services/sap/vbeln.ts`) applies SAP's ALPHA conversion: a numeric number is zero-padded to ten characters. A number longer than ten characters is refused rather than truncated, because a truncated document number reads the log of a different order.
- **Transport** (`services/sap/logApi.ts`): `json` posts `{"IT_SALEORDERS":[{"VBELN":"…"}]}`, and `soap` posts the envelope SOAMANAGER generates for a function module (`urn:sap-com:document:sap:rfc:functions`). It supports basic auth, `sap-client`, and an optional CSRF-token fetch. Native RFC is not attempted, because it would need the SAP NW RFC SDK on the host.
- **Modes:** `off` (the default, and what the hosted demo runs) hides the feature. `mock` answers inside the process, and the answer is marked `simulated`. `live` calls SAP. If `live` is set with no URL, the server refuses to start (as in D-7).
- **Storage:** each call is an audit event (`SAP_LOG_API_CALLED`) holding the request, the HTTP status and SAP's answer verbatim, capped at 64 KB. There is no new table and no migration. Credentials are never stored.
- **Trigger:** calls are made on demand from an `SO_CREATED` record, never automatically. Until the SAP team confirms whether the call writes on their side, a person decides when it runs.

**Contract status, after the SAP team's reply of 2026-10-02.** The cockpit is configured for it but stays on `mock`; the endpoint it needs has not been given.

| | Answer received | Status |
|---|---|---|
| Format | JSON | Taken as given (`SAP_LOG_API_FORMAT=json`). The request body — `{"IT_SALEORDERS":[{"VBELN":"…"}]}` — is still our assumption from the table name. |
| Endpoint | `LV_URL = https://api.thirdparty.com/salesorder` | **Not accepted.** `LV_URL` and `lo_http_client` are ABAP variable names, and the host is a public third-party service, not an SAP system. It reads as the address `ZEE_API_LOG` calls *out* to, not the address the cockpit calls *in* on. Left unset on purpose. |
| User | `BODS02` | Staged in `SAP_LOG_API_USER`. This is a Data Services (ETL) user name; a dedicated technical user is preferable to sharing one. No password was given. |
| Client | `800` | Staged in `SAP_CLIENT`, read as the SAP client (the reply paired it with `lo_http_client`). Unconfirmed; and `sap-client` only means something to an SAP ICF service. |
| Returns | `LV_VBELN` (sales orders) | Stored verbatim with each call, so no mapping is needed until the real shape is known. |
| Writes on the SAP side? | not answered | Open. Decides whether the call may be repeated freely. |
| Auth type / secret | not answered | Open. Basic auth is implemented; certificate or OAuth is not. |
| Reachability (VPN / Cloud Connector) | not answered | Open. |

The reason the endpoint is held back rather than tried: in `live` mode the cockpit sends the user and password with every call, so a wrong host means handing an SAP login to whoever runs it. With `live` and no URL the server refuses to start, which is the intended state until the SAP team names the callable URL of `ZEE_API_LOG` itself (the SICF path or SOAMANAGER binding) and sends a sample request and response.

### D-10 — A warning must be accepted before approval, and the acceptance is of its wording

`FR-6.1` makes a warning something an approval may proceed *with acknowledgement*. For a while the acknowledgement was optional: the server checked only blocking issues, so a flagged wrong total went to SAP like any other. Now `approveRecord` refuses (`400 WARNINGS_UNACKNOWLEDGED`, listing them) while any warning is unaccepted, and the Approve button says so.

- **Accepting is of the warning as it reads.** The wording carries the figures ("Line items sum to 50.00 but the PO total reads 500.00"), and the audit event written at acceptance keeps it (`domain/acknowledgement.ts`). Edit a figure and the warning reads differently, so the acceptance lapses and has to be given again — otherwise a small discrepancy could be accepted, changed into a large one, and approved on the first look. Acceptances recorded before the wording was kept are honoured on code and field alone. No schema change.
- **The server decides what is being accepted.** It recomputes the warning at accept time and stores that wording; the client only names which one. A blocking issue cannot be accepted (`NOT_A_WARNING`), nor one that is no longer raised (`WARNING_NOT_RAISED`), nor anything outside review.
- **`{ "all": true }`** accepts every warning currently raised, for the case where there are a dozen and all have been checked.
- **The approved snapshot records them** (`acceptedWarnings`: code, field, wording, who, when), which is `FR-6.9`.
- **Fewer questions asked.** "Ambiguous date" fires only when nothing on the order settles it: a single date such as `18/09/2026` (first part above 12) proves the document writes day first, and the other numeric dates on it are then not in doubt. Without that, every line date on an Italian or French order would need its own click.

---

## 4. Extraction

1. `matchVendorProfile` checks the user's hint, then scans the PDF bytes for each active profile's markers. Text-bearing PDFs match; pure scans do not, and fall through to the generic prompt. That is the right failure direction — an unmatched profile costs quality, a wrongly matched one costs correctness.
2. The prompt is built from the profile (or the generic fallback) and sent with the PDF as `inlineData`, `temperature: 0`, and a `responseSchema` requiring `{value, confidence}` for every field.
3. The response is parsed, then validated with Zod. **A response that does not match the schema is a failed attempt, never reviewable data** (FR-4.13).
4. Transient failures retry with exponential backoff up to `EXTRACTION_MAX_ATTEMPTS`; the record then lands in `EXTRACTION_FAILED` with a retry and a manual-entry path.
5. Line items are renumbered sequentially on persist, so a model that repeats or skips a line number cannot collide on `(headerId, lineNumber)`.

The prompt's confidence instruction is deliberately explicit that confidence means *"how sure am I that I read this correctly"*, not *"does this look plausible"*. A model that reports 0.99 on a guess defeats the entire review screen.

It is equally explicit about which total is the PO total: the pre-tax goods figure that equals the sum of the lines (Total HT, Subtotal, Net total), never the grand total or amount due, and copied from the page rather than calculated. Left open ("put the order total in poTotalValue"), the model took the grand total on both the French and the Canadian sample, and the wrong figure reached SAP. The stored prompt version (`generic-v2`, or `<vendor>-v1+generic-v2` for a profile run, since a vendor prompt embeds the generic rules) moves whenever the wording does — `prompts.test.ts` pins the text to the version so an edit cannot forget to bump it.

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
| `POST` | `/api/records/:id/acknowledge` (`{code, fieldPath}` or `{all: true}`) | FR-6.1, FR-6.9, D-10 |
| `POST` | `/api/records/:id/approve` · `/reject` | FR-7.9–7.12 |
| `POST` | `/api/records/:id/resubmit` | FR-11.4 |
| `POST` | `/api/records/:id/retry-extraction` · `/manual-entry` | FR-4.12, FR-5.7 |
| `POST` | `/api/records/:id/cancel` · `DELETE /api/records/:id` | FR-2.3, T-14 |
| `GET` `POST` | `/api/records/:id/sap-log` | D-9 — ZEE_API_LOG state / call it for the record's SO |

Errors return `{ error: { code, message, details } }`. `code` is stable for the UI; `message` names the field and the remedy (NFR-4.3). An unexpected error is the exception: its message is only a reference number, and the cause is in the server log under that reference.

Beyond the record itself, every record-detail response carries three things the screens depend on: `duplicates` (same PO number and customer, FR-3.5), `documentDuplicates` (the identical PDF, FR-3.4 — listed on the draft so the warning comes before Publish, not only after it is refused) and `sentBack` (the reason an approver returned the record, read back from the audit trail while it is in review and clear once it is approved again, FR-7.12). `PATCH /api/records/:id` changes only the fields in the body and audits each change.

---

## 7. What the tests cover

`npm test` — unit tests on the parts where a silent error becomes a wrong Sales Order:

- **`status.test.ts`** — every undeclared transition is rejected; terminal states are terminal; nothing reaches `SENT_TO_SAP` except from `APPROVED`; `FAILED` can never transition straight back to SAP.
- **`ids.test.ts`** — correlation IDs are filename-safe, unique, and independent of the vendor PO number.
- **`validation.test.ts`** — required fields, ISO currency, positive quantities, date parsing in three conventions, decimal parsing in both European and US conventions, total reconciliation, and the blocking/warning split.
- **`resultParser.test.ts`** — CSV and JSON result forms, quoted messages containing the delimiter, column reordering, and refusal of a `SUCCESS` with no SO number.
- **`csv.test.ts`** — escaping, correlation ID on every row, line ordering, and the one-physical-line-per-record guarantee.
- **`vbeln.test.ts`** — ALPHA zero-padding to CHAR10, and refusal (not truncation) of anything VBELN cannot hold.
- **`logApi.test.ts`** — the ZEE_API_LOG JSON and SOAP payloads, checked against a local stand-in endpoint: basic auth, `sap-client`, the CSRF round trip, SOAP faults, an unreachable host, and no credentials in what gets stored.
- **`records.test.ts`**, **`records.approve.test.ts`** — who may send a record back (refused before the record is read), and the approval race: the second of two simultaneous approvals gets a 409 and writes no submission, audit event or file.
- **`outbound.test.ts`** — the header file of a pair is written last under the rename convention, the done-marker last under the other, and a failed write leaves nothing behind.
- **`records.metadata.test.ts`**, **`sentBack.test.ts`** — a metadata update touches only what it was sent and is audited; a send-back never overwrites the uploader's notes, and its reason surfaces until the record is approved again; a blocked duplicate publish names the records it matched.
- **`error.test.ts`**, **`query.test.ts`** — an unexpected error reaches the client as a reference number and nothing else; malformed JSON, unique-constraint races and bad worklist parameters get the right 4xx.

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
