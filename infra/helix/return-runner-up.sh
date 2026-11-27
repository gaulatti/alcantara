#!/bin/sh
# Start or update the return runner on Helix.
#
# Usage: AWS_REGION=… ALCANTARA_CONFIG_SECRET_ID=… infra/helix/return-runner-up.sh <ssh-target>
#
# Run from a machine that can read the runtime secret and pull the backend image, as livekit-up.sh is. It renders the
# renderer key with the image's print-return-runner-env.mjs, streams it over SSH into a 0600 file on Helix (never
# printed, never written locally), copies the runner, builds and starts the `alcantara-return-runner` project, and
# waits for it to report healthy. Nothing is published and no port is opened. Helix gets no cloud credential.
# Exit codes: 3 when the secret has no renderer key (nothing on Helix changes), 1 on any other failure.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <ssh-target>" >&2
  exit 1
fi
target=$1
: "${AWS_REGION:?AWS_REGION is required}"
: "${ALCANTARA_CONFIG_SECRET_ID:?ALCANTARA_CONFIG_SECRET_ID is required}"
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
key_line=$(docker run --rm \
  -e AWS_REGION="$AWS_REGION" \
  -e ALCANTARA_CONFIG_SECRET_ID="$ALCANTARA_CONFIG_SECRET_ID" \
  ${AWS_PROFILE:+-e AWS_PROFILE="$AWS_PROFILE"} \
  -v "$HOME/.aws:/root/.aws:ro" \
  "$image" node scripts/print-return-runner-env.mjs) || status=$?
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
