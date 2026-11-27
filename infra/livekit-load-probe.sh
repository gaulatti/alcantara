#!/usr/bin/env bash
# gaulatti/alcantara#354: proves media flows through production LiveKit from outside the studio's network, on demand.
# Run it on a host outside the LAN (cumulus) that can read the runtime secret and pull the deployed backend image:
#
#   ALCANTARA_CONFIG_SECRET_ID=<runtime secret id> AWS_REGION=<region> infra/livekit-load-probe.sh
#
# ALCANTARA_IMAGE picks the backend image (default ghcr.io/gaulatti/alcantara:latest, as infra/helix/livekit-up.sh).
# AWS access comes from the host: ~/.aws (with AWS_PROFILE if set) or the instance role.
#
# It loads LiveKit's public URL, key and secret from the runtime secret inside the backend image
# (backend/scripts/livekit-probe-env.mjs, the same loading as print-livekit-config.mjs) into a 0600 env file, then runs
# the LiveKit CLI's load test in a probe room of its own: 1 audio and 1 simulcast video publisher, 2 subscribers, for
# PROBE_DURATION (25s). The CLI mints its own short-lived tokens. It prints the CLI's table and nothing secret, and
# removes the env file and the images it pulled. Exit status: the CLI's, or 1 when the credentials cannot be loaded.
set -euo pipefail

: "${ALCANTARA_CONFIG_SECRET_ID:?set ALCANTARA_CONFIG_SECRET_ID}"
: "${AWS_REGION:?set AWS_REGION}"
ALCANTARA_IMAGE="${ALCANTARA_IMAGE:-ghcr.io/gaulatti/alcantara:latest}"
LIVEKIT_CLI_IMAGE="${LIVEKIT_CLI_IMAGE:-livekit/livekit-cli:v2.19.4}"
PROBE_DURATION="${PROBE_DURATION:-25s}"
# A room no program uses (programs use alcantara-<programId>), so the probe never meets a call.
PROBE_ROOM="alcantara-probe-$(date -u +%Y%m%dT%H%M%SZ)"

workdir="$(mktemp -d)"
chmod 700 "$workdir"
pulled=()
cleanup() {
  rm -f "$workdir/livekit.env"
  rmdir "$workdir" 2>/dev/null || true
  for image in ${pulled[@]+"${pulled[@]}"}; do docker rmi -f "$image" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

for image in "$ALCANTARA_IMAGE" "$LIVEKIT_CLI_IMAGE"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    docker pull -q "$image" >/dev/null
    pulled+=("$image")
  fi
done

# As the host user, so the host can read the 0600 env file it writes; AWS settings are passed by name only.
aws_config=()
if [ -d "$HOME/.aws" ]; then aws_config=(-v "$HOME/.aws:/probe-home/.aws:ro"); fi
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -e HOME=/probe-home \
  -e ALCANTARA_CONFIG_SECRET_ID -e AWS_REGION ${AWS_PROFILE:+-e AWS_PROFILE} \
  ${aws_config[@]+"${aws_config[@]}"} \
  -v "$workdir:/probe" \
  "$ALCANTARA_IMAGE" node scripts/livekit-probe-env.mjs /probe/livekit.env

echo "LiveKit load probe: room ${PROBE_ROOM}, ${PROBE_DURATION}, 1 audio + 1 simulcast video publisher, 2 subscribers"
docker run --rm --env-file "$workdir/livekit.env" "$LIVEKIT_CLI_IMAGE" \
  perf load-test \
  --room "$PROBE_ROOM" \
  --audio-publishers 1 \
  --video-publishers 1 \
  --subscribers 2 \
  --duration "$PROBE_DURATION"
