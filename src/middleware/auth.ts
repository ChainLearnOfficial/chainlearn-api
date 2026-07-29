import type { FastifyRequest, FastifyReply } from "fastify";
import { UnauthorizedError } from "../utils/errors.js";
import { db } from "../config/database.js";
import { users } from "../database/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger.js";

/**
 * Extracts and verifies the JWT token, then loads the authenticated user.
 * Sets `request.authUser` on success.
 *
 * Only JWT verification errors are converted to 401 — infrastructure errors
 * (e.g. database outage) propagate so the caller receives a 500, not a
 * misleading "invalid token" response.
 */
export async function authGuard(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let decoded: { sub: string; stellarAddress: string };
  try {
    decoded = await request.jwtVerify<{
      sub: string;
      stellarAddress: string;
    }>();
  } catch {
    throw new UnauthorizedError("Invalid or expired token");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, decoded.sub),
  });

    // Validate that the stellarAddress in the JWT matches the database record
    // This provides defense-in-depth against token forgery scenarios
    if (decoded.stellarAddress !== user.stellarAddress) {
      throw new UnauthorizedError("Token stellarAddress mismatch");
    }

    (request as AuthenticatedRequest).authUser = {
      id: user.id,
      stellarAddress: user.stellarAddress,
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid or expired token");
  if (!user) {
    throw new UnauthorizedError("User no longer exists");
  }

  (request as AuthenticatedRequest).authUser = {
    id: user.id,
    stellarAddress: user.stellarAddress,
  };
}

/** Optional auth — populates user if token present, but does not reject.
 *  UnauthorizedError is swallowed; infrastructure errors propagate. */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  try {
    await authGuard(request, _reply);
  } catch (err) {
    if (err instanceof UnauthorizedError) return;
    logger.warn({ err }, "optionalAuth: unexpected infrastructure error");
    throw err;
  }
}

export interface AuthUser {
  id: string;
  stellarAddress: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  authUser: AuthUser;
}
