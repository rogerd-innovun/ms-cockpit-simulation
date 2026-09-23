/**
 * FR-10.3 / docs/01-requirements.md §8.3 — PROVISIONAL until OQ-05 closes.
 *
 * Accepts the CSV form from §8.3 and a JSON form, because which one the existing SAP
 * job emits is still an open question and guessing wrong in only one direction is
 * cheap to absorb here.
 */
export interface ParsedResult {
  correlationId: string;
  attempt: number | null;
  outcome: 'SUCCESS' | 'ERROR';
  soNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sapTimestamp: string | null;
}

export class ResultParseError extends Error {}

const clean = (v: string | undefined): string | null => {
  if (v === undefined) return null;
  const s = v.trim().replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim();
  return s === '' ? null : s;
};

function splitCsvLine(line: string, delimiter = ','): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

export function parseResultFile(filename: string, content: string): ParsedResult {
  const trimmed = content.trim();
  if (!trimmed) throw new ResultParseError('Result file is empty.');

  const raw = filename.toLowerCase().endsWith('.json')
    ? parseJson(trimmed)
    : parseCsv(trimmed);

  if (!raw.correlationId) {
    throw new ResultParseError('Result file has no CORRELATION_ID.');
  }
  if (raw.outcome !== 'SUCCESS' && raw.outcome !== 'ERROR') {
    throw new ResultParseError(`Unrecognised STATUS "${raw.outcome ?? ''}"; expected SUCCESS or ERROR.`);
  }
  // A success with no SO number is not a success we can act on — treat it as malformed
  // rather than marking a record SO_CREATED with nothing to show for it.
  if (raw.outcome === 'SUCCESS' && !raw.soNumber) {
    throw new ResultParseError('Result reports SUCCESS but carries no SO_NUMBER.');
  }

  return {
    correlationId: raw.correlationId,
    attempt: raw.attempt != null && Number.isFinite(Number(raw.attempt)) ? Number(raw.attempt) : null,
    outcome: raw.outcome,
    soNumber: raw.soNumber ?? null,
    errorCode: raw.errorCode ?? null,
    errorMessage: raw.errorMessage ?? null,
    sapTimestamp: raw.sapTimestamp ?? null,
  };
}

interface RawResult {
  correlationId: string | null;
  attempt: string | null;
  outcome: string | null;
  soNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sapTimestamp: string | null;
}

function parseCsv(content: string): RawResult {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) {
    throw new ResultParseError('Result CSV needs a header row and at least one data row.');
  }
  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toUpperCase());
  const cells = splitCsvLine(lines[1]!);
  const get = (name: string) => {
    const idx = headers.indexOf(name);
    return idx === -1 ? null : clean(cells[idx]);
  };
  return {
    correlationId: get('CORRELATION_ID'),
    attempt: get('ATTEMPT'),
    outcome: get('STATUS')?.toUpperCase() ?? null,
    soNumber: get('SO_NUMBER'),
    errorCode: get('ERROR_CODE'),
    errorMessage: get('ERROR_MESSAGE'),
    sapTimestamp: get('SAP_TIMESTAMP'),
  };
}

function parseJson(content: string): RawResult {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new ResultParseError('Result file is not valid JSON.');
  }
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
  return {
    correlationId: pick('CORRELATION_ID', 'correlationId'),
    attempt: pick('ATTEMPT', 'attempt'),
    outcome: pick('STATUS', 'status', 'outcome')?.toUpperCase() ?? null,
    soNumber: pick('SO_NUMBER', 'soNumber'),
    errorCode: pick('ERROR_CODE', 'errorCode'),
    errorMessage: pick('ERROR_MESSAGE', 'errorMessage'),
    sapTimestamp: pick('SAP_TIMESTAMP', 'sapTimestamp'),
  };
}
