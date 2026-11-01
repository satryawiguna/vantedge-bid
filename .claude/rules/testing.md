---
paths:
  - "test/**"
  - "jest.config.js"
---

# Testing rules

- Call production service/processor methods; do not restate production SQL in a test.
- Integration suites share Redis queue names; keep `maxWorkers: 1`. Use a disposable database and an empty Redis DB index.
- Force interleavings with barriers/gates for concurrency tests; assert on persisted state, not only return values.
- A regression test is trusted only after it fails against a valid mutation of the fix; run mutations with `--no-cache` and revert them.
- Never weaken an assertion to pass. Update `docs/09-testing-and-reliability.md` when suites are added or removed.
