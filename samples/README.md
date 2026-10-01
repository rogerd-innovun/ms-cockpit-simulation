# Sample documents

Two sets: the purchase orders that go **into** the cockpit, and the sales order
confirmation layouts that come **out** the other side.

Both generators run from the backend workspace, so the output path is relative to
`backend/` — hence the `../samples/` prefix.

## Purchase orders (input)

Ready-to-upload PO PDFs in thirteen industry-realistic layouts, one file per fictional
customer. Regenerate any of them with:

```bash
npm -w backend exec tsx scripts/makeSamplePo.ts -- ../samples/po-<vendor>.pdf --vendor=<vendor>
```

| File | Customer | Style | Currency / dates | Vendor profile? |
|---|---|---|---|---|
| `po-northwind.pdf` | Northwind Trading Ltd | UK trading company | GBP, `18/09/2026` | ✅ seeded |
| `po-mock.pdf` | Mock Industries GmbH | German manufacturer (Bestellung, `Artikelnr.` is the *customer's* number) | EUR, `18.09.2026`, `1.234,56` | ✅ seeded |
| `po-apex.pdf` | Apex Fastener Supply Inc. | US industrial distributor (FOB terms, freight note to exclude) | USD, `Sep 18, 2026` | ✅ seeded |
| `po-shakti.pdf` | Shakti Engineering Works Pvt. Ltd. | Indian manufacturer (GSTIN, HSN column that must NOT be read as a material number, lakh grouping `1,23,456.78`) | INR, `18-09-2026` | ✅ seeded |
| `po-nordica.pdf` | Nordica Lab Supplies AB | Swedish lab supplier (bilingual Inköpsorder) | SEK, `2026-09-18`, `1 234,56` | ❌ — exercises the generic-prompt fallback |
| `po-scan.pdf` | Orion Metals & Alloys LLC | **Fax/scan: a pure image with no text layer.** Extracting it requires reading pixels, which is what proves the vision path works on scans | USD, uppercase | ❌ — scans can't marker-match, generic prompt |
| `po-columns.pdf` | Meridian Food Distributors Pty Ltd | **Multi-column layout** — ORDER / DELIVER TO / INVOICE TO side by side, so naive line-order reading interleaves unrelated facts | AUD, `19/09/2026` | ❌ — generic prompt |
| `po-letter.pdf` | Cascade Timber & Joinery Ltd | **Letter format — the whole PO is prose.** Nothing is labelled; dates are long-hand; the line items live inside sentences | EUR, `24 September 2026` | ❌ — generic prompt |
| `po-multipage.pdf` | Harbourside Marine Supplies Ltd | **Two pages, sixteen lines.** The column header repeats on page 2; page 1 ends with a *carried forward* subtotal and page 2 opens with *brought forward* — neither is a line item; the total appears once, on the last page | GBP, `18/09/2026` | ❌ — generic prompt |
| `po-bondecommande.pdf` | Établissements Lemaire SA | **French, with accents.** `1 234,56` with a space for thousands, and the foot of the order reads *Total HT / TVA 20 % / Total TTC* — three totals, of which only HT (the goods) is the PO total | EUR, `18/09/2026` | ❌ — generic prompt |
| `po-ordine.pdf` | Bertolini Impianti S.p.A. | **Italian, SAP-style.** Item numbers 10–50, a delivery date and a plant on every line. **`Vs. cod.` is *your* code (our material number) and `Ns. cod.` is *theirs*** — the reverse of how most POs read. `Fornitore n.` is the buyer's number for us, **not** a customer code, and the page has none; the header delivery date is the words *come indicato per ogni riga* | EUR, `18/09/2026`, `1.234,56` | ❌ — generic prompt |
| `po-discounts.pdf` | Maple Ridge Industrial Supply Inc. | **List / Disc % / Net / Extended columns** — the unit price is the *net* one. A **free-of-charge line** (price 0.00) that is still an ordered line. Under the lines: goods subtotal, freight, fuel surcharge, HST 13 % and a grand total — only the subtotal is the PO total | CAD, `18-SEP-2026` | ❌ — generic prompt |
| `po-skewscan.pdf` | Brouwer & Zonen Machinebouw B.V. | **A harder scan than `po-scan.pdf`:** image only, rotated about 2°, faint, with a shadow down the left edge, heavy speckle and an ONTVANGEN stamp in the top margin. Dutch, uppercase | EUR, `18-09-2026`, `1.234,56` | ❌ — scans can't marker-match, generic prompt |

Each layout deliberately contains traps a naive extractor falls into: charge rows
("Carriage", "FREIGHT", "GST @18%") that are not line items, totals rows inside the
table, tax codes that look like material numbers, and four different decimal
conventions.

### What the last five found

Run through real Gemini extraction on 2026-10-01 (`gemini-3.6-flash`), then approved
where the reviewer had nothing blocking to fix:

| Sample | Result |
|---|---|
| `po-multipage.pdf` | All 16 lines, in order, none dropped or doubled at the page break; the carried-forward row was not taken for a line. Total correct. |
| `po-skewscan.pdf` | Every field and line right despite the skew, fade and stamp. Confidence 0.95–0.99. |
| `po-ordine.pdf` | `Vs.`/`Ns.` read the right way round; per-line dates and plants captured; **no customer code invented** (it stays blank, which blocks approval until the reviewer enters it). The header delivery date came back as the Italian sentence, which the validator blocks as not a date — the reviewer clears it. |
| `po-bondecommande.pdf` | Lines right. With the first generic prompt (`generic-v1`) the **PO total came back as the grand total** (`5 517,30` TTC) instead of the goods total (`4 597,75` HT). With `generic-v2`, which says which total to use, it comes back as `4 597,75`. |
| `po-discounts.pdf` | Net prices used, free line kept. With `generic-v1` the **PO total came back as TOTAL DUE** (`5,081.23`) instead of the goods subtotal (`4,399.16`). With `generic-v2` it comes back as `4,399.16`. |

The convention these two test: the PO total is the figure that equals the sum of the
line values (as in `po-shakti.pdf`, where GST is deliberately not part of it). If a
model ever picks the wrong one again, the review screen raises `TOTAL_MISMATCH`, and
since a warning has to be accepted before approval, a wrong total can no longer reach
SAP unnoticed — correct the total, or accept the warning knowingly.

## Sales order confirmations (output) — pick one

Three candidate layouts for the order confirmation. **All three carry identical data**
— the same order, the same four lines, the same USD 5,087.00 — so comparing them is a
comparison of format alone, not content. The client picks one; the other two go away.

```bash
npm -w backend exec tsx scripts/makeSampleSo.ts -- ../samples/so-<format>.pdf --format=<format>
```

| File | Format | Reads like | Best when |
|---|---|---|---|
| `so-classic.pdf` | **ERP-native.** Labelled key-value header in two columns, nine-column item grid, net / freight / tax / total stacked bottom-right | What S/4HANA prints today | The customer's AP team files these against invoices and expects the familiar shape. Lowest-surprise option |
| `so-modern.pdf` | **Customer-facing.** Sales order, total and arrival date lifted out and set large; two lines per item instead of a grid; delivery and payment as plain blocks; plain language | A confirmation email from a company that cares how it looks | The confirmation is a customer-facing touchpoint. Long descriptions never clip, because items aren't in a grid |
| `so-compact.pdf` | **Operations / despatch.** Fixed-width Courier, uppercase, ordered-vs-confirmed quantities, plant / storage location / schedule line per item, plus despatch weights and credit-block status | A warehouse report off a line printer | The despatch desk is the reader. Carries roughly twice the operational detail of the other two in the same page |

Shared, non-obvious details worth checking before choosing:

- Seller identity (`Lakeside Manufacturing LLC`) is a **placeholder** — change `SELLER`
  at the top of `backend/scripts/makeSampleSo.ts` to the real selling entity.
- The order shown is the one that flows through the demo: Apex's PO `APX-118276`
  becoming SO `4500533926`, which is what the SAP simulator returns.
- `classic` and `compact` show the plant and confirmed delivery date per line;
  `modern` shows the arrival date per line but no plant. If the customer needs to see
  the plant, `modern` needs a column added.
- Only `compact` distinguishes **ordered** from **confirmed** quantity. If partial
  confirmation is ever possible, the other two layouts have nowhere to show it.
