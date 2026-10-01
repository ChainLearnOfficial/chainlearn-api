import { describe, it, expect } from "vitest";
import { updateProfileSchema } from "../../../src/modules/users/user.types.js";
import { submitQuizSchema } from "../../../src/modules/quizzes/quiz.types.js";
import {
  createCourseSchema,
  listCoursesSchema,
} from "../../../src/modules/courses/course.types.js";
import { batchMintCredentialSchema } from "../../../src/modules/credentials/credential.types.js";

describe("listCoursesSchema", () => {
  it("accepts an optional search term", () => {
    expect(listCoursesSchema.parse({ search: "stellar" }).search).toBe("stellar");
  });

  it("accepts an empty search term so the service can ignore it", () => {
    expect(listCoursesSchema.safeParse({ search: "" }).success).toBe(true);
  });
});

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

describe("createCourseSchema", () => {
  it("accepts optional course module metadata", () => {
    const parsed = createCourseSchema.parse({
      title: "Stellar Basics",
      description: "Learn Stellar",
      courseModules: [
        {
          id: "intro",
          title: "Introduction",
          description: "Network foundations",
          estimatedDurationMinutes: 15,
        },
      ],
    });

    expect(parsed.courseModules?.[0]).toMatchObject({
      id: "intro",
      title: "Introduction",
      estimatedDurationMinutes: 15,
    });
  });

  it("rejects invalid course module duration", () => {
    const result = createCourseSchema.safeParse({
      title: "Stellar Basics",
      description: "Learn Stellar",
      courseModules: [
        {
          id: "intro",
          title: "Introduction",
          estimatedDurationMinutes: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("batchMintCredentialSchema", () => {
  it("accepts course/submission pairs", () => {
    const result = batchMintCredentialSchema.safeParse({
      submissions: [
        {
          courseId: "00000000-0000-0000-0000-000000000001",
          submissionId: "00000000-0000-0000-0000-000000000002",
        },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("rejects an empty batch", () => {
    expect(
      batchMintCredentialSchema.safeParse({ submissions: [] }).success,
    ).toBe(false);
  });
});
