/**
 * Field extraction tuned to Indonesian tender documents.
 *
 * Generic date parsing is useless here: an SBU prints its validity as
 * "Berlaku sampai dengan 14 Maret 2028", a bid bond as "sampai dengan tanggal
 * 12/03/2027", and both sit next to an issue date in the same format. What
 * makes a field extractable is the Indonesian keyword in front of it, not the
 * date shape. These patterns encode that.
 *
 * Every field carries a confidence, and a low score produces an `inconclusive`
 * finding rather than a guess — in a compliance product, "I could not read
 * this" is a legitimate and useful answer.
 */

export interface ExtractedFields {
  documentNumber: string | null;
  issuer: string | null;
  holderName: string | null;
  holderNpwp: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  classificationCodes: string[];
  monetaryValue: string | null;
  /**
   * Fields that only this document type carries. Kept out of the named fields
   * above because adding a column per document type produces a table that is
   * mostly NULL; see document_extractions.extracted_data.
   */
  extras: Record<string, unknown>;
  confidence: number;
}

const MONTHS_ID: Readonly<Record<string, number>> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, agu: 8, sep: 9, okt: 10, nov: 11, des: 12,
};

const EXPIRY_KEYWORDS =
  '(?:berlaku\\s+sampai(?:\\s+dengan)?|masa\\s+berlaku\\s+s(?:\\.|/)?d|berlaku\\s+hingga|valid\\s+until|expiry\\s+date|tanggal\\s+berakhir)';

const ISSUE_KEYWORDS =
  '(?:diterbitkan\\s+(?:pada\\s+)?(?:tanggal\\s+)?|tanggal\\s+penerbitan|ditetapkan\\s+(?:di\\s+\\S+\\s+)?(?:pada\\s+)?(?:tanggal\\s+)?|issued\\s+(?:on|date))';

const DATE_PATTERN =
  '(\\d{1,2})\\s*(?:[-/\\s]|\\s+)\\s*([A-Za-z]+|\\d{1,2})\\s*(?:[-/\\s]|\\s+)\\s*(\\d{4})';

export function extractFields(text: string, documentTypeCode: string): ExtractedFields {
  const normalised = text.replace(/\s+/g, ' ');
  const signals: boolean[] = [];

  const expiresAt = findLabelledDate(normalised, EXPIRY_KEYWORDS);
  const issuedAt = findLabelledDate(normalised, ISSUE_KEYWORDS);
  const documentNumber = findDocumentNumber(normalised);
  const holderNpwp = findNpwp(normalised);
  // Names are read line by line, not from the flattened text: once newlines are
  // collapsed there is nothing to stop a greedy match running on into the next
  // label and producing "PT Karya Bali Mandiri NPWP".
  const holderName = findHolderName(text);
  const issuer = findIssuer(text);
  const classificationCodes =
    documentTypeCode === 'SBU' ? findClassificationCodes(normalised) : [];
  const monetaryValue =
    documentTypeCode === 'JAMINAN_PENAWARAN' ? findRupiahAmount(normalised) : null;

  // Confidence is the share of fields this document type is expected to yield
  // that were actually found — not a model score, and labelled as such.
  const expected = expectedFieldsFor(documentTypeCode);
  const found: Record<string, unknown> = {
    documentNumber, issuedAt, expiresAt, holderName, holderNpwp,
    classificationCodes: classificationCodes.length ? classificationCodes : null,
    monetaryValue,
  };
  for (const field of expected) signals.push(Boolean(found[field]));

  const confidence =
    signals.length === 0
      ? 0.5
      : Number((signals.filter(Boolean).length / signals.length).toFixed(3));

  return {
    documentNumber,
    issuer,
    holderName,
    holderNpwp,
    issuedAt,
    expiresAt,
    classificationCodes,
    monetaryValue,
    extras: findExtras(normalised, documentTypeCode),
    confidence,
  };
}

/**
 * Document-type-specific fields.
 *
 * Deliberately narrow: only what this document type actually prints and what a
 * reviewer might later want to filter or rule on. Everything found here is a
 * candidate for promotion to a real column once something queries it.
 */
