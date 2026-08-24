# Archived pre-PostgreSQL migration history

These migrations are retained as historical reference only. The earliest files
were generated for SQLite and cannot be replayed against Alcantara's PostgreSQL
database.

The active migration history starts at
`prisma/migrations/0_postgresql_baseline`. Existing PostgreSQL installations
created with `prisma db push` are recognized and baselined by
`scripts/deploy-migrations.mjs` before pending migrations are deployed.
