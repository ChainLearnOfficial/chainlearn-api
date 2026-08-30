import type { FastifyInstance } from "fastify";
import { registerV1Routes } from "./v1/index.js";
import { responseEnvelope } from "../middleware/response-envelope.js";

export function cacheControlHeader(
  url: string,
  statusCode: number = 200,
): string | null {
  const pathname = url.split("?")[0];

  if (statusCode >= 400) {
    return "no-store";
  }

  if (pathname.startsWith("/api/v1/auth")) {
    return "no-store";
  }

  if (pathname === "/api/v1/courses" || pathname === "/api/v1/courses/") {
    return "public, max-age=30";
  }

  if (pathname.startsWith("/api/v1/users/me")) {
    return "private, max-age=60";
  }

  return null;
}

export async function registerVersionedRoutes(app: FastifyInstance) {
  app.register(
    async function v1(app) {
      app.addHook("onRequest", async (request) => {
        (request as any).apiVersion = "v1";
      });
      app.addHook("onSend", async (request, reply, payload) => {
        const header = cacheControlHeader(request.url, reply.statusCode);
        if (header && !reply.hasHeader("Cache-Control")) {
          reply.header("Cache-Control", header);
        }
        return payload;
      });
      app.addHook("onSend", responseEnvelope);
      await registerV1Routes(app);
    },
    { prefix: "/api/v1" },
  );
}
