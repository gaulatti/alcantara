#!/usr/bin/env bash

set -euo pipefail

ghcr_user="$1"
ghcr_token_base64="$2"
broadcast_secret_id="$3"
database_secret_id="$4"
image="$5"
nginx_config_base64="$6"
media_bucket="$7"
docker_config_dir='/tmp/alcantara-docker-config'
metrics_token_dir='/etc/alcantara'
metrics_token_file="$metrics_token_dir/metrics-token"

for value in "$broadcast_secret_id" "$database_secret_id" "$media_bucket"; do
  test -n "$value"
done

rm -rf "$docker_config_dir"
install -d -m 0700 "$docker_config_dir"
trap 'rm -rf "$docker_config_dir"' EXIT
printf '%s' "$ghcr_token_base64" | base64 -d | docker --config "$docker_config_dir" login ghcr.io --username "$ghcr_user" --password-stdin

docker network inspect broadcast-control >/dev/null
docker inspect palazzo >/dev/null
if docker inspect alcantara-backend-previous >/dev/null 2>&1; then
  echo 'An Alcantara rollback container requires operator review'
  exit 1
fi

# Preserve images referenced by running or stopped containers while reclaiming
# stale release images and incomplete layers before downloading the candidate.
docker image prune --all --force
docker --config "$docker_config_dir" pull "$image"
rm -rf "$docker_config_dir"

docker run --rm \
  -e AWS_REGION=us-east-1 \
  -e ARAUCO_SECRET_ID="$database_secret_id" \
  "$image" \
  pnpm run db:verify:restored

docker run --rm \
  -e NODE_ENV=production \
  -e AWS_REGION=us-east-1 \
  -e ALCANTARA_CONFIG_SECRET_ID="$broadcast_secret_id" \
  "$image" \
  pnpm run preflight:runtime

docker run --rm \
  -e AWS_REGION=us-east-1 \
  -e ARAUCO_SECRET_ID="$database_secret_id" \
  "$image" \
  pnpm run db:migrate:deploy

# The last startup and error lines of a container, on stderr: SSM keeps only
# the first 24,000 characters of stdout, which earlier steps can fill, and its
# own stderr limit fits this (colour codes, route mapping and module loading
# lines dropped; at most 35 lines of 200 characters).
print_startup_log() {
  docker logs "$1" 2>&1 \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -vE 'Mapped \{|RoutesResolver|InstanceLoader' \
    | tail -n 35 \
    | cut -c1-200 >&2 || true
}

# gaulatti/alcantara#223: boot the new image once as a deploy candidate and
# check that it answers before the running backend is touched. The candidate
# loads the same configuration and secrets, opens only read-only database
# sessions and starts no writer, claimer or scheduler; it is off the
# broadcast-control network, so it cannot reach Palazzo, and it publishes no
# port. A candidate that fails leaves production as it is.
docker rm -f alcantara-backend-candidate >/dev/null 2>&1 || true
if ! docker run -d --name alcantara-backend-candidate \
  -e NODE_ENV=production \
  -e HTTP_PORT=3006 \
  -e PORT=3006 \
  -e AWS_REGION=us-east-1 \
  -e ARAUCO_SECRET_ID="$database_secret_id" \
  -e ALCANTARA_BUILD_VERSION="${image##*:}" \
  -e ALCANTARA_CONFIG_SECRET_ID="$broadcast_secret_id" \
  -e ALLOWED_ORIGINS=https://alcantara.gaulatti.com,https://fifthbell.com,https://cdn.fifthbell.com \
  -e POMPEII_TEAM_ID=1 \
  -e MEDIA_S3_BUCKET="$media_bucket" \
  -e CONTAINERIZED=true \
  -e ALCANTARA_DEPLOY_CANDIDATE=1 \
  "$image" >/dev/null; then
  echo 'Alcantara candidate could not be created; the running backend is untouched'
  exit 1
fi
candidate_ready=false
for _ in $(seq 1 45); do
  if docker exec alcantara-backend-candidate node -e "fetch('http://127.0.0.1:3006/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    candidate_ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' alcantara-backend-candidate 2>/dev/null)" != true ]; then
    break
  fi
  sleep 2
