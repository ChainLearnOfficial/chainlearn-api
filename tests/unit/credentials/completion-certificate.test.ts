/**
 * Certificate PDF rendering (#387).
 *
 * The renderer is a pure function, so these run with no database or cache.
 * What matters here is that it produces a real, well-formed PDF that a
 * viewer will open — the layout details are asserted loosely on purpose,
 * since reflowing the page shouldn't require rewriting the test.
 */
import { describe, expect, it } from "vitest";
import zlib from "node:zlib";

import {
  renderCompletionCertificate,
  type CompletionCertificateData,
} from "../../../src/modules/credentials/completion-certificate.js";

const baseData: CompletionCertificateData = {
  certificateId: "A1B2C3D4E5F60718",
  userName: "Ada Lovelace",
  stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  courseTitle: "Introduction to Stellar Soroban",
  courseDifficulty: "intermediate",
  courseId: "11111111-2222-4333-8444-555555555555",
  completedOn: "2026-09-26",
  modulesCompleted: "4 of 4",
  onChainVerificationUrl:
    "https://stellar.expert/explorer/testnet/tx/abc123",
};

/** Decode one PDF string token: either a hex string `<...>` or a literal
 *  `(...)`. pdfkit emits hex strings for text runs. */
function decodeString(token: string): string {
  if (token.startsWith("<")) {
    const hex = token.slice(1, -1);
    let out = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }
  return token.slice(1, -1).replace(/\\([()\\])/g, "$1");
}

/**
 * Every string drawn into the page, in order.
 *
 * PDFKit writes text as `[<hex> kerning <hex> ...] TJ` inside a FlateDecode
 * compressed content stream, so this inflates each stream and then pulls the
 * string tokens out of the show-text operators. Kerning numbers between the
 * strings are dropped.
 */
function extractText(pdf: Buffer): string {
  const STREAM = Buffer.from("stream", "latin1");
  const ENDSTREAM = Buffer.from("endstream", "latin1");

  let content = "";
  let cursor = 0;
  while (true) {
    const start = pdf.indexOf(STREAM, cursor);
    if (start === -1) break;
    let bodyStart = start + STREAM.length;
    while (pdf[bodyStart] === 0x0d || pdf[bodyStart] === 0x0a) bodyStart++;
    const end = pdf.indexOf(ENDSTREAM, bodyStart);
    if (end === -1) break;
    cursor = end + ENDSTREAM.length;

    const body = pdf.subarray(bodyStart, end);
    try {
      content += zlib.inflateSync(body).toString("latin1") + "\n";
    } catch {
      // Not a Flate stream (e.g. the font file) — nothing to read.
    }
  }

  const drawn: string[] = [];
  // Show-text arrays first, so their inner strings aren't double-counted.
  const TOKEN = /\((?:\\.|[^()\\])*\)|<[0-9a-fA-F\s]*>/g;

  for (const match of content.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    drawn.push(
      [...match[1].matchAll(TOKEN)].map((t) => decodeString(t[0])).join(""),
    );
  }
  for (const match of content.matchAll(/\((?:\\.|[^()\\])*\)\s*Tj/g)) {
    drawn.push(decodeString(match[0].slice(0, match[0].indexOf(")")).concat(")")));
  }

  return drawn.join(" ");
}

/**
 * The PDF with every stream body removed, leaving the object dictionaries,
 * catalog and trailer. Lets a test assert on document *structure* (active
 * content, actions) without the text-drawing content stream getting in the
 * way — a learner's display name is drawn as literal text, so grepping the
 * whole file for a marker like `/JavaScript` would match the name itself.
 */
function withoutStreams(pdf: Buffer): string {
  const STREAM = Buffer.from("stream", "latin1");
  const ENDSTREAM = Buffer.from("endstream", "latin1");

  const kept: Buffer[] = [];
  let cursor = 0;
  while (true) {
    const start = pdf.indexOf(STREAM, cursor);
    if (start === -1) break;
    const end = pdf.indexOf(ENDSTREAM, start);
    if (end === -1) break;
    kept.push(pdf.subarray(cursor, start));
    cursor = end + ENDSTREAM.length;
  }
  kept.push(pdf.subarray(cursor));

  return Buffer.concat(kept).toString("latin1");
}

