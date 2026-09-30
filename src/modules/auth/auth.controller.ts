import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { authService } from "./auth.service.js";
import {
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} from "./refresh-token.service.js";
import { revokeToken } from "../../middleware/auth.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import { sessionService } from "./session.service.js";
import { logger } from "../../utils/logger.js";
import type {
  ChallengeBody,
  VerifyBody,
  RefreshBody,
  LogoutBody,
  SessionIdParams,
} from "./auth.types.js";

const JWT_TTL_SECONDS = 24 * 60 * 60; // must match the expiresIn below
const ACCESS_TOKEN_EXPIRES_IN = "24h";

export class AuthController {
  /**
   * POST /api/auth/challenge
   * Generate a SEP-10 challenge for wallet authentication.
   */
  async challenge(
    request: FastifyRequest<{ Body: ChallengeBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { stellarAddress } = request.body;
    const result = await authService.createChallenge(stellarAddress);

    reply.send({
      success: true,
      data: result,
    });
  }

  /**
   * POST /api/auth/verify
   * Verify the signed challenge and return an access token + refresh token.
   */
  async verify(
    request: FastifyRequest<{ Body: VerifyBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { stellarAddress, challengeId, signedChallenge } = request.body;

    const authResult = await authService.verifyChallenge(
      stellarAddress,
      challengeId,
      signedChallenge
    );

    // Generate JWT — jti enables per-token revocation via the Redis denylist.
    const token = request.server.jwt.sign(
      {
        sub: authResult.user.id,
        stellarAddress: authResult.user.stellarAddress,
        jti: crypto.randomUUID(),
      },
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );

    // Issue a refresh token alongside it. Starts its own rotation family so
    // this login can be revoked independently of the user's other sessions.
    const refresh = await issueRefreshToken(
      authResult.user.id,
      authResult.user.stellarAddress
    );

    reply.send({
      success: true,
      data: {
        token,
        refreshToken: refresh.token,
        user: authResult.user,
      },
    });
  }

  /**
   * POST /api/auth/refresh
   * Exchange a valid refresh token for a new access token. The refresh token
   * is single-use: it is invalidated here and a new one is returned in its
   * place (rotation). Replaying an already-used token burns the whole family.
   */
  async refresh(
    request: FastifyRequest<{ Body: RefreshBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { refreshToken } = request.body;

    const { record, next } = await rotateRefreshToken(refreshToken);

    const token = request.server.jwt.sign(
      {
        sub: record.userId,
        stellarAddress: record.stellarAddress,
        jti: crypto.randomUUID(),
      },
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );

    reply.send({
      success: true,
      data: {
        token,
        refreshToken: next.token,
      },
    });
  }

  /**
   * POST /api/auth/logout
   * Revoke the caller's current JWT by adding its jti to the Redis denylist.
   * The entry expires automatically when the token would have expired anyway.
   *
   * If the client also sends its `refreshToken`, that token's rotation family
   * is revoked too, so this device's session cannot be resumed via refresh.
   * Other devices (separate families) are unaffected.
   */
  async logout(
    request: FastifyRequest<{ Body: LogoutBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const decoded = request.user as {
      jti?: string;
      exp?: number;
    };

    if (decoded?.jti) {
      const now = Math.floor(Date.now() / 1000);
      const remainingTtl = decoded.exp ? Math.max(decoded.exp - now, 1) : JWT_TTL_SECONDS;
      await revokeToken(decoded.jti, remainingTtl);
    }

    const refreshToken = request.body?.refreshToken;
    if (refreshToken) {
      // Best-effort: a failure here must not fail the logout itself.
      await revokeRefreshToken(refreshToken).catch((err) =>
        logger.warn({ err }, "logout: failed to revoke refresh token")
      );
    }

    reply.send({ success: true, data: { message: "Logged out successfully" } });
  }

  /**
   * GET /api/v1/auth/sessions
   * List the caller's active sessions with device info and last activity.
   */
  async listSessions(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const decoded = request.user as { jti?: string };

    const sessions = await sessionService.listSessions(authUser.id, decoded?.jti);

    reply.send({ success: true, data: sessions });
  }

  /**
   * DELETE /api/v1/auth/sessions/:sessionId
   * Revoke one of the caller's sessions. Its token is blacklisted
   * immediately, on top of the session row being marked revoked.
   */
  async revokeSession(
    request: FastifyRequest<{ Params: SessionIdParams }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { sessionId } = request.params;

    await sessionService.revokeSession(authUser.id, sessionId);

    reply.send({ success: true, message: "Session revoked" });
  }
}

export const authController = new AuthController();
