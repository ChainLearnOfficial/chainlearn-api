import type { FastifyInstance, FastifySchema } from "fastify";
import { authController } from "./auth.controller.js";
import { validate } from "../../middleware/validation.js";
import { authRateLimit } from "../../middleware/rate-limit.js";
import { challengeSchema, verifySchema } from "./auth.types.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
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
    ((request: any, reply: any) => authController.challenge(request, reply)) as any
  );

  app.post(
    "/verify",
    {
      config: { rateLimit: authRateLimit },
      preHandler: [validate({ body: verifySchema })],
      schema: {
        description: "Verify signed challenge and get JWT",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["stellarAddress", "signedChallenge"],
          properties: {
            stellarAddress: { type: "string" },
            signedChallenge: { type: "string" },
          },
        },
      } as FastifySchema,
    },
    ((request: any, reply: any) => authController.verify(request, reply)) as any
  );
}
