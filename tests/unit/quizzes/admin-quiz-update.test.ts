import { describe, expect, it } from "vitest";

import { adminUpdateQuizSchema } from "../../../src/modules/quizzes/quiz.types.js";

const question = {
  id: "q1",
  text: "What does a Stellar account need before it can hold an asset?",
  options: ["A trustline", "A password"],
  correctIndex: 0,
};

describe("adminUpdateQuizSchema (#413)", () => {
  it("accepts a full question replacement", () => {
    const result = adminUpdateQuizSchema.safeParse({ questions: [question] });
    expect(result.success).toBe(true);
  });

  it("accepts archiving without replacing questions", () => {
    const result = adminUpdateQuizSchema.safeParse({ archived: true });
    expect(result.success).toBe(true);
  });

  it("merges metadata and strips markup from string values", () => {
    const result = adminUpdateQuizSchema.safeParse({
      metadata: { title: "<b>Week 1</b>", passingScore: 70 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata?.title).toBe("Week 1");
      expect(result.data.metadata?.passingScore).toBe(70);
    }
  });

  it("rejects an empty body", () => {
    const result = adminUpdateQuizSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects duplicate question ids", () => {
    const result = adminUpdateQuizSchema.safeParse({
      questions: [question, { ...question }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a correctIndex past the options", () => {
    const result = adminUpdateQuizSchema.safeParse({
      questions: [{ ...question, correctIndex: 5 }],
    });
    expect(result.success).toBe(false);
  });
});
