/**
 * Renders a course-completion certificate to a PDF buffer (#387).
 *
 * Deliberately pure: it takes a fully-resolved `CompletionCertificateData`
 * and returns bytes, with no database, cache, or HTTP knowledge. That keeps
 * the layout testable on its own (see tests/unit/credentials/
 * completion-certificate.test.ts) and keeps the eligibility/caching logic in
 * CredentialService, where the rest of the certificate concerns live.
 *
 * Font note: only the PDF standard 14 fonts (Helvetica family) are used, so
 * no font files have to be shipped or registered. A custom font would also
 * need to handle non-Latin display names — the standard fonts have no glyphs
 * outside WinAnsi, so an accented or non-Latin name renders as garbage
 * rather than failing. A custom font is the fix if that ever matters.
 */
import PDFDocument from "pdfkit";

/** US Letter, in PostScript points. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const ACCENT = "#1f4e79";

/**
 * Absolute vertical positions (points from the top of the page) rather than
 * pdfkit's running cursor. A certificate is a fixed composition: stacking
 * centred lines with moveDown() drifts a few points per line, which is what
 * pushed the wordmark over the top rule on the first pass.
 */
const LAYOUT = {
  /** Below the inner rule, with clearance. */
  brand: 118,
  title: 158,
  titleRule: 212,
  certifyThat: 330,
  recipient: 356,
  recipientAddress: 402,
  completed: 452,
  course: 478,
  courseMeta: 528,
  /** Footer block sits just above the bottom rule — the vertical accent
   *  beside it is 44pt tall, so 688 + 44 = 732 stays clear of the inner
   *  rule at PAGE_HEIGHT - MARGIN - 6 = 738. */
  footer: 688,
  footerRuleHeight: 44,
} as const;

export interface CompletionCertificateData {
  /** Certificate number, printed on the document. Stable for a given
   *  (user, course) pair so a re-download is recognizably the same
   *  certificate. */
  certificateId: string;
  /** Recipient's display name, already resolved to a non-empty fallback. */
  userName: string;
  /** The recipient's Stellar address, printed as a secondary identifier. */
  stellarAddress: string;
  courseTitle: string;
  courseDifficulty: string;
  /** The course id, printed so the certificate is traceable. */
  courseId: string;
  /** Date the course was completed, already formatted. */
  completedOn: string;
  /** Modules completed / total, e.g. "4 of 4". */
  modulesCompleted: string;
  /** Stellar Explorer URL for the on-chain credential, when the user has
   *  minted one. Null otherwise — this PDF stands on its own without it. */
  onChainVerificationUrl: string | null;
}

/**
 * Build the certificate PDF. Returns the complete document as a Buffer,
 * which Fastify can send directly as `application/pdf`.
 */
export function renderCompletionCertificate(
  data: CompletionCertificateData,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER",
      margin: MARGIN,
      // Document metadata is stored in plaintext, is readable by file
      // managers and search tools, and survives the visible content being
      // stripped — so the learner's name is deliberately kept out of it.
      info: {
        Title: `Certificate of Completion — ${data.courseTitle}`,
        Author: "ChainLearn",
        Subject: "Course completion certificate",
        Keywords: "certificate, course completion",
        CreationDate: new Date(data.completedOn),
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawFrame(doc);
    drawBrand(doc);
    drawRecipient(doc, data);
    drawCourse(doc, data);
    drawFooter(doc, data);

    doc.end();
  });
}

/** Double rule inset from the page edge, the conventional certificate border. */
function drawFrame(doc: PDFKit.PDFDocument): void {
  doc
    .lineWidth(2)
    .strokeColor(ACCENT)
    .rect(MARGIN, MARGIN, CONTENT_WIDTH, PAGE_HEIGHT - MARGIN * 2)
    .stroke();

  doc
    .lineWidth(0.5)
    .strokeColor(MUTED)
    .rect(MARGIN + 6, MARGIN + 6, CONTENT_WIDTH - 12, PAGE_HEIGHT - MARGIN * 2 - 12)
    .stroke();
}

