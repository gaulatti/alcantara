#!/bin/sh
# Start or update the on-air contribution worker on cumulus, beside Palazzo.
#
# Usage: infra/cumulus/contribution-up.sh <cumulus-ssh-target>
#
# Renders the renderer key inside the running `alcantara-backend` container on the same host (it already has the
# runtime secret's id and the access to read it; set ALCANTARA_BACKEND_DOCKER="sudo docker" if that host needs it),
# streams it over SSH into a 0600 file (never printed, never written locally), copies the worker, builds and starts the
# `alcantara-contribution` project on the broadcast-control network, and waits for it to report healthy. Nothing is
# published on the host and no port is opened. Palazzo must already listen on CONTRIBUTION_RTMP_URL (its RTMP_URL).
# Exit codes: 3 when the secret has no renderer key (nothing on cumulus changes), 1 on any other failure.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <cumulus-ssh-target>" >&2
  exit 1
fi
target=$1
api=${ALCANTARA_API_URL:-https://api.alcantara.gaulatti.com}
program=${CONTRIBUTION_PROGRAM_ID:-modoitaliano.fm}
rtmp=${CONTRIBUTION_RTMP_URL:-rtmp://palazzo:1935/live/contribution}
docker_cmd=${ALCANTARA_BACKEND_DOCKER:-docker}
here=$(cd "$(dirname "$0")" && pwd)
remote_dir='$HOME/.alcantara-contribution'

# The SSH target's login shell may be fish, so every remote command runs in sh.
remote() {
  ssh -o BatchMode=yes "$target" "sh -c '$1'"
}

status=0
key_line=$(ssh -o BatchMode=yes "$target" \
  "sh -c '$docker_cmd exec ${ALCANTARA_BACKEND_CONTAINER:-alcantara-backend} node scripts/print-return-runner-env.mjs --program $program'") || status=$?
# Only the key lines are taken (the station's own key and the shared key, one each): anything else a host's shell prints
# must not reach the file. The worker presents its station's key, else the shared key (gaulatti/alcantara#884).
key_line=$(printf '%s\n' "$key_line" | grep -E '^WEBRTC_(RENDERER|PROGRAM)_KEY=.' | awk -F= '!seen[$1]++' || true)
if [ "$status" -eq 3 ]; then
  echo "The runtime secret has no renderer key; cumulus is unchanged" >&2
  exit 3
fi
if [ "$status" -ne 0 ] || [ -z "$key_line" ]; then
  echo "The renderer key could not be read; cumulus is unchanged" >&2
  exit 1
fi

remote "umask 077 && mkdir -p $remote_dir/contribution"
printf 'ALCANTARA_API_URL=%s\nPROGRAM_ID=%s\nCONTRIBUTION_RTMP_URL=%s\n%s\n' "$api" "$program" "$rtmp" "$key_line" |
  remote "umask 077 && cat > $remote_dir/contribution.env.new && mv -f $remote_dir/contribution.env.new $remote_dir/contribution.env"
key_line=
scp -q -o BatchMode=yes "$here/compose.contribution.yml" "$here/contribution-run.sh" "$target:.alcantara-contribution/"
scp -q -o BatchMode=yes "$here/contribution/Dockerfile" "$here/contribution/package.json" "$here/contribution/worker.mjs" \
  "$target:.alcantara-contribution/contribution/"

# Cumulus has no docker compose; contribution-run.sh applies the same settings with plain docker.
remote "sh $remote_dir/contribution-run.sh \"$docker_cmd\""
remote "i=0; until [ \"\$($docker_cmd inspect -f {{.State.Health.Status}} alcantara-contribution)\" = healthy ]; do i=\$((i + 1)); [ \$i -lt 60 ] || exit 1; sleep 2; done" || {
  echo "The contribution worker did not report healthy within two minutes" >&2
  exit 1
}
echo "The contribution worker is healthy on $target"
remote "$docker_cmd logs --tail 5 alcantara-contribution"
