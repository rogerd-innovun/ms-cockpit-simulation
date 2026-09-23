# PO-to-SO Automation Cockpit

Upload a customer Purchase Order PDF → extract it with OCR → **a human reviews and approves** → a CSV lands in the folder SAP S/4HANA polls → the Sales Order number comes back.

> **Guiding principle:** a bad OCR read must never silently become a wrong Sales Order.
> The review screen, the approval checkpoint and segregation of duties all exist to serve that.

Specs live in [`docs/`](docs/) — this project is built spec-first: [requirements](docs/01-requirements.md) → [design](docs/02-design.md) → [tasks](docs/03-tasks.md).

---

## Quick start

```bash
# 1. Postgres (Docker must be running)
npm install
npm run db:up

# 2. Configure
cp .env.example backend/.env
#    then either set GEMINI_API_KEY=... for real extraction,
#    or set EXTRACTION_PROVIDER=mock to run without a key

# 3. Schema + seed users and vendor profiles
npm -w backend run prisma:migrate
npm -w backend run seed

# 4. Run API + web + the SAP simulator together
npm run dev
```

| Service | URL |
|---|---|
| Cockpit UI | http://localhost:5190 |
| API | http://localhost:4010/api |
| Health | http://localhost:4010/api/health |
| Postgres | `localhost:5439` (user/pass/db: `cockpit`) |

**Seeded logins** — all use the password `cockpit123`:

| Email | Role | Can approve? |
|---|---|---|
| `clerk@cockpit.local` | Uploader | no |
| `approver@cockpit.local` | Approver | yes — but not their own uploads |
| `ops@cockpit.local` | Operations | no |
| `admin@cockpit.local` | Administrator | yes |

Segregation of duties is on by default (`SOD_REQUIRE_SEPARATE_APPROVER=true`), so upload as the clerk and approve as the approver.

### Need a PO to test with?

```bash
npm -w backend exec tsx scripts/makeSamplePo.ts /tmp/po.pdf --vendor=northwind
```

Generates a real text-bearing PO PDF in one of two vendor layouts — readable by Gemini, and it matches a seeded vendor profile.

---

## The lifecycle

```
Draft → Published → Processing → Needs Review → Approved → Sent to SAP → SO Created
                          │            ▲                                      │
                          ▼            └───────── Failed ◀─────────────────────┘
                   Extraction Failed              (resubmit)
```

Every transition is enforced server-side, and every one writes an audit event.

---

## Layout

```
docs/                  the specs — read these first
backend/
  prisma/              schema, migration, seed
  scripts/             sample PO PDF generator
  src/
    domain/            status machine, field contract, validation rules
    services/          records, extraction (Gemini + mock), sap (csv/outbound/watcher)
    workers/           polling loops: extraction, outbound, results, SLA sweep
    simulator/         stands in for the SAP polling job — not part of the cockpit
frontend/src/          React SPA: worklist + review screen
docker-compose.yml     Postgres 16
```

`integration/` and `storage/` are created at runtime and are gitignored:

```
integration/
  outbound/            cockpit writes order CSVs here; SAP polls
  outbound/.staging/   temp files for the atomic-rename strategy
  inbound/             SAP writes result files here; cockpit polls
  inbound/archive/     processed results, by date
  inbound/quarantine/  unmatched or unparseable results — never deleted
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | API + web + SAP simulator |
| `npm run dev:api` / `dev:web` / `sap:sim` | one at a time |
| `npm test` | 38 unit tests on the correctness-critical paths |
| `npm -w backend run prisma:studio` | browse the database |
| `npm run db:up` / `db:down` | Postgres container |

---

## Hosted demo

A free-tier deployment runs at **https://po-cockpit.onrender.com** (Render, Singapore) against Supabase Postgres in the same region. `render.yaml` is the blueprint; [`DEPLOY.md`](DEPLOY.md) is the full runbook.

### Re-baking the demo records

```powershell
node "$env:TEMP\cockpit-prebake\prebake2.mjs"
```

Cancels the existing records, uploads two sample POs, publishes them and waits for each to reach *Needs review*. Takes ~40 seconds and two extraction calls.

It passes a duplicate-override reason deliberately: once a copy of a sample PDF has reached SAP, `FR-3.4` refuses to publish an identical file without a stated reason — which is every re-bake after the first successful run.

**Why you need it:** Render's free plan has no persistent disk, so every deploy *and* every wake from its 15-minute idle sleep empties `storage/`. Records and the audit trail survive in Postgres; the PDFs do not, so the review screen's document pane breaks for older records.

If `%TEMP%` has been cleared, regenerate the PDFs the script expects:

```powershell
$d = "$env:TEMP\cockpit-prebake"; mkdir $d -Force
npm -w backend exec tsx scripts/makeSamplePo.ts -- "$d\po1.pdf" --vendor=northwind
npm -w backend exec tsx scripts/makeSamplePo.ts -- "$d\po2.pdf" --vendor=mock
```

> **Pushing to `main` redeploys.** `render.yaml` sets `autoDeployTrigger: commit`, so any push wipes the PDFs and needs a re-bake afterwards. Turn Auto-Deploy off in the Render dashboard before a demo.

---

## Configuration worth knowing

| Variable | Default | Why it matters |
|---|---|---|
| `EXTRACTION_PROVIDER` | `gemini` | `mock` runs the full lifecycle with no API key. The server **refuses to start** if set to `gemini` with no key, rather than silently faking data. |
| `CONFIDENCE_THRESHOLD` | `0.85` | Below this, a field is flagged for the reviewer. |
| `SOD_REQUIRE_SEPARATE_APPROVER` | `true` | Whether an uploader may approve their own record (OQ-01). |
| `CSV_LAYOUT` | `single_file` | `single_file` (REC_TYPE marker) or `header_lines_pair`. Both implemented — OQ-03 is still open. |
| `COMPLETENESS_CONVENTION` | `done_marker` | `done_marker` or atomic `rename`. Both implemented — OQ-04 is still open. |
| `SAP_SLA_TIMEOUT_MS` | 1 hour | After this, a record stuck in *Sent to SAP* is marked Failed rather than waiting forever. |

---

## Status

**Milestone 1 is complete** — the whole lifecycle runs end to end. Verified scenarios, deferred requirements and remaining blockers are listed in [`docs/03-tasks.md`](docs/03-tasks.md).

Two things to settle before this meets a real SAP system:

- **OQ-03/04/05** — the actual CSV schema, completeness convention and result format from the SAP team. Both candidate layouts ship behind config, so closing these is an env change.
- **OQ-07** — data-protection clearance for sending customer PO PDFs to Gemini.
