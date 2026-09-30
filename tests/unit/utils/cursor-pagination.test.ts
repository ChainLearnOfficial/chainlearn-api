import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../../../src/utils/cursor-pagination.js";

describe("cursor-pagination (#482)", () => {
  it("round-trips a (createdAt, id) pair through encode/decode", () => {
    const row = { createdAt: new Date("2026-01-15T10:30:00.000Z"), id: "abc-123" };
    const cursor = encodeCursor(row);
    const decoded = decodeCursor(cursor);

    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(row.id);
    expect(decoded!.createdAt.toISOString()).toBe(row.createdAt.toISOString());
  });

  it("produces an opaque, URL-safe string", () => {
    const cursor = encodeCursor({ createdAt: new Date(), id: "x" });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it("returns null for garbage input instead of throwing", () => {
    expect(decodeCursor("not-a-real-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null for a validly-encoded but wrong-shaped payload", () => {
    const cursor = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    expect(decodeCursor(cursor)).toBeNull();
  });

  it("returns null when createdAt isn't a valid date string", () => {
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "abc" }),
      "utf8",
    ).toString("base64url");
    expect(decodeCursor(cursor)).toBeNull();
  });
});