function findExtras(text: string, documentTypeCode: string): Record<string, unknown> {
  const extras: Record<string, unknown> = {};

  switch (documentTypeCode) {
    case 'SBU': {
      // Kualifikasi: Kecil / Menengah / Besar — decides which package sizes the
      // contractor may bid for at all.
      const grade = text.match(/kualifikasi\s*[:\-]?\s*(kecil|menengah|besar)/i);
      if (grade) extras.qualificationGrade = grade[1].toLowerCase();
      break;
    }

    case 'NIB': {
      // KBLI business activity codes, five digits each.
      const codes = [...text.matchAll(/\bKBLI\D{0,20}(\d{5})\b/gi)].map((match) => match[1]);
      if (codes.length > 0) extras.kbliCodes = [...new Set(codes)];
      break;
    }

    case 'JAMINAN_PENAWARAN': {
      // Who stands behind the bond. Some announcements restrict which banks or
      // insurers are acceptable.
      const guarantor = text.match(
        /(?:penjamin|penerbit\s+jaminan|diterbitkan\s+oleh)\s*[:\-]?\s*((?:PT|Bank)\s[A-Za-z0-9.&' ]{2,50}?)(?=\s*(?:Nomor|Nilai|Untuk|Berlaku|[:,])|$)/i,
      );
      if (guarantor) extras.guarantor = guarantor[1].trim();
      break;
    }

    case 'SKK_PERSONIL': {
      const level = text.match(/jenjang\s*[:\-]?\s*(\d{1,2})/i);
      if (level) extras.competencyLevel = Number.parseInt(level[1], 10);
      break;
    }

    default:
      break;
  }

  return extras;
}

function expectedFieldsFor(documentTypeCode: string): string[] {
  switch (documentTypeCode) {
    case 'SBU':
      return ['documentNumber', 'expiresAt', 'holderName', 'classificationCodes'];
    case 'SKK_PERSONIL':
      return ['documentNumber', 'expiresAt', 'holderName'];
    case 'JAMINAN_PENAWARAN':
      return ['documentNumber', 'expiresAt', 'monetaryValue'];
    case 'KSWP':
      return ['issuedAt', 'holderNpwp'];
    case 'NPWP':
      return ['holderNpwp', 'holderName'];
    default:
      return ['documentNumber', 'holderName'];
  }
}

/** A date is only trusted when an Indonesian label introduces it. */
function findLabelledDate(text: string, keywords: string): string | null {
  const pattern = new RegExp(`${keywords}[^0-9A-Za-z]{0,20}${DATE_PATTERN}`, 'i');
  const match = text.match(pattern);
  if (!match) return null;
  return toIsoDate(match[1], match[2], match[3]);
}

function toIsoDate(day: string, month: string, year: string): string | null {
  const dayNumber = Number.parseInt(day, 10);
  const yearNumber = Number.parseInt(year, 10);

  const monthNumber = /^\d+$/.test(month)
    ? Number.parseInt(month, 10)
    : MONTHS_ID[month.toLowerCase()];

  if (!monthNumber || monthNumber < 1 || monthNumber > 12) return null;
  if (dayNumber < 1 || dayNumber > 31) return null;
  if (yearNumber < 1900 || yearNumber > 2200) return null;

  // Reject dates the calendar does not have (31 February and friends).
  const date = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  if (date.getUTCMonth() !== monthNumber - 1 || date.getUTCDate() !== dayNumber) return null;

  return date.toISOString().slice(0, 10);
}

function findDocumentNumber(text: string): string | null {
  const match = text.match(
    /(?:nomor|no\.?|number)\s*[:.]?\s*([A-Z0-9][A-Z0-9./\-_]{5,48})/i,
  );
  return match ? match[1].replace(/[.,;]$/, '') : null;
}

/** 01.234.567.8-901.234, or a bare 15–16 digit run. */
function findNpwp(text: string): string | null {
  const formatted = text.match(/\b(\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3})\b/);
  if (formatted) return formatted[1].replace(/[.\-]/g, '');

  const bare = text.match(/(?:npwp)\D{0,10}(\d{15,16})\b/i);
  return bare ? bare[1] : null;
}

/**
 * Labels that end a company name. Indonesian documents put the next field's
 * label straight after the name on the same line as often as not, so the match
 * is non-greedy and stops at the first of these or at the line end.
 */
const NAME_STOP_WORDS =
  '(?:NPWP|NIB|NIP|Nomor|No\\.|Alamat|Klasifikasi|Kualifikasi|Nilai|Berlaku|Masa|Diterbitkan|Ditetapkan|Untuk|Tanggal)';

function findHolderName(text: string): string | null {
  const pattern = new RegExp(
    `\\b((?:PT|CV|UD|PD|Koperasi)\\.?\\s+[A-Z][A-Za-z0-9.&'\\- ]{2,60}?)\\s*(?:${NAME_STOP_WORDS}\\b|[:,]|$)`,
  );

  for (const line of text.split('\n')) {
    const match = line.match(pattern);
    if (match) return match[1].replace(/\s{2,}/g, ' ').trim();
  }
  return null;
}

function findIssuer(text: string): string | null {
  const pattern = new RegExp(
    `(?:diterbitkan\\s+oleh|dikeluarkan\\s+oleh|issued\\s+by)\\s*[:.]?\\s*([A-Z][A-Za-z0-9.&'\\- ]{3,60}?)\\s*(?:${NAME_STOP_WORDS}\\b|[:,]|$)`,
    'i',
  );

  for (const line of text.split('\n')) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/** SBU subclassification codes: two letters then three digits, e.g. BG009, SI003. */
function findClassificationCodes(text: string): string[] {
  const matches = text.matchAll(/\b([A-Z]{2}\d{3})\b/g);
  return [...new Set([...matches].map((match) => match[1]))];
}

/** "Rp 1.500.000.000,00" -> "1500000000.00" */
function findRupiahAmount(text: string): string | null {
  const match = text.match(/Rp\.?\s*([\d.]{4,})(?:,(\d{2}))?/i);
  if (!match) return null;

  const whole = match[1].replace(/\./g, '');
  if (!/^\d+$/.test(whole)) return null;
  return `${whole}.${match[2] ?? '00'}`;
}
