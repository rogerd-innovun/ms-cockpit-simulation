/**
 * Stands in for the existing SAP S/4HANA polling job.
 *
 * This is NOT part of the cockpit. It exists because the real job is on the SAP side and
 * is a fixed integration constraint (IC-01, OQ-08) — without a stand-in there is no way
 * to exercise SENT_TO_SAP → SO_CREATED / FAILED end to end. It deliberately implements
 * only what §8.2–§8.4 say the real job does: poll the drop folder, read a complete file,
 * and write a result keyed to the same correlation ID.
 *
 * Run with:  npm run sap:sim
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { childLogger } from '../lib/logger.js';

const log = childLogger('sap-simulator');

const CONSUMED_DIR = path.join(env.paths.outbound, '.consumed');

/** Realistic S/4HANA sales-order rejections; see errorMap.ts for the cockpit's side. */
const FAILURE_MODES = [
  { code: 'MATERIAL_NOT_FOUND', message: 'Material {material} does not exist in plant 1000' },
  { code: 'CUSTOMER_NOT_FOUND', message: 'Customer {customer} is not defined in sales area 1000/10/00' },
  { code: 'CREDIT_LIMIT_EXCEEDED', message: 'Credit limit exceeded for customer {customer}' },
  { code: 'INVALID_UOM', message: 'Unit {uom} is not a valid sales unit for material {material}' },
  { code: 'PRICING_ERROR', message: 'No valid condition record found for material {material}' },
];

interface ParsedOutbound {
  correlationId: string;
  attempt: number;
  customerCode: string;
  materials: string[];
  uoms: string[];
  lineCount: number;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === env.CSV_DELIMITER) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseOutbound(content: string): ParsedOutbound | null {
  // Tolerate a column-name row being present or absent (CSV_HEADER_ROW): rows are
  // identified by their REC_TYPE marker, not by position.
  const rows = content.split(/\r?\n/).filter((l) => l.trim() !== '').map(splitCsv);
  const headerRow = rows.find((r) => r[0] === 'H');
  const lineRows = rows.filter((r) => r[0] === 'L');
  if (!headerRow) return null;
  return {
    correlationId: headerRow[1] ?? '',
    attempt: Number(headerRow[2] ?? '1'),
    customerCode: headerRow[5] ?? '',
    materials: lineRows.map((r) => r[4] ?? ''),
    uoms: lineRows.map((r) => r[8] ?? ''),
    lineCount: lineRows.length,
  };
}

function resultCsv(
  correlationId: string,
  attempt: number,
  outcome: 'SUCCESS' | 'ERROR',
  soNumber: string | null,
  errorCode: string | null,
  errorMessage: string | null,
): string {
  const esc = (v: string | null) => {
    const s = v ?? '';
    return s.includes(env.CSV_DELIMITER) || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ['CORRELATION_ID', 'ATTEMPT', 'STATUS', 'SO_NUMBER', 'ERROR_CODE', 'ERROR_MESSAGE', 'SAP_TIMESTAMP'];
  const cells = [correlationId, String(attempt), outcome, soNumber, errorCode, errorMessage, new Date().toISOString()];
  return `${headers.join(env.CSV_DELIMITER)}\n${cells.map(esc).join(env.CSV_DELIMITER)}\n`;
}

async function writeResult(base: string, content: string): Promise<void> {
  await fs.mkdir(env.paths.inbound, { recursive: true });
  const dataPath = path.join(env.paths.inbound, `${base}.csv`);
  // The real job's completeness convention is OQ-04; mirror whatever the cockpit expects.
  if (env.COMPLETENESS_CONVENTION === 'rename') {
    const tmp = path.join(env.paths.inbound, `.${base}.tmp`);
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, dataPath);
  } else {
    await fs.writeFile(dataPath, content, 'utf8');
    await fs.writeFile(path.join(env.paths.inbound, `${base}.done`), '', 'utf8');
  }
}

