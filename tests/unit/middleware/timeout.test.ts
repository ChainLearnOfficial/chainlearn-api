import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";

vi.mock("../../../src/config/index.js", () => ({
  config: { REQUEST_TIMEOUT_MS: 1000, QUIZ_GENERATION_TIMEOUT_MS: 5000 },
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { registerRequestTimeout } from "../../../src/middleware/timeout.js";

async function buildTestApp() {
  const app = Fastify();
  registerRequestTimeout(app);

  app.get("/slow", { config: { timeoutMs: 50 } }, async (_request, reply) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return reply.send({ ok: true });
  });

  app.get("/fast", { config: { timeoutMs: 5000 } }, async () => ({ ok: true }));

  app.get("/default", async () => ({ ok: true }));

  app.get("/streaming", { config: { timeoutMs: false } }, async (_request, reply) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return reply.send({ ok: true });
  });

  await app.ready();
  return app;
}

describe("Request Timeout Middleware (#305)", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 408 when a route exceeds its configured timeout", async () => {
    const response = await app.inject({ method: "GET", url: "/slow" });

    expect(response.statusCode).toBe(408);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe("REQUEST_TIMEOUT");
  });

  it("responds normally when the handler finishes within the timeout", async () => {
    const response = await app.inject({ method: "GET", url: "/fast" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ ok: true });
  });

  it("uses the default timeout when no per-route override is set", async () => {
    const response = await app.inject({ method: "GET", url: "/default" });

    expect(response.statusCode).toBe(200);
  });

  it("does not time out a route with timeoutMs disabled", async () => {
    const response = await app.inject({ method: "GET", url: "/streaming" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({ ok: true });
  });
});
