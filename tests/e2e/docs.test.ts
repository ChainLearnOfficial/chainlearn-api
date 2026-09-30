import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server.js";

describe("OpenAPI documentation", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves Swagger UI and the generated OpenAPI specification", async () => {
    const [ui, spec] = await Promise.all([
      app.inject({ method: "GET", url: "/docs/" }),
      app.inject({ method: "GET", url: "/docs/json" }),
    ]);

    expect(ui.statusCode).toBe(200);
    expect(spec.statusCode).toBe(200);
    const document = spec.json();
    expect(document.openapi).toBe("3.0.3");
    expect(Object.keys(document.paths)).toContain("/api/v1/courses/");
    expect(document.paths["/api/v1/courses/"].get.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "search" })]),
    );
    expect(document.components.securitySchemes.bearerAuth).toBeDefined();
  });
});
