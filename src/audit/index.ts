import { logger } from "../utils/logger.js";

type AuditEvent =
  | "quiz.submitted"
  | "reward.claimed"
  | "reward.queued"
  | "credential.minted"
  | "auth.login"
  | "auth.login_failed";

interface AuditFields {
  userId?: string;
  submissionId?: string;
  credentialId?: string;
  courseId?: string;
  txHash?: string | null;
  amount?: number;
  score?: number;
  total?: number;
  passed?: boolean;
  queued?: boolean;
  ip?: string;
  userAgent?: string;
  [key: string]: unknown;
}

export function auditLog(event: AuditEvent, fields: AuditFields): void {
  logger.info({ audit: true, event, ...fields }, `audit: ${event}`);
}
