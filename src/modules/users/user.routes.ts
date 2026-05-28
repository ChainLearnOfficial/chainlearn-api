import type { FastifyInstance } from "fastify";
import { userController } from "./user.controller.js";
import { authGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { updateProfileSchema } from "./user.types.js";

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // All user routes require authentication
  app.addHook("onRequest", authGuard);

  app.get(
    "/me",
    {
      schema: {
        description: "Get authenticated user profile",
        tags: ["users"],
      },
    },
    userController.getMe.bind(userController)
  );

  app.put(
    "/me",
    {
      preHandler: [validate({ body: updateProfileSchema })],
      schema: {
        description: "Update authenticated user profile",
        tags: ["users"],
      },
    },
    userController.updateMe.bind(userController)
  );

  app.get(
    "/me/progress",
    {
      schema: {
        description: "Get learning progress stats",
        tags: ["users"],
      },
    },
    userController.getProgress.bind(userController)
  );
}
