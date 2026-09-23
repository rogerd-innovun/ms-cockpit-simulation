# Requirements Specification — PO-to-SO Automation Cockpit

| Field | Value |
|---|---|
| Document ID | SPEC-001 |
| Status | Draft — pending review |
| Version | 0.1.0 |
| Last updated | 2026-09-21 |
| Phase | Requirements (spec-driven development: **Requirements** → Design → Tasks) |
| Owner | TBD |
| Related docs | `02-design.md` (not yet written), `03-tasks.md` (not yet written) |

---

## 1. Overview

### 1.1 Objective

Build a **cockpit application** that turns inbound Purchase Order (PO) PDFs into Sales Orders (SO) in SAP S/4HANA with minimal manual data entry, while keeping a mandatory human checkpoint before anything reaches SAP.

A user uploads a PO PDF. The system extracts structured data from it via OCR (Gemini API), presents the extraction for human review and correction, and on approval hands the data to SAP through an existing folder-drop integration. SAP creates the Sales Order and writes back a result, which the cockpit matches to the originating record and surfaces to the user.

### 1.2 Problem statement

Today PO data is re-keyed by hand into SAP. This is slow, error-prone, and gives no audit trail linking the SO back to the source document. Vendor PO layouts vary widely, so naive template-based OCR does not generalise.

### 1.3 Value proposition

- **Speed** — manual re-keying replaced by review-and-approve.
- **Accuracy** — low-confidence fields are flagged rather than silently accepted; high-risk fields validated against master data before submission.
- **Traceability** — every SO traceable back to the exact source PDF, the extraction, the corrections made, and who approved it.

### 1.4 Guiding principle

> **A bad OCR read must never silently become a wrong Sales Order.**

Every requirement in this document that creates friction (the review screen, the approval checkpoint, master-data validation, segregation of duties) exists to serve that principle. Optimisations that remove the human checkpoint are out of scope.

---

## 2. Scope

### 2.1 In scope

- PDF upload and document storage of the original PO file.
- Record lifecycle management across the defined status model.
- OCR/data extraction via the Gemini API, with vendor-profile-specific prompts and a generic fallback.
- Per-field confidence scoring and low-confidence flagging.
- Side-by-side human review UI (original PDF + editable extracted fields).
- Validation of extracted fields, including master-data lookups for high-risk fields.
- Explicit approval action with audit trail.
- CSV generation (PO header + N line items) with an embedded correlation ID.
- Atomic file drop into the SAP-polled folder.
- Watching for, and processing, SAP result files.
- Status updates to `SO_CREATED` / `FAILED`, with failure reason surfaced to the user.
- Retry / resubmit path for failed submissions.
- Worklist/dashboard, search, filtering.
- Full audit log.

### 2.2 Out of scope (for this release)

- Direct SAP API/OData/BAPI integration — the folder-drop mechanism is a **fixed integration constraint**.
- Modifying the SAP-side polling job (treated as fixed until proven otherwise — see `OQ-08`).
- Email-inbox ingestion of POs (upload only for v1).
- Automatic creation of master data (materials, customers) that does not already exist in SAP.
- Multi-currency conversion or pricing calculation logic.
- Purchase Order *amendment* handling (a change PO against an already-created SO).
- Mobile-native applications (responsive web is sufficient).
- Training/fine-tuning custom OCR models.

### 2.3 Assumptions

| ID | Assumption | Risk if false |
|---|---|---|
| A-01 | The SAP-side polling job already exists and functions. | Integration scope expands significantly. |
| A-02 | The cockpit and the SAP job can both reach a shared filesystem/network share. | Integration mechanism must be redesigned. |
| A-03 | The SAP job writes a result file back for every input file, success or failure. | Records stall in `SENT_TO_SAP` forever; a timeout policy becomes mandatory (see `FR-9.5`). |
| A-04 | POs are text-bearing or scan-quality PDFs legible to a vision model. | Extraction quality drops; manual entry fallback needed (`FR-5.7`). |
| A-05 | Master data (materials, customers) is readable by the cockpit in some form (API, replica, or periodic export). | `FR-6` validation degrades to format-only checks. |
| A-06 | One PO PDF results in exactly one Sales Order. | Split/merge logic required — a substantial scope addition. |

---

## 3. Glossary

| Term | Definition |
|---|---|
| **PO** | Purchase Order — the document a customer sends us. |
| **SO** | Sales Order — the SAP S/4HANA document we create in response. |
| **PO Record** | The cockpit's internal entity representing one uploaded PO PDF and all derived data. |
| **Correlation ID** | The immutable internal identifier that links a cockpit record → outbound CSV → SAP result file. |
| **Vendor Profile** | A stored configuration (identification hints + extraction prompt + field mappings) for a known customer's PO layout. |
| **Confidence score** | A per-field 0.0–1.0 value from the extraction step expressing model certainty. |
| **Low-confidence field** | A field whose confidence falls below the configured threshold, flagged for human attention. |
| **Folder drop** | The integration pattern: the cockpit writes a file to a watched directory; the SAP job polls and consumes it. |
| **Done marker** | A sentinel (`.done` file or atomic rename) signalling that a dropped file is complete and safe to read. |
| **Outbound file** | The CSV (or CSV pair) written by the cockpit for SAP to consume. |
| **Result file** | The file SAP writes back reporting success (with SO number) or failure (with reason). |
| **SoD** | Segregation of Duties — the control that the approver differs from the uploader. |

---

## 4. Personas and roles

| Role | Description | Core permissions |
|---|---|---|
| **Uploader / Clerk** | Receives PO PDFs and gets them into the system. | Upload, edit in Draft, publish, edit during review, view own records. |
| **Approver** | Accountable for what reaches SAP. | Everything the Uploader can do, plus **Approve** and **Reject**. |
| **Operations / Support** | Monitors failures and the integration health. | View all records, resubmit failed records, view integration diagnostics, access audit log. |
| **Administrator** | Configures the system. | Manage vendor profiles, confidence thresholds, folder paths, users and roles. |
| **System (SAP job)** | Non-interactive counterparty. | Reads outbound files; writes result files. |

> **Open question `OQ-01`** governs whether Uploader and Approver may be the same person for a given record. The system **must** support enforcing separation as a configurable control regardless of the final policy decision (`FR-7.4`).

---

## 5. Status lifecycle

### 5.1 State model

