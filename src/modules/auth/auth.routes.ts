import type { FastifyInstance, FastifySchema } from "fastify";
import { authController } from "./auth.controller.js";
import { validate } from "../../middleware/validation.js";
import { authGuard } from "../../middleware/auth.js";
import { authRateLimit } from "../../middleware/rate-limit.js";
import {
  challengeSchema,
  verifySchema,
  refreshSchema,
  logoutSchema,
  sessionIdParamsSchema,
} from "./auth.types.js";

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

  app.post<{ Body: import("./auth.types.js").RefreshBody }>(
    "/refresh",
    {
      config: { rateLimit: authRateLimit },
      preHandler: [validate({ body: refreshSchema })],
      schema: {
        description:
          "Exchange a refresh token for a new access token. The refresh token is single-use and is rotated — a new one is returned in the response.",
        tags: ["auth"],
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: {
            refreshToken: { type: "string", maxLength: 512 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  token: { type: "string" },
                  refreshToken: { type: "string" },
                },
              },
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => authController.refresh(request, reply)
  );

  app.post<{ Body: import("./auth.types.js").LogoutBody }>(
    "/logout",
    {
      preHandler: [authGuard, validate({ body: logoutSchema })],
      schema: {
        description: "Revoke the caller's JWT — the token is immediately invalidated server-side. Optionally pass the refresh token to also revoke this session's refresh-token family.",
        tags: ["auth"],
        security: [{ bearerAuth: [] }],
        // No `body` JSON schema here on purpose: a bare `{ type: "object" }`
        // makes Fastify 400 a bodyless logout ("body must be object"), which
        // would break the header-only logout contract. The optional
        // `logoutSchema` in the validate() preHandler covers the body when
        // one is sent.
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

  app.get(
    "/sessions",
    {
      preHandler: [authGuard],
      schema: {
        description:
          "List the caller's active sessions, with device info and last activity",
        tags: ["auth"],
        security: [{ bearerAuth: [] }],
      } as FastifySchema,
    },
    (request, reply) => authController.listSessions(request, reply)
  );

  app.delete<{ Params: import("./auth.types.js").SessionIdParams }>(
    "/sessions/:sessionId",
    {
      preHandler: [authGuard, validate({ params: sessionIdParamsSchema })],
      schema: {
        description:
          "Revoke one of the caller's sessions — its token is blacklisted immediately",
        tags: ["auth"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => authController.revokeSession(request, reply)
  );
}
