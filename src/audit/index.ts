import { logger } from "../utils/logger.js";
import { db } from "../config/database.js";
import { auditLogs } from "../database/schema.js";

type AuditEvent =
  | "quiz.submitted"
  | "reward.claimed"
  | "reward.queued"
  | "reward.pending_confirmation"
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
}

export function auditLog(event: AuditEvent, fields: AuditFields): void {
  logger.info({ audit: true, event, ...fields }, `audit: ${event}`);
  db.insert(auditLogs).values({ event, fields }).catch((err) => logger.error({ err }, "Failed to persist audit log"));
}
