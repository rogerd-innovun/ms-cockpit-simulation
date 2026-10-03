import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HeaderWithLines } from '../../domain/validation.js';

vi.mock('../../db/client.js', () => ({ prisma: {} }));

const header = (): HeaderWithLines =>
  ({
    id: 'h1', recordId: 'r1', poNumber: 'PO-1', poDate: '2026-09-01', customerName: 'Acme',
    customerCode: 'C-1', shipTo: null, billTo: null, requestedDeliveryDate: '2026-10-01',
    currency: 'EUR', paymentTerms: null, incoterms: null, poTotalValue: '50.00', contact: null,
    updatedAt: new Date(),
    lineItems: [
      { id: 'l1', headerId: 'h1', lineNumber: 1, materialCode: 'MAT-1', customerMaterialNumber: null,
        description: 'Widget', quantity: '10', uom: 'EA', unitPrice: '5.00', lineNetValue: '50.00',
        deliveryDate: null, plant: null },
    ],
  }) as HeaderWithLines;

/** env is read once at import, so each scenario sets the process env and loads a fresh copy. */
const roots: string[] = [];

async function loadWith(settings: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-outbound-'));
  roots.push(root);
  Object.assign(process.env, { INTEGRATION_ROOT: root, CSV_LAYOUT: 'header_lines_pair', ...settings });
  vi.resetModules();
  const mod = await import('./outbound.js');
  return { ...mod, root, outbound: path.join(root, 'outbound') };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
  for (const k of ['INTEGRATION_ROOT', 'CSV_LAYOUT', 'COMPLETENESS_CONVENTION']) delete process.env[k];
});

describe('outbound write order (FR-9.6)', () => {
  it('rename convention: the header file appears last, so the lines are already there when SAP sees it', async () => {
    const { writeOutboundFiles, outbound } = await loadWith({ COMPLETENESS_CONVENTION: 'rename' });
    const renames: string[] = [];
    const real = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      renames.push(path.basename(String(to)));
      await real(from, to);
    });

    const result = await writeOutboundFiles('PO-ABC', 1, header());

    expect(renames).toEqual(['PO_PO-ABC_1_L.csv', 'PO_PO-ABC_1_H.csv']);
    expect((await fs.readdir(outbound)).filter((f) => f.endsWith('.csv')).sort()).toEqual([
      'PO_PO-ABC_1_H.csv',
      'PO_PO-ABC_1_L.csv',
    ]);
    // What is reported is unchanged: header first, so the first path is the header file.
    expect(result.filenames).toEqual(['PO_PO-ABC_1_H.csv', 'PO_PO-ABC_1_L.csv']);
    expect(path.basename(result.paths[0]!)).toBe('PO_PO-ABC_1_H.csv');
  });

  it('done-marker convention: the marker is written after every data file', async () => {
    const { writeOutboundFiles, outbound } = await loadWith({ COMPLETENESS_CONVENTION: 'done_marker' });
    const opened: string[] = [];
    const real = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (p, flags, mode) => {
      opened.push(path.basename(String(p)));
      return real(p, flags, mode);
    });

    const result = await writeOutboundFiles('PO-ABC', 1, header());

    expect(opened.at(-1)).toBe('PO_PO-ABC_1.done');
    expect(opened.slice(0, -1)).toHaveLength(2);
    expect(result.filenames).toEqual(['PO_PO-ABC_1_H.csv', 'PO_PO-ABC_1_L.csv', 'PO_PO-ABC_1.done']);
    expect(await fs.readdir(outbound)).toContain('PO_PO-ABC_1.done');
  });

  it('single file: unchanged, one file and no staging leftovers', async () => {
    const { writeOutboundFiles, outbound, root } = await loadWith({
      COMPLETENESS_CONVENTION: 'rename',
      CSV_LAYOUT: 'single_file',
    });
    const result = await writeOutboundFiles('PO-ABC', 2, header());
    expect(result.filenames).toEqual(['PO_PO-ABC_2.csv']);
    expect(await fs.readdir(path.join(root, 'outbound', '.staging'))).toEqual([]);
    expect(await fs.readdir(outbound)).toContain('PO_PO-ABC_2.csv');
  });

  it('leaves no file behind when the write fails part way', async () => {
    const { writeOutboundFiles, outbound } = await loadWith({ COMPLETENESS_CONVENTION: 'rename' });
    const real = fs.rename.bind(fs);
    let n = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (++n === 2) throw new Error('disk full'); // the header, after the lines went in
      await real(from, to);
    });

    await expect(writeOutboundFiles('PO-ABC', 1, header())).rejects.toThrow('disk full');
    expect((await fs.readdir(outbound)).filter((f) => f.startsWith('PO_'))).toEqual([]);
  });
});
