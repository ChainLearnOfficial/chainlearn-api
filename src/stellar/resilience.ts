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

export type StellarOperation = "read" | "write";

const stellarReadBreaker = createCircuitBreaker({ label: "StellarRead" });
const stellarWriteBreaker = createCircuitBreaker({ label: "StellarWrite" });

function getBreaker(operation: StellarOperation = "read") {
  return operation === "write" ? stellarWriteBreaker : stellarReadBreaker;
}

export function getCircuitState(operation: StellarOperation = "read"): CircuitState {
  return getBreaker(operation).getState();
}

export function resetCircuitBreaker(operation?: StellarOperation): void {
  if (operation) {
    getBreaker(operation).reset();
    return;
  }

  stellarReadBreaker.reset();
  stellarWriteBreaker.reset();
}

export function circuitBreakerExecute<T>(fn: () => Promise<T>, operation: StellarOperation = "read"): Promise<T> {
  return getBreaker(operation).execute(fn);
}

export { withTimeout, isCircuitBreakerError, CircuitState, CircuitBreakerOpenError, TimeoutError };
