/**
 * Builds a minimal, structurally valid PDF with an uncompressed content stream.
 *
 * Tests need real PDF bytes — asserting against a hand-written Buffer would
 * test the assertion, not the parser. This produces the simplest file that a
 * reader would accept, with the supplied lines as text-showing operators.
 */
export function buildPdf(lines: string[], options: { encrypted?: boolean } = {}): Buffer {
  const content = [
    'BT',
    '/F1 12 Tf',
    ...lines.flatMap((line, index) => [
      `1 0 0 1 50 ${740 - index * 18} Tm`,
      `(${escapePdfString(line)}) Tj`,
    ]),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  objects.forEach((object, index) => {
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const trailer = options.encrypted
    ? '<< /Size 6 /Root 1 0 R /Encrypt 6 0 R >>'
    : '<< /Size 6 /Root 1 0 R >>';

  body += `trailer\n${trailer}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** A PDF-shaped file with no text at all — stands in for a scanned document. */
export function buildScannedPdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      'trailer\n<< /Size 2 /Root 1 0 R >>\n%%EOF\n',
    'latin1',
  );
}

export function buildXlsx(): Buffer {
  // PK\x03\x04 followed by filler: enough for signature detection, which is
  // all the upload path inspects.
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(512, 0x20)]);
}

export function buildPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(256, 0x00),
  ]);
}

function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