```
                  ┌──────────┐
   upload ──────► │  DRAFT   │
                  └────┬─────┘
                       │ publish
                       ▼
                  ┌───────────┐
                  │ PUBLISHED │
                  └────┬──────┘
                       │ extraction job picked up
                       ▼
                  ┌────────────┐   extraction error   ┌──────────────────┐
                  │ PROCESSING │ ───────────────────► │ EXTRACTION_FAILED │
                  └────┬───────┘                      └────────┬─────────┘
                       │ extraction returned                   │ retry / manual entry
                       ▼                                       │
                  ┌──────────────┐ ◄──────────────────────────-┘
                  │ NEEDS_REVIEW │ ◄──────────┐
                  └────┬─────────┘            │ reject (send back)
                       │ approve              │
                       ▼                      │
                  ┌──────────┐                │
                  │ APPROVED │ ───────────────┘
                  └────┬─────┘
                       │ CSV written + done marker
                       ▼
                  ┌──────────────┐
                  │ SENT_TO_SAP  │
                  └────┬─────┬───┘
         result: ok    │     │   result: error / timeout
                       ▼     ▼
              ┌────────────┐ ┌────────┐
              │ SO_CREATED │ │ FAILED │
              └────────────┘ └───┬────┘
                   (terminal)    │ resubmit
                                 └──► NEEDS_REVIEW
```

### 5.2 Status definitions

| Status | Meaning | Entered by | User-editable fields? |
|---|---|---|---|
| `DRAFT` | PDF uploaded, record created, nothing extracted yet. | Upload action | Metadata only (vendor hint, notes) |
| `PUBLISHED` | User has committed the record for extraction. | User action | No |
| `PROCESSING` | Extraction request in flight to Gemini. | System | No |
| `NEEDS_REVIEW` | Extraction returned; awaiting human review. | System | **Yes** — all extracted fields |
| `EXTRACTION_FAILED` | Extraction could not complete after retries. | System | Yes — manual entry permitted |
| `APPROVED` | Human approved the data; queued for SAP handoff. | Approver action | No |
| `SENT_TO_SAP` | Outbound file written and marked complete. | System | No |
| `SO_CREATED` | SAP confirmed creation; SO number recorded. **Terminal.** | System (result file) | No |
| `FAILED` | SAP rejected the order, or the submission errored/timed out. | System | No (until resubmit) |
| `CANCELLED` | Record abandoned by a user before submission. **Terminal.** | User action | No |

### 5.3 Transition rules

| # | From | To | Trigger | Guard conditions |
|---|---|---|---|---|
| T-01 | — | `DRAFT` | PDF uploaded | File passes type/size validation |
| T-02 | `DRAFT` | `PUBLISHED` | User clicks Publish | File readable; record not a blocked duplicate (`FR-3.4`) |
| T-03 | `PUBLISHED` | `PROCESSING` | Extraction worker picks up job | — |
| T-04 | `PROCESSING` | `NEEDS_REVIEW` | Extraction returns parseable result | Result conforms to the extraction schema |
| T-05 | `PROCESSING` | `EXTRACTION_FAILED` | Extraction errors after max retries | — |
| T-06 | `EXTRACTION_FAILED` | `PROCESSING` | User retries extraction | — |
| T-07 | `EXTRACTION_FAILED` | `NEEDS_REVIEW` | User opts for manual entry | — |
| T-08 | `NEEDS_REVIEW` | `APPROVED` | Approver clicks Approve | All blocking validations pass; SoD satisfied (`FR-7.4`) |
| T-09 | `APPROVED` | `SENT_TO_SAP` | Outbound file written + done marker | Write confirmed durable |
| T-10 | `APPROVED` | `NEEDS_REVIEW` | Outbound write fails after retries | Failure reason recorded |
| T-11 | `SENT_TO_SAP` | `SO_CREATED` | Success result file matched | Correlation ID matches exactly one record |
| T-12 | `SENT_TO_SAP` | `FAILED` | Failure result file matched, **or** SLA timeout elapsed | — |
| T-13 | `FAILED` | `NEEDS_REVIEW` | User clicks Resubmit | New submission attempt number allocated |
| T-14 | `DRAFT` / `NEEDS_REVIEW` / `EXTRACTION_FAILED` | `CANCELLED` | User cancels | — |

**Invariants**

- `INV-01` — All transitions not listed above are rejected by the backend, not merely hidden in the UI.
- `INV-02` — `SO_CREATED` and `CANCELLED` are terminal; no transition leaves them.
- `INV-03` — Every transition writes an immutable audit event (`FR-11`).
- `INV-04` — A record's correlation ID never changes, across any number of resubmissions.
- `INV-05` — Extracted field values are only mutable while the record is in `NEEDS_REVIEW` or `EXTRACTION_FAILED`.

---

## 6. Functional requirements

Acceptance criteria use EARS phrasing (`WHEN <trigger> THE SYSTEM SHALL <response>` / `IF <condition> THEN ...` / `WHILE <state> ...`).

---

### FR-1 — PO upload

**User story:** As an Uploader, I want to upload a PO PDF, so that the system holds the source document and can extract data from it.

1. WHEN a user submits a PDF file, THE SYSTEM SHALL store the file unmodified in durable document storage and create a PO Record in `DRAFT` linked to it.
2. THE SYSTEM SHALL accept `application/pdf` only, and SHALL reject other types with a clear message naming the accepted type.
3. THE SYSTEM SHALL enforce a maximum file size (default **20 MB**, configurable) and reject larger files with the limit stated in the error.
4. THE SYSTEM SHALL compute and store a SHA-256 hash of the uploaded file for duplicate detection (`FR-3.4`) and integrity verification.
5. THE SYSTEM SHALL record upload metadata: original filename, size, content hash, page count, uploading user, and upload timestamp (UTC).
6. THE SYSTEM SHALL allocate the record's immutable **correlation ID** at creation time (`FR-8.1`).
7. WHERE a user uploads multiple files in one action, THE SYSTEM SHALL create one independent PO Record per file.
8. IF file storage fails, THEN THE SYSTEM SHALL NOT create a record and SHALL report the failure to the user.
9. THE SYSTEM SHALL retain the original PDF for the full retention period (`NFR-7.1`) and SHALL keep it viewable at every subsequent lifecycle stage.

---

### FR-2 — Draft management

