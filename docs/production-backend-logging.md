# Production backend logging

Alcantara writes application diagnostics to stdout and stderr. Both production
deployment paths configure Docker's `local` logging driver with a 10 MiB limit
per file and three retained files. Operators can continue to inspect recent
output with:

```bash
docker logs --tail 200 alcantara-backend
docker inspect alcantara-backend \
  --format '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}'
```

The expected inspection result has driver `local`, `max-size` `10m`, and
`max-file` `3`. Backend startup, health checks, authenticated status reads, and
automatic rollback do not depend on `/services/alcantara`, CloudWatch Logs
writer permissions, or a hosted replacement collector. Historical CloudWatch
log data is outside this repository's retention contract and is not deleted by
deployment or infrastructure changes.

## Cutover verification

After the reviewed change reaches `main` and the normal backend deployment
finishes:

1. Confirm the deployment used the intended `main` commit and completed its
   startup check.
2. Inspect `alcantara-backend` and confirm the bounded `local` driver options
   above.
3. Restart the container once and confirm the public health endpoint and an
   authenticated status read succeed.
4. Confirm `docker logs --tail 200 alcantara-backend` remains useful and does
   not expose program, token, or user values.
5. Compare the `AWS/Logs` `IncomingBytes` metric for log group
   `/services/alcantara` before and after the cutover window. New application
   events must remain at zero after old buffered deliveries have settled.

Do not copy log contents or credentials into GitHub evidence. Record only the
commit, timestamps, resource name, driver options, health/status outcome, and
metric totals.

## Rollback

The deployment scripts keep the previous container until the replacement
passes its startup check. A failed replacement automatically removes the new
container, renames the previous container back to `alcantara-backend`, starts
it, and checks recovery where the host path supports that check. Because the
previous container retains its original logging configuration, this rollback
does not depend on the new driver.

To reverse the logging cutover after a successful deployment, revert the single
merged logging change through the normal review path, deploy that exact revert
commit, and apply the reverted `infra/aws` stack. Verify the restored container
driver and the `/services/alcantara` writer grant before considering rollback
complete. Do not recreate a log group, alter a live container, or add a writer
grant manually.
