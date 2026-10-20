import { describe, expect, test } from "vitest";
import { evaluateAddE2eTestsFor631 } from "../../../src/utils/issue-631-add-e2e-tests-for-course.js";

describe("evaluateAddE2eTestsFor631", () => {
  test("classifies healthy, degraded, and critical statuses", () => {
    expect(evaluateAddE2eTestsFor631({ scopeKey: "scope-1", passedCount: 10, failedCount: 5, limitThreshold: 100 }).status).toBe("healthy");
    expect(evaluateAddE2eTestsFor631({ scopeKey: "scope-2", passedCount: 35, failedCount: 10 }).status).toBe("degraded");
    expect(evaluateAddE2eTestsFor631({ scopeKey: "scope-3", passedCount: 60, failedCount: 15, limitThreshold: 100 }).status).toBe("critical");
  });

  test("rejects blank scopeKey", () => {
    expect(() => evaluateAddE2eTestsFor631({ scopeKey: "   ", passedCount: 1, failedCount: 0 })).toThrow(/scopeKey is required/);
  });
});
