import type { FastifyRequest, FastifyReply } from "fastify";
import { credentialService } from "./credential.service.js";
import { Controller, Get, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { CredentialService } from './credential.service';
// import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

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

  /**
   * GET /api/v1/users/me/certificates
   * The authenticated user's earned certificates with download and
   * verification URLs (#371).
   */
  async certificates(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const certificates = await credentialService.listCertificates(authUser.id);

    reply.send({ success: true, data: certificates });
  }

  /**
   * GET /api/v1/credentials/:id/certificate
   * Download one certificate as a JSON document (#371).
   */
  async downloadCertificate(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { authUser } = request as AuthenticatedRequest;
    const certificate = await credentialService.getCertificate(
      authUser.id,
      request.params.id
    );

    reply
      .header(
        "Content-Disposition",
        `attachment; filename="certificate-${certificate.credentialId}.json"`
      )
      .send({ success: true, data: certificate });
  }
}

export const credentialController = new CredentialController();



@Controller('api/v1/courses')
export class CredentialController {
  constructor(private readonly credentialService: CredentialService) {}

  @Get(':id/completion-certificate')
  // @UseGuards(JwtAuthGuard)
  async getCompletionCertificate(
    @Param('id') courseId: string,
    @Req() req: any,
    @Res() res: Response,
  ): Promise<void> {
    const userId = req.user?.id || 'mock-user-id';

    const pdfBuffer = await this.credentialService.generateCompletionCertificate(userId, courseId);

    // Set caching headers for generated certificate (cache for 1 hour since completion is static)
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${courseId}.pdf"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    res.status(200).send(pdfBuffer);
  }
}