import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("Request body limits", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should return 413 with expected and actual sizes for oversized JSON", async () => {
    const payload = JSON.stringify({
      stellarAddress: "G".repeat(1_100_000),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload).toString(),
      },
      payload,
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("PAYLOAD_TOO_LARGE");
    expect(body.details.expectedSize).toBe(1_048_576);
    expect(body.details.actualSize).toBeGreaterThan(1_048_576);
  });

  // #484 — routes with a tighter-than-global bodyLimit report *that* route's
  // limit as expectedSize, not the 1 MB global fallback.
  it("should enforce the profile update route's 10KB limit, not the global 1MB one", async () => {
    const token = app.jwt.sign({
      sub: "00000000-0000-0000-0000-000000000001",
      stellarAddress:
        "GALICE0000000000000000000000000000000000000000000000000000000",
    });
    const payload = JSON.stringify({ background: "x".repeat(20_000) });

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/users/me",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload).toString(),
        authorization: `Bearer ${token}`,
      },
      payload,
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe("PAYLOAD_TOO_LARGE");
    expect(body.details.expectedSize).toBe(10 * 1024);
  });
});
