#!/bin/sh
# Start or update the return runner on Helix.
#
# Usage: AWS_REGION=… ALCANTARA_CONFIG_SECRET_ID=… infra/helix/return-runner-up.sh <ssh-target>
#        infra/helix/return-runner-up.sh --from-container <backend-ssh-target> <ssh-target>
#
# The first form runs from a machine that can read the runtime secret and pull the backend image, as livekit-up.sh is.
# The second needs neither: it renders the key inside the running `alcantara-backend` container on its host, which
# already has the secret's id and the access to read it (set ALCANTARA_BACKEND_DOCKER="sudo docker" if that host needs
# it). Either way it renders the renderer key with the image's print-return-runner-env.mjs, streams it over SSH into a
# 0600 file on Helix (never
# printed, never written locally), copies the runner, builds and starts the `alcantara-return-runner` project, and
# waits for it to report healthy. Nothing is published and no port is opened. Helix gets no cloud credential.
# The env file gets the fleet key, each program's key and the shared key, whichever the secret holds (gaulatti/alcantara#884).
# Exit codes: 3 when the secret has no renderer key (nothing on Helix changes), 1 on any other failure.
set -eu

usage="usage: $0 [--from-container <backend-ssh-target>] <ssh-target>"
backend=
if [ "${1:-}" = "--from-container" ]; then
  [ "$#" -eq 3 ] || { echo "$usage" >&2; exit 1; }
  backend=$2
  shift 2
fi
if [ "$#" -ne 1 ]; then
  echo "$usage" >&2
  exit 1
fi
target=$1
if [ -z "$backend" ]; then
  : "${AWS_REGION:?AWS_REGION is required}"
  : "${ALCANTARA_CONFIG_SECRET_ID:?ALCANTARA_CONFIG_SECRET_ID is required}"
fi
image=${ALCANTARA_IMAGE:-ghcr.io/gaulatti/alcantara:latest}
api=${ALCANTARA_API_URL:-https://api.alcantara.gaulatti.com}
app=${ALCANTARA_APP_URL:-https://alcantara.gaulatti.com}
browser=${WEBRTC_BROWSER:-chromium}
here=$(cd "$(dirname "$0")" && pwd)
remote_dir='$HOME/.alcantara-return-runner'

# The SSH target's login shell may be fish, so every remote command runs in sh.
remote() {
  ssh -o BatchMode=yes "$target" "sh -c '$1'"
}

status=0
if [ -n "$backend" ]; then
  key_line=$(ssh -o BatchMode=yes "$backend" \
    "sh -c '${ALCANTARA_BACKEND_DOCKER:-docker} exec ${ALCANTARA_BACKEND_CONTAINER:-alcantara-backend} node scripts/print-return-runner-env.mjs'") || status=$?
else
  key_line=$(docker run --rm \
    -e AWS_REGION="$AWS_REGION" \
    -e ALCANTARA_CONFIG_SECRET_ID="$ALCANTARA_CONFIG_SECRET_ID" \
    ${AWS_PROFILE:+-e AWS_PROFILE="$AWS_PROFILE"} \
    -v "$HOME/.aws:/root/.aws:ro" \
    "$image" node scripts/print-return-runner-env.mjs) || status=$?
fi
# Only the key lines are taken (the shared key, the fleet key and the programs' keys, one each): anything else a host's
# shell prints must not reach the file. The runner needs the fleet key or the shared key for its router list.
key_line=$(printf '%s\n' "$key_line" | grep -E '^WEBRTC_(RENDERER_KEY|FLEET_KEY|PROGRAM_KEYS)=.' | awk -F= '!seen[$1]++' || true)
printf '%s\n' "$key_line" | grep -qE '^WEBRTC_(RENDERER|FLEET)_KEY=.' || key_line=
if [ "$status" -eq 3 ]; then
  echo "The runtime secret has no renderer key; Helix is unchanged" >&2
  exit 3
fi
if [ "$status" -ne 0 ] || [ -z "$key_line" ]; then
  echo "The renderer key could not be read; Helix is unchanged" >&2
  exit 1
fi

remote "umask 077 && mkdir -p $remote_dir/return-runner"
printf 'ALCANTARA_API_URL=%s\nALCANTARA_APP_URL=%s\nWEBRTC_BROWSER=%s\n%s\n' "$api" "$app" "$browser" "$key_line" |
  remote "umask 077 && cat > $remote_dir/return-runner.env.new && mv -f $remote_dir/return-runner.env.new $remote_dir/return-runner.env"
key_line=
scp -q -o BatchMode=yes "$here/compose.return-runner.yml" "$target:.alcantara-return-runner/"
scp -q -o BatchMode=yes "$here/return-runner/Dockerfile" "$here/return-runner/package.json" "$here/return-runner/runner.mjs" \
  "$target:.alcantara-return-runner/return-runner/"

remote "cd $remote_dir && ALCANTARA_SERVICE_DIR=$remote_dir docker compose -f compose.return-runner.yml up -d --build"
remote "i=0; until [ \"\$(docker inspect -f {{.State.Health.Status}} alcantara-return-runner)\" = healthy ]; do i=\$((i + 1)); [ \$i -lt 60 ] || exit 1; sleep 2; done" || {
  echo "The return runner did not report healthy within two minutes" >&2
  exit 1
}
echo "The return runner is healthy on $target"
remote "docker logs --tail 5 alcantara-return-runner"