done
if [ "$candidate_ready" != true ]; then
  # Say why: a container that exited is a different failure from one that stayed up and did not answer.
  if [ "$(docker inspect --format '{{.State.Running}}' alcantara-backend-candidate 2>/dev/null)" != true ]; then
    candidate_exit="$(docker inspect --format '{{.State.ExitCode}}' alcantara-backend-candidate 2>/dev/null || echo unknown)"
    echo "Alcantara candidate exited with code ${candidate_exit} before it answered its health check; the running backend is untouched"
  else
    echo 'Alcantara candidate did not answer its health check in time; the running backend is untouched'
  fi
  # The candidate's own start-up lines come next, on stderr: the workflow prints stdout first and
  # stderr after, so they appear below this line although they happened before the deploy's later steps.
  echo '--- candidate start-up log (last lines, printed on stderr) ---' >&2
  print_startup_log alcantara-backend-candidate
  docker rm -f alcantara-backend-candidate >/dev/null 2>&1 || true
  exit 1
fi
docker rm -f alcantara-backend-candidate >/dev/null
echo 'Alcantara candidate passed its health check'

# Resolve the scrape credential before touching the live backend. A missing or
# malformed secret field fails the deploy; the token is never printed.
install -d -m 0755 -o root -g root "$metrics_token_dir"
# No pipe: a reader that exits early would kill the writer with SIGPIPE under
# pipefail. The value goes to a private temp file by redirection, is checked
# non-empty, then installed read-only for root and moved into place.
metrics_token_tmp="$(umask 077 && mktemp "$metrics_token_dir/metrics-token.XXXXXX")"
if ! docker run --rm \
  -e AWS_REGION=us-east-1 \
  -e ALCANTARA_CONFIG_SECRET_ID="$broadcast_secret_id" \
  "$image" \
  node scripts/print-metrics-token.mjs >"$metrics_token_tmp" || [ ! -s "$metrics_token_tmp" ]; then
  rm -f "$metrics_token_tmp"
  echo 'Alcantara metrics scrape token could not be resolved; the running backend was not touched' >&2
  exit 1
fi
install -m 0400 -o root -g root "$metrics_token_tmp" "$metrics_token_file.new"
rm -f "$metrics_token_tmp"
mv -f "$metrics_token_file.new" "$metrics_token_file"

had_previous=false
if docker inspect alcantara-backend >/dev/null 2>&1; then
  docker stop alcantara-backend
  docker rename alcantara-backend alcantara-backend-previous
  had_previous=true
fi

rollback_backend() {
  echo 'Restoring previous Alcantara backend'
  docker rm -f alcantara-backend >/dev/null 2>&1 || true
  if [ "$had_previous" = true ]; then
    docker rename alcantara-backend-previous alcantara-backend
    docker start alcantara-backend
  fi
}

# Node runs the server directly, without pnpm's start-up time, under Docker's init: as the first process Node would
# not exit on SIGTERM, and every stop would wait out the grace period and kill it.
# The live container starts the server only (gaulatti/alcantara#873): the migrations ran above, from this same image,
# before the running backend was touched, and a second run here only lengthened the time with no backend.
# The radio check below waits for a song that started after this moment.
radio_since="$(date +%s)"

if ! docker run -d --name alcantara-backend \
  --init \
  --network broadcast-control \
  -p 127.0.0.1:3006:3006 \
  -e NODE_ENV=production \
  -e HTTP_PORT=3006 \
  -e PORT=3006 \
  -e AWS_REGION=us-east-1 \
  -e ARAUCO_SECRET_ID="$database_secret_id" \
  -e ALCANTARA_BUILD_VERSION="${image##*:}" \
  -e ALCANTARA_CONFIG_SECRET_ID="$broadcast_secret_id" \
  -e METRICS_TOKEN_FILE=/run/secrets/alcantara-metrics-token \
  -v "$metrics_token_file":/run/secrets/alcantara-metrics-token:ro \
  -e ALLOWED_ORIGINS=https://alcantara.gaulatti.com,https://fifthbell.com,https://cdn.fifthbell.com \
  -e POMPEII_TEAM_ID=1 \
  -e MEDIA_S3_BUCKET="$media_bucket" \
  -e CONTAINERIZED=true \
  --restart=always \
  --log-driver=local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  "$image" \
  node dist/src/main; then
  rollback_backend
  exit 1
fi

deployed_ready=false
for _ in $(seq 1 45); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3006/ >/dev/null; then
    deployed_ready=true
    break
  fi
  sleep 2
done
if [ "$deployed_ready" != true ]; then
  echo 'Alcantara backend failed its local health check; rolling back'
  print_startup_log alcantara-backend
  rollback_backend
  exit 1
fi