async function isComplete(filename: string): Promise<boolean> {
  if (env.COMPLETENESS_CONVENTION !== 'done_marker') return true;
  const base = filename.replace(/(_H|_L)?\.csv$/, '');
  try {
    await fs.access(path.join(env.paths.outbound, `${base}.done`));
    return true;
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  await fs.mkdir(env.paths.outbound, { recursive: true });
  const entries = await fs.readdir(env.paths.outbound, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = entry.name;
    // Option B writes a pair; the header file is the one that triggers processing.
    if (!filename.startsWith('PO_') || !filename.endsWith('.csv')) continue;
    if (filename.endsWith('_L.csv')) continue;
    if (!(await isComplete(filename))) continue;

    const sourcePath = path.join(env.paths.outbound, filename);
    const base = filename.replace(/(_H)?\.csv$/, '');

    try {
      let content = await fs.readFile(sourcePath, 'utf8');
      // Option B: the lines live in a sibling file.
      if (filename.endsWith('_H.csv')) {
        const linesPath = path.join(env.paths.outbound, `${base}_L.csv`);
        try {
          const lineContent = await fs.readFile(linesPath, 'utf8');
          content = `${content}\n${lineContent}`;
        } catch {
          log.warn({ filename }, 'header file has no matching lines file yet; waiting');
          continue;
        }
      }

      const parsed = parseOutbound(content);
      if (!parsed) {
        log.error({ filename }, 'could not parse outbound file');
        continue;
      }

      log.info(
        { correlationId: parsed.correlationId, attempt: parsed.attempt, lines: parsed.lineCount },
        'picked up order file',
      );

      await fs.mkdir(CONSUMED_DIR, { recursive: true });
      await fs.rename(sourcePath, path.join(CONSUMED_DIR, filename));
      if (filename.endsWith('_H.csv')) {
        await fs.rm(path.join(env.paths.outbound, `${base}_L.csv`), { force: true }).catch(() => {});
      }
      await fs.rm(path.join(env.paths.outbound, `${base}.done`), { force: true });

      // SAP takes a moment to post the document.
      setTimeout(() => {
        void (async () => {
          const failed = Math.random() < env.SAP_SIM_FAILURE_RATE;
          const resultBase = `RESULT_${parsed.correlationId}_${parsed.attempt}`;

          if (failed) {
            const mode = FAILURE_MODES[Math.floor(Math.random() * FAILURE_MODES.length)]!;
            const message = mode.message
              .replace('{material}', parsed.materials[0] ?? 'UNKNOWN')
              .replace('{customer}', parsed.customerCode || 'UNKNOWN')
              .replace('{uom}', parsed.uoms[0] ?? 'UNKNOWN');
            await writeResult(
              resultBase,
              resultCsv(parsed.correlationId, parsed.attempt, 'ERROR', null, mode.code, message),
            );
            log.warn({ correlationId: parsed.correlationId, code: mode.code }, 'order rejected');
          } else {
            const soNumber = String(4500000000 + Math.floor(Math.random() * 999999));
            await writeResult(
              resultBase,
              resultCsv(parsed.correlationId, parsed.attempt, 'SUCCESS', soNumber, null, null),
            );
            log.info({ correlationId: parsed.correlationId, soNumber }, 'sales order created');
          }
        })();
      }, env.SAP_SIM_PROCESSING_MS);
    } catch (err) {
      log.error({ filename, err: (err as Error).message }, 'failed to process outbound file');
    }
  }
}

async function main() {
  // This process fabricates Sales Order numbers and writes them into the inbound
  // folder as if S/4HANA had replied. Against a real SAP landscape that would put
  // invented order numbers into the audit trail, so it must be opted into.
  if (env.NODE_ENV === 'production' && !env.SAP_SIM_ALLOW_IN_PRODUCTION) {
    log.error(
      'Refusing to start: this simulator invents Sales Order numbers and NODE_ENV is "production". ' +
        'Set SAP_SIM_ALLOW_IN_PRODUCTION=true only if this environment has no real SAP integration.',
    );
    process.exit(1);
  }

  await fs.mkdir(env.paths.outbound, { recursive: true });
  await fs.mkdir(env.paths.inbound, { recursive: true });
  log.info(
    {
      outbound: env.paths.outbound,
      inbound: env.paths.inbound,
      failureRate: env.SAP_SIM_FAILURE_RATE,
      convention: env.COMPLETENESS_CONVENTION,
    },
    'SAP simulator polling for order files',
  );
  setInterval(() => void tick().catch((e) => log.error({ err: e.message }, 'tick failed')), env.SAP_SIM_POLL_MS);
}

void main();
