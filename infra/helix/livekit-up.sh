#!/bin/sh
# gaulatti/alcantara#354: start or update production LiveKit on Helix.
#
# Usage: AWS_REGION=… ALCANTARA_CONFIG_SECRET_ID=… infra/helix/livekit-up.sh <ssh-target>
#
# Run from a machine that can read the runtime secret and pull the backend image.
# It renders livekit.yaml with the image's print-livekit-config.mjs, streams it
# over SSH into a 0600 file on Helix (never printed, never written locally),
# copies the compose file and the nginx server block, starts the
# `alcantara-livekit` project, and waits for LiveKit to report healthy.
# Helix gets no cloud credential. Exit codes follow the renderer: 3 when the
# secret has no LiveKit group (nothing on Helix changes), 1 on any other failure.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <ssh-target>" >&2
  exit 1
fi
target=$1
: "${AWS_REGION:?AWS_REGION is required}"
: "${ALCANTARA_CONFIG_SECRET_ID:?ALCANTARA_CONFIG_SECRET_ID is required}"
image=${ALCANTARA_IMAGE:-ghcr.io/gaulatti/alcantara:latest}
here=$(cd "$(dirname "$0")" && pwd)
remote_dir='$HOME/.alcantara-livekit'

# The SSH target's login shell may be fish, so every remote command runs in sh.
remote() {
  ssh -o BatchMode=yes "$target" "sh -c '$1'"
}

status=0
config=$(docker run --rm \
  -e AWS_REGION="$AWS_REGION" \
  -e ALCANTARA_CONFIG_SECRET_ID="$ALCANTARA_CONFIG_SECRET_ID" \
  ${AWS_PROFILE:+-e AWS_PROFILE="$AWS_PROFILE"} \
  -v "$HOME/.aws:/root/.aws:ro" \
  "$image" node scripts/print-livekit-config.mjs) || status=$?
if [ "$status" -eq 3 ]; then
  echo "LiveKit is not configured in the runtime secret; Helix is unchanged" >&2
  exit 3
fi
if [ "$status" -ne 0 ] || [ -z "$config" ]; then
  echo "LiveKit configuration could not be rendered; Helix is unchanged" >&2
  exit 1
fi

remote "umask 077 && mkdir -p $remote_dir/livekit-redis"
printf '%s\n' "$config" |
  remote "umask 077 && cat > $remote_dir/livekit.yaml.new && mv -f $remote_dir/livekit.yaml.new $remote_dir/livekit.yaml"
config=
scp -q -o BatchMode=yes "$here/compose.livekit.yml" "$here/nginx-livekit.conf" "$target:.alcantara-livekit/"

remote "cd $remote_dir && ALCANTARA_SERVICE_DIR=$remote_dir docker compose -f compose.livekit.yml up -d"
remote "i=0; until [ \"\$(docker inspect -f {{.State.Health.Status}} alcantara-livekit)\" = healthy ]; do i=\$((i + 1)); [ \$i -lt 60 ] || exit 1; sleep 2; done" || {
  echo "LiveKit did not report healthy within two minutes" >&2
  exit 1
}
echo "LiveKit is healthy on $target"