**User story:** As an Uploader, I want to check and annotate a record before committing it, so that obviously wrong uploads never consume extraction capacity.

1. WHILE a record is in `DRAFT`, THE SYSTEM SHALL let the user view the PDF, set an optional vendor/customer hint, add free-text notes, and delete the record.
2. WHILE a record is in `DRAFT`, THE SYSTEM SHALL allow replacing the attached PDF; replacing SHALL recompute the content hash and re-run duplicate detection.
3. WHEN a user deletes a `DRAFT` record, THE SYSTEM SHALL soft-delete it, retaining the audit trail.
4. THE SYSTEM SHALL NOT call the extraction service for any record in `DRAFT`.

---

### FR-3 — Publish and extraction trigger

**User story:** As an Uploader, I want publishing a record to kick off extraction, so that structured data is prepared for me without further action.

1. WHEN a user publishes a `DRAFT` record, THE SYSTEM SHALL transition it to `PUBLISHED` and enqueue an extraction job.
2. WHEN the extraction worker accepts the job, THE SYSTEM SHALL transition the record to `PROCESSING` and record the start timestamp.
3. THE SYSTEM SHALL make publishing idempotent: repeated publish requests for the same record SHALL NOT enqueue duplicate extraction jobs.
4. WHEN a user publishes a record whose content hash matches an existing non-cancelled record, THE SYSTEM SHALL surface a duplicate warning naming the matching record(s) and its status, and SHALL apply the configured duplicate policy (see `OQ-02`; default: **warn and allow override with a reason**).
5. WHEN a user publishes a record whose extracted PO number and customer match an existing record, THE SYSTEM SHALL raise the same duplicate warning at review time (post-extraction, since the PO number is not known before).
6. THE SYSTEM SHALL show the user that extraction is in progress, with an indicative duration.
7. THE SYSTEM SHALL NOT require the user to keep the page open for extraction to complete.

---

### FR-4 — OCR / data extraction

**User story:** As an Uploader, I want the system to read the PO for me, so that I review data rather than type it.

**Vendor profiles**

1. THE SYSTEM SHALL support **vendor profiles**, each holding: identification hints (e.g. sender name, VAT/tax ID, layout markers, regex patterns), a vendor-specific extraction prompt, and field mapping/normalisation rules.
2. WHEN extraction starts, THE SYSTEM SHALL attempt to identify the vendor from the document content and any user-supplied hint.
3. IF a vendor profile is matched with sufficient certainty, THEN THE SYSTEM SHALL use that profile's prompt; OTHERWISE THE SYSTEM SHALL use the **generic extraction prompt**.
4. THE SYSTEM SHALL record on the record which profile (or the generic fallback) was used, and the prompt/profile version.
5. THE SYSTEM SHALL allow an Administrator to create, edit, version, and test vendor profiles without a code deployment.
6. THE SYSTEM SHALL allow a reviewer to report a misidentified vendor, producing a signal Administrators can act on.

**Extraction call**

7. THE SYSTEM SHALL submit the PO PDF to the Gemini API requesting a **structured response conforming to a defined extraction schema** (`FR-5.1`), not free text.
8. THE SYSTEM SHALL request a **per-field confidence score** for every extracted field, header and line item alike.
9. THE SYSTEM SHALL persist the raw extraction response alongside the normalised result, for debugging and prompt improvement.
10. THE SYSTEM SHALL apply a configurable request timeout (default **120 s**) to the extraction call.
11. IF the extraction call fails with a transient error, THEN THE SYSTEM SHALL retry with exponential backoff up to a configurable maximum (default **3** attempts).
12. IF extraction fails after the maximum attempts, THEN THE SYSTEM SHALL transition the record to `EXTRACTION_FAILED` and record the error for the user and for Operations.
13. IF the response does not conform to the extraction schema, THEN THE SYSTEM SHALL treat it as a failed attempt and SHALL NOT present malformed data as reviewable.
14. THE SYSTEM SHALL NOT transmit the PDF to any service other than the configured extraction provider.
15. THE SYSTEM SHALL record extraction telemetry per record: model/version, prompt version, latency, token usage, and attempt count.

---

### FR-5 — Extracted data model and confidence

**User story:** As a Reviewer, I want extracted data structured as one header with many line items, so that it maps cleanly to a Sales Order.

1. THE SYSTEM SHALL represent an extraction as **one PO header** plus **one or more line items**.
2. THE SYSTEM SHALL extract at minimum the following **header** fields:

   | Field | Type | Notes |
   |---|---|---|
   | PO number | string | Vendor's own reference; **not** the correlation ID |
   | PO date | date | |
   | Customer name | string | |
   | Customer code | string | **High risk** — see `FR-6` |
   | Ship-to party / address | string / structured | |
   | Bill-to party / address | string / structured | |
   | Requested delivery date | date | |
   | Currency | string (ISO 4217) | |
   | Payment terms | string | |
   | Incoterms | string | |
   | PO total value | decimal | Used for the cross-check in `FR-6.6` |
   | Vendor/customer contact | string | Optional |

3. THE SYSTEM SHALL extract at minimum the following **line item** fields:

   | Field | Type | Notes |
   |---|---|---|
   | Line number | integer | Sequenced if absent in the source |
   | Material / product code | string | **High risk** — see `FR-6` |
   | Customer material number | string | Where the vendor uses their own code |
   | Description | string | |
   | Quantity | decimal | |
   | Unit of measure (UOM) | string | Normalised to SAP UOM (`FR-6.4`) |
   | Unit price | decimal | |
   | Line net value | decimal | |
   | Requested delivery date | date | Line-level override of header |
   | Plant / delivery location | string | Where applicable |

4. THE SYSTEM SHALL store, for every extracted field, the extracted value, the confidence score, and the original value as extracted (preserved even after human correction).
5. THE SYSTEM SHALL mark a field **low confidence** when its score falls below the configured threshold (default **0.85**, configurable globally and per field).
6. THE SYSTEM SHALL mark a field **missing** when the extractor returns no value for a field designated as required.
7. WHERE extraction is unavailable or unusable, THE SYSTEM SHALL permit full manual entry of header and line items, flagging those values as manually entered with confidence `null`.
8. THE SYSTEM SHALL normalise numbers, dates, and currencies to canonical internal formats, preserving the raw string for display next to the normalised value.
9. THE SYSTEM SHALL handle multi-page POs and line items spanning page breaks without duplicating or dropping lines.

