import { logger } from "../utils/logger.js";
import { db } from "../config/database.js";
import { auditLogs } from "../database/schema.js";
import { config } from "../config/index.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AuditEvent =
  | "quiz.submitted"
  | "reward.claimed"
  | "reward.queued"
  | "reward.pending_confirmation"
  | "credential.minted"
  | "auth.login"
  | "auth.login_failed"
  | "admin.credits.deducted"
  | "admin.credits.granted";

export interface AuditFields {
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
  stellarAddress?: string;
  previousCredits?: number;
  newCredits?: number;
  reason?: string;
  adminNote?: string;
}

interface AuditEntry {
  event: AuditEvent;
  fields: AuditFields;
  timestamp: Date;
}

// ─── AuditLogger ─────────────────────────────────────────────────────────────

/**
 * Non-blocking, buffered audit logger.
 *
 * Entries are accumulated in an in-memory buffer. The buffer is flushed to the
 * database either:
 *   a) periodically, every AUDIT_FLUSH_INTERVAL_MS milliseconds, or
 *   b) immediately when the buffer reaches AUDIT_BUFFER_SIZE entries.
 *
 * The public `log()` method is synchronous and returns immediately — callers
 * are never blocked or slowed by database latency. Flush errors are logged as
 * warnings and never propagate to callers.
 *
 * Lifecycle:
 *   `start()` — arms the periodic flush timer (called once at server start)
 *   `stop()`  — clears the timer and awaits a final flush of buffered entries
 *               (called during graceful shutdown before the DB connection closes)
 */
class AuditLogger {
  private buffer: AuditEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Guards against concurrent flush calls racing to drain the same buffer.
   * Without this, two simultaneous flushes (e.g. timer fires while a
   * capacity-triggered flush is in progress) could each splice the same
   * slice and attempt to insert duplicate rows.
   */
  private flushing = false;

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    if (this.timer !== null) return; // idempotent
    this.timer = setInterval(
      () => void this.flush(),
      config.AUDIT_FLUSH_INTERVAL_MS,
    );
    // setInterval keeps the event loop alive by design; unref() lets Node.js
    // exit normally even if the timer is still armed — the explicit stop()
    // call in the shutdown path will drain buffered entries first.
    this.timer.unref();
    logger.info(
      {
        flushIntervalMs: config.AUDIT_FLUSH_INTERVAL_MS,
        bufferSize: config.AUDIT_BUFFER_SIZE,
      },
      "Audit logger started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    logger.info("Audit logger stopped");
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Enqueue an audit entry. Synchronous and non-blocking — returns immediately.
   * Also emits a structured log line so the entry is visible in log streams
   * even before it is persisted.
   */
  log(event: AuditEvent, fields: AuditFields): void {
    logger.info({ audit: true, event, ...fields }, `audit: ${event}`);

    this.buffer.push({ event, fields, timestamp: new Date() });

    if (this.buffer.length >= config.AUDIT_BUFFER_SIZE) {
      // Trigger an early flush without awaiting — callers must not block.
      void this.flush();
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Drain the buffer and write all pending entries to the database in a
   * single INSERT. Safe to call concurrently — re-entrant calls are dropped
   * while a flush is already in progress.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;

    this.flushing = true;
    // Splice the entire buffer atomically so new entries queued during an
    // in-progress flush land in the next cycle rather than being lost.
    const entries = this.buffer.splice(0);

    try {
      await db.insert(auditLogs).values(
        entries.map((e) => ({ event: e.event, fields: e.fields })),
      );
    } catch (err) {
      logger.warn(
        { err, count: entries.length },
        "Audit log flush failed — entries dropped",
      );
      // Entries are intentionally not re-queued: re-queuing on failure risks
      // unbounded buffer growth if the database is persistently unavailable,
      // and audit log loss is preferable to OOM or cascading failures in the
      // main application path. The structured log line emitted by log() above
      // provides a secondary record in the log stream.
    } finally {
      this.flushing = false;
    }
  }
}

// ─── Singleton & exports ──────────────────────────────────────────────────────

export const auditLogger = new AuditLogger();

/**
 * Convenience wrapper used by all call sites in the codebase.
 * Delegates to the singleton logger — synchronous and non-blocking.
 */
export function auditLog(event: AuditEvent, fields: AuditFields): void {
  auditLogger.log(event, fields);
}

export function startAuditLogger(): void {
  auditLogger.start();
}

export async function stopAuditLogger(): Promise<void> {
  await auditLogger.stop();
}
