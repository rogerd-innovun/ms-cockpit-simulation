import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  // SourceDocument.content holds the PDF bytes (megabytes per row). Omit it globally
  // so it never rides along on worklist/detail queries or gets serialised into JSON
  // responses; the few readers that need the bytes select it explicitly.
  omit: { sourceDocument: { content: true } },
});

export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