---

### FR-6 — Validation

**User story:** As a Reviewer, I want the system to catch bad values before I approve, so that SAP does not reject the order later.

1. THE SYSTEM SHALL classify each validation result as **blocking** (approval prevented) or **warning** (approval allowed with acknowledgement).
2. THE SYSTEM SHALL validate structural and format rules: required fields present, dates parseable and sane, quantities `> 0`, prices `>= 0`, currency a valid ISO 4217 code, at least one line item present.
3. WHERE master data is accessible (`A-05`), THE SYSTEM SHALL validate **customer code** and **material code** against reference data at review time, and SHALL flag unmatched values as **blocking**.
4. WHERE master data is accessible, THE SYSTEM SHALL validate the **UOM** against SAP's unit list and offer a normalised suggestion where the source uses a synonym (e.g. `PCS` → `EA`).
5. WHERE a material lookup returns close matches, THE SYSTEM SHALL offer them as selectable suggestions rather than requiring free typing.
6. THE SYSTEM SHALL cross-check that the sum of line net values reconciles with the PO total value and SHALL raise a **warning** on mismatch beyond a configurable tolerance.
7. THE SYSTEM SHALL re-run all validations after every user edit and reflect results without a page reload.
8. THE SYSTEM SHALL re-run all validations server-side at the moment of approval, and SHALL reject the approval if any blocking validation fails.
9. THE SYSTEM SHALL record which warnings were acknowledged, by whom, and when.

---

### FR-7 — Human review and approval

**User story:** As an Approver, I want the original PDF next to the editable extracted data, so that I can verify every value against the source before anything reaches SAP.

**Review screen**

1. THE SYSTEM SHALL display the original PDF and the editable extracted fields **side by side** in a single screen, with the PDF viewer supporting page navigation, zoom, and text search.
2. THE SYSTEM SHALL visually distinguish: low-confidence fields, missing required fields, blocking validation errors, warnings, and fields edited by a human.
3. THE SYSTEM SHALL provide a summary count of items needing attention and a way to jump directly to each.
4. WHERE the extractor supplies source coordinates for a field, THE SYSTEM SHALL highlight the corresponding region in the PDF when the field is focused. *(Desirable; degrade gracefully when coordinates are unavailable.)*
5. THE SYSTEM SHALL allow editing every header and line-item field, adding line items, deleting line items, and reordering lines.
6. THE SYSTEM SHALL show the original extracted value alongside any human-edited value.
7. THE SYSTEM SHALL autosave review edits as the user works, so that a lost session does not lose corrections.
8. THE SYSTEM SHALL prevent two users from concurrently editing the same record's review (lock or optimistic-concurrency conflict detection).

**Approval**

9. THE SYSTEM SHALL require an explicit, deliberate **Approve** action; approval SHALL NOT occur automatically on any confidence level, at any time, for any vendor.
10. WHEN a user approves, THE SYSTEM SHALL re-validate server-side (`FR-6.8`), transition the record to `APPROVED`, and record the approving user, the timestamp, and a snapshot of the exact data approved.
11. THE SYSTEM SHALL enforce a configurable **segregation-of-duties** rule determining whether the uploader may approve their own record (`OQ-01`); when the rule is enabled and violated, approval SHALL be refused with a clear explanation.
12. THE SYSTEM SHALL allow an Approver to **Reject** a record with a mandatory reason, returning it to `NEEDS_REVIEW` with the reason visible.
13. THE SYSTEM SHALL make the approved data snapshot immutable — later edits, if any, create a new revision rather than mutating what was approved.
14. THE SYSTEM SHALL prevent approval of a record that is not in `NEEDS_REVIEW` or `EXTRACTION_FAILED`.

---

### FR-8 — Correlation ID

**User story:** As Operations, I want a reliable key linking cockpit records to SAP results, so that results are never matched to the wrong order.

1. THE SYSTEM SHALL allocate a correlation ID from the **internal record identifier**, never from the vendor's PO number, since vendors reuse PO numbers across time and across vendors.
2. THE SYSTEM SHALL guarantee the correlation ID is globally unique, immutable for the record's lifetime, and filename-safe (no characters requiring escaping on the target filesystem).
3. THE SYSTEM SHALL embed the correlation ID **both** in the outbound filename and in the file's content.
4. WHERE a record is resubmitted, THE SYSTEM SHALL retain the same correlation ID and SHALL distinguish attempts by an **attempt number** (e.g. `<correlationId>_<attempt>`), so that a stale result file is never mistaken for the current attempt's result.
5. THE SYSTEM SHALL index records by correlation ID for constant-time lookup by the result watcher.

---

### FR-9 — SAP handoff (outbound folder drop)

**User story:** As the business, I want approved orders to reach SAP automatically, so that no one re-keys data into S/4HANA.

**File generation**

1. WHEN a record enters `APPROVED`, THE SYSTEM SHALL generate the outbound payload as **CSV** containing the PO header fields and all line items, with the correlation ID embedded.
2. THE SYSTEM SHALL implement the CSV schema defined in `§8.2`, treating it as **provisional until confirmed against the existing SAP job** (`OQ-03`).
3. THE SYSTEM SHALL support both candidate layouts behind configuration — **(a)** a single file with a header/line marker column, and **(b)** a header-file + lines-file pair sharing the correlation ID — so that the final choice is a configuration decision, not a rewrite.
4. THE SYSTEM SHALL apply the configured character encoding, delimiter, quoting, decimal separator, and date format, and SHALL escape delimiters and newlines occurring inside field values.
5. THE SYSTEM SHALL store a copy of every generated outbound file, immutably, against the record.

**Atomic write**

6. THE SYSTEM SHALL write outbound files atomically so the SAP job can never read a partially written file, using either **(a)** write to a temp name/staging directory then rename into the watched folder, or **(b)** write the data file then write a `.done` marker — whichever the SAP job supports (`OQ-08`).
7. WHERE the rename strategy is used, THE SYSTEM SHALL ensure the temp file resides on the same filesystem/volume as the target so the rename is atomic.
8. THE SYSTEM SHALL `fsync` (or platform equivalent) the data file before rename or before writing the done marker.
9. WHEN the outbound write completes and is confirmed durable, THE SYSTEM SHALL transition the record to `SENT_TO_SAP` and record the filename, path, byte size, checksum, and timestamp.
10. IF the write fails, THEN THE SYSTEM SHALL retry with backoff, and on final failure SHALL return the record to `NEEDS_REVIEW` with the reason, SHALL remove any partial artefacts, and SHALL alert Operations.
11. THE SYSTEM SHALL never write two files for the same `(correlation ID, attempt)` pair.
12. THE SYSTEM SHALL monitor outbound folder accessibility and free space, and SHALL alert Operations when the drop location is unwritable.

