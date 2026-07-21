import type { FastifyInstance } from "fastify";

import { authRoutes } from "../../modules/auth/auth.routes.js";
import { userRoutes } from "../../modules/users/user.routes.js";
import { courseRoutes } from "../../modules/courses/course.routes.js";
import { quizRoutes } from "../../modules/quizzes/quiz.routes.js";
import { rewardRoutes } from "../../modules/rewards/reward.routes.js";
import { credentialRoutes } from "../../modules/credentials/credential.routes.js";

export async function registerV1Routes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(courseRoutes, { prefix: "/courses" });
  await app.register(quizRoutes, { prefix: "/quizzes" });
  await app.register(rewardRoutes, { prefix: "/rewards" });
  await app.register(credentialRoutes, { prefix: "/credentials" });
}
