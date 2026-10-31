import { inflateSync } from 'node:zlib';

/**
 * Minimal PDF text extraction.
 *
 * Scope and honesty: this reads text from PDFs whose content streams are
 * uncompressed or FlateDecode-compressed, which covers documents produced by
 * the office suites and web exporters a contractor actually uses. It does not
 * do OCR, does not resolve custom font encodings, and does not handle scanned
 * documents — those return no text, which the DOC.READABLE compliance rule is
 * there to catch rather than paper over.
 *
 * A production deployment would put pdfjs or Tika behind this same function
 * signature, and OCR behind that. The interface is the point; the parser is
 * replaceable.
 */

export interface ExtractedText {
  text: string;
  /** Streams successfully decoded, as a rough proxy for coverage. */
  streamsDecoded: number;
  streamsTotal: number;
}

const STREAM_PATTERN = /stream\r?\n?([\s\S]*?)endstream/g;

export function extractPdfText(buffer: Buffer): ExtractedText {
  const raw = buffer.toString('latin1');
  const chunks: string[] = [];
  let streamsTotal = 0;
  let streamsDecoded = 0;

  for (const match of raw.matchAll(STREAM_PATTERN)) {
    streamsTotal += 1;
    const body = Buffer.from(match[1], 'latin1');

    let decoded: Buffer | null = null;
    try {
      decoded = inflateSync(body);
    } catch {
      // Not Flate-compressed, or compressed with a filter we do not implement.
      // An uncompressed content stream is still readable as-is.
      decoded = looksLikeContentStream(body) ? body : null;
    }

    if (!decoded) continue;
    streamsDecoded += 1;

    const text = readTextOperators(decoded.toString('latin1'));
    if (text.trim()) chunks.push(text);
  }

  return {
    text: normaliseWhitespace(chunks.join('\n')),
    streamsDecoded,
    streamsTotal,
  };
}

/** Does this look like page content rather than an embedded font or image? */
function looksLikeContentStream(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 2048).toString('latin1');
  return /\bBT\b|\bTj\b|\bTJ\b/.test(head);
}

/**
 * Pull the string arguments out of the text-showing operators.
 *
 *   (Sertifikat Badan Usaha) Tj
 *   [(Masa) -250 (Berlaku)] TJ
 */
function readTextOperators(content: string): string {
  const out: string[] = [];

  // Tj / ' / " — a single string argument
  for (const match of content.matchAll(/\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g)) {
    out.push(decodePdfString(match[0].slice(0, match[0].lastIndexOf(')') + 1)));
  }

  // TJ — an array of strings interleaved with kerning numbers
  for (const match of content.matchAll(/\[((?:[^\][\\]|\\.)*)\]\s*TJ/g)) {
    const parts = match[1].matchAll(/\((?:\\.|[^\\()])*\)/g);
    const line = [...parts].map((part) => decodePdfString(part[0])).join('');
    if (line) out.push(line);
  }

  return out.join('\n');
}

/** Resolve PDF string escapes: \( \) \\ \n \t and \ooo octal. */
function decodePdfString(literal: string): string {
  const inner = literal.slice(literal.indexOf('(') + 1, literal.lastIndexOf(')'));
  return inner.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_, escape: string) => {
    switch (escape) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return String.fromCharCode(Number.parseInt(escape, 8));
    }
  });
}

function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
