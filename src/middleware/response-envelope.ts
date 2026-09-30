import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger.js";

export async function responseEnvelope(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: string,
) {
  if (reply.statusCode >= 200 && reply.statusCode < 300) {
    try {
      const body = JSON.parse(payload);
      if (!body.meta) {
        body.meta = {
          version: (request as any).apiVersion ?? "v1",
          timestamp: new Date().toISOString(),
          requestId: request.id,
        };
        return JSON.stringify(body);
      }
    } catch (err) {
      // Non-JSON response (e.g. a PDF download), pass through unchanged.
      logger.debug({ err, requestId: request.id, url: request.url }, "Response body is not JSON — skipping envelope");
    }
  }
  return payload;
}
