import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users, courses } from "../../src/database/schema.js";

describe("Admin Course Import E2E API (#650)", () => {
  let app: FastifyInstance;

  const adminUserId = "m1c2d3e4-1111-4ef8-bb6d-6bb9bd380c10";
  const adminStellarAddress = "GADMINIMPORT0000000000000000000000000000000000000000000".slice(
    0,
    56,
  );
  const nonAdminUserId = "m1c2d3e4-2222-4ef8-bb6d-6bb9bd380c10";
  const nonAdminStellarAddress =
    "GNONADMINIMPORT0000000000000000000000000000000000000000".slice(0, 56);

  const createdCourseIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: adminUserId,
        stellarAddress: adminStellarAddress,
        displayName: "Import Admin",
        isAdmin: true,
      })
      .onConflictDoNothing();

    await db
      .insert(users)
      .values({
        id: nonAdminUserId,
        stellarAddress: nonAdminStellarAddress,
        displayName: "Import Non-Admin",
        isAdmin: false,
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    for (const id of createdCourseIds) {
      await db.delete(courses).where(eq(courses.id, id));
    }
    await db.delete(users).where(eq(users.id, adminUserId));
    await db.delete(users).where(eq(users.id, nonAdminUserId));
    await app.close();
  });

  const adminToken = () =>
    app.jwt.sign({ sub: adminUserId, stellarAddress: adminStellarAddress });

  const nonAdminToken = () =>
    app.jwt.sign({ sub: nonAdminUserId, stellarAddress: nonAdminStellarAddress });

  function createMultipartPayload(
    fileContent: string,
    filename = "course.json",
    contentType = "application/json",
  ) {
    const boundary = "----WebKitFormBoundaryImportCourseTest123";
    const payload = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${contentType}`,
      "",
      fileContent,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      payload,
    };
  }

  describe("Authentication & Authorization", () => {
    it("should reject unauthenticated requests with 401", async () => {
      const { contentType, payload } = createMultipartPayload(
        JSON.stringify({ title: "Unauth Course", description: "Desc" }),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: { "content-type": contentType },
        payload,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should reject non-admin users with 403", async () => {
      const { contentType, payload } = createMultipartPayload(
        JSON.stringify({ title: "Non-Admin Course", description: "Desc" }),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${nonAdminToken()}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("Request Format & Error Handling", () => {
    it("should reject requests that are not multipart/form-data with 400", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${adminToken()}`,
          "content-type": "application/json",
        },
        payload: { title: "Direct JSON Course", description: "Desc" },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBeDefined();
    });

    it("should reject multipart requests without a file field with 400", async () => {
      const boundary = "----WebKitFormBoundaryEmptyField";
      const emptyPayload = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="otherField"',
        "",
        "some value",
        `--${boundary}--`,
        "",
      ].join("\r\n");

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${adminToken()}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: emptyPayload,
      });

      expect(response.statusCode).toBe(400);
    });

    it("should reject malformed non-JSON file content with 400", async () => {
      const { contentType, payload } = createMultipartPayload(
        "INVALID NOT JSON DATA {{{",
        "corrupt.json",
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${adminToken()}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBeDefined();
    });
  });

  describe("JSON Validation & Course Import Execution (#650 / #366)", () => {
    it("should reject JSON missing required course fields (e.g. title or description)", async () => {
      const invalidCourseJson = {
        difficulty: "beginner",
        tags: ["stellar"],
        // Missing title and description
      };

      const { contentType, payload } = createMultipartPayload(
        JSON.stringify(invalidCourseJson),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${adminToken()}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.error).toBeDefined();
    });

    it("should reject JSON with invalid difficulty enum", async () => {
      const invalidDifficultyJson = {
        title: "Invalid Difficulty Course",
        description: "Valid description",
        difficulty: "expert", // Not in ["beginner", "intermediate", "advanced"]
      };

      const { contentType, payload } = createMultipartPayload(
        JSON.stringify(invalidDifficultyJson),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${adminToken()}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    it("should successfully import a valid course with nested modules", async () => {
      const validImportJson = {
        title: "Imported Stellar Smart Contracts",
        description: "Learn how to build Soroban smart contracts on Stellar",
        difficulty: "intermediate",
        tags: ["soroban", "rust", "stellar"],
        modules: [
          {
            title: "Environment Setup",
            description: "Install Rust and Soroban CLI",
            order: 0,
          },
          {
            title: "Contract Syntax",
            description: "Writing and building your first contract",
            order: 1,
          },
        ],
      };

      const { contentType, payload } = createMultipartPayload(
        JSON.stringify(validImportJson),
      );

      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/courses/import",
        headers: {
          authorization: `Bearer ${adminToken()}`,
          "content-type": contentType,
        },
        payload,
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.courseId).toBeDefined();
      expect(body.data.modulesCreated).toBe(2);

      createdCourseIds.push(body.data.courseId);

      // Verify DB record
      const [importedCourse] = await db
        .select()
        .from(courses)
        .where(eq(courses.id, body.data.courseId));

      expect(importedCourse).toBeDefined();
      expect(importedCourse?.title).toBe("Imported Stellar Smart Contracts");
      expect(importedCourse?.difficulty).toBe("intermediate");
      expect(importedCourse?.modules).toHaveLength(2);
    });
  });
});
