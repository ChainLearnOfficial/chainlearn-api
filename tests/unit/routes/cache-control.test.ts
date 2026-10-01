import { describe, expect, it } from "vitest";
import { cacheControlHeader } from "../../../src/routes/versioning.js";

describe("cacheControlHeader", () => {
  it("marks course listings as publicly cacheable", () => {
    expect(cacheControlHeader("/api/v1/courses?page=1")).toBe(
      "public, max-age=30",
    );
  });

  it("marks user profile data as private", () => {
    expect(cacheControlHeader("/api/v1/users/me")).toBe(
      "private, max-age=60",
    );
  });

  it("prevents auth responses from being stored", () => {
    expect(cacheControlHeader("/api/v1/auth/challenge")).toBe("no-store");
  });

  it("prevents error responses from being stored", () => {
    expect(cacheControlHeader("/api/v1/users/me", 401)).toBe("no-store");
  });
});
