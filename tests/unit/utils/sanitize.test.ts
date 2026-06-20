import { describe, it, expect } from "vitest";
import {
  sanitizeText,
  sanitizeMarkdown,
  sanitizeQuizFeedback,
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

describe("sanitizeMarkdown", () => {
  it("keeps allowed formatting tags", () => {
    expect(sanitizeMarkdown("<strong>x</strong>")).toBe("<strong>x</strong>");
  });

  it("drops disallowed tags but keeps allowed ones", () => {
    expect(sanitizeMarkdown('<script>bad()</script><em>ok</em>')).toBe(
      "<em>ok</em>"
    );
  });

  it("strips attributes from allowed tags", () => {
    expect(sanitizeMarkdown('<p onclick="x()">t</p>')).toBe("<p>t</p>");
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
