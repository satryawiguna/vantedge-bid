---
paths:
  - "db/**"
  - "src/database/**"
---

# Database rules

- New schema change = new numbered forward-only file in `db/migrations/` (next after the highest existing number). Never edit an applied migration; the migrator checksums them.
- TypeORM `synchronize` stays `false`. Update the entity and `test/integration/schema-drift.spec.ts` expectations with the migration.
- Add a `COMMENT ON` for any non-obvious column; correct stale comments with a new migration, not an edit.
- Use conditional `UPDATE … WHERE <expected state>` for transitions, and `returningRows()` for `RETURNING` row counts.
- Update `docs/ERD.md` and `docs/04-data-model-and-erd.md` in the same change.
