import { retry, handleType, ExponentialBackoff } from "cockatiel";
import { logger } from "../utils/logger.js";

function isTransientError(err: Error): boolean {
  const name = err.name ?? "";
  const msg = err.message ?? "";

  if (name === "FetchError" || name === "HttpError") return true;
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ENOTFOUND") ||
    msg.includes("socket hang up")
  ) {
    return true;
  }

  const statusMatch = msg.match(/\b(502|503|504)\b/);
  if (statusMatch) return true;

  return false;
}

export const stellarRetry = retry(
  handleType(Error, (err) => {
    if (isTransientError(err)) {
      logger.warn({ error: err.message }, "Stellar call retrying after transient error");
      return true;
    }
    return false;
  }),
  { backoff: new ExponentialBackoff() }
);

// Circuit breaker implementation
export enum CircuitState {
  Closed = "Closed",
  Open = "Open",
  HalfOpen = "HalfOpen",
}

let circuitState = CircuitState.Closed;
let failureCount = 0;
let lastFailureTime = 0;
const THRESHOLD = 5;
const HALF_OPEN_AFTER = 30_000;

function recordSuccess(): void {
  failureCount = 0;
  if (circuitState !== CircuitState.Closed) {
    logger.info("Circuit breaker reset to closed");
    circuitState = CircuitState.Closed;
  }
}

function recordFailure(): void {
  failureCount++;
  lastFailureTime = Date.now();
  if (failureCount >= THRESHOLD && circuitState === CircuitState.Closed) {
    circuitState = CircuitState.Open;
    logger.warn("Circuit breaker opened after consecutive failures");
  }
}

export function getCircuitState(): CircuitState {
  if (circuitState === CircuitState.Open) {
    if (Date.now() - lastFailureTime > HALF_OPEN_AFTER) {
      circuitState = CircuitState.HalfOpen;
      logger.info("Circuit breaker half-open — allowing probe request");
    }
  }
  return circuitState;
}

export function resetCircuitBreaker(): void {
  circuitState = CircuitState.Closed;
  failureCount = 0;
  lastFailureTime = 0;
}

export async function circuitBreakerExecute<T>(fn: () => Promise<T>): Promise<T> {
  const state = getCircuitState();

  if (state === CircuitState.Open) {
    throw new CircuitBreakerOpenError("Circuit breaker is open");
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

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new TimeoutError(`Operation timed out after ${ms}ms`)),
      ms
    );
  });

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
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
