import {
  createTransientRetryPolicy,
  createCircuitBreaker,
  withTimeout,
  isCircuitBreakerError,
  CircuitState,
  CircuitBreakerOpenError,
  TimeoutError,
} from "../utils/resilience.js";

export const stellarRetry = createTransientRetryPolicy("Stellar");

const stellarBreaker = createCircuitBreaker({ label: "Stellar" });

export function getCircuitState(): CircuitState {
  return stellarBreaker.getState();
}

export function resetCircuitBreaker(): void {
  stellarBreaker.reset();
}

export function circuitBreakerExecute<T>(fn: () => Promise<T>): Promise<T> {
  return stellarBreaker.execute(fn);
}

export { withTimeout, isCircuitBreakerError, CircuitState, CircuitBreakerOpenError, TimeoutError };
