import type { FastifyRequest, FastifyReply } from "fastify";
import { type ZodSchema, ZodError } from "zod";
import { ValidationError } from "../utils/errors.js";

interface ValidationSchemas {
  body?: ZodSchema;
  querystring?: ZodSchema;
  params?: ZodSchema;
}

/**
 * Fastify preHandler hook factory that validates request data against Zod schemas.
 */
export function validate(schemas: ValidationSchemas) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const errors: Record<string, string[]> = {};

    if (schemas.body) {
      const result = schemas.body.safeParse(request.body);
      if (!result.success) {
        errors.body = formatZodErrors(result.error);
      } else {
        (request as any).validatedBody = result.data;
      }
    }

    if (schemas.querystring) {
      const result = schemas.querystring.safeParse(request.query);
      if (!result.success) {
        errors.querystring = formatZodErrors(result.error);
      } else {
        (request as any).validatedQuery = result.data;
      }
    }

    if (schemas.params) {
      const result = schemas.params.safeParse(request.params);
      if (!result.success) {
        errors.params = formatZodErrors(result.error);
      } else {
        (request as any).validatedParams = result.data;
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new ValidationError(errors);
    }
  };
}

function formatZodErrors(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
