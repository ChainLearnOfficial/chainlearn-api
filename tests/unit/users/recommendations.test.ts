import { describe, it, expect } from "vitest";
import {
  rankCourses,
  scoreCourse,
  targetLevel,
  type CandidateCourse,
  type RecommendationProfile,
} from "../../../src/modules/users/recommendations.js";

const baseProfile: RecommendationProfile = {
  learningGoal: null,
  background: null,
  pace: "medium",
  interestTags: [],
  highestCompletedLevel: -1,
  averageScorePercent: null,
};

function course(overrides: Partial<CandidateCourse> & { id: string }): CandidateCourse {
  return {
    title: "Course",
    description: "A course",
    difficulty: "beginner",
    tags: [],
    peerEnrollments: 0,
    ...overrides,
  };
}

describe("targetLevel", () => {
  it("starts at beginner for a new learner", () => {
    expect(targetLevel(baseProfile)).toBe(0);
  });

  it("moves one level above the highest completed", () => {
    expect(targetLevel({ ...baseProfile, highestCompletedLevel: 0 })).toBe(1);
  });

  it("stays at the reached level when quiz scores are low", () => {
    expect(
      targetLevel({ ...baseProfile, highestCompletedLevel: 1, averageScorePercent: 40 }),
    ).toBe(1);
  });

  it("skips ahead for a fast learner with high scores", () => {
    expect(
      targetLevel({ ...baseProfile, pace: "fast", highestCompletedLevel: 0, averageScorePercent: 95 }),
    ).toBe(2);
  });
});

describe("scoreCourse", () => {
  it("scores a matching course higher than an unrelated one", () => {
    const profile = { ...baseProfile, interestTags: ["stellar", "wallets"], learningGoal: "learn stellar smart contracts" };
    const match = scoreCourse(profile, course({ id: "a", tags: ["stellar"], description: "Stellar smart contracts" }), 0);
    const other = scoreCourse(profile, course({ id: "b", tags: ["cooking"], difficulty: "advanced" }), 0);
    expect(match.confidence).toBeGreaterThan(other.confidence);
    expect(match.reasons.length).toBeGreaterThan(0);
  });

  it("keeps confidence within 0 and 1", () => {
    const profile = { ...baseProfile, interestTags: ["a"], learningGoal: "alpha beta gamma delta" };
    const scored = scoreCourse(
      profile,
      course({ id: "a", tags: ["a"], title: "alpha beta gamma", peerEnrollments: 5 }),
      5,
    );
    expect(scored.confidence).toBeLessThanOrEqual(1);
    expect(scored.confidence).toBeGreaterThan(0);
  });
});

describe("rankCourses", () => {
  it("orders by confidence, limits the result and drops zero-signal courses", () => {
    const profile = { ...baseProfile, interestTags: ["stellar"] };
    const ranked = rankCourses(
      profile,
      [
        course({ id: "low", title: "Low", tags: ["x"], difficulty: "advanced" }),
        course({ id: "high", title: "High", tags: ["stellar"] }),
        course({ id: "mid", title: "Mid", tags: ["x"], peerEnrollments: 3 }),
      ],
      2,
    );
    expect(ranked.map((r) => r.courseId)).toEqual(["high", "mid"]);
  });
});
