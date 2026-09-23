# Documentation — PO-to-SO Automation Cockpit

All specifications and design documents for this project live in this folder. The project follows **spec-driven development**: a document is written and agreed before the corresponding code is built.

## Workflow

```
Requirements  →  Design  →  Tasks  →  Implementation
  (what & why)   (how)      (steps)    (code)
```

Each phase is reviewed before the next begins. Code changes trace back to a requirement ID; if a change has no requirement, the requirement gets written first.

## Documents

| Doc | Purpose | Status |
|---|---|---|
| [`01-requirements.md`](01-requirements.md) | What the system must do, why, and under what constraints. Functional requirements (FR-*), non-functional requirements (NFR-*), integration contract (IC-*), open questions (OQ-*). | **Draft** |
| [`02-design.md`](02-design.md) | Stack, architecture, the decisions behind the build, API surface, test coverage, known limitations. | Living |
| [`03-tasks.md`](03-tasks.md) | Milestone breakdown with requirement IDs, plus what has been verified end to end. | M1 complete |

## Conventions

- **Requirement IDs are stable.** Never renumber; deprecate instead. Code comments, commits, and tasks reference them.
- **EARS phrasing** for acceptance criteria — `WHEN <trigger> THE SYSTEM SHALL <response>`, `IF <condition> THEN ...`, `WHILE <state> ...`, `WHERE <feature> ...`.
- **Open questions are tracked, not buried.** Anything unresolved goes in the open-questions table with an owner and a proposed default, and is referenced from the requirement it blocks.
- **Dates are absolute** (`2026-09-21`), never relative.
- One topic per file; keep the index above current.

## Current blockers

The following open questions gate parts of the design phase — see `§11` of the requirements:

- `OQ-03` / `OQ-04` / `OQ-05` — exact CSV schema, file-completeness convention, and result-file format, all owned by the SAP team.
- `OQ-07` — data-protection clearance for sending PO PDFs to the extraction provider.
- `OQ-01` — approver segregation-of-duties policy.
