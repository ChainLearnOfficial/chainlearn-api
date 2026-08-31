import type { FastifyInstance, FastifySchema } from "fastify";
import { webhookController } from "./webhook.controller.js";
import { adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import {
  createWebhookSchema,
  updateWebhookSchema,
  listWebhooksSchema,
} from "./webhook.types.js";
import { z } from "zod";

const idParamSchema = z.object({
  id: z.string().uuid(),
});

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", adminGuard);

  app.post<{ Body: import("./webhook.types.js").CreateWebhookBody }>(
    "/",
    {
      preHandler: [validate({ body: createWebhookSchema })],
      schema: {
        description: "Create a new webhook",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["url", "events"],
          properties: {
            url: { type: "string", format: "uri" },
            events: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.create(request, reply)
  );

  app.get<{ Querystring: import("./webhook.types.js").ListWebhooksQuery }>(
    "/",
    {
      preHandler: [validate({ querystring: listWebhooksSchema })],
      schema: {
        description: "List all webhooks",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.list(request, reply)
  );

  app.get<{ Params: z.infer<typeof idParamSchema> }>(
    "/:id",
    {
      preHandler: [validate({ params: idParamSchema })],
      schema: {
        description: "Get a single webhook",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.get(request, reply)
  );

  app.put<{ Params: z.infer<typeof idParamSchema>; Body: import("./webhook.types.js").UpdateWebhookBody }>(
    "/:id",
    {
      preHandler: [validate({ params: idParamSchema, body: updateWebhookSchema })],
      schema: {
        description: "Update a webhook",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            events: { type: "array", items: { type: "string" } },
            active: { type: "boolean" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.update(request, reply)
  );

  app.delete<{ Params: z.infer<typeof idParamSchema> }>(
    "/:id",
    {
      preHandler: [validate({ params: idParamSchema })],
      schema: {
        description: "Delete a webhook",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.delete(request, reply)
  );

  app.post<{ Params: z.infer<typeof idParamSchema> }>(
    "/:id/rotate-secret",
    {
      preHandler: [validate({ params: idParamSchema })],
      schema: {
        description: "Rotate webhook secret",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.rotateSecret(request, reply)
  );

  app.get<{
    Params: z.infer<typeof idParamSchema>;
    Querystring: { page?: number; limit?: number };
  }>(
    "/:id/attempts",
    {
      preHandler: [validate({ params: idParamSchema })],
      schema: {
        description: "Get webhook delivery attempts",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.getAttempts(request, reply)
  );

  app.get<{ Params: z.infer<typeof idParamSchema> }>(
    "/:id/stats",
    {
      preHandler: [validate({ params: idParamSchema })],
      schema: {
        description: "Get webhook statistics",
        tags: ["webhooks"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => webhookController.getStats(request, reply)
  );
}
