#!/bin/sh
# Creates the local-only media bucket for the Compose stack
# (gaulatti/alcantara#206). It exists only inside the localstack container.
set -eu
awslocal s3api head-bucket --bucket alcantara-local-only >/dev/null 2>&1 ||
  awslocal s3 mb s3://alcantara-local-only
