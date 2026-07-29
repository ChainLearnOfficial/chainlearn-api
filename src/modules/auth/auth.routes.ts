import type { FastifyInstance, FastifySchema } from "fastify";
import { authController } from "./auth.controller.js";
import { validate } from "../../middleware/validation.js";
import { authGuard } from "../../middleware/auth.js";
import { authRateLimit } from "../../middleware/rate-limit.js";
import { challengeSchema, verifySchema } from "./auth.types.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: import("./auth.types.js").ChallengeBody }>(
    "/challenge",
    {
      config: { rateLimit: authRateLimit },
      preHandler: [validate({ body: challengeSchema })],
      schema: {
        description: "Generate a SEP-10 authentication challenge",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["stellarAddress"],
          properties: {
            stellarAddress: { type: "string" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => authController.challenge(request, reply)
  );

  app.post<{ Body: import("./auth.types.js").VerifyBody }>(
    "/verify",
    {
      config: { rateLimit: authRateLimit },
      preHandler: [validate({ body: verifySchema })],
      schema: {
        description: "Verify signed challenge and get JWT",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["stellarAddress", "challengeId", "signedChallenge"],
          properties: {
            stellarAddress: { type: "string" },
            challengeId: { type: "string", format: "uuid" },
            signedChallenge: { type: "string", maxLength: 10000 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => authController.verify(request, reply)
  );

  app.post(
    "/logout",
    {
      preHandler: [authGuard],
      schema: {
        description: "Revoke the caller's JWT — the token is immediately invalidated server-side",
        tags: ["auth"],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: { message: { type: "string" } },
              },
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => authController.logout(request, reply)
  );
}
