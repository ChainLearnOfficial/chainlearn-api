/**
 * Validation rules for hand-authored quizzes (#388).
 *
 * Pure schema tests — no database — because the question rules are the part
 * of this feature most likely to let bad data into `quizzes.questions`, and
 * they need to hold on every request regardless of what the DB is doing.
 */
import { describe, expect, it } from "vitest";

import {
  authoredQuestionSchema,
  authoredQuizSchema,
  MAX_QUIZ_OPTIONS,
  adminQuizModuleParamsSchema,
  adminQuizParamsSchema,
} from "../../../src/modules/quizzes/quiz.types.js";

const validQuestion = {
  id: "q1",
  text: "What is the primary purpose of the Stellar network?",
  options: ["Social media", "Cross-border payments", "Gaming"],
  correctIndex: 1,
};

function messages(error: { issues: Array<{ message: string; path: (string | number)[] }> }) {
  return error.issues.map((issue) => issue.message);
}

describe("authoredQuestionSchema (#388)", () => {
  it("accepts a well-formed question", () => {
    const result = authoredQuestionSchema.safeParse(validQuestion);
    expect(result.success).toBe(true);
  });

  it("rejects a correctIndex past the end of the options array", () => {
    // The failure mode this guards: a stored question whose correctIndex
    // points at nothing, so submitQuiz's `options[correctIndex]` is
    // undefined and every learner is told the correct answer is "undefined".
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      options: ["A", "B"],
      correctIndex: 2,
    });

    expect(result.success).toBe(false);
    expect(messages(result.error!)[0]).toContain("out of range");
  });

  it("accepts correctIndex exactly at the last valid position", () => {
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      options: ["A", "B"],
      correctIndex: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative correctIndex", () => {
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      correctIndex: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer correctIndex", () => {
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      correctIndex: 1.5,
    });
    expect(result.success).toBe(false);
    expect(messages(result.error!)[0]).toContain("whole number");
  });

  it("coerces a numeric string correctIndex, since JSON clients send strings", () => {
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      correctIndex: "1",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.correctIndex).toBe(1);
  });

  it("requires at least two options", () => {
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      options: ["Only one"],
    });
    expect(result.success).toBe(false);
    expect(messages(result.error!)[0]).toContain("at least 2 options");
  });

  it("rejects more options than a submitted answer index can address", () => {
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      options: Array.from({ length: MAX_QUIZ_OPTIONS + 1 }, (_, i) => `Option ${i}`),
      correctIndex: 0,
    });
    expect(result.success).toBe(false);
    expect(messages(result.error!)[0]).toContain(`at most ${MAX_QUIZ_OPTIONS}`);
  });

  it("rejects blank question text and blank options", () => {
    expect(authoredQuestionSchema.safeParse({ ...validQuestion, text: "  " }).success).toBe(
      false,
    );
    expect(
      authoredQuestionSchema.safeParse({ ...validQuestion, options: ["A", "   "] }).success,
    ).toBe(false);
  });

  it("strips HTML from text, options and feedback", () => {
    // These strings are rendered back to learners inside quiz feedback, so
    // storing raw markup would be a stored-XSS vector for every client.
    const result = authoredQuestionSchema.safeParse({
      ...validQuestion,
      text: "<script>alert(1)</script>Safe text",
      options: ["<b>Bold</b> option", "Plain"],
      correctFeedback: "<img src=x onerror=alert(1)>Nice",
      incorrectFeedback: "<script>bad()</script>",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.text).not.toContain("<script");
    expect(result.data.options[0]).not.toContain("<b>");
    expect(result.data.correctFeedback ?? "").not.toContain("<img");
    expect(result.data.incorrectFeedback ?? "").not.toContain("<script");
    // Content that isn't markup survives sanitization.
    expect(result.data.text).toContain("Safe text");
  });

  it("leaves omitted feedback undefined rather than turning it into an empty string", () => {
    const result = authoredQuestionSchema.safeParse(validQuestion);
    expect(result.success && result.data.correctFeedback).toBeUndefined();
    expect(result.success && result.data.incorrectFeedback).toBeUndefined();
  });
});

describe("authoredQuizSchema (#388)", () => {
  const parse = (questions: unknown[]) =>
    authoredQuizSchema.safeParse({ questions });

  it("accepts a quiz with distinct question ids", () => {
    expect(
      parse([
        validQuestion,
        { ...validQuestion, id: "q2", text: "Another question?" },
      ]).success,
    ).toBe(true);
  });

  it("rejects duplicate question ids", () => {
    // submitQuiz resolves an answer with `questions.find(q => q.id === id)`,
    // so a duplicate id makes the second copy unreachable and permanently
    // scores as "not answered".
    const result = parse([validQuestion, { ...validQuestion, text: "Different text" }]);

    expect(result.success).toBe(false);
    expect(messages(result.error!)[0]).toContain("Duplicate question id");
    // The issue points at the *second* occurrence, not the first.
    expect(result.error!.issues[0].path).toEqual(["questions", 1, "id"]);
  });

  it("rejects an empty quiz", () => {
    expect(parse([]).success).toBe(false);
  });

  it("reports every invalid question, not just the first", async () => {
    // validate() collects all zod issues into the 400 body, so an author
    // fixing a quiz sees every problem in one round trip.
    const result = parse([
      { ...validQuestion, correctIndex: 9 },
      { ...validQuestion, id: "q2", options: ["only one"] },
    ]);

    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves the author's question order", () => {
    const result = parse([
      { ...validQuestion, id: "a" },
      { ...validQuestion, id: "b" },
      { ...validQuestion, id: "c" },
    ]);

    expect(result.success).toBe(true);
    expect(result.success && result.data.questions.map((q) => q.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("admin quiz route params (#388)", () => {
  const COURSE_ID = "11111111-2222-4333-8444-555555555555";
  const QUIZ_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

  it("requires a uuid course id and a non-empty module id", () => {
    expect(
      adminQuizModuleParamsSchema.safeParse({ id: COURSE_ID, moduleId: "m1" }).success,
    ).toBe(true);
    expect(
      adminQuizModuleParamsSchema.safeParse({ id: "not-a-uuid", moduleId: "m1" }).success,
    ).toBe(false);
    expect(
      adminQuizModuleParamsSchema.safeParse({ id: COURSE_ID, moduleId: "" }).success,
    ).toBe(false);
  });

  it("requires a uuid quiz id on the single-quiz routes", () => {
    expect(
      adminQuizParamsSchema.safeParse({
        id: COURSE_ID,
        moduleId: "m1",
        quizId: QUIZ_ID,
      }).success,
    ).toBe(true);
    expect(
      adminQuizParamsSchema.safeParse({ id: COURSE_ID, moduleId: "m1", quizId: "nope" })
        .success,
    ).toBe(false);
  });
});
