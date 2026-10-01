/**
 * Basic course-content accessibility checks (#326).
 *
 * Deliberately lightweight and non-blocking: course content is stored as
 * free text that may contain HTML or Markdown, and authors get *warnings*
 * (never hard errors) plus a 0–100 score so accessibility regressions are
 * visible without gating publishing. The checks cover the three cheapest,
 * highest-signal WCAG issues: images without alt text, skipped heading
 * levels, and non-descriptive link text.
 */

export type AccessibilityRule =
  | "image-alt-text"
  | "heading-hierarchy"
  | "link-text";

export interface AccessibilityWarning {
  rule: AccessibilityRule;
  /** The content field the warning was found in (e.g. "description"). */
  field: string;
  message: string;
}

export interface AccessibilityReport {
  /** 0–100. 100 = no warnings. Each warning costs 10 points, floored at 0. */
  score: number;
  warnings: AccessibilityWarning[];
}

const WARNING_PENALTY = 10;

// Link text that tells a screen-reader user nothing about the destination.
const NON_DESCRIPTIVE_LINK_TEXT = new Set([
  "click here",
  "here",
  "read more",
  "more",
  "link",
  "this link",
  "this",
  "learn more",
  "download",
  "go",
  "click",
]);

function checkImages(field: string, content: string): AccessibilityWarning[] {
  const warnings: AccessibilityWarning[] = [];

  // HTML <img> tags.
  for (const match of content.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const alt = /\balt\s*=\s*("([^"]*)"|'([^']*)'|[^\s>]+)/i.exec(tag);
    const altValue = alt ? (alt[2] ?? alt[3] ?? alt[1]).trim() : null;
    if (altValue === null) {
      warnings.push({
        rule: "image-alt-text",
        field,
        message: `Image is missing an alt attribute: ${truncate(tag)}`,
      });
    } else if (altValue === "") {
      warnings.push({
        rule: "image-alt-text",
        field,
        message: `Image has an empty alt attribute (use alt="" only for decorative images): ${truncate(tag)}`,
      });
    }
  }

  // Markdown images: ![alt](src)
  for (const match of content.matchAll(/!\[([^\]]*)\]\(([^)]*)\)/g)) {
    if (match[1].trim() === "") {
      warnings.push({
        rule: "image-alt-text",
        field,
        message: `Markdown image is missing alt text: ${truncate(match[0])}`,
      });
    }
  }

  return warnings;
}

function checkHeadings(field: string, content: string): AccessibilityWarning[] {
  const warnings: AccessibilityWarning[] = [];

  // Collect HTML and Markdown headings together, in document order.
  const found: Array<{ index: number; level: number }> = [];
  for (const match of content.matchAll(/<h([1-6])\b[^>]*>/gi)) {
    found.push({ index: match.index ?? 0, level: Number(match[1]) });
  }
  for (const match of content.matchAll(/^(#{1,6})\s+\S/gm)) {
    found.push({ index: match.index ?? 0, level: match[1].length });
  }
  found.sort((a, b) => a.index - b.index);
  const levels = found.map((h) => h.level);

  if (levels.length === 0) return warnings;

  if (levels[0] > 2) {
    warnings.push({
      rule: "heading-hierarchy",
      field,
      message: `Content starts at heading level h${levels[0]} — start at h1 or h2 and nest from there.`,
    });
  }

  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      warnings.push({
        rule: "heading-hierarchy",
        field,
        message: `Heading level jumps from h${levels[i - 1]} to h${levels[i]} — don't skip levels.`,
      });
    }
  }

  return warnings;
}

function checkLinks(field: string, content: string): AccessibilityWarning[] {
  const warnings: AccessibilityWarning[] = [];

  const flag = (text: string, raw: string) => {
    const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
    if (normalized === "") {
      warnings.push({
        rule: "link-text",
        field,
        message: `Link has no text: ${truncate(raw)}`,
      });
    } else if (NON_DESCRIPTIVE_LINK_TEXT.has(normalized.replace(/[.!]+$/, ""))) {
      warnings.push({
        rule: "link-text",
        field,
        message: `Link text "${text.trim()}" is not descriptive — say where the link goes.`,
      });
    } else if (/^https?:\/\/\S+$/i.test(normalized)) {
      warnings.push({
        rule: "link-text",
        field,
        message: `Link text is a bare URL (${truncate(text.trim())}) — use human-readable text instead.`,
      });
    }
  };

  for (const match of content.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    flag(match[1].replace(/<[^>]+>/g, ""), match[0]);
  }
  for (const match of content.matchAll(/\[([^\]]*)\]\(([^)]*)\)/g)) {
    // Skip image links (![alt](src)) — handled by checkImages.
    if (content[match.index! - 1] === "!") continue;
    flag(match[1], match[0]);
  }

  return warnings;
}

function truncate(text: string, max = 80): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * Run every accessibility check over a set of named content fields and
 * combine the result into a single report.
 */
export function checkAccessibility(
  fields: Record<string, string | null | undefined>,
): AccessibilityReport {
  const warnings: AccessibilityWarning[] = [];

  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    warnings.push(
      ...checkImages(field, value),
      ...checkHeadings(field, value),
      ...checkLinks(field, value),
    );
  }

  const score = Math.max(0, 100 - warnings.length * WARNING_PENALTY);
  return { score, warnings };
}
