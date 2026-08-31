import { logger } from "../utils/logger.js";
import { db } from "../config/database.js";
import { auditLogs } from "../database/schema.js";
import { getRequestId } from "../utils/request-context.js";

type AuditEvent =
  | "quiz.submitted"
  | "quiz.retried"
  | "reward.claimed"
  | "reward.queued"
  | "reward.pending_confirmation"
  | "credential.minted"
  | "auth.login"
  | "auth.login_failed"
  | "course.enrolled"
  | "course.shared"
  | "course.referral_enrolled"
  | "course.created"
  | "course.updated"
  | "course.deleted"
  | "course.published"
  | "course.duplicated"
  | "course.reviewed"
  | "user.account_deleted"
  | "user.data_exported"
  | "course.module.created"
  | "course.module.updated"
  | "course.module.deleted"
  | "course.waitlist.joined"
  | "course.waitlist.left"
  | "webhook.created"
  | "webhook.updated"
  | "webhook.deleted"
  | "webhook.secret_rotated";

interface AuditFields {
  userId?: string;
  submissionId?: string;
  credentialId?: string;
  courseId?: string;
  moduleId?: string;
  txHash?: string | null;
  amount?: number;
  score?: number;
  total?: number;
  passed?: boolean;
  queued?: boolean;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  contentHashMatch?: boolean;
  onChainContentHash?: string | null;
  storedContentHash?: string | null;
  webhookId?: string;
  position?: number;
  previousPosition?: number;
  url?: string;
  events?: string[];
  changes?: string[];
  rating?: number;
  sourceCourseId?: string;
}

export async function auditLog(event: AuditEvent, fields: AuditFields): Promise<void> {
  const auditFields = { requestId: getRequestId(), ...fields };
  logger.info({ audit: true, event, ...auditFields }, `audit: ${event}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.insert(auditLogs).values({ event, fields: auditFields });
      return;
    } catch (err) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        continue;
      }
      logger.error({ err }, "Failed to persist audit log after 3 attempts");
      process.stdout.write(
        JSON.stringify({ audit: true, event, ...auditFields, persistError: String(err) }) + "\n",
      );
    }
  }
}
