# 00 — Project overview

**Purpose:** orient a new reader (or agent) in one page. **Related:** [01](01-challenge-scope.md), [03](03-system-architecture.md), [root README](../README.md).
**Sources:** `README.md`, `package.json`, `src/`. **Last verified:** 2026-11-01, against the working tree.

## What it is
Vantedge Bid is a backend service for the two modules of the brief: **Tender Documents** (ingestion) and **Compliance Audit**. Contractors upload the document package for a tender; the service validates each file at the edge, processes it asynchronously, extracts the fields that matter, and audits the package against a versioned ruleset before the bid is submitted.

## Problem
Bids are routinely disqualified for clerical reasons — an expired SBU, a classification that does not match the announcement, a bid bond below the required percentage. These checks are easy but tedious and done by hand under deadline pressure. Ingestion exists to turn documents into facts the compliance engine can reason about.

## Users
Contractor staff preparing bids (and, later, auditors). There is **no authentication** yet: callers identify their organisation with a header — see [07](07-security-and-tenancy.md).

## Modules
- **Tender documents** — `src/modules/documents`, `tenders`, `ingestion`, `storage` — [05](05-document-ingestion.md).
- **Compliance audit** — `src/modules/compliance` — [06](06-compliance-engine.md).
- Two processes: an HTTP **API** (`src/main.ts`) and a queue **worker** (`src/worker.ts`).

## Stack
NestJS 11 · TypeScript · PostgreSQL 16 (SQL-first schema, TypeORM as mapping layer) · Redis + BullMQ · S3-compatible object storage (MinIO locally; a local-disk driver exists for tests) · Docker Compose · Jest.

## Status
Implemented and tested: ingestion API with an eight-stage validation gate, content-addressed storage, slot/version model, idempotent uploads with crash recovery, durable queue publication, a rule-based audit engine with durable audit scheduling. Not implemented: authentication/authorisation, RLS, malware scanning, expiry scheduler, pagination, rate limiting — see [11](11-known-gaps-and-roadmap.md). This is a technical-challenge submission, **not** a production-ready system.

## Where to go next
[Domain](02-domain-and-workflows.md) → [architecture](03-system-architecture.md) → [data model](04-data-model-and-erd.md).
