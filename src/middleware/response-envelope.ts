import type { FastifyRequest, FastifyReply } from "fastify";

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
    } catch {
      // Non-JSON response, pass through
    }
  }
  return payload;
}
