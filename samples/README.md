# Sample purchase orders

Ready-to-upload PO PDFs in six industry-realistic layouts, one file per fictional
customer. Regenerate any of them with:

```bash
npm -w backend exec tsx scripts/makeSamplePo.ts -- samples/po-<vendor>.pdf --vendor=<vendor>
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

Each layout deliberately contains traps a naive extractor falls into: charge rows
("Carriage", "FREIGHT", "GST @18%") that are not line items, totals rows inside the
table, tax codes that look like material numbers, and four different decimal
conventions.
