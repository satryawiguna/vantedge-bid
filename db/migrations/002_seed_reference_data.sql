-- =============================================================================
-- Migration 002: reference data
--
-- Document types follow the qualification and bid document set required of
-- construction contractors on LPSE/SPSE. Compliance ruleset v1 encodes the
-- checks a bid administrator performs by hand today.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Document types
-- -----------------------------------------------------------------------------

INSERT INTO document_types
    (code, name, category, has_expiry, is_mandatory_default, allowed_mime_types, max_size_bytes, description)
VALUES
    ('AKTA_PENDIRIAN', 'Akta Pendirian & Perubahan', 'administrasi', false, true,
     '{application/pdf}', 26214400,
     'Deed of establishment and its amendments.'),

    ('NIB', 'Nomor Induk Berusaha (OSS)', 'administrasi', false, true,
     '{application/pdf}', 10485760,
     'Business identification number issued through the OSS system.'),

    ('NPWP', 'NPWP Perusahaan', 'administrasi', false, true,
     '{application/pdf,image/jpeg,image/png}', 5242880,
     'Company tax identification number.'),

    ('SPT_TAHUNAN', 'SPT Tahunan PPh Badan', 'administrasi', true, true,
     '{application/pdf}', 26214400,
     'Latest annual corporate income tax return.'),

    ('KSWP', 'Konfirmasi Status Wajib Pajak', 'administrasi', true, true,
     '{application/pdf}', 5242880,
     'Taxpayer status confirmation; short validity, frequent cause of disqualification.'),

    ('SBU', 'Sertifikat Badan Usaha Konstruksi', 'kualifikasi', true, true,
     '{application/pdf}', 10485760,
     'Construction business entity certificate carrying the subclassification codes.'),

    ('SKK_PERSONIL', 'SKK Konstruksi Personil Inti', 'kualifikasi', true, true,
     '{application/pdf}', 10485760,
     'Work competency certificate of a key person. Several rows per tender are normal.'),

    ('PAKTA_INTEGRITAS', 'Pakta Integritas', 'administrasi', false, true,
     '{application/pdf}', 5242880,
     'Signed integrity pact.'),

    ('SURAT_PERNYATAAN', 'Surat Pernyataan Tidak Masuk Daftar Hitam', 'administrasi', false, true,
     '{application/pdf}', 5242880,
     'Declaration of not being on the LKPP blacklist.'),

    ('NERACA_KEUANGAN', 'Laporan Keuangan / Neraca', 'kualifikasi', true, true,
     '{application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}', 52428800,
     'Financial statements used to derive real capability (SKN).'),

    ('PENGALAMAN_KERJA', 'Daftar Pengalaman Pekerjaan Sejenis', 'kualifikasi', false, true,
     '{application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}', 26214400,
     'Record of comparable past work, basis of the KD assessment.'),

    ('SURAT_PENAWARAN', 'Surat Penawaran', 'administrasi', false, true,
     '{application/pdf}', 10485760,
     'The bid letter itself, signed and stamped.'),

    ('JAMINAN_PENAWARAN', 'Jaminan Penawaran (Bid Bond)', 'administrasi', true, false,
     '{application/pdf}', 10485760,
     'Bid security. Required above a value threshold; amount and validity are both checked.'),

    ('BOQ_RAB', 'Daftar Kuantitas dan Harga (BoQ/RAB)', 'harga', false, true,
     '{application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel}', 52428800,
     'Bill of quantities and priced schedule.'),

    ('AHSP', 'Analisa Harga Satuan Pekerjaan', 'harga', false, false,
     '{application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}', 52428800,
     'Unit price analysis supporting the BoQ.'),

    ('METODE_PELAKSANAAN', 'Metode Pelaksanaan', 'teknis', false, true,
     '{application/pdf}', 52428800,
     'Construction method statement.'),

    ('JADWAL_PELAKSANAAN', 'Jadwal Pelaksanaan / Kurva S', 'teknis', false, true,
     '{application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}', 26214400,
     'Work schedule and S-curve.'),

    ('RKK', 'Rencana Keselamatan Konstruksi', 'teknis', false, true,
     '{application/pdf}', 52428800,
     'Construction safety management plan (SMKK).'),

    ('DAFTAR_PERALATAN', 'Daftar Peralatan Utama', 'teknis', false, true,
     '{application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}', 26214400,
     'Schedule of major equipment with ownership evidence.'),

    ('SURAT_DUKUNGAN', 'Surat Dukungan Material/Distributor', 'teknis', true, false,
     '{application/pdf}', 10485760,
     'Supplier support letter for specified materials.');

