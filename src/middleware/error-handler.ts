import type {
  FastifyInstance,
  FastifyError,
  FastifyRequest,
  FastifyReply,
} from "fastify";
import { AppError, ValidationError, RateLimitError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { config } from "../config/index.js";
import { ZodError } from "zod";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError | AppError | Error, request: FastifyRequest, reply: FastifyReply) => {
      const fastifyError = error as FastifyError;
      if (
        fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
        fastifyError.code === "FST_REQ_FILE_TOO_LARGE"
      ) {
        const isMultipart = fastifyError.code === "FST_REQ_FILE_TOO_LARGE";
        const routeConfig = request.routeOptions.config as {
          fileSizeLimit?: number;
        };
        const expectedSize = isMultipart
          ? routeConfig.fileSizeLimit ?? config.MULTIPART_BODY_LIMIT_BYTES
          : request.routeOptions.bodyLimit;
        const actualSize = Number(request.headers["content-length"]) || null;

        return reply.status(413).send({
          statusCode: 413,
          error: "PAYLOAD_TOO_LARGE",
          message: isMultipart
            ? "Uploaded file is too large"
            : "Request body is too large",
          details: {
            expectedSize,
            actualSize,
          },
        });
      }

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
        if (error instanceof RateLimitError && error.retryAfterSeconds !== undefined) {
          // Set the standard Retry-After header (RFC 9110 §10.2.3) so
          // clients/proxies can back off automatically instead of just
          // reading it out of the JSON body.
          reply.header("Retry-After", String(error.retryAfterSeconds));
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
        // Use the validated config, not raw process.env. Only surface the
        // real message outside production — these are non-operational errors
        // (AppError is handled above), so production never leaks internals.
        message:
          config.NODE_ENV === "production"
            ? "Internal server error"
            : error.message,
      });
    }
  );

  // Handle 404 for unmatched routes, with backwards compatibility redirect
  app.setNotFoundHandler((request, reply) => {
    if (
      request.url.startsWith("/api/") &&
      !request.url.startsWith("/api/v")
    ) {
      const newPath = request.url.replace("/api/", "/api/v1/");
      return reply.code(301).redirect(newPath);
    }
    reply.status(404).send({
      statusCode: 404,
      error: "NOT_FOUND",
      message: "Route not found",
    });
  });
}
