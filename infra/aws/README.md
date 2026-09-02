# Alcántara AWS infrastructure

This CDK app owns Alcántara-specific AWS integration. Macondo owns only the
shared Cumulus host, network, and Arauco database. This stack owns:

- `alcantara-github-deploy`, restricted to `gaulatti/alcantara` `main` and SSM
  commands to the EC2 instance tagged `Name=macondo-services`;
- the host grants for Alcántara media and `/services/alcantara` logs; and
- `api.alcantara.gaulatti.com` pointing to the Cumulus Elastic IP.

Copy `.env.example` to `.env`, populate it with the non-secret identifiers from
the deployed Macondo stack, export those values, then validate:

```bash
set -a
. ./.env
set +a
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm exec cdk diff AlcantaraInfrastructureStack
```

Macondo grants the Cumulus instance role read access to the database secrets it
provisions. Alcántara's containers receive only the non-secret Arauco secret
identifier and resolve credentials through that instance profile. The existing
Route 53 record must be adopted into this stack during the first deployment
rather than duplicated. After deployment, set the GitHub repository variables
`ARAUCO_SECRET_ARN` and `MEDIA_S3_BUCKET` to the corresponding identifiers.
