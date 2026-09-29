import { StellarClientError, type StellarResultCodes } from "../utils/errors.js";

/**
 * Type guards and classification for errors thrown by @stellar/stellar-sdk's
 * Horizon and Soroban RPC clients (#479). The SDK doesn't export typed error
 * classes for these — Horizon/Soroban failures surface as an Axios-shaped
 * error with `.response`, and Node network failures as a standard
 * `NodeJS.ErrnoException` — so this narrows `unknown` catch variables into
 * one of those shapes instead of reaching for `err: any`.
 */

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/** True for a transport-level failure (DNS, connection reset, timeout) —
 *  the dependency was never reached, as opposed to answering with an error. */
export function isNetworkError(err: unknown): err is NodeJS.ErrnoException {
  return isNodeErrnoException(err) && NETWORK_ERROR_CODES.has(err.code as string);
}

interface HorizonErrorResponse {
  response?: {
    status?: number;
    data?: {
      extras?: {
        result_codes?: StellarResultCodes;
        envelope_xdr?: string;
      };
    };
  };
}

interface SorobanErrorResponse {
  response?: {
    status?: number;
    data?: {
      error?: string;
    };
  };
}

function getResponse(err: unknown): { status?: number; data?: unknown } | undefined {
  if (typeof err !== "object" || err === null || !("response" in err)) {
    return undefined;
  }
  const response = (err as HorizonErrorResponse).response;
  return response && typeof response === "object" ? response : undefined;
}

/** The HTTP status code on a Horizon/Soroban RPC error response, if any.
 *  Checks `.response.status` (the Axios-shaped errors the SDK throws) and
 *  falls back to a top-level `.status`, in case a caller ever gets a plain
 *  fetch-style error instead. */
export function getHttpStatus(err: unknown): number | undefined {
  const responseStatus = getResponse(err)?.status;
  if (responseStatus !== undefined) return responseStatus;

  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/** Horizon's `extras.result_codes` from a failed submitTransaction/simulate
 *  response, if the error has that shape. */
export function getHorizonResultCodes(err: unknown): StellarResultCodes | undefined {
  const response = getResponse(err) as HorizonErrorResponse["response"];
  return response?.data?.extras?.result_codes;
}

/** Horizon's raw envelope XDR from a failed transaction, if present. */
export function getHorizonEnvelopeXdr(err: unknown): string | undefined {
  const response = getResponse(err) as HorizonErrorResponse["response"];
  return response?.data?.extras?.envelope_xdr;
}

/** The Soroban RPC error string from a failed simulate/getTransaction
 *  response, if the error has that shape. */
export function getSorobanErrorMessage(err: unknown): string | undefined {
  const response = getResponse(err) as SorobanErrorResponse["response"];
  return response?.data?.error;
}

/**
 * Classify an `unknown` catch value into a `StellarClientError`, preserving
 * whatever structured context is recoverable from it. `fallbackMessage`
 * covers the case where none of the known shapes match (e.g. a bare Error).
 */
export function toStellarClientError(
  err: unknown,
  fallbackMessage: string,
): StellarClientError {
  if (isNetworkError(err)) {
    return new StellarClientError(
      `${fallbackMessage}: network error (${err.code})`,
      "network",
      { cause: err },
    );
  }

  const httpStatus = getHttpStatus(err);
  const resultCodes = getHorizonResultCodes(err);
  const sorobanError = getSorobanErrorMessage(err);

  if (resultCodes) {
    return new StellarClientError(
      `${fallbackMessage}: ${JSON.stringify(resultCodes)}`,
      "horizon",
      { httpStatus, resultCodes, cause: err },
    );
  }

  if (sorobanError) {
    return new StellarClientError(
      `${fallbackMessage}: ${sorobanError}`,
      "soroban",
      { httpStatus, sorobanError, cause: err },
    );
  }

  if (httpStatus !== undefined) {
    return new StellarClientError(fallbackMessage, "horizon", { httpStatus, cause: err });
  }

  return new StellarClientError(fallbackMessage, "network", { cause: err });
}
