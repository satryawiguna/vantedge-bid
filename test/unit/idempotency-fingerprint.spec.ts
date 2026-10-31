import { fingerprintRequest } from '../../src/modules/documents/documents.service';
import { IngestDocumentDto } from '../../src/modules/documents/dto/ingest-document.dto';

const TENDER = '00000000-0000-4000-8000-000000000003';
const CHECKSUM_A = 'a'.repeat(64);
const CHECKSUM_B = 'b'.repeat(64);

const dto = (overrides: Partial<IngestDocumentDto> = {}): IngestDocumentDto =>
  ({ documentTypeCode: 'SBU', ...overrides }) as IngestDocumentDto;

describe('ingestion request fingerprint', () => {
  it('is stable for the same tender, fields and file', () => {
    expect(fingerprintRequest(TENDER, dto(), CHECKSUM_A)).toBe(
      fingerprintRequest(TENDER, dto(), CHECKSUM_A),
    );
  });

  it('changes when the file changes', () => {
    // The case the whole mechanism exists for: a client reuses an
    // Idempotency-Key but sends a different document. Replaying the first
    // response would tell them their NIB upload succeeded when an SBU is what
    // is actually stored.
    expect(fingerprintRequest(TENDER, dto(), CHECKSUM_A)).not.toBe(
      fingerprintRequest(TENDER, dto(), CHECKSUM_B),
    );
  });

  it('changes when the document type changes', () => {
    expect(fingerprintRequest(TENDER, dto({ documentTypeCode: 'SBU' }), CHECKSUM_A)).not.toBe(
      fingerprintRequest(TENDER, dto({ documentTypeCode: 'NIB' }), CHECKSUM_A),
    );
  });

  it('changes when the target tender changes', () => {
    expect(fingerprintRequest(TENDER, dto(), CHECKSUM_A)).not.toBe(
      fingerprintRequest('00000000-0000-4000-8000-000000000099', dto(), CHECKSUM_A),
    );
  });

  it('distinguishes an absent optional field from an empty one', () => {
    expect(fingerprintRequest(TENDER, dto(), CHECKSUM_A)).not.toBe(
      fingerprintRequest(TENDER, dto({ title: '' }), CHECKSUM_A),
    );
  });

  it('does not depend on the order the fields were set', () => {
    // Guards against a fingerprint built from JSON.stringify over a DTO whose
    // key order varies with how the form was parsed.
    const a = fingerprintRequest(TENDER, dto({ title: 'SBU', isMandatory: true }), CHECKSUM_A);
    const reordered = { isMandatory: true, title: 'SBU', documentTypeCode: 'SBU' };
    const b = fingerprintRequest(TENDER, reordered as IngestDocumentDto, CHECKSUM_A);
    expect(a).toBe(b);
  });
});
