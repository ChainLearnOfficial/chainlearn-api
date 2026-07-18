import type { FastifyRequest, FastifyReply } from "fastify";
import { credentialService } from "./credential.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { MintCredentialBody } from "./credential.types.js";
import {
  checkIdempotency,
  storeIdempotentResponse,
} from "../../middleware/idempotency.js";

export class CredentialController {
  /**
   * POST /api/credentials/mint
   * Mint a course completion NFT credential.
   */
  async mint(
    request: FastifyRequest<{ Body: MintCredentialBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const { courseId, submissionId, idempotencyKey } = (request as any).validatedBody;

    const { cached, response } = await checkIdempotency(
      idempotencyKey,
      authUser.id,
      "/credentials/mint",
      request.body
    );

    if (cached) {
      reply.status(response!.status).send(response!.body);
      return;
    }

    try {
      const result = await credentialService.mint(
        authUser.id,
        courseId,
        submissionId
      );

      await storeIdempotentResponse(
        idempotencyKey,
        201,
        { success: true, data: result },
        result.mintTxHash
      );

      reply.status(201).send({ success: true, data: result });
    } catch (err: unknown) {
      const statusCode =
        err && typeof err === "object" && "statusCode" in err
          ? (err as { statusCode: number }).statusCode
          : 500;
      const message =
        err instanceof Error ? err.message : "Internal server error";

      await storeIdempotentResponse(idempotencyKey, statusCode, {
        success: false,
        error: message,
      });

      throw err;
    }
  }

  /**
   * GET /api/credentials
   * List credentials for the authenticated user.
   */
  async list(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const creds = await credentialService.list(authUser.id);

    reply.send({ success: true, data: creds });
  }
}

export const credentialController = new CredentialController();
