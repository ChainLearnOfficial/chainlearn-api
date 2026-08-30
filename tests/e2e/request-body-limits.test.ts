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
});
