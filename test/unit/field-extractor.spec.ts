import { extractFields } from '../../src/modules/ingestion/extraction/field-extractor';
import { extractPdfText } from '../../src/modules/ingestion/extraction/pdf-text-extractor';
import { buildPdf, buildScannedPdf } from '../helpers/pdf-fixture';

const SBU_LINES = [
  'SERTIFIKAT BADAN USAHA JASA PELAKSANA KONSTRUKSI',
  'Nomor : 0123456789-BG-2024',
  'Diberikan kepada : PT Karya Bali Mandiri',
  'NPWP : 01.234.567.8-901.234',
  'Klasifikasi : BG009 Jasa Pelaksana Konstruksi Bangunan Gedung Lainnya',
  'Diterbitkan pada tanggal 14 Maret 2024',
  'Berlaku sampai dengan 14 Maret 2027',
];

describe('PDF text extraction', () => {
  it('reads text out of an uncompressed content stream', () => {
    const { text } = extractPdfText(buildPdf(SBU_LINES));
    expect(text).toContain('SERTIFIKAT BADAN USAHA');
    expect(text).toContain('PT Karya Bali Mandiri');
  });

  it('returns nothing for a document with no text layer', () => {
    // A scan. The DOC.READABLE rule is what turns this into a visible finding
    // rather than a silent pass.
    expect(extractPdfText(buildScannedPdf()).text).toBe('');
  });
});

describe('field extraction for Indonesian tender documents', () => {
  const fieldsFrom = (lines: string[], type = 'SBU') =>
    extractFields(extractPdfText(buildPdf(lines)).text, type);

  it('reads an Indonesian month-name expiry date', () => {
    expect(fieldsFrom(SBU_LINES).expiresAt).toBe('2027-03-14');
  });

  it('distinguishes the issue date from the expiry date by their labels', () => {
    // Both are "14 Maret"; only the surrounding Indonesian keyword separates
    // them. This is why generic date parsing does not work here.
    const fields = fieldsFrom(SBU_LINES);
    expect(fields.issuedAt).toBe('2024-03-14');
    expect(fields.expiresAt).toBe('2027-03-14');
  });

  it('reads a numeric date format', () => {
    const fields = fieldsFrom(['Masa berlaku s.d 31/12/2027']);
    expect(fields.expiresAt).toBe('2027-12-31');
  });

  it('rejects a date the calendar does not have', () => {
    expect(fieldsFrom(['Berlaku sampai dengan 31 Februari 2027']).expiresAt).toBeNull();
  });

  it('normalises a formatted NPWP to digits', () => {
    expect(fieldsFrom(SBU_LINES).holderNpwp).toBe('012345678901234');
  });

  it('reads the company name with its legal form', () => {
    expect(fieldsFrom(SBU_LINES).holderName).toContain('PT Karya Bali Mandiri');
  });

  it('stops the company name at the next field label', () => {
    // Regression: a greedy match produced "PT Karya Bali Mandiri NPWP", which
    // then failed the cross-document name consistency rule on every document —
    // a false blocker, the most expensive kind of bug in a compliance tool.
    const fields = fieldsFrom([
      'Diberikan kepada : PT Karya Bali Mandiri NPWP 01.234.567.8-901.234',
    ]);
    expect(fields.holderName).toBe('PT Karya Bali Mandiri');
  });

  it('stops the company name at a trailing amount label', () => {
    const fields = fieldsFrom(
      ['Untuk dan atas nama : PT Karya Bali Mandiri Nilai Jaminan : Rp 90.000.000,00'],
      'JAMINAN_PENAWARAN',
    );
    expect(fields.holderName).toBe('PT Karya Bali Mandiri');
  });

  it('reads SBU subclassification codes', () => {
    expect(fieldsFrom(SBU_LINES).classificationCodes).toContain('BG009');
  });

  it('parses a rupiah amount without floating point', () => {
    const fields = fieldsFrom(
      ['Nilai Jaminan : Rp 150.000.000,00', 'Berlaku sampai dengan 20 Februari 2027'],
      'JAMINAN_PENAWARAN',
    );
    expect(fields.monetaryValue).toBe('150000000.00');
  });

  it('puts the SBU qualification grade in extras, not in a column', () => {
    // Nothing queries the grade yet, so it stays in extracted_data rather than
    // earning a column of its own.
    const fields = fieldsFrom([...SBU_LINES, 'Kualifikasi : Menengah']);
    expect(fields.extras).toEqual({ qualificationGrade: 'menengah' });
  });

  it('extracts KBLI codes from an NIB', () => {
    const fields = fieldsFrom(
      ['NOMOR INDUK BERUSAHA', 'KBLI : 41011 Konstruksi Gedung Hunian', 'KBLI 42101'],
      'NIB',
    );
    expect(fields.extras.kbliCodes).toEqual(['41011', '42101']);
  });

  it('extracts the guarantor from a bid bond', () => {
    const fields = fieldsFrom(
      ['JAMINAN PENAWARAN', 'Penjamin : PT Asuransi Nusantara', 'Nilai Jaminan : Rp 150.000.000,00'],
      'JAMINAN_PENAWARAN',
    );
    expect(fields.extras.guarantor).toBe('PT Asuransi Nusantara');
  });

  it('leaves extras empty for a document type with no specific fields', () => {
    expect(fieldsFrom(['PAKTA INTEGRITAS'], 'PAKTA_INTEGRITAS').extras).toEqual({});
  });

  it('reports low confidence when the expected fields are absent', () => {
    const fields = fieldsFrom(['Dokumen tanpa informasi apa pun'], 'SBU');
    expect(fields.confidence).toBeLessThan(0.5);
  });

  it('reports high confidence when every expected field is found', () => {
    expect(fieldsFrom(SBU_LINES).confidence).toBeGreaterThanOrEqual(0.75);
  });
});
