# Tasks — PO-to-SO Automation Cockpit

| Field | Value |
|---|---|
| Document ID | SPEC-003 |
| Status | Milestone 1 complete |
| Last updated | 2026-09-21 |
| Phase | Tasks (Requirements → Design → **Tasks**) |

---

## 1. Milestone 1 — full vertical slice ✅

Every status in the lifecycle is reachable, end to end, with a human approval checkpoint before anything reaches SAP.

| # | Task | Requirements | Status |
|---|---|---|---|
| 1.1 | Docker Postgres, Prisma schema, migration, seed | §7, DM-01…05 | ✅ |
| 1.2 | Config module, validated at boot; all paths configurable | FR-15.1, IC-10 | ✅ |
| 1.3 | Status machine declared once, enforced server-side | §5, INV-01…05 | ✅ |
| 1.4 | JWT auth, four seeded roles, server-side role checks | §4, NFR-3.1 | ✅ |
| 1.5 | PDF upload: content-sniffed, size-limited, hashed, stored | FR-1 | ✅ |
| 1.6 | Draft management and soft delete | FR-2 | ✅ |
| 1.7 | Publish → extraction queue, idempotent | FR-3.1–3.3 | ✅ |
| 1.8 | Duplicate detection by file hash and PO+customer | FR-3.4, FR-3.5 | ✅ |
| 1.9 | Vendor profiles with marker matching + generic fallback | FR-4.1–4.6 | ✅ |
| 1.10 | Gemini structured extraction with per-field confidence | FR-4.7–4.15 | ✅ ¹ |
| 1.11 | Mock extractor for keyless development | FR-5.7 | ✅ |
| 1.12 | Header + line items + per-field provenance persisted | FR-5 | ✅ |
| 1.13 | Validation: structure, formats, totals, blocking/warning split | FR-6.1, 6.2, 6.6–6.9 | ✅ |
| 1.14 | Review screen: PDF beside editable fields | FR-7.1–7.7 | ✅ |
| 1.15 | Approval with server-side re-validation and SoD | FR-7.9–7.14 | ✅ |
| 1.16 | Correlation ID + attempt number | FR-8 | ✅ |
| 1.17 | CSV generation, both layouts, configurable | FR-9.1–9.5, §8.2 | ✅ |
| 1.18 | Atomic outbound write, both conventions | FR-9.6–9.12 | ✅ |
| 1.19 | Result watcher: match, stale guard, quarantine, archive | FR-10 | ✅ |
| 1.20 | SLA timeout sweep | FR-10.5 | ✅ |
| 1.21 | SAP error-code → plain language + remedy | FR-11.1–11.3 | ✅ |
| 1.22 | Resubmit under the same correlation ID | FR-11.4–11.8 | ✅ |
| 1.23 | Worklist with saved views, search, self-refresh | FR-12 | ✅ |
| 1.24 | Append-only audit trail, surfaced in the UI | FR-13 | ✅ |
| 1.25 | SAP simulator standing in for the real polling job | — | ✅ |
| 1.26 | Sample PO PDF generator (two vendor layouts) | — | ✅ |
| 1.27 | Health checks for DB and both integration folders | NFR-5.1 | ✅ |
| 1.28 | 38 unit tests on the correctness-critical paths | §7 of design | ✅ |

¹ Written and type-checked against the SDK; **not yet run against the live API** — no key was available. See task 2.1.

---

## 2. Milestone 2 — the deferred requirements

| # | Task | Requirements | Blocked by |
|---|---|---|---|
| 2.1 | Verify Gemini extraction against real vendor PDFs; tune prompts | FR-4 | a `GEMINI_API_KEY` + sample POs |
| 2.2 | Master-data validation for customer, material, UOM | FR-6.3–6.5 | `OQ-11` |
| 2.3 | Notifications — in-app and email | FR-14 | — |
| 2.4 | Admin UI: vendor profiles, thresholds, paths, users | FR-15 | — |
| 2.5 | Concurrent-edit lock on the review screen | FR-7.8 | — |
| 2.6 | Multi-instance worker safety (`FOR UPDATE SKIP LOCKED`) | NFR-2.4 | L-1 |
| 2.7 | Per-field source highlighting in the PDF | FR-7.4 | extractor bounding boxes |
| 2.8 | Continuous autosave during review | FR-7.7 | L-8 |
| 2.9 | Worklist CSV export | FR-12.6 | — |
| 2.10 | Metrics: correction rate per field, SAP rejection rate by code | NFR-5.2 | — |
| 2.11 | Retention and soft-delete purge jobs | NFR-7 | `OQ-10` |
| 2.12 | Integration tests over the worker loops | — | — |

---

## 3. Manually verified end to end

Run against the mock extractor with the SAP simulator, on 2026-09-21:

| Scenario | Result |
|---|---|
| Upload → Publish → Processing → Needs Review | ✅ vendor profile matched from PDF markers; 18 low-confidence fields flagged |
| Approve → CSV written → SAP simulator → **SO Created** | ✅ SO 4500104988 |
| Uploader attempts to approve their own record | ✅ refused, `SOD_VIOLATION` |
| Non-approver role attempts approval | ✅ refused, `NOT_AN_APPROVER` |
| Approval with blocking validation issues | ✅ refused, 4 issues named with field and remedy |
| SAP rejection → **Failed** with mapped explanation | ✅ `MATERIAL_NOT_FOUND` → plain language + remedy |
| Resubmit → correct → re-approve as attempt 2 | ✅ same correlation ID, new attempt |
| Late result for attempt 1 arriving after resubmission | ✅ ignored, `RESULT_STALE_IGNORED`, status unchanged |
| Correct result for attempt 2 | ✅ SO 4500777001 |
| Duplicate PDF upload and publish | ✅ blocked, both matching records named |
| Illegal transition via the API | ✅ refused, allowed transitions listed |
| Audit trail | ✅ 15 events, upload through SO creation, actor on each |

---

## 4. Open questions still blocking

Unchanged from `01-requirements.md` §11. The two that matter most before this touches a real SAP system:

- **`OQ-03` / `OQ-04` / `OQ-05`** — the real CSV schema, completeness convention and result format. Both candidate layouts are implemented behind config, so closing these is an env change, not a rewrite.
- **`OQ-07`** — data-protection clearance for sending customer PO PDFs to Gemini. This gates the core mechanism; confirm before any production pilot.
