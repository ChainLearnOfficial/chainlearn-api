import type { FastifyRequest, FastifyReply } from "fastify";
import { webhookService } from "./webhook.service.js";
import type {
  CreateWebhookBody,
  UpdateWebhookBody,
  ListWebhooksQuery,
} from "./webhook.types.js";

export class WebhookController {
  /**
   * POST /api/v1/admin/webhooks
   * Create a new webhook
   */
  async create(
    request: FastifyRequest<{ Body: CreateWebhookBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const webhook = await webhookService.createWebhook(request.body);
    reply.status(201).send({
      success: true,
      data: webhook,
    });
  }

  /**
   * GET /api/v1/admin/webhooks
   * List all webhooks
   */
  async list(
    request: FastifyRequest<{ Querystring: ListWebhooksQuery }>,
    reply: FastifyReply
  ): Promise<void> {
    const { page, limit } = request.query;
    const { webhooks, total } = await webhookService.listWebhooks(page, limit);
    reply.send({
      success: true,
      data: webhooks,
      pagination: { page, limit, total },
    });
  }

  /**
   * GET /api/v1/admin/webhooks/:id
   * Get a single webhook
   */
  async get(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const webhook = await webhookService.getWebhook(id);
    reply.send({
      success: true,
      data: webhook,
    });
  }

  /**
   * PUT /api/v1/admin/webhooks/:id
   * Update a webhook
   */
  async update(
    request: FastifyRequest<{ Params: { id: string }; Body: UpdateWebhookBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const webhook = await webhookService.updateWebhook(id, request.body);
    reply.send({
      success: true,
      data: webhook,
    });
  }

  /**
   * DELETE /api/v1/admin/webhooks/:id
   * Delete a webhook
   */
  async delete(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    await webhookService.deleteWebhook(id);
    reply.send({
      success: true,
      data: { message: "Webhook deleted" },
    });
  }

  /**
   * POST /api/v1/admin/webhooks/:id/rotate-secret
   * Rotate webhook secret
   */
  async rotateSecret(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const result = await webhookService.rotateSecret(id);
    reply.send({
      success: true,
      data: result,
    });
  }

  /**
   * GET /api/v1/admin/webhooks/:id/attempts
   * Get webhook attempts
   */
  async getAttempts(
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { page?: number; limit?: number };
    }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const page = request.query.page ?? 1;
    const limit = request.query.limit ?? 20;
    const { attempts, total } = await webhookService.getWebhookAttempts(id, page, limit);
    reply.send({
      success: true,
      data: attempts,
      pagination: { page, limit, total },
    });
  }

  /**
   * GET /api/v1/admin/webhooks/:id/stats
   * Get webhook statistics
   */
  async getStats(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ): Promise<void> {
    const { id } = request.params;
    const stats = await webhookService.getWebhookStats(id);
    reply.send({
      success: true,
      data: stats,
    });
  }
}

export const webhookController = new WebhookController();
