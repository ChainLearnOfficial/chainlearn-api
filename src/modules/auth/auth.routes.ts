import type { FastifyInstance } from "fastify";
import { authController } from "./auth.controller.js";
import { validate } from "../../middleware/validation.js";
import { challengeSchema, verifySchema } from "./auth.types.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/challenge",
    {
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
      },
    },
    authController.challenge.bind(authController)
  );

  app.post(
    "/verify",
    {
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
      },
    },
    authController.verify.bind(authController)
  );
}
