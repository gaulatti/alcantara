#!/bin/sh
# Creates the local-only media bucket for the Compose stack
# (gaulatti/alcantara#206). It exists only inside the localstack container.
# Objects are readable without credentials, as the real media bucket serves
# them publicly, so uploaded songs and artwork play back in the browser.
set -eu
bucket=alcantara-local-only
awslocal s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 ||
  awslocal s3 mb "s3://$bucket"
awslocal s3api put-bucket-policy --bucket "$bucket" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$bucket/*\"}]}"
