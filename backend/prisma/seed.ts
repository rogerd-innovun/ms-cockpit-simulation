import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seed users cover the segregation-of-duties case (FR-7.11): with
 * SOD_REQUIRE_SEPARATE_APPROVER=true, clerk@ uploads and approver@ approves.
 */
const USERS = [
  { email: 'clerk@cockpit.local', name: 'Clerk (Uploader)', role: 'UPLOADER' as const },
  { email: 'approver@cockpit.local', name: 'Approver', role: 'APPROVER' as const },
  { email: 'ops@cockpit.local', name: 'Operations', role: 'OPERATIONS' as const },
  { email: 'admin@cockpit.local', name: 'Administrator', role: 'ADMIN' as const },
];

/** FR-4.1 — example vendor profiles. Prompts are data, not code (NFR-6.1). */
const PROFILES = [
  {
    name: 'Mock Industries GmbH',
    identificationHints: { markers: ['Mock Industries', 'DE123456789'] },
    extractionPrompt: [
      '- The PO number is printed top-right, labelled "Bestellnummer", and always starts with "MI-".',
      '- Dates are written DD.MM.YYYY. Return them exactly as printed; do not convert to ISO.',
      '- Amounts use "." as the thousands separator and "," as the decimal separator.',
      '- The line item table has columns: Pos. | Artikelnr. | Bezeichnung | Menge | ME | Preis | Betrag.',
      '- "Artikelnr." is the customer material number, NOT our material code. Our material code appears in the Bezeichnung cell in brackets, e.g. "(MAT-1234)".',
      '- The final table row labelled "Gesamtsumme" is the order total, not a line item.',
    ].join('\n'),
  },
  {
    name: 'Northwind Trading Ltd',
    identificationHints: { markers: ['Northwind Trading', 'GB987654321'] },
    extractionPrompt: [
      '- The PO number is labelled "Order Ref" in the header block.',
      '- Dates are DD/MM/YYYY.',
      '- Line items continue across pages under a repeated column header; do not treat the repeated header as a line.',
      '- The "Code" column is our material code. The "UOM" column uses EA, BOX, PAL.',
      '- Rows labelled "Carriage" or "Handling" are charges, not materials — exclude them from lineItems.',
    ].join('\n'),
  },
];

async function main() {
  const passwordHash = await bcrypt.hash('cockpit123', 10);

  for (const user of USERS) {
    await prisma.user.upsert({
      where: { email: user.email },
      create: { ...user, passwordHash },
      update: { name: user.name, role: user.role },
    });
  }

  for (const profile of PROFILES) {
    await prisma.vendorProfile.upsert({
      where: { name_version: { name: profile.name, version: 1 } },
      create: { ...profile, version: 1, active: true },
      update: { extractionPrompt: profile.extractionPrompt, identificationHints: profile.identificationHints },
    });
  }

  console.log(`Seeded ${USERS.length} users and ${PROFILES.length} vendor profiles.`);
  console.log('All seeded users share the password: cockpit123');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
