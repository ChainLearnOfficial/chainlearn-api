import type { FastifyRequest, FastifyReply } from "fastify";
import { UnauthorizedError } from "../utils/errors.js";
import { db } from "../config/database.js";
import { users } from "../database/schema.js";
import { eq } from "drizzle-orm";

/**
 * Extracts and verifies the JWT token, then loads the authenticated user.
 * Sets `request.authUser` on success.
 */
export async function authGuard(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const decoded = await request.jwtVerify<{
      sub: string; // user id
      stellarAddress: string;
    }>();

    const user = await db.query.users.findFirst({
      where: eq(users.id, decoded.sub),
    });

    if (!user) {
      throw new UnauthorizedError("User no longer exists");
    }

    (request as AuthenticatedRequest).authUser = {
      id: user.id,
      stellarAddress: user.stellarAddress,
    };
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    throw new UnauthorizedError("Invalid or expired token");
  }
}

/** Optional auth — populates user if token present, but does not reject. */
export async function optionalAuth(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  try {
    await authGuard(request, _reply);
  } catch {
    // silently ignore — endpoint is accessible without auth
  }
}

export interface AuthUser {
  id: string;
  stellarAddress: string;
}

export interface AuthenticatedRequest extends FastifyRequest {
  authUser: AuthUser;
}
