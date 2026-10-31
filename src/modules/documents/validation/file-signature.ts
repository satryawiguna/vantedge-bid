/**
 * Magic-byte sniffing.
 *
 * A browser's Content-Type header and a filename extension are both supplied by
 * the client and are both trivially wrong — by accident as often as on purpose.
 * The only trustworthy statement about a file's type is in its own first bytes.
 *
 * Implemented here rather than pulled from npm for three reasons: the set of
 * formats a tender package may contain is small and closed, the detection is
 * about forty lines, and a dependency that is ESM-only or that ships a
 * thousand format parsers is a poor trade for that.
 */

export type DetectedFormat = 'pdf' | 'zip' | 'jpeg' | 'png' | 'legacy-office' | 'unknown';

const SIGNATURES: ReadonlyArray<{ format: DetectedFormat; bytes: readonly number[] }> = [
  { format: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { format: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // PK.. — OOXML (xlsx/docx) container
  { format: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // OLE2 compound file — legacy .xls/.doc
  { format: 'legacy-office', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];

/** MIME types each detected container is allowed to claim. */
const FORMAT_TO_MIME: Readonly<Record<DetectedFormat, readonly string[]>> = {
  pdf: ['application/pdf'],
  zip: [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
  ],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  'legacy-office': ['application/vnd.ms-excel', 'application/msword'],
  unknown: [],
};

export function detectFormat(buffer: Buffer): DetectedFormat {
  for (const signature of SIGNATURES) {
    if (buffer.length < signature.bytes.length) continue;
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) {
      return signature.format;
    }
  }
  return 'unknown';
}

/**
 * Does the declared MIME type agree with what the bytes actually are?
 *
 * OOXML files are ZIP containers, so a .xlsx and a .docx are indistinguishable
 * at the magic-byte level. Both are accepted for a `zip` container and the
 * distinction is left to the declared type — a deliberate limit, noted rather
 * than hidden. Telling .xlsx from .docx means reading [Content_Types].xml from
 * inside the archive, which belongs in the worker, not in the request path.
 */
export function signatureMatchesMime(buffer: Buffer, declaredMime: string): boolean {
  const format = detectFormat(buffer);
  if (format === 'unknown') return false;
  return FORMAT_TO_MIME[format].includes(declaredMime);
}

/**
 * Is this PDF encrypted?
 *
 * An encrypted PDF uploads and stores fine, then fails silently in the worker
 * when no text can be extracted — and a compliance check that silently reads
 * nothing is worse than one that refuses. Catching it at the edge turns a
 * mysterious 'processing failed' into an actionable 415 at upload time.
 *
 * The /Encrypt entry lives in the trailer dictionary, so the tail is enough.
 */
export function isEncryptedPdf(buffer: Buffer): boolean {
  if (detectFormat(buffer) !== 'pdf') return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  return /\/Encrypt\s+\d+\s+\d+\s+R/.test(tail);
}

/** Best-effort page count, used for queue prioritisation rather than validation. */
export function estimatePdfPageCount(buffer: Buffer): number | null {
  if (detectFormat(buffer) !== 'pdf') return null;
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length : null;
}
