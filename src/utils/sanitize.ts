import sanitizeHtml from "sanitize-html";

// Strict: strip ALL HTML. Used for plain-text fields (names, goals, feedback).
const STRICT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

// Markdown-ish: allow a small set of formatting tags, no attributes.
const MARKDOWN_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ["b", "i", "em", "strong", "p", "br", "ul", "ol", "li", "code", "pre"],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

/** Strip all HTML/script content and trim. Use for untrusted plain-text input. */
export function sanitizeText(input: string): string {
  return sanitizeHtml(input, STRICT_OPTIONS).trim();
}

/** Allow a limited set of formatting tags; strip everything else. */
export function sanitizeMarkdown(input: string): string {
  return sanitizeHtml(input, MARKDOWN_OPTIONS).trim();
}

/**
 * Sanitize strings built from user-controlled quiz content before they are
 * stored as feedback. Strips all HTML so the frontend can't be tricked into
 * executing injected markup (e.g. via dangerouslySetInnerHTML).
 */
export function sanitizeQuizFeedback(input: string): string {
  return sanitizeHtml(input, STRICT_OPTIONS);
}