-- -----------------------------------------------------------------------------
-- Compliance ruleset v1
-- -----------------------------------------------------------------------------

INSERT INTO compliance_rulesets (id, code, version, name, description, effective_from, is_active)
VALUES (
    '11111111-1111-4111-8111-111111111111',
    'LKPP_KONSTRUKSI',
    1,
    'Construction procurement baseline — v1',
    'Administrative and qualification checks applied to a construction bid package before submission.',
    DATE '2026-01-01',
    true
);

INSERT INTO compliance_rules
    (ruleset_id, code, name, description, document_type_code, severity, evaluator, params)
VALUES
    -- Completeness -------------------------------------------------------------
    ('11111111-1111-4111-8111-111111111111', 'DOC.MANDATORY_PRESENT',
     'All mandatory documents uploaded',
     'Every document slot marked mandatory for the tender has at least one processed version.',
     NULL, 'blocker', 'mandatory_documents_present', '{}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'DOC.READABLE',
     'Uploaded files are machine readable',
     'Rejects encrypted, corrupt or image-only PDFs that yield no extractable text.',
     -- Deliberately low: the rule detects the absence of a text layer, not
     -- brevity. A one-page bid bond is legitimately short, and a threshold set
     -- high enough to judge "substance" fails those instead of scans.
     NULL, 'critical', 'document_readable', '{"min_text_length": 40}'::jsonb),

    -- Validity -----------------------------------------------------------------
    ('11111111-1111-4111-8111-111111111111', 'SBU.NOT_EXPIRED',
     'SBU valid at submission deadline',
     'The business entity certificate must still be valid on the tender submission deadline.',
     'SBU', 'blocker', 'not_expired_at_deadline', '{"grace_days": 0}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'SKK.NOT_EXPIRED',
     'Key personnel certificates valid at submission deadline',
     NULL,
     'SKK_PERSONIL', 'blocker', 'not_expired_at_deadline', '{"grace_days": 0}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'KSWP.FRESH',
     'Taxpayer status confirmation recently issued',
     'KSWP older than 30 days is commonly rejected by the procurement committee.',
     'KSWP', 'critical', 'issued_within_days', '{"max_age_days": 30}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'BOND.NOT_EXPIRED',
     'Bid bond covers the required validity period',
     'Bid security must remain valid for the number of days stated in the announcement.',
     'JAMINAN_PENAWARAN', 'blocker', 'valid_for_days_after_deadline', '{"min_days": 60}'::jsonb),

    -- Substance ----------------------------------------------------------------
    ('11111111-1111-4111-8111-111111111111', 'SBU.CLASSIFICATION_MATCH',
     'SBU subclassification matches the announcement',
     'At least one subclassification code on the certificate must match tenders.required_sbu_codes.',
     'SBU', 'blocker', 'classification_match', '{"match_mode": "any"}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'BOND.AMOUNT_SUFFICIENT',
     'Bid bond amount meets the minimum percentage',
     'Bid security must be at least the configured percentage of the estimated value.',
     'JAMINAN_PENAWARAN', 'blocker', 'monetary_threshold',
     '{"basis": "tender.estimated_value", "min_percent": 1.0}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'BOND.REQUIRED_ABOVE_THRESHOLD',
     'Bid bond present when the package value requires one',
     'A bid bond becomes mandatory above the configured package value.',
     'JAMINAN_PENAWARAN', 'blocker', 'conditionally_required',
     '{"when": "tender.estimated_value", "gte": 10000000000}'::jsonb),

    -- Consistency --------------------------------------------------------------
    ('11111111-1111-4111-8111-111111111111', 'IDENTITY.NPWP_CONSISTENT',
     'Tax ID consistent across documents',
     'The NPWP extracted from each document must match the one on the organization profile.',
     NULL, 'critical', 'field_consistency',
     '{"field": "holder_npwp", "reference": "organization.npwp"}'::jsonb),

    ('11111111-1111-4111-8111-111111111111', 'IDENTITY.NAME_CONSISTENT',
     'Company name consistent across documents',
     'Catches documents belonging to a sister company or an outdated legal name.',
     NULL, 'major', 'field_consistency',
     '{"field": "holder_name", "reference": "organization.name", "fuzzy": true}'::jsonb),

    -- Confidence ---------------------------------------------------------------
    ('11111111-1111-4111-8111-111111111111', 'EXTRACTION.CONFIDENCE',
     'Extraction confident enough to rely on',
     'Below this confidence the finding is reported as inconclusive and flagged for human review.',
     NULL, 'minor', 'extraction_confidence', '{"min_confidence": 0.7}'::jsonb);

COMMIT;