describe("renderCompletionCertificate (#387)", () => {
  it("returns a non-empty buffer that is a real PDF document", async () => {
    const pdf = await renderCompletionCertificate(baseData);

    expect(pdf.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    // %PDF- header and %%EOF trailer.
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.subarray(-1024).toString("latin1")).toContain("%%EOF");
  });

  it("includes the recipient, the course, and the completion date", async () => {
    const text = extractText(await renderCompletionCertificate(baseData));

    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("Introduction to Stellar Soroban");
    expect(text).toContain("2026-09-26");
    expect(text).toContain("intermediate");
    expect(text).toContain("4 of 4");
  });

  it("prints the certificate and course identifiers", async () => {
    const text = extractText(await renderCompletionCertificate(baseData));

    expect(text).toContain(baseData.certificateId);
    expect(text).toContain(baseData.courseId);
  });

  it("includes the on-chain verification link when there is a credential", async () => {
    const text = extractText(await renderCompletionCertificate(baseData));
    expect(text).toContain("stellar.expert");
  });

  it("says so explicitly when there is no on-chain credential", async () => {
    const text = extractText(
      await renderCompletionCertificate({
        ...baseData,
        onChainVerificationUrl: null,
      }),
    );

    expect(text).not.toContain("stellar.expert");
    expect(text).toContain("not a blockchain credential");
  });

  it("renders a very long course title without throwing or emitting an error", async () => {
    // The renderer shrinks oversized headings to fit the content width
    // rather than letting them run off the page.
    const pdf = await renderCompletionCertificate({
      ...baseData,
      courseTitle: "A".repeat(400),
    });

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a very long recipient name without throwing", async () => {
    const pdf = await renderCompletionCertificate({
      ...baseData,
      userName: "Bartholomew ".repeat(40).trim(),
    });

    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("keeps the learner's name out of the plaintext document metadata", async () => {
    // PDF metadata is stored uncompressed in the Info dictionary, is read by
    // file managers and search tools, and survives the visible content being
    // stripped — so the recipient's name belongs only in the drawn text.
    const structure = withoutStreams(
      await renderCompletionCertificate({
        ...baseData,
        userName: "Unique Learner Name",
      }),
    );

    expect(structure).not.toContain("Unique Learner Name");
  });

  it("draws a hostile display name as inert text, and adds no active content", async () => {
    // Display names are free text, and a certificate has to actually show
    // the learner's name — so the string is drawn verbatim. The safety
    // property is that it stays *text*: the document must not gain a
    // JavaScript action or an auto-run action because of it. A viewer
    // renders drawn glyphs, it does not execute them.
    const pdf = await renderCompletionCertificate({
      ...baseData,
      userName: "() /JavaScript <script>alert(1)</script>",
    });

    // The name is present as drawn text...
    expect(extractText(pdf)).toContain("JavaScript");

    // ...and the document structure gains no active content. Checked on the
    // stream-stripped bytes so the drawn name can't produce a false match.
    const structure = withoutStreams(pdf);
    expect(structure).not.toContain("/JavaScript");
    expect(structure).not.toContain("/JS");
    expect(structure).not.toContain("/OpenAction");
    expect(structure).not.toContain("/AA");
    expect(structure).not.toContain("/Launch");
    expect(structure).not.toContain("/EmbeddedFile");
  });

  it("adds no active content for a plain render either", async () => {
    // Belt and braces: the renderer has no path that emits a PDF action, so
    // even an ordinary certificate should be structurally inert.
    const structure = withoutStreams(await renderCompletionCertificate(baseData));

    expect(structure).not.toContain("/JavaScript");
    expect(structure).not.toContain("/OpenAction");
    expect(structure).not.toContain("/EmbeddedFile");
  });
});
