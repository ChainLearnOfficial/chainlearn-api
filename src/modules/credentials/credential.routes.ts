import type { FastifyInstance, FastifySchema } from "fastify";
import { credentialController } from "./credential.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  batchMintCredentialSchema,
  certificateIdParamsSchema,
  mintCredentialSchema,
} from "./credential.types.js";
import { batchMintRateLimit } from "../../middleware/rate-limit.js";

export async function credentialRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);

  app.post<{ Body: import("./credential.types.js").MintCredentialBody }>(
    "/mint",
    {
      preHandler: [validate({ body: mintCredentialSchema })],
      schema: {
        description: "Mint a course completion credential (NFT)",
        tags: ["credentials"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object", required: ["courseId", "submissionId", "idempotencyKey"],
          properties: {
            courseId: { type: "string", format: "uuid" },
            submissionId: { type: "string", format: "uuid" },
            idempotencyKey: { type: "string", minLength: 16, maxLength: 64 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => credentialController.mint(request, reply)
  );

  app.post<{ Body: import("./credential.types.js").BatchMintCredentialBody }>(
    "/batch-mint",
    {
      config: { rateLimit: batchMintRateLimit },
      preHandler: [validate({ body: batchMintCredentialSchema })],
      schema: {
        description: "Mint multiple course completion credentials sequentially",
        tags: ["credentials"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["submissions"],
          properties: {
            submissions: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                required: ["courseId", "submissionId"],
                properties: {
                  courseId: { type: "string", format: "uuid" },
                  submissionId: { type: "string", format: "uuid" },
                },
              },
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => credentialController.batchMint(request, reply)
  );

  app.get(
    "/",
    {
      schema: {
        description: "List user credentials",
        tags: ["credentials"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => credentialController.list(request, reply)
  );

  app.get<{ Params: { id: string } }>(
    "/:id/certificate",
    {
      preHandler: [validate({ params: certificateIdParamsSchema })],
      schema: {
        description: "Download one of your certificates as a JSON document",
        tags: ["credentials"],
        security: [{ bearerAuth: [] }],
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      } as FastifySchema,
    },
    (request, reply) => credentialController.downloadCertificate(request, reply)
  );
}
