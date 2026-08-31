import crypto from "node:crypto";
import { redis } from "../../config/redis.js";
import { logger } from "../../utils/logger.js";
import { UnauthorizedError } from "../../utils/errors.js";

/**
 * Refresh-token issuance, rotation, single-use enforcement, and
 * reuse-detection for the SEP-10 auth flow (#275).
 *
 * Storage is Redis, matching the rest of the auth module: SEP-10 challenges
 * (auth.service.ts) and the JWT denylist (middleware/auth.ts) already keep
 * their state in Redis with a TTL and atomic single-use semantics, so a
 * refresh token — short-lived, single-use, revocable — belongs there too.
 * No Postgres table is involved.
 *
 * Raw refresh tokens are never persisted. Redis keys carry a SHA-256 of the
 * token, the same "store only an opaque derived value" approach the SEP-10
 * layer uses; a leaked Redis snapshot yields no usable token.
 */

// Access tokens stay at 24h (auth.controller.ts JWT_TTL_SECONDS). Refresh
// tokens live 7 days — long enough to survive a week of inactivity, short
// enough to bound the blast radius of a leaked token. Expressed as a
// module constant to match CHALLENGE_TTL_SECONDS / JWT_TTL_SECONDS; the
// config schema currently carries no expiry values.
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

// hash -> RefreshTokenRecord JSON. Deleted on first use (rotation).
const ACTIVE_PREFIX = "auth:refresh:active:";
// hash -> familyId. Written when a token is rotated; a later presentation of
// the same token hits this and is treated as a replay.
const CONSUMED_PREFIX = "auth:refresh:consumed:";
// familyId -> "1". Set when a family is burned (reuse detected, or logout).
const FAMILY_REVOKED_PREFIX = "auth:refresh:family-revoked:";

export interface RefreshTokenRecord {
  userId: string;
  stellarAddress: string;
  /** Shared by every token in one rotation lineage. Revoked as a unit. */
  familyId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedRefreshToken {
  /** Opaque token string — returned to the client once, never stored raw. */
  token: string;
  familyId: string;
  record: RefreshTokenRecord;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function mintInFamily(
  userId: string,
  stellarAddress: string,
  familyId: string,
): Promise<IssuedRefreshToken> {
  const token = crypto.randomBytes(32).toString("base64url");
  const issuedAt = nowSeconds();
  const record: RefreshTokenRecord = {
    userId,
    stellarAddress,
    familyId,
    issuedAt,
    expiresAt: issuedAt + REFRESH_TOKEN_TTL_SECONDS,
  };
  await redis.setex(
    `${ACTIVE_PREFIX}${hashToken(token)}`,
    REFRESH_TOKEN_TTL_SECONDS,
    JSON.stringify(record),
  );
  return { token, familyId, record };
}

/**
 * Issue a fresh refresh token that starts its own rotation family. Called
 * alongside the access token on a successful SEP-10 verify.
 */
export async function issueRefreshToken(
  userId: string,
  stellarAddress: string,
): Promise<IssuedRefreshToken> {
  return mintInFamily(userId, stellarAddress, crypto.randomUUID());
}

async function isFamilyRevoked(familyId: string): Promise<boolean> {
  return (await redis.get(`${FAMILY_REVOKED_PREFIX}${familyId}`)) !== null;
}

/**
 * Burn an entire rotation family. Every outstanding token in the lineage
 * stops working immediately; independent families (other devices/sessions)
 * are untouched.
 */
export async function revokeRefreshFamily(
  familyId: string,
  reason: string,
): Promise<void> {
  await redis.setex(
    `${FAMILY_REVOKED_PREFIX}${familyId}`,
    REFRESH_TOKEN_TTL_SECONDS,
    "1",
  );
  logger.info({ familyId, reason }, "Refresh token family revoked");
}

/**
 * Validate and atomically consume `token`, returning its stored record plus
 * a freshly minted replacement token in the same family.
 *
 * Single-use: the active key is removed with GETDEL, so two concurrent
 * refreshes cannot both succeed and a second call with the same token
 * finds nothing. A token that was already rotated once (present in the
 * consumed set) is a replay — the standard signal of a stolen token — and
 * trips revocation of the whole family before rejecting.
 */
export async function rotateRefreshToken(token: string): Promise<{
  record: RefreshTokenRecord;
  next: IssuedRefreshToken;
}> {
  const hash = hashToken(token);

  const raw = await redis.getdel(`${ACTIVE_PREFIX}${hash}`);
  if (!raw) {
    const familyId = await redis.get(`${CONSUMED_PREFIX}${hash}`);
    if (familyId) {
      await revokeRefreshFamily(familyId, "refresh-token-reuse");
      logger.warn(
        { familyId },
        "Refresh token reuse detected — revoking family",
      );
    }
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  let record: RefreshTokenRecord;
  try {
    record = JSON.parse(raw) as RefreshTokenRecord;
  } catch {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  if (await isFamilyRevoked(record.familyId)) {
    throw new UnauthorizedError("Refresh token has been revoked");
  }

  if (record.expiresAt <= nowSeconds()) {
    throw new UnauthorizedError("Invalid or expired refresh token");
  }

  // Remember this token as spent so a future replay is caught above. Kept
  // for a full TTL — long enough to still be around if a stolen copy is
  // presented late in the window.
  await redis.setex(
    `${CONSUMED_PREFIX}${hash}`,
    REFRESH_TOKEN_TTL_SECONDS,
    record.familyId,
  );

  const next = await mintInFamily(
    record.userId,
    record.stellarAddress,
    record.familyId,
  );
  return { record, next };
}

/**
 * Best-effort revoke of a single refresh token and its family. Used on
 * logout, where the client hands back the refresh token it holds. Silent if
 * the token is unknown — logout must not fail because a token was already
 * gone.
 */
export async function revokeRefreshToken(token: string): Promise<void> {
  const hash = hashToken(token);
  const raw = await redis.getdel(`${ACTIVE_PREFIX}${hash}`);
  if (!raw) return;
  try {
    const record = JSON.parse(raw) as RefreshTokenRecord;
    await revokeRefreshFamily(record.familyId, "logout");
  } catch {
    // Corrupt record — nothing more we can do, and logout still succeeds.
  }
}
