import type { FastifyRequest, FastifyReply } from "fastify";
import { authService } from "./auth.service.js";
import type { ChallengeBody, VerifyBody } from "./auth.types.js";

export class AuthController {
  /**
   * POST /api/auth/challenge
   * Generate a SEP-10 challenge for wallet authentication.
   */
  async challenge(
    request: FastifyRequest<{ Body: ChallengeBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { stellarAddress } = (request as any).validatedBody;
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
    const { stellarAddress, signedChallenge } = (request as any).validatedBody;

    const authResult = await authService.verifyChallenge(
      stellarAddress,
      signedChallenge
    );

    // Generate JWT
    const token = request.server.jwt.sign(
      {
        sub: authResult.user.id,
        stellarAddress: authResult.user.stellarAddress,
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
}

export const authController = new AuthController();
