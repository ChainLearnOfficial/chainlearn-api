/**
 * Tests for request ID tracing (#287).
 *
 * Three acceptance criteria, three kinds of test here:
 *  1. Every response — success, error, and non-JSON — carries an
 *     `X-Request-Id` header (verified via real HTTP through `app.inject`).
 *  2. A client-supplied `X-Request-Id` header is honored verbatim rather
 *     than overwritten by a server-generated ID (verified via real HTTP).
 *  3. Log entries written through the shared `logger` (used by ~20 modules
 *     via the bare import, as opposed to the ~0 that use `request.log`)
 *     automatically pick up the request's ID from the AsyncLocalStorage
 *     context populated by the `onRequest` hook in server.ts. Pino's level
 *     is "silent" in NODE_ENV=test, so rather than capture real log output
 *     from the shared instance, this builds an equivalent pino instance
 *     wired to the *same* mixin logic and a capturing stream — proving the
 *     mixin/AsyncLocalStorage wiring itself is correct, independent of log
 *     level.
 */
import { test, describe, expect, beforeAll, afterAll } from "vitest";
import pino from "pino";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../server.js";
import { getRequestId, runWithRequestContext } from "../utils/request-context.js";

describe("X-Request-Id response header (#287)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  test("a server-generated X-Request-Id is present when the client sends none", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(typeof res.headers["x-request-id"]).toBe("string");
  });

  test("a client-supplied X-Request-Id is echoed back verbatim, not replaced", async () => {
    const clientRequestId = "client-supplied-9f8e7d6c";

    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": clientRequestId },
    });

    expect(res.headers["x-request-id"]).toBe(clientRequestId);
  });

  test("each request without a client-supplied ID gets a distinct X-Request-Id", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: "/health/live" }),
      app.inject({ method: "GET", url: "/health/live" }),
    ]);

    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  test("X-Request-Id is present on a 404 error response, not just 2xx JSON success", async () => {
    const res = await app.inject({ method: "GET", url: "/this-route-does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  test("X-Request-Id is present on a validation-error (400) response from a real route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: { stellarAddress: "not-a-valid-address" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers["x-request-id"]).toBeTruthy();
  });

  test("the response body's meta.requestId (from response-envelope) matches the X-Request-Id header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/courses/stats" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.meta.requestId).toBe(res.headers["x-request-id"]);
  });
});

describe("Shared logger requestId mixin (#287)", () => {
  test("getRequestId() returns undefined outside of any request context", () => {
    expect(getRequestId()).toBeUndefined();
  });

  test("getRequestId() returns the active context's ID inside runWithRequestContext", () => {
    runWithRequestContext("test-request-id-111", () => {
      expect(getRequestId()).toBe("test-request-id-111");
    });
  });

  test("nested/sequential contexts don't leak into each other", () => {
    runWithRequestContext("first-id", () => {
      expect(getRequestId()).toBe("first-id");
    });
    runWithRequestContext("second-id", () => {
      expect(getRequestId()).toBe("second-id");
    });
    expect(getRequestId()).toBeUndefined();
  });

  test("a pino instance using the same mixin pattern as utils/logger.ts attaches requestId to every log line written inside a request context", () => {
    const lines: string[] = [];
    const captureStream = {
      write(msg: string) {
        lines.push(msg);
      },
    };

    // Mirrors the mixin wired into the real exported `logger` — same
    // getRequestId() call, same shape. Constructed locally (rather than
    // reusing the app's singleton logger) because that singleton is
    // level:"silent" in NODE_ENV=test and pino instances can't be
    // re-targeted to a different stream after construction.
    const testLogger = pino(
      {
        mixin() {
          const requestId = getRequestId();
          return requestId ? { requestId } : {};
        },
      },
      captureStream,
    );

    runWithRequestContext("mixin-wiring-test-id", () => {
      testLogger.info("inside request context");
    });
    testLogger.info("outside request context");

    expect(lines).toHaveLength(2);
    const inside = JSON.parse(lines[0]);
    const outside = JSON.parse(lines[1]);

    expect(inside.requestId).toBe("mixin-wiring-test-id");
    expect(outside.requestId).toBeUndefined();
  });
});