/** Wordmark, document title, and the rule beneath it. */
function drawBrand(doc: PDFKit.PDFDocument): void {
  doc
    .fillColor(ACCENT)
    .font("Helvetica-Bold")
    .fontSize(11)
    .text("CHAINLEARN", MARGIN, LAYOUT.brand, {
      align: "center",
      width: CONTENT_WIDTH,
      characterSpacing: 4,
    });

  doc
    .fillColor(ACCENT)
    .fontSize(32)
    .text("Certificate of Completion", MARGIN, LAYOUT.title, {
      align: "center",
      width: CONTENT_WIDTH,
    });

  doc
    .moveTo(PAGE_WIDTH / 2 - 60, LAYOUT.titleRule)
    .lineTo(PAGE_WIDTH / 2 + 60, LAYOUT.titleRule)
    .lineWidth(1)
    .strokeColor(ACCENT)
    .stroke();
}

/**
 * Draw a centred line, shrinking the type until the string fits within
 * `maxHeight` when wrapped to the content width.
 *
 * Measuring the unwrapped width and scaling proportionally is not enough: it
 * ignores wrapping entirely, so a long name stayed one line and spilled past
 * the border rule. Asking PDFKit for the wrapped height instead converges on
 * a size that is guaranteed to fit the box it is drawn into.
 */
function drawFittedLine(
  doc: PDFKit.PDFDocument,
  text: string,
  options: {
    y: number;
    font: string;
    size: number;
    minimumSize: number;
    color: string;
    maxHeight: number;
  },
): void {
  doc.font(options.font).fillColor(options.color);

  let size = options.size;
  doc.fontSize(size);
  while (
    size > options.minimumSize &&
    doc.heightOfString(text, { width: CONTENT_WIDTH, lineBreak: true }) >
      options.maxHeight
  ) {
    size -= 0.5;
    doc.fontSize(size);
  }

  doc.text(text, MARGIN, options.y, {
    align: "center",
    width: CONTENT_WIDTH,
    lineBreak: true,
  });
}

function drawRecipient(
  doc: PDFKit.PDFDocument,
  data: CompletionCertificateData,
): void {
  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(11)
    .text("This certifies that", MARGIN, LAYOUT.certifyThat, {
      align: "center",
      width: CONTENT_WIDTH,
    });

  drawFittedLine(doc, data.userName, {
    y: LAYOUT.recipient,
    font: "Helvetica-Bold",
    size: 26,
    minimumSize: 11,
    color: INK,
    // Room for two lines before the Stellar address below it.
    maxHeight: 44,
  });

  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text(data.stellarAddress, MARGIN, LAYOUT.recipientAddress, {
      align: "center",
      width: CONTENT_WIDTH,
    });

  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(11)
    .text("has successfully completed", MARGIN, LAYOUT.completed, {
      align: "center",
      width: CONTENT_WIDTH,
    });
}

function drawCourse(
  doc: PDFKit.PDFDocument,
  data: CompletionCertificateData,
): void {
  drawFittedLine(doc, data.courseTitle, {
    y: LAYOUT.course,
    font: "Helvetica-Bold",
    size: 20,
    minimumSize: 10,
    color: ACCENT,
    // Room for two lines before the level/date line below it.
    maxHeight: 40,
  });

  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(10)
    .text(
      `Level: ${data.courseDifficulty}   ·   Modules completed: ${data.modulesCompleted}   ·   Completed on ${data.completedOn}`,
      MARGIN,
      LAYOUT.courseMeta,
      { align: "center", width: CONTENT_WIDTH },
    );
}

function drawFooter(
  doc: PDFKit.PDFDocument,
  data: CompletionCertificateData,
): void {
  const footerWidth = CONTENT_WIDTH - 56;

  doc
    .moveTo(MARGIN + 24, LAYOUT.footer)
    .lineTo(MARGIN + 24, LAYOUT.footer + LAYOUT.footerRuleHeight)
    .lineWidth(0.5)
    .strokeColor(MUTED)
    .stroke();

  doc
    .fillColor(MUTED)
    .font("Helvetica")
    .fontSize(8)
    .text(`Certificate ${data.certificateId}`, MARGIN + 32, LAYOUT.footer, {
      width: footerWidth,
    })
    .text(`Course ${data.courseId}`, { width: footerWidth });

  if (data.onChainVerificationUrl) {
    doc
      .text("Verify the on-chain credential:", { width: footerWidth })
      .text(data.onChainVerificationUrl, { width: footerWidth, lineBreak: true });
  } else {
    doc.text(
      "This certificate is issued by ChainLearn. It is not a blockchain credential.",
      { width: footerWidth },
    );
  }
}
