import { describe, it, expect } from "vitest";
import { enrollmentTrendsQuerySchema } from "../../../src/modules/courses/course.types.js";

describe("enrollmentTrendsQuerySchema (#485)", () => {
  it("accepts the documented range/granularity values", () => {
    for (const range of ["7d", "30d", "90d"] as const) {
      for (const granularity of ["daily", "weekly", "monthly"] as const) {
        expect(enrollmentTrendsQuerySchema.safeParse({ range, granularity }).success).toBe(true);
      }
    }
  });

  it("defaults range to 30d and granularity to daily", () => {
    const result = enrollmentTrendsQuerySchema.parse({});
    expect(result.range).toBe("30d");
    expect(result.granularity).toBe("daily");
  });

  it("rejects a SQL-injection-shaped range value rather than letting it reach the interval lookup", () => {
    const result = enrollmentTrendsQuerySchema.safeParse({
      range: "7d'); DROP TABLE enrollments; --",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a SQL-injection-shaped granularity value rather than letting it reach the date_trunc lookup", () => {
    const result = enrollmentTrendsQuerySchema.safeParse({
      granularity: "day'); DROP TABLE enrollments; --",
    });
    expect(result.success).toBe(false);
  });

  it("rejects any range/granularity outside the fixed enum, closing off unmapped map lookups", () => {
    expect(enrollmentTrendsQuerySchema.safeParse({ range: "1y" }).success).toBe(false);
    expect(enrollmentTrendsQuerySchema.safeParse({ granularity: "yearly" }).success).toBe(false);
  });
});
