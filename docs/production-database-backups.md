# Production database backups

Alcantara creates one logical PostgreSQL backup at the top of every UTC hour
while the production backend is running. This application-owned layer augments
Arauco's native RDS point-in-time recovery; it does not replace the RDS backup
retention configured by Macondo.

## Backup contract

- Backups run only when `NODE_ENV=production`.
- The backend uses the already-loaded `DATABASE_URL`, `AWS_REGION`, and
  `MEDIA_S3_BUCKET` production configuration. Missing configuration fails
  startup rather than silently disabling backups.
- PostgreSQL 17 `pg_dump` produces a transactionally consistent plain SQL dump,
  which is gzip-compressed while streaming to a private temporary file.
- Database credentials are supplied through a mode-0600 libpq password file.
  They are not placed in process arguments, child `DATABASE_URL`, or logs.
- The compressed object is stored at
  `s3://<MEDIA_S3_BUCKET>/postgres-backups/alcantara/alcantara-<UTC timestamp>.sql.gz`
  with S3-managed AES-256 encryption.
- The upload includes a content MD5, then the backend reads object metadata and
  verifies the exact byte length and encryption mode before recording success.
- A second run never overlaps an active backup. It is recorded as skipped and
  the next top-of-hour run remains scheduled.
- Temporary dump and credential files are removed after success or failure.

The existing media bucket currently owns retention policy. Alcantara does not
silently delete recovery points, so these objects remain until an explicit S3
lifecycle policy is approved and deployed.

## Operations

The backend exposes bounded backup telemetry on its existing private metrics
endpoint:

- `alcantara_jobs_total{job="database-backup",result="success|failure|skipped"}`
- `alcantara_job_last_success_timestamp_seconds{job="database-backup"}`
- PostgreSQL read and S3 write results through
  `alcantara_dependency_operations_total`

After deployment, verify all of the following before treating hourly recovery
as active:

1. The backend logs that hourly PostgreSQL backups are enabled.
2. A non-empty encrypted object appears under `postgres-backups/alcantara/`
   after the next top of the hour.
3. The private metrics endpoint reports a successful `database-backup` job and
   a recent last-success timestamp.
4. Download one object into an isolated environment, decompress it, and perform
   a PostgreSQL restore drill. Never restore over production.

If a run fails, the process logs only the bounded stage (`prepare`, `dump`,
`upload`, or `cleanup`) and retries naturally at the next hour. Use the
dependency result to distinguish database-read failures from object-storage
failures. Alerting and S3 lifecycle policy are infrastructure concerns and must
be configured separately from this application change.
