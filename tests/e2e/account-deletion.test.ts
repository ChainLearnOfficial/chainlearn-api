import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { users } from "../../src/database/schema.js";

describe("DELETE /api/v1/users/me (#290)", () => {
  let app: FastifyInstance;

  const userId = "a1b2c3d4-1111-4ef8-bb6d-6bb9bd380a33";
  const stellarAddress =
    "GDELETEE2E00000000000000000000000000000000000000000000005".slice(0, 56);

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({
        id: userId,
        stellarAddress,
        displayName: "Delete Me E2E",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
    await app.close();
  });

  const token = () => app.jwt.sign({ sub: userId, stellarAddress });

  it("should reject unauthenticated requests", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/users/me",
    });

    expect(response.statusCode).toBe(401);
  });

  it("should delete the account and subsequently reject the same JWT with 401", async () => {
    const jwt = token();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(deleteResponse.statusCode).toBe(204);

    // Same JWT, now that deletedAt is set — authGuard must reject it.
    const meResponse = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(meResponse.statusCode).toBe(401);
    const body = JSON.parse(meResponse.payload);
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("should return 401 (not 404) for a repeat delete with the same now-invalid JWT", async () => {
    // The account from the previous test is already soft-deleted, and its
    // JWT is now rejected before deleteAccount would ever run again.
    const jwt = token();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(response.statusCode).toBe(401);
  });
});
