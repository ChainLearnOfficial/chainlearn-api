import type { FastifyRequest, FastifyReply } from "fastify";
import { credentialService } from "./credential.service.js";
import type { AuthenticatedRequest } from "../../middleware/auth.js";
import type { MintCredentialBody } from "./credential.types.js";

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
    const { courseId, submissionId } = (request as any).validatedBody;
    const result = await credentialService.mint(
      authUser.id,
      courseId,
      submissionId
    );

    reply.status(201).send({ success: true, data: result });
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
