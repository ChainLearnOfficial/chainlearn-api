import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/server.js";
import { db } from "../../src/config/database.js";
import { courses, quizSubmissions, quizzes, users } from "../../src/database/schema.js";

describe("Admin course quiz history E2E API (#658)", () => {
  let app: FastifyInstance;

  const adminUserId = "a6580000-0000-4000-8000-000000000001";
  const adminAddress = "GADMINQUIZHISTORY00000000000000000000000000000000000000".slice(0, 56);
  const learnerIds = [
    "a6580000-0000-4000-8000-000000000002",
    "a6580000-0000-4000-8000-000000000003",
    "a6580000-0000-4000-8000-000000000004",
    "a6580000-0000-4000-8000-000000000005",
  ];
  const learnerAddresses = [
    "GUSERQUIZHISTORYA0000000000000000000000000000000000000000",
    "GUSERQUIZHISTORYB0000000000000000000000000000000000000000",
    "GUSERQUIZHISTORYC0000000000000000000000000000000000000000",
    "GUSERQUIZHISTORYD0000000000000000000000000000000000000000",
  ].map((address) => address.slice(0, 56));
  const moduleId = "quiz-history-module";
  let courseId = "";
  const quizIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await db.insert(users).values({ id: adminUserId, stellarAddress: adminAddress, displayName: "Quiz History Admin", isAdmin: true }).onConflictDoNothing();
    await db.insert(users).values(learnerIds.map((id, index) => ({
      id,
      stellarAddress: learnerAddresses[index]!,
      displayName: `Quiz History Learner ${index + 1}`,
      isAdmin: false,
    }))).onConflictDoNothing();

    const [course] = await db.insert(courses).values({
      title: "Quiz History Fixture",
      description: "Fixture for module quiz history aggregation",
      difficulty: "beginner",
      modules: [{ id: moduleId, title: "Quiz History Module", description: "Assessment module", order: 0 }],
      isActive: true,
      isDraft: false,
    }).returning();
    courseId = course!.id;

    const [fourQuestionQuiz] = await db.insert(quizzes).values({
      courseId,
      moduleId,
      questions: ["q1", "q2", "q3", "q4"].map((id) => ({ id, text: `${id}?`, options: ["A", "B"], correctIndex: 0 })),
    }).returning();
    quizIds.push(fourQuestionQuiz!.id);

    const [twoQuestionQuiz] = await db.insert(quizzes).values({
      courseId,
      moduleId,
      questions: ["q1", "q2"].map((id) => ({ id, text: `${id}?`, options: ["A", "B"], correctIndex: 0 })),
    }).returning();
    quizIds.push(twoQuestionQuiz!.id);

    await db.insert(quizSubmissions).values([
      { quizId: fourQuestionQuiz!.id, userId: learnerIds[0]!, answers: [], score: 4 },
      { quizId: twoQuestionQuiz!.id, userId: learnerIds[1]!, answers: [], score: 1 },
      { quizId: fourQuestionQuiz!.id, userId: learnerIds[2]!, answers: [], score: 0, superseded: true },
    ]);
  });

  afterAll(async () => {
    if (quizIds.length) await db.delete(quizSubmissions).where(eq(quizSubmissions.quizId, quizIds[0]!));
    if (quizIds.length > 1) await db.delete(quizSubmissions).where(eq(quizSubmissions.quizId, quizIds[1]!));
    for (const id of quizIds) await db.delete(quizzes).where(eq(quizzes.id, id));
    if (courseId) await db.delete(courses).where(eq(courses.id, courseId));
    await db.delete(users).where(eq(users.id, adminUserId));
    for (const id of learnerIds) await db.delete(users).where(eq(users.id, id));
    await app.close();
  });

  const adminHeaders = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: adminUserId, stellarAddress: adminAddress })}` });

  it("requires an administrator to inspect quiz history", async () => {
    const url = `/api/v1/courses/${courseId}/modules/${moduleId}/quiz-history`;
    const unauthenticated = await app.inject({ method: "GET", url });
    expect(unauthenticated.statusCode).toBe(401);
    const learnerToken = app.jwt.sign({ sub: learnerIds[0], stellarAddress: learnerAddresses[0] });
    const forbidden = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${learnerToken}` } });
    expect(forbidden.statusCode).toBe(403);
  });

  it("aggregates module scores, excludes superseded attempts, and serves the cached result", async () => {
    const url = `/api/v1/courses/${courseId}/modules/${moduleId}/quiz-history`;
    const firstResponse = await app.inject({ method: "GET", url, headers: adminHeaders() });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json().data).toMatchObject({
      courseId,
      moduleId,
      quizCount: 2,
      totalAttempts: 2,
      averageScore: 75,
      passRate: 50,
      scoreDistribution: { "0-20": 0, "21-40": 0, "41-60": 1, "61-80": 0, "81-100": 1 },
    });

    await db.insert(quizSubmissions).values({
      quizId: quizIds[1]!,
      userId: learnerIds[3]!,
      answers: [],
      score: 2,
    });

    const cachedResponse = await app.inject({ method: "GET", url, headers: adminHeaders() });
    expect(cachedResponse.statusCode).toBe(200);
    expect(cachedResponse.json().data.totalAttempts).toBe(2);
    expect(cachedResponse.json().data.averageScore).toBe(75);
  });
});