---

### FR-10 — SAP result ingestion

**User story:** As an Uploader, I want to see whether SAP actually created the order, so that I know when to act.

1. THE SYSTEM SHALL watch the configured inbound result folder continuously (filesystem events where available, with a polling fallback at a configurable interval, default **30 s**).
2. THE SYSTEM SHALL only consume a result file once it is confirmed complete, per the agreed completeness convention (`.done` marker, atomic rename, or stable-size check) — `OQ-04`.
3. THE SYSTEM SHALL parse the result file per the schema in `§8.3`, extracting: correlation ID, attempt number, outcome, SO number (on success), error code and message (on failure), and SAP timestamp.
4. WHEN a result file matches a record in `SENT_TO_SAP` with the current attempt number, THE SYSTEM SHALL transition the record to `SO_CREATED` (storing the SO number) or `FAILED` (storing the error code and reason).
5. IF no result arrives within the configured SLA (default **60 minutes**, configurable), THEN THE SYSTEM SHALL transition the record to `FAILED` with reason `NO_RESPONSE_FROM_SAP` and SHALL alert Operations.
6. IF a result file's correlation ID matches no record, THEN THE SYSTEM SHALL quarantine the file, log the event, and alert Operations — and SHALL NOT delete it.
7. IF a result file is unparseable, THEN THE SYSTEM SHALL quarantine it, alert Operations, and leave the corresponding record's status unchanged.
8. IF a result arrives for an attempt number that is not the record's current attempt, THEN THE SYSTEM SHALL log it as a stale result and SHALL NOT change the record's status.
9. THE SYSTEM SHALL process result ingestion **idempotently**: reprocessing the same result file SHALL NOT produce duplicate status changes or duplicate notifications.
10. WHEN a result file has been successfully processed, THE SYSTEM SHALL archive it to a dated archive location rather than deleting it.
11. THE SYSTEM SHALL store the raw result file content against the record.

---

### FR-11 — Failure handling and resubmission

**User story:** As an Uploader, I want to understand and fix a failure, so that a rejected PO still becomes a Sales Order without starting over.

1. WHEN a record enters `FAILED`, THE SYSTEM SHALL display the SAP failure reason in the record's detail view, in plain language where a mapping exists for the error code, with the raw SAP message always available.
2. THE SYSTEM SHALL maintain a configurable mapping from SAP error codes to human-readable explanations and suggested remedies (e.g. "Material X not found in SAP — verify the material code on line 3").
3. WHERE the failure identifies a specific field or line item, THE SYSTEM SHALL highlight that field or line in the review screen.
4. THE SYSTEM SHALL provide a **Resubmit** action on `FAILED` records that returns the record to `NEEDS_REVIEW` for correction, preserving all prior data.
5. WHEN a corrected record is re-approved, THE SYSTEM SHALL increment the attempt number and submit under the same correlation ID (`FR-8.4`).
6. THE SYSTEM SHALL retain the full history of every attempt: data submitted, file written, result received, and the user who acted.
7. THE SYSTEM SHALL surface a Failed worklist to Operations, sortable by age and error type.
8. THE SYSTEM SHALL NOT auto-resubmit a `FAILED` record without a human action.

---

### FR-12 — Worklist, search, and record detail

**User story:** As any user, I want to find records and see where each one stands, so that I can work the queue.

1. THE SYSTEM SHALL provide a worklist showing at minimum: correlation ID, PO number, customer, status, line count, PO value, uploader, approver, age in current status, and SO number where present.
2. THE SYSTEM SHALL support filtering by status, customer, vendor profile, date range, uploader, approver, and error type.
3. THE SYSTEM SHALL support free-text search across PO number, customer, SO number, correlation ID, and filename.
4. THE SYSTEM SHALL provide saved/default views for the common queues: **Needs Review**, **Failed**, **In Flight to SAP**, **My Records**.
5. THE SYSTEM SHALL provide a record detail view showing: current status, full status history with timestamps and actors, the PDF, current data, extraction metadata, all outbound files, all result files, and the audit trail.
6. THE SYSTEM SHALL support exporting a filtered worklist to CSV.
7. THE SYSTEM SHALL reflect status changes in an open worklist without requiring a manual refresh.

---

### FR-13 — Audit trail

**User story:** As an auditor, I want an immutable record of everything that happened to a PO, so that any Sales Order can be justified after the fact.

1. THE SYSTEM SHALL write an immutable, append-only audit event for: upload, publish, extraction start/finish/failure, every field edit (old value → new value), warning acknowledgement, approval, rejection, outbound write, result ingestion, status change, resubmission, cancellation, and configuration changes to vendor profiles, thresholds, and folder paths.
2. THE SYSTEM SHALL record on every audit event: actor (user or system component), UTC timestamp, record ID, event type, and before/after values where applicable.
3. THE SYSTEM SHALL prevent modification or deletion of audit events through the application.
4. THE SYSTEM SHALL make a record's audit trail viewable by Operations and Administrators, and exportable.
5. THE SYSTEM SHALL retain audit events for the retention period in `NFR-7.1`, independent of record deletion.

---

### FR-14 — Notifications

**User story:** As an Uploader, I want to be told when something needs me, so that records do not sit unattended.

1. THE SYSTEM SHALL notify the relevant user(s) when a record enters `NEEDS_REVIEW`, `FAILED`, or `EXTRACTION_FAILED`.
2. THE SYSTEM SHALL notify the uploader when their record reaches `SO_CREATED`.
3. THE SYSTEM SHALL alert Operations on integration-level failures: drop folder unwritable, result watcher stopped, unmatched result file, SLA timeout.
4. THE SYSTEM SHALL let users configure which notifications they receive and through which channel (in-app at minimum; email where configured).
5. THE SYSTEM SHALL NOT send duplicate notifications for a single state change (`FR-10.9`).

---

### FR-15 — Administration

**User story:** As an Administrator, I want to tune the system without a deployment, so that new vendors and changed paths are handled operationally.

