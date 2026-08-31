import type { FastifyInstance } from "fastify";

import { authRoutes } from "../../modules/auth/auth.routes.js";
import { userRoutes } from "../../modules/users/user.routes.js";
import { courseRoutes } from "../../modules/courses/course.routes.js";
import { adminCourseRoutes } from "../../modules/courses/admin-course.routes.js";
import { adminUsersRoutes } from "../../modules/admin/admin-users.routes.js";
import { auditRoutes } from "../../modules/admin/audit.routes.js";
import { quizRoutes, quizPublicRoutes } from "../../modules/quizzes/quiz.routes.js";
import { rewardRoutes } from "../../modules/rewards/reward.routes.js";
import { credentialRoutes } from "../../modules/credentials/credential.routes.js";

export async function registerV1Routes(app: FastifyInstance) {
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(userRoutes, { prefix: "/users" });
  await app.register(courseRoutes, { prefix: "/courses" });
  await app.register(adminCourseRoutes, { prefix: "/admin/courses" });
  await app.register(adminUsersRoutes, { prefix: "/admin/users" });
  await app.register(auditRoutes, { prefix: "/admin/audit-logs" });
  await app.register(quizPublicRoutes, { prefix: "/quizzes" });
  await app.register(quizRoutes, { prefix: "/quizzes" });
  await app.register(rewardRoutes, { prefix: "/rewards" });
  await app.register(credentialRoutes, { prefix: "/credentials" });
}
