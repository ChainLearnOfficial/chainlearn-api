import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../config/database.js";
import { sessions } from "../../database/schema.js";
import { NotFoundError } from "../../utils/errors.js";
import { revokeToken } from "../../middleware/auth.js";
import { logger } from "../../utils/logger.js";

// Must cover the longest a session's JWT can still be valid, so a revoked
// session's token is blacklisted for at least as long as it could have
// otherwise been presented. Matches auth.controller.ts's ACCESS_TOKEN_EXPIRES_IN.
const JWT_TTL_SECONDS = 24 * 60 * 60;

export interface SessionSummary {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  lastActive: Date;
  createdAt: Date;
  /** True when this row corresponds to the token used for the current request. */
  current: boolean;
}

export class SessionService {
  /**
   * Upserts the session row for the given token (jti). Called from
   * authGuard on every authenticated request so `lastActive` stays current.
   * Best-effort — a tracking failure must not fail the request itself.
   */
  async track(
    userId: string,
    tokenId: string,
    deviceInfo: string | null,
    ipAddress: string | null,
  ): Promise<void> {
    try {
      await db
        .insert(sessions)
        .values({ userId, tokenId, deviceInfo, ipAddress })
        .onConflictDoUpdate({
          target: sessions.tokenId,
          set: { lastActive: new Date(), deviceInfo, ipAddress },
        });
    } catch (err) {
      logger.warn({ err, userId }, "Failed to track session");
    }
  }

  /** Lists the caller's active (non-revoked) sessions, most recently active first. */
  async listSessions(userId: string, currentTokenId?: string): Promise<SessionSummary[]> {
    const rows = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.lastActive));

    return rows.map((row) => ({
      id: row.id,
      deviceInfo: row.deviceInfo,
      ipAddress: row.ipAddress,
      lastActive: row.lastActive,
      createdAt: row.createdAt,
      current: row.tokenId === currentTokenId,
    }));
  }

  /**
   * Revoke a single session owned by `userId`. Marks the row revoked and
   * blacklists its token immediately (via the same Redis denylist authGuard
   * checks), so the session cannot be used again even though its JWT
   * hasn't naturally expired yet.
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));

    if (!session || session.revokedAt) {
      throw new NotFoundError("Session");
    }

    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, sessionId));

    await revokeToken(session.tokenId, JWT_TTL_SECONDS);

    logger.info({ userId, sessionId }, "Session revoked");
  }
}

export const sessionService = new SessionService();
