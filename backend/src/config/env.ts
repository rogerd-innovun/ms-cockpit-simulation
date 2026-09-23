import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? d : v === 'true' || v === '1' || v === 'on'));

const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number(v)))
    .pipe(z.number().int().nonnegative());

const num = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number(v)))
    .pipe(z.number());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: int(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().default('dev-only-insecure-secret'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // FR-1 storage
  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: int(20 * 1024 * 1024),

  // FR-4 extraction
  EXTRACTION_PROVIDER: z.enum(['gemini', 'mock']).default('gemini'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  EXTRACTION_TIMEOUT_MS: int(120_000),
  EXTRACTION_MAX_ATTEMPTS: int(3),
  EXTRACTION_POLL_MS: int(2000),
  CONFIDENCE_THRESHOLD: num(0.85),

  // FR-7.11 (OQ-01) — may the uploader approve their own record?
  SOD_REQUIRE_SEPARATE_APPROVER: bool(true),
  // FR-3.4 (OQ-02) — duplicate policy: warn | block
  DUPLICATE_POLICY: z.enum(['warn', 'block']).default('warn'),

  // FR-9 / FR-10 integration — IC-10: paths are configuration, never hard-coded
  INTEGRATION_ROOT: z.string().default('./integration'),
  COMPLETENESS_CONVENTION: z.enum(['rename', 'done_marker']).default('done_marker'),
  CSV_LAYOUT: z.enum(['single_file', 'header_lines_pair']).default('single_file'),
  CSV_DELIMITER: z.string().default(','),
  /** IC-07 — does the existing SAP job expect a column-name row? (OQ-03) */
  CSV_HEADER_ROW: bool(false),
  SAP_RESULT_POLL_MS: int(3000),
  SAP_SLA_TIMEOUT_MS: int(60 * 60 * 1000),

  // Workers
  WORKERS_ENABLED: bool(true),

  /**
   * Serve the built SPA from the API process when set. Used by the single-container
   * deployment so the UI and the API share an origin and CORS never applies.
   * Unset in local development, where Vite serves the UI and proxies /api.
   */
  WEB_ROOT: z.string().optional(),

  // SAP simulator
  SAP_SIM_POLL_MS: int(2000),
  SAP_SIM_PROCESSING_MS: int(4000),
  SAP_SIM_FAILURE_RATE: num(0.15),
  /**
   * The simulator invents Sales Order numbers. That is correct for a demo and
   * catastrophic against anything real, so it refuses to start when
   * NODE_ENV=production unless this is explicitly turned on.
   */
  SAP_SIM_ALLOW_IN_PRODUCTION: bool(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const raw = parsed.data;
const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));

const integrationRoot = resolve(raw.INTEGRATION_ROOT);

export const env = {
  ...raw,
  STORAGE_ROOT: resolve(raw.STORAGE_ROOT),
  INTEGRATION_ROOT: integrationRoot,
  WEB_ROOT: raw.WEB_ROOT ? resolve(raw.WEB_ROOT) : undefined,
  paths: {
    documents: path.join(resolve(raw.STORAGE_ROOT), 'documents'),
    // docs/01-requirements.md §8.4
    outbound: path.join(integrationRoot, 'outbound'),
    // IC-11: staging must share a filesystem with outbound for the rename to be atomic
    staging: path.join(integrationRoot, 'outbound', '.staging'),
    inbound: path.join(integrationRoot, 'inbound'),
    archive: path.join(integrationRoot, 'inbound', 'archive'),
    quarantine: path.join(integrationRoot, 'inbound', 'quarantine'),
  },
} as const;

export type Env = typeof env;