1. THE SYSTEM SHALL allow configuring: outbound folder path, inbound result folder path, archive and quarantine paths, completeness convention, polling interval, SLA timeout, confidence thresholds, duplicate policy, SoD policy, and file size limits.
2. THE SYSTEM SHALL allow managing vendor profiles, including testing a profile's prompt against a sample PDF before activation.
3. THE SYSTEM SHALL version vendor profiles and record which version produced any given extraction.
4. THE SYSTEM SHALL allow managing users and role assignments.
5. THE SYSTEM SHALL validate configuration on save (e.g. folder exists and is writable) and refuse invalid configuration.
6. THE SYSTEM SHALL audit every configuration change (`FR-13.1`).

---

## 7. Data model requirements

The design document will specify the physical schema. These are the entities and the constraints the requirements imply.

| Entity | Purpose | Key requirements |
|---|---|---|
| `PORecord` | The central record. | Immutable correlation ID; current status; current attempt number; FK to file, header, audit events. |
| `SourceDocument` | The uploaded PDF. | Content hash; original filename; size; page count; immutable content. |
| `ExtractionRun` | One extraction attempt. | Model, prompt/profile version, latency, token usage, raw response, outcome; many per record. |
| `POHeader` | Header fields of the current revision. | One per record revision; fields per `FR-5.2`. |
| `POLineItem` | Line items of the current revision. | N per header; fields per `FR-5.3`; stable line ordering. |
| `FieldExtraction` | Per-field provenance. | Field path, extracted value, confidence, source coordinates (optional), current value, edited-by, edited-at. |
| `VendorProfile` | Per-vendor extraction config. | Identification hints, prompt, mappings, version, active flag. |
| `ValidationResult` | Outcome of validation. | Field path, severity (blocking/warning), code, message, acknowledged-by. |
| `Submission` | One handoff attempt to SAP. | Attempt number, outbound filename/path/checksum, written-at, approved-by, approved data snapshot. |
| `SapResult` | One ingested result file. | Correlation ID, attempt, outcome, SO number, error code/message, raw content, ingested-at. |
| `AuditEvent` | Append-only history. | Actor, event type, timestamp, before/after, record ID. |

**Constraints**

- `DM-01` — Correlation ID is unique and immutable (`FR-8.2`).
- `DM-02` — A record has at most one submission per `(correlation ID, attempt)` (`FR-9.11`).
- `DM-03` — Approved data snapshots are immutable (`FR-7.13`).
- `DM-04` — Deleting a `PORecord` never cascades to `AuditEvent` (`FR-13.5`).
- `DM-05` — Every `POLineItem` belongs to exactly one `POHeader`; a header has at least one line at approval time (`FR-6.2`).

---

## 8. Integration contract requirements

> **Status: provisional.** Everything in `§8.2`–`§8.4` must be confirmed against the existing SAP-side job before implementation begins (`OQ-03`, `OQ-04`, `OQ-05`, `OQ-08`).

### 8.1 Mechanism

