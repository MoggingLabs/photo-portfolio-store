# Biometric Retention Cron (F1.35)

Operational runbook for the worker-side cron that purges face embeddings and
revokes biometric consents once an event's retention window expires.

## Schedule

- Cron expression: `0 */6 * * *` (every six hours, on the hour).
- Owner: `apps/worker` — `src/jobs/scheduler.ts` wires it up at boot.
- Concurrency: `protect: true` in croner skips a tick if the previous run is
  still in flight.

Six hours is a deliberate compromise: nightly is too lossy for the biometric
SLA — under BIPA, "promptly destroy" leaves no defensible 24-hour window of
over-retention — and hourly is wasteful given that events typically archive
once and stay archived.

## What happens on each pass

For every row in `app.events` where:

```sql
archived_at IS NOT NULL
AND archived_at + (retention_days || ' days')::interval < now()
```

the cron does the following, in order, per event:

1. **Drop the Qdrant collection** `faces_event_<eventId>`.
   - If Qdrant returns "not found" the step is a no-op (event had no face
     data) and the rest of the purge proceeds.
   - If Qdrant returns any other error the per-event purge aborts. No
     Postgres rows are deleted, no consents are revoked, no audit row is
     written. The next tick retries. This prevents Qdrant ↔ Postgres drift.
2. **Delete `app.face_vectors` rows** for that event.
3. **Revoke biometric consents** for that event: `UPDATE app.consents SET
   revoked_at = now(), retention_until = now() WHERE event_id = $1 AND scope
   = 'biometric' AND revoked_at IS NULL`.
4. **Append `app.audit_log`** with `action = 'biometric.purged'`, `actor_kind
   = 'cron'`, `target_kind = 'event'`, `target_id = <eventId>`, and a payload
   of `{ vectorsDeleted, qdrantCollectionDropped, consentsRevoked,
   retentionDays }`.

Each event is isolated: a failure on one event does not stop the rest of the
batch.

## Manual one-off run

Use the standalone CLI when the cron is paused, when you need immediate proof
of action for a regulator, or while debugging:

```bash
pnpm --filter @app/worker tsx src/jobs/retention-once.ts
```

The script runs a single `runRetentionPass` and prints the summary as JSON to
stdout. It exits 0 on completion; per-event failures are logged to stderr but
do not change the exit code.

## Idempotency

A second consecutive run is a no-op: the predicate that drives
`findExpiredEvents` excludes events whose face data has already been wiped,
and dropping an already-dropped Qdrant collection is treated as a benign
no-op.

## Audit trail

Every purge produces exactly one `app.audit_log` row per event. These rows
are append-only by policy (DB trigger lands in a separate migration) and are
surfaced through the audit CSV export (F1.34) so compliance can prove
end-to-end action.

`payload_hash` (sha256 of canonical JSON of `payload_jsonb`) is written by
the centralized writer where applicable; the retention cron writes directly
via Drizzle and supplies only the payload — extend if hash coverage becomes
mandatory at the DB level.

## Regulatory mapping

| Regime  | Article / Section                                  | How this cron + the takedown endpoint satisfy it                                                                                              |
| ------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| LGPD    | Art. 15 (term of treatment) / Art. 16 (elimination) | Treatment ends when the event's `retention_days` elapses past `archived_at`; the cron eliminates biometric data and revokes the consent.       |
| GDPR    | Art. 5(1)(e) (storage limitation), Art. 17 (erasure) | Storage limited to `retention_days`. Right-to-erasure (F3.5) calls the same primitives on demand; cron is the periodic safety net.            |
| BIPA    | 740 ILCS 14/15(a) (retention schedule + destruction)   | Public retention schedule is the event's `retention_days`; the cron is the "destroy on schedule" mechanism with auditable proof.              |

## Out of scope (deferred)

- **Consent-revocation-driven purge** for individual subjects (F3.7,
  right-to-erasure cascade). The cron handles per-event expiry; per-subject
  takedowns flow through the takedown endpoint (F3.5).
- **Photo derivatives** generated from face matches. Their lifecycle is owned
  by the storage retention workflow (separate issue).

## Failure modes and on-call

- **"retention pass failed" log line, no per-event entries**: the
  `findExpiredEvents` query itself failed — usually a DB connection issue.
  Check `DATABASE_URL` and connection pool saturation.
- **Per-event `[retention] event purge failed` log line**: that event will be
  retried next tick. If it keeps failing, run the CLI manually and inspect
  the Qdrant collection state and `app.face_vectors` row count for that
  event.
- **Qdrant down for an extended window**: the cron will keep retrying every
  six hours. Once Qdrant is back, the next tick clears the backlog.
