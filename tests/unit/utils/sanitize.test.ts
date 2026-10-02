import { describe, it, expect } from "vitest";
import {
  sanitizeText,
  sanitizeQuizFeedback,
  escapeLikePattern,
} from "../../../src/utils/sanitize.js";

describe("sanitizeText", () => {
  it("strips script tags and their contents", () => {
    expect(sanitizeText('<script>alert(1)</script>hi')).toBe("hi");
  });

  it("strips event-handler image payloads", () => {
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe("");
  });

  it("removes all HTML tags but keeps inner text", () => {
    expect(sanitizeText("<b>bold</b> <i>italic</i>")).toBe("bold italic");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeText("  clean  ")).toBe("clean");
  });

  it("leaves plain text untouched", () => {
    expect(sanitizeText("Hello world")).toBe("Hello world");
  });
});


describe("sanitizeQuizFeedback", () => {
  it("strips injected markup from feedback strings", () => {
    const malicious = 'Q: "<img onerror=alert(1)>" - Correct!';
    const out = sanitizeQuizFeedback(malicious);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("onerror");
    expect(out).toContain("Correct!");
  });
});

describe("escapeLikePattern (#533)", () => {
  it("escapes percent wildcards", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("%admin%")).toBe("\\%admin\\%");
  });

  it("escapes underscore wildcards", () => {
    expect(escapeLikePattern("user_name")).toBe("user\\_name");
    expect(escapeLikePattern("___")).toBe("\\_\\_\\_");
  });

  it("escapes backslashes", () => {
    expect(escapeLikePattern("path\\to")).toBe("path\\\\to");
  });

  it("handles mixed special characters", () => {
    expect(escapeLikePattern("50%_discount\\deal")).toBe("50\\%\\_discount\\\\deal");
  });

  it("leaves standard alphanumeric strings unchanged", () => {
    expect(escapeLikePattern("GBZX...123 Stellar")).toBe("GBZX...123 Stellar");
    expect(escapeLikePattern("")).toBe("");
  });
});
