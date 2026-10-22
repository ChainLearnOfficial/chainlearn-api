import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { courses, enrollments, users } from "../../src/database/schema.js";

describe("Admin course enrollment trends E2E API (#659)", () => {
  let app: FastifyInstance;

  const adminUserId = "a6590000-0000-4000-8000-000000000001";
  const adminAddress = "GADMINENROLLTRENDS00000000000000000000000000000000000000".slice(0, 56);
  const learnerIds = [
    "a6590000-0000-4000-8000-000000000002",
    "a6590000-0000-4000-8000-000000000003",
    "a6590000-0000-4000-8000-000000000004",
    "a6590000-0000-4000-8000-000000000005",
  ];
  const learnerAddresses = [
    "GUSERENROLLTRENDSA000000000000000000000000000000000000000",
    "GUSERENROLLTRENDSB000000000000000000000000000000000000000",
    "GUSERENROLLTRENDSE00000000000000000000000000000000000000",
    "GUSERENROLLTRENDSE00000000000000000000000000000000000001",
  ].map((address) => address.slice(0, 56));
  let courseId = "";

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await db.insert(users).values({ id: adminUserId, stellarAddress: adminAddress, displayName: "Enrollment Trends Admin", isAdmin: true }).onConflictDoNothing();
    await db.insert(users).values(learnerIds.map((id, index) => ({
      id,
      stellarAddress: learnerAddresses[index]!,
      displayName: `Enrollment Trends Learner ${index + 1}`,
      isAdmin: false,
    }))).onConflictDoNothing();

    const [course] = await db.insert(courses).values({
      title: "Enrollment Trends Fixture",
      description: "Fixture for enrollment trend aggregation",
      difficulty: "beginner",
      isActive: true,
      isDraft: false,
    }).returning();
    courseId = course!.id;

    const now = Date.now();
    await db.insert(enrollments).values([
      { userId: learnerIds[0]!, courseId, enrolledAt: new Date(now - 24 * 60 * 60 * 1000) },
      { userId: learnerIds[1]!, courseId, enrolledAt: new Date(now - 3 * 24 * 60 * 60 * 1000) },
      { userId: learnerIds[2]!, courseId, enrolledAt: new Date(now - 10 * 24 * 60 * 60 * 1000) },
    ]);
  });

  afterAll(async () => {
    if (courseId) {
      await db.delete(enrollments).where(eq(enrollments.courseId, courseId));
      await db.delete(courses).where(eq(courses.id, courseId));
    }
    await db.delete(users).where(eq(users.id, adminUserId));
    for (const id of learnerIds) await db.delete(users).where(eq(users.id, id));
    await app.close();
  });

  const adminHeaders = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: adminUserId, stellarAddress: adminAddress })}` });

  it("rejects unauthenticated and non-admin requests", async () => {
    const url = `/api/v1/admin/courses/${courseId}/enrollment-trends`;
    const unauthenticated = await app.inject({ method: "GET", url });
    expect(unauthenticated.statusCode).toBe(401);

    const learnerToken = app.jwt.sign({ sub: learnerIds[0], stellarAddress: learnerAddresses[0] });
    const forbidden = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${learnerToken}` } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("filters by range, groups daily enrollments, and caches the aggregation", async () => {
    const url = `/api/v1/admin/courses/${courseId}/enrollment-trends?range=7d&granularity=daily`;
    const firstResponse = await app.inject({ method: "GET", url, headers: adminHeaders() });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json().data;
    expect(first).toMatchObject({ courseId, range: "7d", granularity: "daily", totalEnrollments: 2 });
    expect(first.trends).toHaveLength(2);
    expect(first.trends.every((point: { count: number; date: string }) => point.count === 1 && /^\d{4}-\d{2}-\d{2}/.test(point.date))).toBe(true);

    await db.insert(enrollments).values({
      userId: learnerIds[3]!,
      courseId,
      enrolledAt: new Date(),
    }).onConflictDoNothing();

    const cachedResponse = await app.inject({ method: "GET", url, headers: adminHeaders() });
    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json().data.totalEnrollments).toBe(2);

    const weeklyResponse = await app.inject({
      method: "GET",
      url: `/api/v1/admin/courses/${courseId}/enrollment-trends?range=30d&granularity=weekly`,
      headers: adminHeaders(),
    });
    expect(weeklyResponse.statusCode).toBe(200);
    expect(weeklyResponse.json().data).toMatchObject({ range: "30d", granularity: "weekly", totalEnrollments: 4 });
    expect(weeklyResponse.json().data.trends.length).toBeGreaterThan(0);
  });
});
