import { describe, it, expect } from "vitest";
import {
  isNetworkError,
  getHttpStatus,
  getHorizonResultCodes,
  getHorizonEnvelopeXdr,
  getSorobanErrorMessage,
  toStellarClientError,
} from "../../../src/stellar/errors.js";
import { StellarClientError } from "../../../src/utils/errors.js";

describe("stellar/errors (#479)", () => {
  describe("isNetworkError", () => {
    it("recognizes a Node errno exception with a known network code", () => {
      const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      expect(isNetworkError(err)).toBe(true);
    });

    it("rejects a plain Error with no code", () => {
      expect(isNetworkError(new Error("boom"))).toBe(false);
    });

    it("rejects a non-network errno code", () => {
      const err = Object.assign(new Error("enoent"), { code: "ENOENT" });
      expect(isNetworkError(err)).toBe(false);
    });
  });

  describe("getHttpStatus / getHorizonResultCodes / getHorizonEnvelopeXdr", () => {
    const horizonError = {
      response: {
        status: 400,
        data: {
          extras: {
            result_codes: { transaction: "tx_bad_seq" },
            envelope_xdr: "AAAA...",
          },
        },
      },
    };

    it("extracts the HTTP status from an Axios-shaped response", () => {
      expect(getHttpStatus(horizonError)).toBe(400);
    });

    it("falls back to a top-level status when there is no .response", () => {
      expect(getHttpStatus({ status: 404 })).toBe(404);
    });

    it("returns undefined for an error with neither shape", () => {
      expect(getHttpStatus(new Error("plain"))).toBeUndefined();
    });

    it("extracts Horizon result codes", () => {
      expect(getHorizonResultCodes(horizonError)).toEqual({ transaction: "tx_bad_seq" });
    });

    it("extracts the envelope XDR", () => {
      expect(getHorizonEnvelopeXdr(horizonError)).toBe("AAAA...");
    });
  });

  describe("getSorobanErrorMessage", () => {
    it("extracts a Soroban RPC error string", () => {
      const err = { response: { status: 400, data: { error: "simulation failed" } } };
      expect(getSorobanErrorMessage(err)).toBe("simulation failed");
    });

    it("returns undefined when the error has no Soroban shape", () => {
      expect(getSorobanErrorMessage(new Error("plain"))).toBeUndefined();
    });
  });

  describe("toStellarClientError", () => {
    it("classifies a network error", () => {
      const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      const result = toStellarClientError(err, "fallback");

      expect(result).toBeInstanceOf(StellarClientError);
      expect(result.kind).toBe("network");
      expect(result.cause).toBe(err);
      expect(result.message).toContain("ETIMEDOUT");
    });

    it("classifies a Horizon error and preserves result codes", () => {
      const err = {
        response: {
          status: 400,
          data: { extras: { result_codes: { transaction: "tx_bad_seq" } } },
        },
      };
      const result = toStellarClientError(err, "fallback");

      expect(result.kind).toBe("horizon");
      expect(result.httpStatus).toBe(400);
      expect(result.resultCodes).toEqual({ transaction: "tx_bad_seq" });
      expect(result.message).toContain("tx_bad_seq");
    });

    it("classifies a Soroban RPC error", () => {
      const err = { response: { status: 400, data: { error: "Error(Contract, #1)" } } };
      const result = toStellarClientError(err, "fallback");

      expect(result.kind).toBe("soroban");
      expect(result.sorobanError).toBe("Error(Contract, #1)");
      expect(result.message).toContain("Error(Contract, #1)");
    });

    it("falls back to an http-status-only horizon error when the shape is unrecognized", () => {
      const err = { response: { status: 503 } };
      const result = toStellarClientError(err, "fallback");

      expect(result.kind).toBe("horizon");
      expect(result.httpStatus).toBe(503);
      expect(result.message).toBe("fallback");
    });

    it("falls back to a network classification for a totally unrecognized error", () => {
      const result = toStellarClientError(new Error("mystery"), "fallback");

      expect(result.kind).toBe("network");
      expect(result.message).toBe("fallback");
    });
  });
});
