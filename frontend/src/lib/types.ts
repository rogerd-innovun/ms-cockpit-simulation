export type POStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'PROCESSING'
  | 'NEEDS_REVIEW'
  | 'EXTRACTION_FAILED'
  | 'APPROVED'
  | 'SENT_TO_SAP'
  | 'SO_CREATED'
  | 'FAILED'
  | 'CANCELLED';

export type Role = 'UPLOADER' | 'APPROVER' | 'OPERATIONS' | 'ADMIN';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface LineItem {
  id: string;
  lineNumber: number;
  materialCode: string | null;
  customerMaterialNumber: string | null;
  description: string | null;
  quantity: string | null;
  uom: string | null;
  unitPrice: string | null;
  lineNetValue: string | null;
  deliveryDate: string | null;
  plant: string | null;
}

export interface POHeader {
  id: string;
  poNumber: string | null;
  poDate: string | null;
  customerName: string | null;
  customerCode: string | null;
  shipTo: string | null;
  billTo: string | null;
  requestedDeliveryDate: string | null;
  currency: string | null;
  paymentTerms: string | null;
  incoterms: string | null;
  poTotalValue: string | null;
  contact: string | null;
  lineItems: LineItem[];
}

export interface PORecord {
  id: string;
  correlationId: string;
  status: POStatus;
  currentAttempt: number;
  vendorHint: string | null;
  notes: string | null;
  soNumber: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  statusChangedAt: string;
  sentToSapAt: string | null;
  createdAt: string;
  uploadedBy: { id: string; name: string; email: string };
  vendorProfile: { id: string; name: string; version: number } | null;
  sourceDocument: {
    originalFilename: string;
    byteSize: number;
    contentHash: string;
    pageCount: number | null;
  } | null;
  header: POHeader | null;
}

export interface FieldProvenance {
  fieldPath: string;
  extractedValue: string | null;
  confidence: number | null;
  lowConfidence: boolean;
  editedBy: { id: string; name: string } | null;
  editedAt: string | null;
}

export interface ValidationIssue {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  fieldPath: string;
  message: string;
  acknowledged: boolean;
}

export interface Submission {
  id: string;
  attempt: number;
  approvedAt: string;
  approvedBy: { id: string; name: string };
  outboundFilename: string | null;
  writtenAt: string | null;
  writeError: string | null;
  checksum: string | null;
  byteSize: number | null;
}

export interface SapResultRow {
  id: string;
  attempt: number | null;
  outcome: 'SUCCESS' | 'ERROR';
  soNumber: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  sourceFilename: string;
  ingestedAt: string;
  rawContent: string;
}

export interface AuditRow {
  id: string;
  eventType: string;
  message: string | null;
  timestamp: string;
  actorName: string | null;
  actor: { id: string; name: string } | null;
}

export interface MappedFailure {
  code: string;
  explanation: string;
  remedy: string;
  fieldHint?: string;
}

export interface RecordDetail {
  record: PORecord;
  fields: FieldProvenance[];
  validation: {
    threshold: number;
    issues: ValidationIssue[];
    blockingCount: number;
  };
  submissions: Submission[];
  results: SapResultRow[];
  audit: AuditRow[];
  failure: MappedFailure | null;
  duplicates: { recordId: string; correlationId: string; status: POStatus; matchedOn: string }[];
  allowedTransitions: POStatus[];
  statusLabel: string;
}

export interface WorklistRow {
  id: string;
  correlationId: string;
  status: POStatus;
  currentAttempt: number;
  soNumber: string | null;
  failureCode: string | null;
  statusChangedAt: string;
  createdAt: string;
  uploadedBy: { id: string; name: string };
  sourceDocument: { originalFilename: string; pageCount: number | null } | null;
  header: {
    poNumber: string | null;
    customerName: string | null;
    customerCode: string | null;
    poTotalValue: string | null;
    currency: string | null;
    _count: { lineItems: number };
  } | null;
}
