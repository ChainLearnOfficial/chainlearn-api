import type {
  FastifyInstance,
  FastifyError,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { AppError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { ZodError } from "zod";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | AppError | Error, request: FastifyRequest, reply: FastifyReply) => {
      // Handle Zod errors that weren't caught by validation middleware
      if (error instanceof ZodError) {
        return reply.status(400).send({
          statusCode: 400,
          error: "Validation Error",
          message: "Request validation failed",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }

      // Handle our custom AppError
      if (error instanceof AppError) {
        const body: Record<string, unknown> = {
          statusCode: error.statusCode,
          error: error.code,
          message: error.message,
        };
        if (error instanceof ValidationError) {
          body.details = error.errors;
        }
        return reply.status(error.statusCode).send(body);
      }

      // Handle Fastify-specific errors
      if ("statusCode" in error && typeof error.statusCode === "number") {
        return reply.status(error.statusCode).send({
          statusCode: error.statusCode,
          error: error.code ?? "FASTIFY_ERROR",
          message: error.message,
        });
      }

      // Unhandled errors — log and return 500
      logger.error(
        { err: error, url: request.url, method: request.method },
        "Unhandled error"
      );

      return reply.status(500).send({
        statusCode: 500,
        error: "INTERNAL_ERROR",
        message:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : error.message,
      });
    }
  );

  // Handle 404 for unmatched routes
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      statusCode: 404,
      error: "NOT_FOUND",
      message: "Route not found",
    });
  });
}
