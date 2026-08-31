import type { FastifyRequest, FastifyReply } from "fastify";
import { credentialService } from "./credential.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type {
  BatchMintCredentialBody,
  MintCredentialBody,
} from "./credential.types.js";
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
    const { courseId, submissionId, idempotencyKey } = request.body;

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
        authUser.id,
        "/credentials/mint",
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

      // Store generic error message in cache to avoid leaking internal details
      await storeIdempotentResponse(
        idempotencyKey,
        authUser.id,
        "/credentials/mint",
        statusCode,
        {
          success: false,
          error: "Failed to mint credential",
        }
      );

      throw err;
    }
  }

  /**
   * POST /api/credentials/batch-mint
   * Mint multiple course completion NFT credentials sequentially.
   */
  async batchMint(
    request: FastifyRequest<{ Body: BatchMintCredentialBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const results = await credentialService.batchMint(
      authUser.id,
      request.body.submissions,
    );

    reply.send({ success: true, data: results });
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
