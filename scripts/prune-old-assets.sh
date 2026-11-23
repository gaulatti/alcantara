#!/usr/bin/env bash
# Delete objects under assets/ that are not in the build just uploaded and are older than N days
# (gaulatti/alcantara#229). A bucket lifecycle rule by age would be wrong: `aws s3 sync` skips
# unchanged files, so an asset the current build still uses keeps its old date.
#
# usage: prune-old-assets.sh BUCKET BUILD_DIR [DAYS=14]
# BUILD_DIR is the uploaded build; its assets/ files are never deleted whatever their age.
# Exits non-zero if listing or any delete fails; the deploy step tolerates that.
set -euo pipefail

bucket="${1:?bucket}"
build="${2:?build dir}"
days="${3:-14}"
[ -d "$build/assets" ] || { echo "no $build/assets: refusing to prune" >&2; exit 2; }

keep="$(cd "$build" && find assets -type f | sort)"
[ -n "$keep" ] || { echo "the build has no assets: refusing to prune" >&2; exit 2; }
cutoff="$(python3 -c 'import sys,datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=int(sys.argv[1]))).strftime("%Y-%m-%dT%H:%M:%S"))' "$days")"

listing="$(aws s3api list-objects-v2 --bucket "$bucket" --prefix assets/ \
  --query 'Contents[].[Key,LastModified]' --output text)"
[ "$listing" = "None" ] && listing=""

failed=0
while IFS=$'\t' read -r key modified; do
  [ -n "$key" ] || continue
  case "$key" in assets/*) ;; *) continue ;; esac
  if grep -Fxq -- "$key" <<<"$keep"; then continue; fi
  # LastModified is ISO 8601 UTC (2026-01-02T03:04:05+00:00): the first 19 characters compare as text.
  if [[ "${modified:0:19}" < "$cutoff" ]]; then
    echo "pruning $key ($modified)"
    aws s3 rm "s3://$bucket/$key" || failed=1
  fi
done <<<"$listing"
exit "$failed"
