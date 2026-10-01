import { describe, it, expect } from "vitest";
import { checkAccessibility } from "../../../src/modules/courses/accessibility.js";

describe("checkAccessibility (#326)", () => {
  it("gives a perfect score to accessible content", () => {
    const report = checkAccessibility({
      description: [
        "# Introduction",
        "## Getting started",
        'Read the <a href="/setup">setup guide</a> before you begin.',
        '<img src="/diagram.png" alt="Architecture diagram of the reward flow">',
        "![Sequence diagram of a quiz submission](/seq.png)",
      ].join("\n"),
    });
    expect(report).toEqual({ score: 100, warnings: [] });
  });

  it("flags images without alt text", () => {
    const report = checkAccessibility({
      description: '<img src="/a.png"> and ![](/b.png)',
    });
    expect(report.warnings.map((w) => w.rule)).toEqual([
      "image-alt-text",
      "image-alt-text",
    ]);
    expect(report.score).toBe(80);
  });

  it("flags an empty alt as distinct from a missing one", () => {
    const report = checkAccessibility({ description: '<img src="/a.png" alt="  ">' });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0].message).toContain("empty alt");
  });

  it("flags skipped heading levels and a bad starting level", () => {
    const report = checkAccessibility({
      description: "### Deep start\n\n<h5>Way too deep</h5>",
    });
    const rules = report.warnings.map((w) => w.rule);
    expect(rules).toEqual(["heading-hierarchy", "heading-hierarchy"]);
  });

  it("flags non-descriptive and bare-URL link text", () => {
    const report = checkAccessibility({
      description:
        '[click here](/x) and <a href="/y">https://example.com/y</a> and [Guide](/z)',
    });
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings.every((w) => w.rule === "link-text")).toBe(true);
  });

  it("attributes warnings to the field they came from and floors the score at 0", () => {
    const bad = "<img src=x><img src=x><img src=x><img src=x><img src=x>";
    const report = checkAccessibility({
      description: bad,
      'module "Intro"': bad,
    });
    expect(report.score).toBe(0);
    expect(new Set(report.warnings.map((w) => w.field))).toEqual(
      new Set(["description", 'module "Intro"']),
    );
  });

  it("ignores empty / missing fields", () => {
    expect(checkAccessibility({ description: null, extra: undefined })).toEqual({
      score: 100,
      warnings: [],
    });
  });
});
