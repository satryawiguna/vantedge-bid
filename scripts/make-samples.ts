#!/usr/bin/env node
/**
 * Generates sample tender documents under ./samples so the API can be exercised
 * without hunting for a real SBU certificate — and so the failure cases are
 * reproducible rather than described.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(__dirname, '..', 'samples');

function pdf(lines: string[], options: { encrypted?: boolean } = {}): Buffer {
  const content = [
    'BT',
    '/F1 12 Tf',
    ...lines.flatMap((line, index) => [
      `1 0 0 1 50 ${760 - index * 20} Tm`,
      `(${line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')}) Tj`,
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
  body += `trailer\n<< /Size 6 /Root 1 0 R${options.encrypted ? ' /Encrypt 6 0 R' : ''} >>\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

mkdirSync(OUT, { recursive: true });

const samples: Array<[string, Buffer, string]> = [
  [
    'sbu-valid.pdf',
    pdf([
      'SERTIFIKAT BADAN USAHA JASA PELAKSANA KONSTRUKSI',
      'Nomor : 0123456789-BG-2024',
      'Diberikan kepada : PT Karya Bali Mandiri',
      'NPWP : 01.234.567.8-901.234',
      'Klasifikasi : BG009 Jasa Pelaksana Konstruksi Bangunan Gedung Lainnya',
      'Diterbitkan pada tanggal 14 Maret 2024',
      'Berlaku sampai dengan 14 Maret 2029',
      'Diterbitkan oleh Lembaga Sertifikasi Badan Usaha',
    ]),
    'passes every SBU rule',
  ],
  [
    'sbu-expired.pdf',
    pdf([
      'SERTIFIKAT BADAN USAHA JASA PELAKSANA KONSTRUKSI',
      'Nomor : 0123456789-BG-2019',
      'Diberikan kepada : PT Karya Bali Mandiri',
      'NPWP : 01.234.567.8-901.234',
      'Klasifikasi : BG009 Jasa Pelaksana Konstruksi Bangunan Gedung Lainnya',
      'Diterbitkan pada tanggal 10 Januari 2019',
      'Berlaku sampai dengan 10 Januari 2024',
    ]),
    'fails SBU.NOT_EXPIRED',
  ],
  [
    'sbu-wrong-classification.pdf',
    pdf([
      'SERTIFIKAT BADAN USAHA JASA PELAKSANA KONSTRUKSI',
      'Nomor : 0123456789-SI-2024',
      'Diberikan kepada : PT Karya Bali Mandiri',
      'NPWP : 01.234.567.8-901.234',
      'Klasifikasi : SI003 Jasa Pelaksana Konstruksi Jalan Raya',
      'Berlaku sampai dengan 14 Maret 2029',
    ]),
    'fails SBU.CLASSIFICATION_MATCH when the tender requires BG009',
  ],
  [
    'sbu-other-company.pdf',
    pdf([
      'SERTIFIKAT BADAN USAHA JASA PELAKSANA KONSTRUKSI',
      'Nomor : 0987654321-BG-2024',
      'Diberikan kepada : PT Bali Sejahtera Konstruksi',
      'NPWP : 99.888.777.6-665.554',
      'Klasifikasi : BG009',
      'Berlaku sampai dengan 14 Maret 2029',
    ]),
    'fails IDENTITY.NPWP_CONSISTENT — a sister company document',
  ],
  [
    'jaminan-penawaran-kurang.pdf',
    pdf([
      'JAMINAN PENAWARAN (BID BOND)',
      'Nomor : JP-2026-00881',
      'Untuk dan atas nama : PT Karya Bali Mandiri',
      'Nilai Jaminan : Rp 90.000.000,00',
      'Berlaku sampai dengan 28 Februari 2027',
    ]),
    'fails BOND.AMOUNT_SUFFICIENT against a Rp 15 bn package',
  ],
  [
    'kswp-kadaluarsa.pdf',
    pdf([
      'KONFIRMASI STATUS WAJIB PAJAK',
      'Nomor : KSWP-2026-55512',
      'Nama Wajib Pajak : PT Karya Bali Mandiri',
      'NPWP : 01.234.567.8-901.234',
      'Diterbitkan pada tanggal 5 Januari 2026',
    ]),
    'fails KSWP.FRESH — older than 30 days at the deadline',
  ],
  [
    'scan-tanpa-teks.pdf',
    Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Size 2 /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    ),
    'quarantined: no extractable text, as a scan would be',
  ],
  [
    'terproteksi.pdf',
    pdf(['DOKUMEN TERPROTEKSI'], { encrypted: true }),
    'rejected at upload with 415 file_encrypted',
  ],
  [
    'bukan-pdf.pdf',
    Buffer.from('#!/bin/sh\necho "this is not a pdf"\n'),
    'rejected at upload with 415 file_signature_mismatch',
  ],
];

for (const [name, buffer, note] of samples) {
  writeFileSync(join(OUT, name), buffer);
  console.log(`  ${name.padEnd(34)} ${note}`);
}

console.log(`\n${samples.length} sample files written to ./samples`);
