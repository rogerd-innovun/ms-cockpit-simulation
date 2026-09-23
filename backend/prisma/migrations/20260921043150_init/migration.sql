-- CreateEnum
CREATE TYPE "Role" AS ENUM ('UPLOADER', 'APPROVER', 'OPERATIONS', 'ADMIN');

-- CreateEnum
CREATE TYPE "POStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'PROCESSING', 'NEEDS_REVIEW', 'EXTRACTION_FAILED', 'APPROVED', 'SENT_TO_SAP', 'SO_CREATED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExtractionOutcome" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "SapOutcome" AS ENUM ('SUCCESS', 'ERROR');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('BLOCKING', 'WARNING');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PORecord" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "status" "POStatus" NOT NULL DEFAULT 'DRAFT',
    "currentAttempt" INTEGER NOT NULL DEFAULT 0,
    "vendorHint" TEXT,
    "notes" TEXT,
    "uploadedById" TEXT NOT NULL,
    "vendorProfileId" TEXT,
    "soNumber" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentToSapAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PORecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "pageCount" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionRun" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "vendorProfileId" TEXT,
    "outcome" "ExtractionOutcome" NOT NULL DEFAULT 'PENDING',
    "latencyMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "rawResponse" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POHeader" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "poNumber" TEXT,
    "poDate" TEXT,
    "customerName" TEXT,
    "customerCode" TEXT,
    "shipTo" TEXT,
    "billTo" TEXT,
    "requestedDeliveryDate" TEXT,
    "currency" TEXT,
    "paymentTerms" TEXT,
    "incoterms" TEXT,
    "poTotalValue" TEXT,
    "contact" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "POHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "POLineItem" (
    "id" TEXT NOT NULL,
    "headerId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "materialCode" TEXT,
    "customerMaterialNumber" TEXT,
    "description" TEXT,
    "quantity" TEXT,
    "uom" TEXT,
    "unitPrice" TEXT,
    "lineNetValue" TEXT,
    "deliveryDate" TEXT,
    "plant" TEXT,

    CONSTRAINT "POLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldExtraction" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "extractedValue" TEXT,
    "confidence" DOUBLE PRECISION,
    "sourcePage" INTEGER,
    "sourceBBox" JSONB,
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "FieldExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "identificationHints" JSONB NOT NULL,
    "extractionPrompt" TEXT NOT NULL,
    "fieldMappings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "approvedById" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedSnapshot" JSONB NOT NULL,
    "outboundFilename" TEXT,
    "outboundPath" TEXT,
    "byteSize" INTEGER,
    "checksum" TEXT,
    "writtenAt" TIMESTAMP(3),
    "writeError" TEXT,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SapResult" (
    "id" TEXT NOT NULL,
    "recordId" TEXT,
    "correlationId" TEXT NOT NULL,
    "attempt" INTEGER,
    "outcome" "SapOutcome" NOT NULL,
    "soNumber" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "sapTimestamp" TEXT,
    "rawContent" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantineReason" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SapResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ValidationAck" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL,
    "acknowledgedById" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationAck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "recordId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT,
    "before" JSONB,
    "after" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PORecord_correlationId_key" ON "PORecord"("correlationId");

-- CreateIndex
CREATE INDEX "PORecord_status_idx" ON "PORecord"("status");

-- CreateIndex
CREATE INDEX "PORecord_uploadedById_idx" ON "PORecord"("uploadedById");

-- CreateIndex
CREATE INDEX "PORecord_createdAt_idx" ON "PORecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SourceDocument_recordId_key" ON "SourceDocument"("recordId");

-- CreateIndex
CREATE INDEX "SourceDocument_contentHash_idx" ON "SourceDocument"("contentHash");

-- CreateIndex
CREATE INDEX "ExtractionRun_recordId_idx" ON "ExtractionRun"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionRun_recordId_attempt_key" ON "ExtractionRun"("recordId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "POHeader_recordId_key" ON "POHeader"("recordId");

-- CreateIndex
CREATE INDEX "POLineItem_headerId_idx" ON "POLineItem"("headerId");

-- CreateIndex
CREATE UNIQUE INDEX "POLineItem_headerId_lineNumber_key" ON "POLineItem"("headerId", "lineNumber");

-- CreateIndex
CREATE INDEX "FieldExtraction_recordId_idx" ON "FieldExtraction"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldExtraction_recordId_fieldPath_key" ON "FieldExtraction"("recordId", "fieldPath");

-- CreateIndex
CREATE UNIQUE INDEX "VendorProfile_name_version_key" ON "VendorProfile"("name", "version");

-- CreateIndex
CREATE INDEX "Submission_recordId_idx" ON "Submission"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_recordId_attempt_key" ON "Submission"("recordId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "SapResult_sourceFilename_key" ON "SapResult"("sourceFilename");

-- CreateIndex
CREATE INDEX "SapResult_correlationId_idx" ON "SapResult"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "ValidationAck_recordId_code_fieldPath_key" ON "ValidationAck"("recordId", "code", "fieldPath");

-- CreateIndex
CREATE INDEX "AuditEvent_recordId_timestamp_idx" ON "AuditEvent"("recordId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_eventType_idx" ON "AuditEvent"("eventType");

-- AddForeignKey
ALTER TABLE "PORecord" ADD CONSTRAINT "PORecord_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PORecord" ADD CONSTRAINT "PORecord_vendorProfileId_fkey" FOREIGN KEY ("vendorProfileId") REFERENCES "VendorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceDocument" ADD CONSTRAINT "SourceDocument_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionRun" ADD CONSTRAINT "ExtractionRun_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POHeader" ADD CONSTRAINT "POHeader_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "POLineItem" ADD CONSTRAINT "POLineItem_headerId_fkey" FOREIGN KEY ("headerId") REFERENCES "POHeader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldExtraction" ADD CONSTRAINT "FieldExtraction_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldExtraction" ADD CONSTRAINT "FieldExtraction_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SapResult" ADD CONSTRAINT "SapResult_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationAck" ADD CONSTRAINT "ValidationAck_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationAck" ADD CONSTRAINT "ValidationAck_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "PORecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
