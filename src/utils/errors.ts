export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = "INTERNAL_ERROR",
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = "Resource") {
    super(`${resource} not found`, 404, "NOT_FOUND");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

export class ValidationError extends AppError {
  public readonly errors: Record<string, string[]>;

  constructor(errors: Record<string, string[]>) {
    super("Validation failed", 400, "VALIDATION_ERROR");
    this.errors = errors;
  }
}

export class ConflictError extends AppError {
  constructor(message: string = "Resource already exists") {
    super(message, 409, "CONFLICT");
  }
}

export class StellarError extends AppError {
  constructor(message: string = "Stellar transaction failed") {
    super(message, 502, "STELLAR_ERROR");
  }
}

/** Which layer produced the error — lets callers branch without re-parsing
 *  the underlying SDK error shape themselves (#479). */
export type StellarErrorKind = "network" | "horizon" | "soroban";

export interface StellarResultCodes {
  transaction?: string;
  operations?: string[];
}

/**
 * Structured Stellar client error (#479). Preserves the diagnostic context
 * that `catch (err: any)` + a generic `StellarError` message used to throw
 * away: which layer failed, the HTTP status if any, Horizon's result codes,
 * and the raw Soroban RPC error string. `cause` carries the original
 * unknown error for logging.
 */
export class StellarClientError extends StellarError {
  public readonly kind: StellarErrorKind;
  public readonly httpStatus?: number;
  public readonly resultCodes?: StellarResultCodes;
  public readonly sorobanError?: string;

  constructor(
    message: string,
    kind: StellarErrorKind,
    details?: {
      httpStatus?: number;
      resultCodes?: StellarResultCodes;
      sorobanError?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.kind = kind;
    this.httpStatus = details?.httpStatus;
    this.resultCodes = details?.resultCodes;
    this.sorobanError = details?.sorobanError;
    if (details?.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

export class RateLimitError extends AppError {
  /** Seconds the client should wait before retrying, if known. When set,
   *  the error handler surfaces this as a `Retry-After` response header. */
  public readonly retryAfterSeconds?: number;

  constructor(message: string = "Rate limit exceeded", retryAfterSeconds?: number) {
    super(message, 429, "RATE_LIMIT_EXCEEDED");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
