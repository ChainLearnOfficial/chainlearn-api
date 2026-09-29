import type { FastifyInstance, FastifySchema } from "fastify";
import { adminCourseController } from "./admin-course.controller.js";
import { quizController } from "../quizzes/quiz.controller.js";
import { authGuard, adminGuard } from "../../middleware/auth.js";
import { validate } from "../../middleware/validation.js";
import { ROUTE_BODY_LIMITS } from "../../config/route-body-limits.js";
import {
  adminQuizModuleParamsSchema,
  adminQuizParamsSchema,
  adminUpdateQuizSchema,
  authoredQuestionSchema,
  authoredQuizSchema,
} from "../quizzes/quiz.types.js";
import {
  createCourseSchema,
  updateCourseSchema,
  draftCourseSchema,
  courseIdParamsSchema,
  createModuleSchema,
  updateModuleSchema,
  moduleParamsSchema,
  listEnrolledUsersQuerySchema,
  enrollmentTrendsQuerySchema,
  reorderModulesSchema,
  cloneCourseSchema,
  moduleContentParamsSchema,
  contentParamsSchema,
  createContentSchema,
  updateContentSchema,
  reorderContentSchema,
} from "./course.types.js";

/** Admin-only course management (#292). Every route requires an admin user. */
export async function adminCourseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", authGuard);
  app.addHook("preHandler", adminGuard);

  app.post<{ Body: import("./course.types.js").CreateCourseBody }>(
    "/",
    {
      preHandler: [validate({ body: createCourseSchema })],
      schema: {
        description: "Create a course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        body: {
          type: "object",
          required: ["title", "description"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            difficulty: {
              type: "string",
              enum: ["beginner", "intermediate", "advanced"],
            },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
            courseModules: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["id", "title"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 100 },
                  title: { type: "string", minLength: 1, maxLength: 255 },
                  description: { type: "string", maxLength: 1000 },
                  estimatedDurationMinutes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 1440,
                  },
                },
              },
            },
            contentHash: { type: "string", maxLength: 64 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.create(request, reply),
  );

  app.post(
    "/import",
    {
      schema: {
        description:
          "Bulk-create a course (and its modules) from an uploaded JSON file — multipart/form-data with a single file part (admin only) (#366)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.import(request, reply),
  );

  app.put<{
    Params: { id: string };
    Body: import("./course.types.js").UpdateCourseBody;
  }>(
    "/:id",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: updateCourseSchema }),
      ],
      schema: {
        description: "Update a course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            difficulty: {
              type: "string",
              enum: ["beginner", "intermediate", "advanced"],
            },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
            courseModules: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                required: ["id", "title"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 100 },
                  title: { type: "string", minLength: 1, maxLength: 255 },
                  description: { type: "string", maxLength: 1000 },
                  estimatedDurationMinutes: {
                    type: "integer",
                    minimum: 1,
                    maximum: 1440,
                  },
                },
              },
            },
            contentHash: { type: "string", maxLength: 64 },
            isActive: { type: "boolean" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.update(request, reply),
  );

  app.post<{
    Params: { id: string };
    Body: import("./course.types.js").DraftCourseBody;
  }>(
    "/:id/draft",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: draftCourseSchema }),
      ],
      schema: {
        description:
          "Save course content as a draft without publishing (admin only). The course is hidden from users and can be saved repeatedly; publish it by setting isActive to true.",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", minLength: 1 },
            difficulty: {
              type: "string",
              enum: ["beginner", "intermediate", "advanced"],
            },
            tags: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 50 },
              maxItems: 20,
            },
            courseModules: { type: "array", maxItems: 100 },
            contentHash: { type: "string", maxLength: 64 },
            prerequisites: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 20,
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.saveDraft(request, reply),
  );

  app.delete<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description: "Soft-delete a course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.remove(request, reply),
  );

  app.post<{ Params: { id: string } }>(
    "/:id/archive",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Archive a course: hides it from public listings while preserving data and enrolled users' access (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.archive(request, reply),
  );

  app.post<{ Params: { id: string } }>(
    "/:id/publish",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Publish a course after validating required content (title, description, difficulty, modules, and a quiz per module) is present (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.publish(request, reply),
  );

  app.post<{ Params: { id: string } }>(
    "/:id/publish-check",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Check whether a course is ready to publish: returns every unmet requirement (blocking issues that would stop a publish, plus advisory ones that wouldn't) and a 0-100 readiness score. Non-destructive — the course is not modified (admin only, #384)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.publishCheck(request, reply),
  );

  app.post<{
    Params: { id: string };
    Body?: import("./course.types.js").CloneCourseBody;
  }>(
    "/:id/duplicate",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Duplicate a course, its modules, and quizzes into a new draft course (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.duplicate(request, reply),
  );

  app.post<{
    Params: { id: string };
    Body: import("./course.types.js").CloneCourseBody;
  }>(
    "/:id/clone",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: cloneCourseSchema }),
      ],
      schema: {
        description:
          "Clone a course including all content, modules, and quizzes into a new draft course (admin only, #378)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.clone(request, reply),
  );

  app.post<{
    Params: { id: string };
    Body: import("./course.types.js").CreateModuleBody;
  }>(
    "/:id/modules",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: createModuleSchema }),
      ],
      schema: {
        description: "Create a course module definition (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", maxLength: 2000 },
            order: { type: "integer", minimum: 0 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.createModule(request, reply),
  );

  app.put<{
    Params: { id: string; moduleId: string };
    Body: import("./course.types.js").UpdateModuleBody;
  }>(
    "/:id/modules/:moduleId",
    {
      preHandler: [
        validate({ params: moduleParamsSchema, body: updateModuleSchema }),
      ],
      schema: {
        description: "Update a course module definition (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: "string", maxLength: 2000 },
            order: { type: "integer", minimum: 0 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.updateModule(request, reply),
  );

  app.delete<{ Params: { id: string; moduleId: string } }>(
    "/:id/modules/:moduleId",
    {
      preHandler: [validate({ params: moduleParamsSchema })],
      schema: {
        description:
          "Delete a course module definition and its quizzes (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.removeModule(request, reply),
  );

  app.post<{
    Params: { id: string };
    Body: import("./course.types.js").ReorderModulesBody;
  }>(
    "/:id/modules/reorder",
    {
      preHandler: [
        validate({ params: courseIdParamsSchema, body: reorderModulesSchema }),
      ],
      schema: {
        description:
          "Reorder course modules atomically — accepts an ordered array of module IDs (admin only, #374)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["moduleIds"],
          properties: {
            moduleIds: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 100 },
              minItems: 1,
              maxItems: 100,
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.reorderModules(request, reply),
  );

  // ─── Module Quiz Authoring (#388) ───────────────────────────────────────

  app.get<{ Params: { id: string; moduleId: string } }>(
    "/:id/modules/:moduleId/quizzes",
    {
      preHandler: [validate({ params: adminQuizModuleParamsSchema })],
      schema: {
        description:
          "List every quiz on a course module, including correct answers and submission counts (admin only, #388)",
        tags: ["admin", "courses", "quizzes"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.listModuleQuizzes(request, reply),
  );

  app.get<{ Params: { id: string; moduleId: string } }>(
    "/:id/modules/:moduleId/content",
    {
      preHandler: [validate({ params: moduleContentParamsSchema })],
      schema: {
        description: "List content items within a module (admin only, #382)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.listContent(request, reply),
  );

  app.post<{
    Params: { id: string; moduleId: string };
    Body: import("../quizzes/quiz.types.js").AuthoredQuizBody;
  }>(
    "/:id/modules/:moduleId/quizzes",
    {
      config: { bodyLimit: ROUTE_BODY_LIMITS.quizAuthoring },
      preHandler: [
        validate({
          params: adminQuizModuleParamsSchema,
          body: authoredQuizSchema,
        }),
      ],
      schema: {
        description:
          "Create a hand-authored quiz for a course module. Each question needs a unique id, text, 2-10 options, and a correctIndex within the options range. The quiz is course-wide (unlike AI-generated ones, which belong to a single learner). Questions are stored in the order given and are not shuffled (admin only, #388)",
        tags: ["admin", "courses", "quizzes"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        body: {
          type: "object",
          required: ["questions"],
          properties: {
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "object" },
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.createModuleQuiz(request, reply),
  );

  app.post<{
    Params: { id: string; moduleId: string };
    Body: import("./course.types.js").CreateContentBody;
  }>(
    "/:id/modules/:moduleId/content",
    {
      preHandler: [
        validate({
          params: moduleContentParamsSchema,
          body: createContentSchema,
        }),
      ],
      schema: {
        description: "Create a content item within a module (admin only, #382)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        body: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1 },
            content: { type: "string" },
            contentType: { type: "string" },
            videoUrl: { type: "string" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.createContent(request, reply),
  );

  app.put<{
    Params: { id: string; moduleId: string; quizId: string };
    Body: import("../quizzes/quiz.types.js").AuthoredQuizBody;
  }>(
    "/:id/modules/:moduleId/quizzes/:quizId",
    {
      config: { bodyLimit: ROUTE_BODY_LIMITS.quizAuthoring },
      preHandler: [
        validate({ params: adminQuizParamsSchema, body: authoredQuizSchema }),
      ],
      schema: {
        description:
          "Replace a quiz's questions with a hand-authored set — `questions` is a full replacement, not a patch. Existing submissions keep their recorded score but can no longer be explained by the new questions, so prefer editing a quiz nobody has answered yet (admin only, #388)",
        tags: ["admin", "courses", "quizzes"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId", "quizId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
            quizId: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          required: ["questions"],
          properties: {
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "object" },
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.updateModuleQuiz(request, reply),
  );

  app.post<{
    Params: { id: string; moduleId: string; quizId: string };
    Body: import("../quizzes/quiz.types.js").AdminQuizUpdateBody;
  }>(
    "/:id/modules/:moduleId/quizzes/:quizId",
    {
      config: { bodyLimit: ROUTE_BODY_LIMITS.quizAuthoring },
      preHandler: [
        validate({
          params: adminQuizParamsSchema,
          body: adminUpdateQuizSchema,
        }),
      ],
      schema: {
        description:
          "Update an existing quiz: replace its questions, merge metadata, and/or archive it. Questions are validated before they are stored. The write is atomic and recorded in the audit log (admin only, #413)",
        tags: ["admin", "courses", "quizzes"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId", "quizId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
            quizId: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: { type: "object" },
            },
            archived: { type: "boolean" },
            metadata: { type: "object", additionalProperties: true },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.updateModuleQuizDetails(request, reply),
  );

  app.post<{
    Params: { id: string; moduleId: string; quizId: string };
    Body: import("../quizzes/quiz.types.js").AuthoredQuestion;
  }>(
    "/:id/modules/:moduleId/quizzes/:quizId/questions",
    {
      config: { bodyLimit: ROUTE_BODY_LIMITS.quizAuthoring },
      preHandler: [
        validate({
          params: adminQuizParamsSchema,
          body: authoredQuestionSchema,
        }),
      ],
      schema: {
        description:
          "Add one question to an existing quiz. The question needs an id, text, 2-10 options, and a correctIndex within that range. The questions array is updated atomically and the change is audit-logged (admin only, #411)",
        tags: ["admin", "courses", "quizzes"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId", "quizId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
            quizId: { type: "string", format: "uuid" },
          },
        },
        body: {
          type: "object",
          required: ["id", "text", "options", "correctIndex"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 100 },
            text: { type: "string", minLength: 1, maxLength: 2000 },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 10,
              items: { type: "string" },
            },
            correctIndex: { type: "integer", minimum: 0 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.addModuleQuizQuestion(request, reply),
  );

  app.put<{
    Params: { id: string; moduleId: string; contentId: string };
    Body: import("./course.types.js").UpdateContentBody;
  }>(
    "/:id/modules/:moduleId/content/:contentId",
    {
      preHandler: [
        validate({ params: contentParamsSchema, body: updateContentSchema }),
      ],
      schema: {
        description: "Update a content item within a module (admin only, #382)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId", "contentId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
            contentId: { type: "string", format: "uuid" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.updateContent(request, reply),
  );

  app.delete<{ Params: { id: string; moduleId: string; quizId: string } }>(
    "/:id/modules/:moduleId/quizzes/:quizId",
    {
      preHandler: [validate({ params: adminQuizParamsSchema })],
      schema: {
        description:
          "Delete a quiz and its submissions in one transaction, and remove any module content item that references it. The response reports how many submissions and claimed rewards were destroyed (admin only, #414)",
        tags: ["admin", "courses", "quizzes"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId", "quizId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
            quizId: { type: "string", format: "uuid" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => quizController.deleteModuleQuiz(request, reply),
  );

  app.delete<{ Params: { id: string; moduleId: string; contentId: string } }>(
    "/:id/modules/:moduleId/content/:contentId",
    {
      preHandler: [validate({ params: contentParamsSchema })],
      schema: {
        description: "Delete a content item within a module (admin only, #382)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId", "contentId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
            contentId: { type: "string", format: "uuid" },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.deleteContent(request, reply),
  );

  app.post<{
    Params: { id: string; moduleId: string };
    Body: import("./course.types.js").ReorderContentBody;
  }>(
    "/:id/modules/:moduleId/content/reorder",
    {
      preHandler: [
        validate({
          params: moduleContentParamsSchema,
          body: reorderContentSchema,
        }),
      ],
      schema: {
        description:
          "Reorder content items within a module atomically (admin only, #382)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id", "moduleId"],
          properties: {
            id: { type: "string", format: "uuid" },
            moduleId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.reorderContent(request, reply),
  );

  app.get<{ Params: { id: string } }>(
    "/:id/analytics",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Detailed course analytics: enrollment trends (daily/weekly), completion rate, average time-to-complete, average quiz score, and modules with the lowest average score (admin only, cached 1 hour)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.analytics(request, reply),
  );

  app.get<{ Params: { id: string } }>(
    "/:id/engagement",
    {
      preHandler: [validate({ params: courseIdParamsSchema })],
      schema: {
        description:
          "Course engagement metrics: completion rate, average time to complete, per-module drop-off, average score and quiz retake rate, the biggest drop-off point, and weekly enrollment/completion trends (admin only, cached 1 hour)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.engagement(request, reply),
  );

  app.get<{
    Params: { id: string };
    Querystring: import("./course.types.js").ListEnrolledUsersQuery;
  }>(
    "/:id/enrolled-users",
    {
      preHandler: [
        validate({
          params: courseIdParamsSchema,
          querystring: listEnrolledUsersQuerySchema,
        }),
      ],
      schema: {
        description:
          "List a course's enrolled users (paginated) with their quiz progress (admin only)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.listEnrolledUsers(request, reply),
  );

  app.get<{
    Params: { id: string };
    Querystring: import("./course.types.js").EnrollmentTrendsQuery;
  }>(
    "/:id/enrollment-trends",
    {
      preHandler: [
        validate({
          params: courseIdParamsSchema,
          querystring: enrollmentTrendsQuerySchema,
        }),
      ],
      schema: {
        description:
          "Enrollment trends for a course over time with configurable range (7d/30d/90d) and granularity (daily/weekly/monthly) (admin only, cached 1 hour, #391)",
        tags: ["admin", "courses"],
        security: [{ bearerAuth: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        querystring: {
          type: "object",
          properties: {
            range: {
              type: "string",
              enum: ["7d", "30d", "90d"],
              default: "30d",
            },
            granularity: {
              type: "string",
              enum: ["daily", "weekly", "monthly"],
              default: "daily",
            },
          },
        },
      } as FastifySchema,
    },
    (request, reply) => adminCourseController.enrollmentTrends(request, reply),
  );
}