- `IC-01` — The integration is **folder drop**. This is a fixed constraint; no direct API call to SAP is in scope.
- `IC-02` — The cockpit writes to the outbound folder and reads from the inbound result folder. It never writes to the result folder except to archive or quarantine (if those live under it).
- `IC-03` — File completeness is signalled by either atomic rename or a `.done` marker; the choice is a single configuration value applied consistently (`FR-9.6`).
- `IC-04` — Both sides must agree on encoding (proposed: **UTF-8**, BOM per SAP's requirement), line endings, delimiter, decimal separator, and date format. Disagreement here is the most likely cause of silent data corruption.

### 8.2 Outbound file — proposed schema

**Naming:** `PO_<correlationId>_<attempt>.csv` (data) plus `PO_<correlationId>_<attempt>.done` (marker, if the marker convention is used).

**Option A — single file with a record-type marker column**

```
REC_TYPE,CORRELATION_ID,ATTEMPT,...
H,<correlationId>,<attempt>,<poNumber>,<poDate>,<customerCode>,<shipTo>,<billTo>,<currency>,<requestedDeliveryDate>,<paymentTerms>,<incoterms>,<poTotalValue>
L,<correlationId>,<attempt>,<lineNumber>,<materialCode>,<customerMaterialNumber>,<description>,<quantity>,<uom>,<unitPrice>,<lineNetValue>,<lineDeliveryDate>,<plant>
```

**Option B — header file + lines file sharing the correlation ID**

```
PO_<correlationId>_<attempt>_H.csv    # one row: header fields
PO_<correlationId>_<attempt>_L.csv    # N rows: line items, each carrying the correlation ID
```

- `IC-05` — The implementation SHALL support both options behind configuration until `OQ-03` is closed (`FR-9.3`).
- `IC-06` — The correlation ID SHALL appear on every row, so that a line row is never orphaned from its header.
- `IC-07` — Column order and header-row presence SHALL be exactly as the SAP job expects; if the job is positional, a column-order change is a breaking change requiring coordinated release.

### 8.3 Result file — proposed schema

**Naming:** `RESULT_<correlationId>_<attempt>.csv` (or `.json`, per `OQ-05`).

| Field | Notes |
|---|---|
| `CORRELATION_ID` | Must match the outbound value exactly |
| `ATTEMPT` | Must match the submitted attempt |
| `STATUS` | `SUCCESS` \| `ERROR` |
| `SO_NUMBER` | Populated on success |
| `ERROR_CODE` | SAP message code on failure |
| `ERROR_MESSAGE` | Human-readable SAP text on failure |
| `SAP_TIMESTAMP` | When SAP processed it |

- `IC-08` — A result SHALL be written for **every** submitted file, success or failure (`A-03`).
- `IC-09` — Where SAP reports multiple messages, the result SHALL carry the determinative one plus, ideally, the full message list.

### 8.4 Folder layout — proposed

```
<root>/
  outbound/            # cockpit writes here; SAP job polls
  outbound/.staging/   # temp files for the rename strategy (same volume)
  inbound/             # SAP writes result files here; cockpit polls
  inbound/archive/     # processed results, dated
  inbound/quarantine/  # unmatched or unparseable results
```

- `IC-10` — Paths SHALL be configuration, never hard-coded (`FR-15.1`).
- `IC-11` — The staging directory SHALL reside on the same filesystem as `outbound/` (`FR-9.7`).
- `IC-12` — The SAP job's consumption behaviour (does it delete consumed files, move them, or leave them?) SHALL be documented, because it determines whether the cockpit must avoid filename reuse across attempts.

---

## 9. Non-functional requirements

### NFR-1 — Performance

1. Worklist and record detail views SHALL render within **2 s** at the 95th percentile for the expected data volume.
2. Extraction SHALL complete within **60 s** at the median and **180 s** at the 95th percentile for a typical (≤10 page) PO.
3. Outbound file generation and write SHALL complete within **5 s** of approval at the 95th percentile.
4. A result file SHALL be detected and reflected in the record's status within **60 s** of becoming complete.
5. The system SHALL support the target throughput defined during design (`OQ-09`) without queue backlog growth.

### NFR-2 — Reliability and correctness

1. Status transitions SHALL be atomic and enforced server-side (`INV-01`).
2. Outbound writes and result ingestion SHALL be idempotent (`FR-9.11`, `FR-10.9`).
3. No record SHALL be able to reach SAP without a recorded human approval.
4. The system SHALL survive restart of the extraction worker or result watcher without losing or double-processing work.
5. Extraction provider unavailability SHALL degrade the system to queued/manual-entry operation, not data loss.

### NFR-3 — Security

1. Authentication SHALL be required for all access; roles per `§4` SHALL be enforced server-side.
2. PO PDFs and extracted data SHALL be encrypted at rest and in transit.
3. Credentials (extraction API key, file-share credentials) SHALL be held in a secret store, never in source or configuration files in the repo.
4. File uploads SHALL be validated by content type, not filename extension alone, and SHALL be stored so that they cannot be executed.
5. Access to a record's PDF SHALL be authorised per request; storage URLs SHALL NOT be guessable or permanently public.
6. The audit trail SHALL be tamper-evident (`FR-13.3`).
7. Data sent to the extraction provider SHALL be governed by a reviewed data-processing position (customer data leaves the network boundary) — see `OQ-07`.

### NFR-4 — Usability

1. The review screen SHALL be usable on a standard laptop display without horizontal scrolling of the field panel.
2. Fields needing attention SHALL be reachable via keyboard navigation, so that review can be done without a mouse.
3. Error messages SHALL name the field and the remedy, never only an internal code.
4. The interface SHALL meet WCAG 2.1 AA for colour contrast and keyboard operability; confidence and validation state SHALL NOT be conveyed by colour alone.

### NFR-5 — Observability

1. The system SHALL expose health checks for: extraction worker, result watcher, outbound folder writability, inbound folder readability.
2. The system SHALL emit metrics for: records by status, extraction success rate, mean confidence, human correction rate per field, SAP rejection rate by error code, and end-to-end time from upload to `SO_CREATED`.
3. The system SHALL log every integration file operation with the correlation ID for end-to-end tracing.
4. Alerts SHALL fire on: watcher stopped, folder unreachable, SLA timeouts, extraction error-rate spike, unmatched result file.

### NFR-6 — Maintainability

1. Vendor profiles and prompts SHALL be data, not code (`FR-4.5`).
2. The CSV schema and folder paths SHALL be configuration (`IC-10`).
3. The status machine SHALL be defined in one place, with transitions declared rather than scattered across handlers.

### NFR-7 — Data retention

1. PO PDFs, extracted data, submission files, result files, and audit events SHALL be retained for a configurable period (default **7 years**, to be confirmed against finance/tax policy — `OQ-10`).
2. Soft-deleted records SHALL remain recoverable for a configurable window before hard deletion.

---

## 10. Error handling matrix

| Scenario | Detection | System response | User-visible outcome |
|---|---|---|---|
| Non-PDF or oversized upload | Upload validation (`FR-1.2`, `FR-1.3`) | Reject before record creation | Inline error naming the limit |
| Corrupt / unreadable PDF | Extraction failure | Retry, then `EXTRACTION_FAILED` | Message + manual-entry option |
| Extraction API timeout / 5xx | Call error | Backoff retry ×3, then `EXTRACTION_FAILED` | Status + Retry action |
| Extraction returns malformed schema | Schema validation (`FR-4.13`) | Treat as failed attempt; never present malformed data | `EXTRACTION_FAILED` |
| Vendor not recognised | No profile match | Generic prompt; record fallback used | Banner noting generic extraction |
| Low-confidence fields | Threshold check (`FR-5.5`) | Flag for attention | Highlighted fields + attention count |
| Unknown material / customer code | Master-data lookup (`FR-6.3`) | Blocking validation | Approval refused until corrected |
| Duplicate PO | Hash / PO+customer match (`FR-3.4`) | Warn; policy-driven block or override-with-reason | Duplicate warning naming the other record |
| Approval attempted with blocking errors | Server-side re-validation (`FR-6.8`) | Refuse approval | Error listing the blocking items |
| SoD violation | Approval check (`FR-7.11`) | Refuse approval | "Requires a different approver" |
| Outbound folder unwritable | Write failure (`FR-9.10`) | Retry; return to `NEEDS_REVIEW`; alert Ops | Status + reason + Ops alert |
| Partial file read by SAP | Prevented by design (`FR-9.6`) | Atomic rename / done marker | N/A |
| SAP rejects the order | Failure result file | `FAILED` + mapped reason | Reason + Resubmit path |
| No result within SLA | Timeout (`FR-10.5`) | `FAILED` (`NO_RESPONSE_FROM_SAP`); alert Ops | Status + Ops alert |
| Result file for unknown correlation ID | Lookup miss (`FR-10.6`) | Quarantine; alert Ops; never delete | Ops-only |
| Unparseable result file | Parse error (`FR-10.7`) | Quarantine; alert Ops; record unchanged | Ops-only |
| Stale result (old attempt) | Attempt mismatch (`FR-10.8`) | Log; ignore | None |
| Duplicate result file | Idempotency (`FR-10.9`) | No-op | None |
| Concurrent review edits | Lock / version conflict (`FR-7.8`) | Block second writer | "Record is being edited by X" |

---

## 11. Open questions

These must be resolved before or during the design phase. Each is referenced from the requirements above.

| ID | Question | Why it matters | Blocks | Owner | Proposed default |
|---|---|---|---|---|---|
| `OQ-01` | Can the uploader also approve, or is a separate approver required? Does it vary by PO value? | Determines the role model, the approval UI, and whether a second person is a throughput bottleneck. | `FR-7.11`, `§4` | Business / Finance control | Configurable; **default: separate approver required**, with a value threshold as a possible refinement. |
| `OQ-02` | How are duplicate POs handled — hard block, warn-and-override, or allow? What defines a duplicate (file hash, PO number + customer, or both)? | Prevents duplicate Sales Orders; vendors legitimately reuse PO numbers. | `FR-3.4`, `FR-3.5` | Business | Warn on both signals; allow override with a mandatory reason; block only on exact file-hash match of a record already `SENT_TO_SAP` or beyond. |
| `OQ-03` | Exact outbound CSV schema: single file with a record-type marker, or header + lines pair? Exact column names, order, header row, encoding, delimiter, decimal separator, date format. | The SAP job's existing parser defines this; guessing wrong means silent data corruption, not a loud failure. | `FR-9.2`, `FR-9.3`, `§8.2` | SAP team | Implement both behind configuration; confirm before first integration test. |
| `OQ-04` | How does the SAP job signal that it has finished writing a result file, and how should the cockpit signal completeness of outbound files — `.done` marker or atomic rename? | Determines whether partial reads are possible in either direction. | `FR-9.6`, `FR-10.2`, `IC-03` | SAP team | Atomic rename if same-volume; `.done` marker otherwise. |
| `OQ-05` | Exact result-file schema and format (CSV vs JSON), and the SAP error codes that can appear. | Needed for parsing and for the error-code-to-remedy mapping. | `FR-10.3`, `FR-11.2`, `§8.3` | SAP team | CSV matching `§8.3`. |
| `OQ-06` | Exact folder paths, share protocol, and the service account's permissions on each folder. | Deployment and security configuration. | `§8.4`, `FR-15.1` | Infrastructure | Per `§8.4` layout. |
| `OQ-07` | Is sending customer PO PDFs to the Gemini API acceptable under data-protection policy? Which region? Any redaction required? | A blocking legal/compliance gate on the core mechanism. | `FR-4.14`, `NFR-3.7` | Legal / Security | Confirm before build; identify an on-prem/regional fallback if refused. |
| `OQ-08` | How much of the SAP-side polling job can be modified? | If it is modifiable, cleaner conventions (JSON, done markers, richer errors) become available. If fixed, the cockpit adapts entirely. | `FR-9.3`, `IC-03`, `IC-12` | SAP team | Treat as **fixed** until told otherwise. |
| `OQ-09` | Expected volume: POs per day, peak concurrency, average line items per PO, number of distinct vendors. | Sizing, cost forecasting for extraction, and whether a queue is needed. | `NFR-1.5` | Business | — |
| `OQ-10` | Retention period for PDFs, extracted data, and audit events. | Legal/tax requirement; drives storage cost. | `NFR-7.1` | Legal / Finance | 7 years. |
| `OQ-11` | Is master data (materials, customers, UOM) reachable for validation, and by what means — live API, nightly replica, or export file? | Determines whether `FR-6.3`–`FR-6.5` are implementable in v1 or deferred. | `FR-6.3`, `A-05` | SAP team | Nightly replica if no live API. |
| `OQ-12` | Does a PO PDF ever map to more than one Sales Order (e.g. split by plant or delivery date)? | Invalidates `A-06` and adds significant scope. | `A-06`, `FR-5.1` | Business | One PO → one SO for v1. |
| `OQ-13` | What is the expected behaviour when a vendor sends a revised PO for an already-created SO? | Amendment handling is currently out of scope; needs an explicit interim process. | `§2.2` | Business | Out of scope for v1; handle manually in SAP. |

---

## 12. Key design considerations carried into design

Recorded here so they are not lost between phases. These are inputs to `02-design.md`, not decisions made in this document.

1. **Vendor-format variance is the central extraction risk.** A vendor-profile/prompt-per-vendor approach with a generic fallback is the chosen strategy (`FR-4.1`–`FR-4.6`). The design must make adding a profile cheap and safe, because profile count will grow continuously.
2. **Material and customer codes are the highest-risk fields for SAP rejection.** Validating them against reference data at review time converts a slow, asynchronous SAP failure into an immediate, fixable one at the point where the human is already looking at the document (`FR-6.3`).
3. **Correlation ID must derive from the internal record ID, never the vendor PO number**, because vendors reuse PO numbers — across years and across each other (`FR-8.1`). The attempt-number suffix exists so that resubmissions do not collide with stale results (`FR-8.4`).
4. **The CSV shape is dictated by the existing SAP job, not by us.** Supporting both candidate layouts behind configuration keeps `OQ-03` from blocking the build (`FR-9.3`).
5. **Partial-file reads are the classic folder-drop failure.** The atomic-write requirement (`FR-9.6`–`FR-9.8`) is non-negotiable in both directions.
6. **The approval checkpoint is the product's core control, not a step to optimise away.** Any future "auto-approve above confidence X" proposal is a change to the guiding principle in `§1.4` and requires explicit business sign-off.

---

## 13. Requirement index

| ID | Title |
|---|---|
| FR-1 | PO upload |
| FR-2 | Draft management |
| FR-3 | Publish and extraction trigger |
| FR-4 | OCR / data extraction |
| FR-5 | Extracted data model and confidence |
| FR-6 | Validation |
| FR-7 | Human review and approval |
| FR-8 | Correlation ID |
| FR-9 | SAP handoff (outbound folder drop) |
| FR-10 | SAP result ingestion |
| FR-11 | Failure handling and resubmission |
| FR-12 | Worklist, search, and record detail |
| FR-13 | Audit trail |
| FR-14 | Notifications |
| FR-15 | Administration |
| NFR-1…7 | Performance, reliability, security, usability, observability, maintainability, retention |
| IC-01…12 | Integration contract |
| OQ-01…13 | Open questions |

---

## 14. Acceptance of this document

This specification is accepted when:

1. Every open question in `§11` has either a recorded decision or an explicit deferral with an owner and a date.
2. The SAP team has confirmed `§8.2`, `§8.3`, and `§8.4` against the existing polling job.
3. The business has signed off on the approval/SoD model (`OQ-01`) and the duplicate policy (`OQ-02`).
4. Legal/Security has cleared the extraction provider data flow (`OQ-07`).

Until then this document is **Draft**, and `02-design.md` may proceed only on the parts not gated by an unresolved open question.
