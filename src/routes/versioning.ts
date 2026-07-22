import type { FastifyInstance } from "fastify";
import { registerV1Routes } from "./v1/index.js";
import { responseEnvelope } from "../middleware/response-envelope.js";

export async function registerVersionedRoutes(app: FastifyInstance) {
  app.register(
    async function v1(app) {
      app.addHook("onRequest", async (request) => {
        (request as any).apiVersion = "v1";
      });
      app.addHook("onSend", responseEnvelope);
      await registerV1Routes(app);
    },
    { prefix: "/api/v1" },
  );
}
