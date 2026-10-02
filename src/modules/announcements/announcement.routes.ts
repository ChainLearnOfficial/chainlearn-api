import type { FastifyInstance, FastifySchema } from "fastify";
import { announcementController } from "./announcement.controller.js";

/** Public announcements feed (#353) — no auth required. */
export async function announcementRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/",
    {
      schema: {
        description: "List active, unexpired platform announcements",
        tags: ["announcements"],
      } as FastifySchema,
    },
    (request, reply) => announcementController.listActive(request, reply)
  );
}
