import {
  detectFormat,
  isEncryptedPdf,
  signatureMatchesMime,
} from '../../src/modules/ingestion/../documents/validation/file-signature';
import { buildPdf, buildPng, buildXlsx } from '../helpers/pdf-fixture';

describe('file signature detection', () => {
  it('identifies a PDF by its magic bytes', () => {
    expect(detectFormat(buildPdf(['hello']))).toBe('pdf');
  });

  it('identifies an OOXML container as a zip', () => {
    expect(detectFormat(buildXlsx())).toBe('zip');
  });

  it('identifies a PNG', () => {
    expect(detectFormat(buildPng())).toBe('png');
  });

  it('reports unknown for arbitrary bytes', () => {
    expect(detectFormat(Buffer.from('not a document at all'))).toBe('unknown');
  });

  it('is not fooled by a declared MIME type that the bytes contradict', () => {
    // The exact attack the check exists for: an executable or script renamed to
    // .pdf and uploaded with Content-Type: application/pdf.
    const disguised = Buffer.from('#!/bin/sh\nrm -rf /\n');
    expect(signatureMatchesMime(disguised, 'application/pdf')).toBe(false);
  });

  it('accepts a real PDF declared as a PDF', () => {
    expect(signatureMatchesMime(buildPdf(['Sertifikat']), 'application/pdf')).toBe(true);
  });

  it('rejects a PDF declared as a spreadsheet', () => {
    expect(
      signatureMatchesMime(
        buildPdf(['Sertifikat']),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBe(false);
  });

  it('detects an encrypted PDF from its trailer', () => {
    expect(isEncryptedPdf(buildPdf(['secret'], { encrypted: true }))).toBe(true);
  });

  it('does not flag an ordinary PDF as encrypted', () => {
    expect(isEncryptedPdf(buildPdf(['public']))).toBe(false);
  });
});