# The repository's nginx file is the HTTP half only; certbot writes the TLS half into the installed copy. Writing the
# repository's file over it takes 443 away until certbot puts it back (gaulatti/alcantara#873), so it is written only
# while there is no certificate, or the installed site does not use one.
nginx_site='/etc/nginx/conf.d/cumulus-alcantara.conf'
certificate='/etc/letsencrypt/live/api.alcantara.gaulatti.com/fullchain.pem'
printf '%s' "$nginx_config_base64" | base64 -d > /tmp/cumulus-alcantara.conf
if [ -s "$certificate" ] && grep -q '^[[:space:]]*ssl_certificate ' "$nginx_site" 2>/dev/null; then
  echo 'NGINX_SITE_KEPT: the installed site already serves TLS'
  # Say so when the repository's file has a setting the installed one lacks: it is not applied by itself.
  sed -E 's/^[[:space:]]+//' /tmp/cumulus-alcantara.conf \
    | grep -vE '^(#|$|listen |server \{|location |\})' \
    | while IFS= read -r directive; do
        grep -qF -- "$directive" "$nginx_site" || echo "NGINX_SITE_DRIFT: not in the installed site: $directive"
      done
else
  install -m 0644 /tmp/cumulus-alcantara.conf "$nginx_site"
  nginx -t
  systemctl reload nginx
  certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d api.alcantara.gaulatti.com
fi
rm -f /tmp/cumulus-alcantara.conf
systemctl enable --now certbot-renew.timer

public_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' https://api.alcantara.gaulatti.com/ || true)"
if [ "$public_status" != 200 ]; then
  echo 'Alcantara public health check failed; rolling back'
  rollback_backend
  exit 1
fi

if [ "$had_previous" = true ]; then
  docker rm alcantara-backend-previous
fi
docker image prune --all --force
echo ALCANTARA_HEALTHY

# gaulatti/alcantara#230: a healthy backend is not a playing radio. When a radio
# program is in automation (autoplay or shuffle), a song must start after the
# restart, read from Palazzo's own state: within 120 s, or within the remaining
# time of a song already on air plus 120 s (at most 15 minutes); a live show on
# the air (live.onAir) passes at once with RADIO_LIVE. Otherwise the
# deploy fails loudly with the playback state. It does not roll back: the new
# backend is healthy, and another restart is what turns one stall into three.
automatic_programs="$(docker exec alcantara-backend node -e "fetch('http://127.0.0.1:3006/metrics',{headers:{authorization:'Bearer '+require('fs').readFileSync(process.env.METRICS_TOKEN_FILE,'utf8').trim()}}).then(async(r)=>{if(!r.ok)process.exit(1);const m=/^alcantara_radio_automatic_programs (\\d+)$/m.exec(await r.text());if(!m)process.exit(1);console.log(m[1])},()=>process.exit(1))" || true)"
case "$automatic_programs" in
  ''|*[!0-9]*)
    echo 'RADIO_CHECK_FAILED: the backend did not report its automatic programs'
    exit 1
    ;;
  0)
    echo 'RADIO_CHECK_SKIPPED: no radio program is in automation'
    exit 0
    ;;
esac
if ! docker exec palazzo node -e '
const since = Number(process.argv[1]) * 1000;
const url = "http://127.0.0.1:3100/v1/programs/" + encodeURIComponent(process.env.PROGRAM_ID) + "/playback/state";
let deadline = Date.now() + 120000;
let state = null;
(async () => {
  for (;;) {
    try {
      const response = await fetch(url);
      state = response.ok ? await response.json() : { error: "http " + response.status };
    } catch {
      state = { error: "unreachable" };
    }
    // A live show is the radio playing; it never fails a deploy.
    if (state?.live?.onAir === true) {
      console.log("RADIO_LIVE");
      return;
    }
    const startedAt = Date.parse(state?.track?.startedAt ?? "");
    if (state?.status === "playing" && startedAt >= since) {
      console.log("RADIO_PLAYING startedAt=" + state.track.startedAt);
      return;
    }
    if (state?.status === "playing" && typeof state.remainingSeconds === "number")
      deadline = Math.max(deadline, Math.min(Date.now() + state.remainingSeconds * 1000 + 120000, since + 900000));
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log("RADIO_NOT_PLAYING " + JSON.stringify({
    error: state?.error ?? null,
    availability: state?.availability ?? null,
    status: state?.status ?? null,
    trackStartedAt: state?.track?.startedAt ?? null,
    remainingSeconds: state?.remainingSeconds ?? null,
    intro: state?.intro?.status ?? null,
    outputRms: state?.levels?.output?.rms ?? null,
    liveOnAir: state?.live?.onAir ?? null,
    liquidsoapRunning: state?.liquidsoap?.running ?? null,
    icecastConnected: state?.icecast?.connected ?? null,
  }));
  process.exitCode = 1;
})();
' "$radio_since"; then
  echo 'RADIO_CHECK_FAILED: no song started after the restart; the backend stays deployed'
  exit 1
fi
