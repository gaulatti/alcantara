#!/usr/bin/env bash
# Test for prune-old-assets.sh with a stub `aws`, no AWS access (gaulatti/alcantara#229).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/build/assets" "$tmp/empty/assets"
touch "$tmp/build/assets/current-old.js" "$tmp/build/assets/current-new.js"
ago() { python3 -c 'import sys,datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=int(sys.argv[1]))).isoformat(timespec="seconds"))' "$1"; }
printf 'assets/live-old.js\t%s\nassets/current-old.js\t%s\nassets/current-new.js\t%s\nassets/gone-old.js\t%s\nassets/gone-young.js\t%s\nindex.html\t%s\n' \
  "$(ago 400)" "$(ago 400)" "$(ago 1)" "$(ago 15)" "$(ago 13)" "$(ago 400)" >"$tmp/listing"
cat >"$tmp/bin/aws" <<'STUB'
#!/usr/bin/env bash
if [ "$1 $2" = "s3api list-objects-v2" ]; then cat "$LISTING"; exit 0; fi
if [ "$1 $2" = "s3 cp" ]; then [ -z "${NO_INDEX:-}" ] || exit 1; cat "$INDEX"; exit 0; fi
if [ "$1 $2" = "s3 rm" ]; then echo "$3" >>"$RM_LOG"; [ -z "${FAIL_RM:-}" ]; exit; fi
exit 9
STUB
chmod +x "$tmp/bin/aws"
printf '<script src="/assets/live-old.js"></script><link href="/assets/current-new.js">' >"$tmp/index"
export INDEX="$tmp/index"
export PATH="$tmp/bin:$PATH" LISTING="$tmp/listing" RM_LOG="$tmp/rm.log"; : >"$RM_LOG"

"$here/prune-old-assets.sh" bkt "$tmp/build" 14 >/dev/null
# Deleted: only the asset absent from the build and older than 14 days.
[ "$(cat "$RM_LOG")" = "s3://bkt/assets/gone-old.js" ] || { echo "FAIL: deleted $(cat "$RM_LOG")"; exit 1; }
! grep -q "live-old" "$RM_LOG" || { echo "FAIL: deleted a file the live index.html references"; exit 1; }
! grep -q "current-" "$RM_LOG" || { echo "FAIL: deleted a current asset"; exit 1; }
! grep -q "index.html" "$RM_LOG" || { echo "FAIL: deleted outside assets/"; exit 1; }

: >"$RM_LOG"
if "$here/prune-old-assets.sh" bkt "$tmp/empty" 14 2>/dev/null; then echo "FAIL: pruned with an empty build"; exit 1; fi
[ ! -s "$RM_LOG" ] || { echo "FAIL: deleted with an empty build"; exit 1; }

if FAIL_RM=1 "$here/prune-old-assets.sh" bkt "$tmp/build" 14 >/dev/null 2>&1; then echo "FAIL: a failed delete exited 0"; exit 1; fi
# The live index.html cannot be read, or references no assets/ file: nothing is deleted.
: >"$RM_LOG"
if NO_INDEX=1 "$here/prune-old-assets.sh" bkt "$tmp/build" 14 >/dev/null 2>&1; then echo "FAIL: pruned without the live index"; exit 1; fi
printf '<html></html>' >"$tmp/index"
if "$here/prune-old-assets.sh" bkt "$tmp/build" 14 >/dev/null 2>&1; then echo "FAIL: pruned with an index that references no assets"; exit 1; fi
[ ! -s "$RM_LOG" ] || { echo "FAIL: deleted without a usable live index"; exit 1; }
echo "ok"
