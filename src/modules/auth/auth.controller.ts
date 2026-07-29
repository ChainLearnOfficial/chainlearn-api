import crypto from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { authService } from "./auth.service.js";
import { revokeToken } from "../../middleware/auth.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { ChallengeBody, VerifyBody } from "./auth.types.js";

const JWT_TTL_SECONDS = 24 * 60 * 60; // must match the expiresIn below

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
   * Verify the signed challenge and return a JWT.
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
      { expiresIn: "24h" }
    );

    reply.send({
      success: true,
      data: {
        token,
        user: authResult.user,
      },
    });
  }

  /**
   * POST /api/auth/logout
   * Revoke the caller's current JWT by adding its jti to the Redis denylist.
   * The entry expires automatically when the token would have expired anyway.
   */
  async logout(
    request: FastifyRequest,
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

    reply.send({ success: true, data: { message: "Logged out successfully" } });
  }
}

export const authController = new AuthController();
