/**
 * Machine-readable error codes.
 *
 * Clients branch on these, never on the human-readable message. The message is
 * free to change; the code is part of the API contract.
 */
export const ErrorCode = {
  // 400 — the request is malformed
  VALIDATION_FAILED: 'validation_failed',
  FILE_MISSING: 'file_missing',

  // 404
  TENDER_NOT_FOUND: 'tender_not_found',
  DOCUMENT_NOT_FOUND: 'document_not_found',
  DOCUMENT_TYPE_NOT_FOUND: 'document_type_not_found',

  // 409 — the request is well formed but conflicts with current state
  DUPLICATE_DOCUMENT: 'duplicate_document',
  /** Same key, different request — the caller must pick a new key. */
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  /** Same key, same request, still running — the caller should retry shortly. */
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'idempotent_request_in_progress',

  // 413 / 415 — the file itself is rejected
  FILE_TOO_LARGE: 'file_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  FILE_SIGNATURE_MISMATCH: 'file_signature_mismatch',
  FILE_ENCRYPTED: 'file_encrypted',
  FILE_EMPTY: 'file_empty',

  // 422
  TENDER_DEADLINE_PASSED: 'tender_deadline_passed',

  // 5xx
  STORAGE_UNAVAILABLE: 'storage_unavailable',
  QUEUE_UNAVAILABLE: 'queue_unavailable',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
