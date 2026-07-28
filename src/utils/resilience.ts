import { retry, handleType, ExponentialBackoff, type RetryPolicy } from "cockatiel";
import { logger } from "./logger.js";

export function isTransientError(err: Error): boolean {
  const name = err.name ?? "";
  const msg = err.message ?? "";

  if (name === "FetchError" || name === "HttpError" || name === "AbortError" || name === "TimeoutError") {
    return true;
  }
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("socket hang up") ||
    msg.includes("timed out")
  ) {
    return true;
  }

  const statusMatch = msg.match(/\b(502|503|504)\b/);
  if (statusMatch) return true;

  return false;
}

export interface RetryPolicyOptions {
  maxAttempts?: number;
}

export function createTransientRetryPolicy(
  label: string,
  options: RetryPolicyOptions = {}
): RetryPolicy {
  return retry(
    handleType(Error, (err) => {
      if (isTransientError(err)) {
        logger.warn({ error: err.message }, `${label} call retrying after transient error`);
        return true;
      }
      return false;
    }),
    { backoff: new ExponentialBackoff(), maxAttempts: options.maxAttempts }
  );
}

export enum CircuitState {
  Closed = "Closed",
  Open = "Open",
  HalfOpen = "HalfOpen",
}

export class CircuitBreakerOpenError extends Error {
  constructor(message = "Circuit breaker is open") {
    super(message);
    this.name = "CircuitBreakerOpenError";
  }
}

export class TimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export function isCircuitBreakerError(err: unknown): boolean {
  return err instanceof CircuitBreakerOpenError;
}

export interface CircuitBreaker {
  execute<T>(fn: () => Promise<T>): Promise<T>;
  getState(): CircuitState;
  reset(): void;
}

export interface CircuitBreakerOptions {
  label: string;
  threshold?: number;
  halfOpenAfterMs?: number;
}

export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  const { label, threshold = 5, halfOpenAfterMs = 30_000 } = options;

  let circuitState = CircuitState.Closed;
  let failureCount = 0;
  let lastFailureTime = 0;

  function recordSuccess(): void {
    failureCount = 0;
    if (circuitState !== CircuitState.Closed) {
      logger.info({ label }, "Circuit breaker reset to closed");
      circuitState = CircuitState.Closed;
    }
  }

  function recordFailure(): void {
    failureCount++;
    lastFailureTime = Date.now();

    if (failureCount >= threshold && circuitState === CircuitState.Closed) {
      circuitState = CircuitState.Open;
      logger.warn({ label }, "Circuit breaker opened after consecutive failures");
    }

    if (circuitState === CircuitState.HalfOpen) {
      circuitState = CircuitState.Open;
      logger.warn({ label }, "Circuit breaker re-opened after probe failure in HalfOpen state");
    }
  }

  function getState(): CircuitState {
    if (circuitState === CircuitState.Open) {
      if (Date.now() - lastFailureTime > halfOpenAfterMs) {
        circuitState = CircuitState.HalfOpen;
        logger.info({ label }, "Circuit breaker half-open — allowing probe request");
      }
    }
    return circuitState;
  }

  function reset(): void {
    circuitState = CircuitState.Closed;
    failureCount = 0;
    lastFailureTime = 0;
  }

  async function execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = getState();

    if (state === CircuitState.Open) {
      throw new CircuitBreakerOpenError(`Circuit breaker is open for ${label}`);
    }

    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (err) {
      if (err instanceof Error && isTransientError(err)) {
        recordFailure();
      }
      throw err;
    }
  }

  return { execute, getState, reset };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`Operation timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
