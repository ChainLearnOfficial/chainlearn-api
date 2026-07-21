import type { FastifyRequest, FastifyReply } from "fastify";

export function deprecationHeader(version: string, sunsetDate: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Deprecation", "true");
    reply.header("Sunset", new Date(sunsetDate).toUTCString());
    reply.header(
      "Link",
      `</api/v${parseInt(version) + 1}>; rel="successor-version"`,
    );
  };
}
