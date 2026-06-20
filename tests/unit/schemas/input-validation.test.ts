import { describe, it, expect } from "vitest";
import { updateProfileSchema } from "../../../src/modules/users/user.types.js";
import { submitQuizSchema } from "../../../src/modules/quizzes/quiz.types.js";

describe("updateProfileSchema", () => {
  it("sanitizes HTML out of free-text fields", () => {
    const parsed = updateProfileSchema.parse({
      displayName: '<script>alert(1)</script>Dave',
      background: "<b>builder</b>",
      learningGoal: "<img src=x onerror=alert(1)>learn rust",
    });
    expect(parsed.displayName).toBe("Dave");
    expect(parsed.background).toBe("builder");
    expect(parsed.learningGoal).toBe("learn rust");
  });

  it("leaves undefined optional fields undefined", () => {
    const parsed = updateProfileSchema.parse({ pace: "fast" });
    expect(parsed.displayName).toBeUndefined();
    expect(parsed.pace).toBe("fast");
  });

  it("rejects over-length displayName before sanitizing", () => {
    const result = updateProfileSchema.safeParse({
      displayName: "a".repeat(101),
    });
    expect(result.success).toBe(false);
  });
});

describe("submitQuizSchema", () => {
  const answer = { questionId: "q1", selectedIndex: 1 };

  it("accepts a valid submission", () => {
    expect(submitQuizSchema.safeParse({ answers: [answer] }).success).toBe(true);
  });

  it("rejects an empty answers array", () => {
    expect(submitQuizSchema.safeParse({ answers: [] }).success).toBe(false);
  });

  it("rejects selectedIndex above the max bound", () => {
    const result = submitQuizSchema.safeParse({
      answers: [{ questionId: "q1", selectedIndex: 21 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative selectedIndex", () => {
    const result = submitQuizSchema.safeParse({
      answers: [{ questionId: "q1", selectedIndex: -1 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 50 answers", () => {
    const answers = Array.from({ length: 51 }, (_, i) => ({
      questionId: `q${i}`,
      selectedIndex: 0,
    }));
    expect(submitQuizSchema.safeParse({ answers }).success).toBe(false);
  });

  it("rejects an over-length questionId", () => {
    const result = submitQuizSchema.safeParse({
      answers: [{ questionId: "x".repeat(101), selectedIndex: 0 }],
    });
    expect(result.success).toBe(false);
  });
});
