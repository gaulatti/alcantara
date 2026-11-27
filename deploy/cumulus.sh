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
# gaulatti/alcantara#873: an image that answers /health/ready holds the playout lease, so it can start beside the
# running backend and take over without a gap. One that does not (404) is replaced as before.
lease_supported=false
if docker exec alcantara-backend-candidate node -e "fetch('http://127.0.0.1:3006/health/ready').then((r) => process.exit(r.status === 200 ? 0 : 3), () => process.exit(1))" >/dev/null 2>&1; then
  lease_supported=true
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

# Starts the backend image as NAME on loopback PORT, running COMMAND.
start_backend() {
  name="$1"
  port="$2"
  shift 2
  # Under Docker's init: as the first process Node ignores SIGTERM, so a stop would wait out the grace period.
  docker run -d --name "$name" \
    --init \
    --network broadcast-control \
    -p "127.0.0.1:$port:$port" \
    -e NODE_ENV=production \
    -e HTTP_PORT="$port" \
    -e PORT="$port" \
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
    "$@"
}

# The playout state a lease-holding backend on PORT reports (standby, active), or nothing (no backend there, or one
# from before the lease, whose /health/ready answers 404).
playout_state() {
  curl --fail --silent --max-time 2 "http://127.0.0.1:$1/health/ready" | sed -n 's/.*"state":"\([a-z]*\)".*/\1/p'
}

# When the backend on loopback PORT took the playout lock, by its own clock (empty from a backend that does not say).
playout_granted() {
  curl --fail --silent --max-time 2 "http://127.0.0.1:$1/health/ready" | sed -n 's/.*"grantedAt":"\([^"]*\)".*/\1/p'
}

# The nginx workers that accept new connections. A worker retitles itself "worker process is shutting down" once a
# reload tells it to stop accepting, so it no longer matches.
nginx_accepting_workers() {
  pgrep -f '^nginx: worker process$' 2>/dev/null || true
}

# After a reload, waits until none of the workers that accepted before it (BEFORE, their pids) still accepts, at
# most 5 s: only then can no new request reach the previous backend once it is told to stop. A worker kept by a
# long-lived stream stops accepting at once, so it does not hold this up. Without pgrep, a fixed 1 s settle.
wait_nginx_workers() {
  local before="$1" now pid lingering
  if ! command -v pgrep >/dev/null 2>&1; then
    sleep 1
    echo "NGINX_SETTLED $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) fixed"
    return 0
  fi
  for _ in $(seq 1 50); do
    now="$(nginx_accepting_workers)"
    lingering=false
    for pid in $before; do
      if printf '%s\n' "$now" | grep -qx "$pid"; then lingering=true; fi
    done
    if [ "$lingering" = false ]; then
      echo "NGINX_SETTLED $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
      return 0
    fi
    sleep 0.1
  done
  echo "NGINX_SETTLE_TIMEOUT $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ): workers from before the reload still accept"
}

# Points the installed nginx site at loopback PORT, changing only its proxy_pass port (certbot's TLS half stays). The
# new site is written beside it, checked complete (non-empty, the new proxy_pass in it) and moved into place in one
# step; a full disk or any failure leaves the site as it was. If nginx refuses it or the reload fails, the previous
# site goes back and nginx is reloaded on it. Returns non-zero on any failure.
nginx_site='/etc/nginx/conf.d/cumulus-alcantara.conf'
point_nginx_at() {
  local port="$1" backup="$nginx_site.before-switch" next="$nginx_site.next"
  [ -f "$nginx_site" ] || return 0
  # Already there: nothing to write or reload (a failed switch always puts the previous site back and reloads it, so
  # the file never says one port while nginx serves another). A site with no loopback proxy_pass has nothing to point.
  # Reloaded anyway: an earlier run cut off between writing the site and reloading would have left nginx serving the
  # old port with the file already saying this one.
  if grep -q "proxy_pass http://127.0.0.1:$port;" "$nginx_site"; then
    nginx -t && systemctl reload nginx
    return
  fi
  grep -q 'proxy_pass http://127.0.0.1:' "$nginx_site" || return 0
  rm -f "$next"
  cp "$nginx_site" "$backup" || { rm -f "$backup"; return 1; }
  # Through a copy, not sed -i, so it behaves the same with GNU and BSD sed.
  if ! sed -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+;#proxy_pass http://127.0.0.1:$port;#" "$backup" >"$next" ||
    [ ! -s "$next" ] || ! grep -q "proxy_pass http://127.0.0.1:$port;" "$next"; then
    rm -f "$next" "$backup"
    return 1
  fi
  if ! mv -f "$next" "$nginx_site"; then
    rm -f "$next" "$backup"
    return 1
  fi
  if nginx -t && systemctl reload nginx; then
    rm -f "$backup"
    return 0
  fi
  mv -f "$backup" "$nginx_site"
  nginx -t && systemctl reload nginx
  return 1
}

# Available memory in MB, or nothing where the host does not say.
available_mb() {
  awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || true
}

if docker inspect alcantara-backend-next >/dev/null 2>&1 && ! docker inspect alcantara-backend >/dev/null 2>&1; then
  echo 'An Alcantara handover container (alcantara-backend-next) is running with no alcantara-backend: requires operator review'
  exit 1
fi

live_port=3006
if docker inspect alcantara-backend >/dev/null 2>&1; then
  live_port="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' alcantara-backend | sed -n 's/^PORT=//p' | head -n 1)"
  [ -n "$live_port" ] || live_port=3006
fi

# gaulatti/alcantara#873: the handover needs both sides to speak the lease. The new image must answer /health/ready
# (lease_supported, from its candidate) and the running backend must report itself active: a running backend from
# before the lease holds no lock, so a standby beside it would take the free lock at once and two engines would drive
# playout. It also needs room for a second backend for a minute. Anything else takes today's path.
handover=false
if [ "$lease_supported" = true ] && docker inspect alcantara-backend >/dev/null 2>&1; then
  live_state="$(playout_state "$live_port" || true)"
  memory="$(available_mb)"
  if [ "$live_state" != active ]; then
    echo "HANDOVER_SKIPPED: the running backend does not hold the playout lease (state: ${live_state:-none}); replacing it as before"
  elif [ -n "$memory" ] && [ "$memory" -lt 600 ]; then
    echo "HANDOVER_SKIPPED: ${memory} MB available, under 600 MB; replacing the backend as before"
  else
    handover=true
  fi
fi

# Puts the previous backend back after the new one failed between the nginx switch and taking the lease: removes the
# new container, points nginx back, starts the previous backend and waits for it to hold the lease again.
restore_previous() {
  docker rm -f alcantara-backend-next >/dev/null 2>&1 || true
  point_nginx_at "$live_port" || echo 'NGINX_NOT_RESTORED: nginx could not be pointed back at the previous backend'
  docker start alcantara-backend || true
  for _ in $(seq 1 40); do
    if [ "$(playout_state "$live_port" || true)" = active ]; then
      echo "OWNER_RESTORED $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
      return 0
    fi
    sleep 0.5
  done
  echo 'OWNER_NOT_RESTORED: the previous backend did not take the playout lease back; no instance drives playout'
  return 1
}

if [ "$handover" = true ]; then
  # The new backend starts beside the old one as a standby (it holds requests and drives nothing), nginx moves to it,
  # and the old one is stopped: its lease connection closes, the new one takes the lease, adopts the playing song and
  # serves the held requests. Before the old one stops, a failure removes the new container and leaves the old one
  # serving and driving playout.
  had_previous=false
  if [ "$live_port" = 3006 ]; then new_port=3007; else new_port=3006; fi
  docker rm -f alcantara-backend-next >/dev/null 2>&1 || true
  if ! start_backend alcantara-backend-next "$new_port" node dist/src/main; then
    echo 'Alcantara standby could not be created; the running backend is untouched'
    exit 1
  fi
  standby_ready=false
  for _ in $(seq 1 45); do
    state="$(playout_state "$new_port" || true)"
    if [ "$state" = active ]; then
      # Only possible if the running backend let go of the lease: never leave two backends that may both drive.
      echo 'Alcantara standby took the playout lease while the running backend was up; removing it'
      docker rm -f alcantara-backend-next >/dev/null 2>&1 || true
      exit 1
    fi
    if [ "$state" = standby ]; then
      standby_ready=true
      break
    fi
    sleep 2
  done
  if [ "$standby_ready" != true ]; then
    echo 'Alcantara standby did not report ready; the running backend is untouched'
    print_startup_log alcantara-backend-next
    docker rm -f alcantara-backend-next >/dev/null 2>&1 || true
    exit 1
  fi
  nginx_workers_before="$(nginx_accepting_workers)"
  if ! point_nginx_at "$new_port"; then
    echo 'nginx would not take the new port; the running backend is untouched'
    docker rm -f alcantara-backend-next >/dev/null 2>&1 || true
    exit 1
  fi
  echo "BACKEND_SWITCH $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) port=$new_port"
  # From here to OWNER_ACQUIRED nginx points at a standby. Any exit (an error under set -e, a signal) puts the
  # previous backend back first.
  trap 'status=$?; trap - EXIT; rm -rf "$docker_config_dir"; if [ "$status" -ne 0 ]; then restore_previous || true; fi; exit "$status"' EXIT
  trap 'exit 130' INT TERM
  # `systemctl reload` returns before the old workers stop accepting: until they do, a new request can still reach the
  # previous backend, which answers 503 once it starts closing. It is told to stop only after they stopped.
  wait_nginx_workers "$nginx_workers_before"
  # The radio check below waits for a song that started after this moment.
  radio_since="$(date +%s)"
  echo "OWNER_RELEASED $(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  # Stopped in the background and polled meanwhile: the new one holds the lease as soon as the old one frees it,
  # usually long before the old process has exited (up to 15 s), and OWNER_ACQUIRED must say when it did.
  docker stop -t 15 alcantara-backend &
  stop_pid=$!
  active=false
  acquired_at=''
  while kill -0 "$stop_pid" 2>/dev/null; do
    if [ "$(playout_state "$new_port" || true)" = active ]; then
      active=true
      acquired_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
      break
    fi
    sleep 0.2
  done
  # The old one is gone before anything else happens; a stop that failed is an exit, so the trap restores it.
  wait "$stop_pid"
  # Otherwise the new one normally holds the lease about a second after the old one's connection closes; activation
  # adopts the playing song from the database. 20 s bounds the wait.
  if [ "$active" != true ]; then
    for _ in $(seq 1 40); do
      if [ "$(playout_state "$new_port" || true)" = active ]; then
        active=true
        acquired_at="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
        break
      fi
      sleep 0.5
    done
  fi
  if [ "$active" != true ]; then
    trap - EXIT INT TERM
    echo 'Alcantara standby did not take the playout lease; restoring the previous backend'
    print_startup_log alcantara-backend-next
    if restore_previous; then
      handover_failed=true
      rollback_backend() {
        echo 'The previous backend is back and serving; nothing more to roll back'
      }
    else
      exit 1
    fi
  else
    trap - EXIT INT TERM
    # The poll's time, and the backend's own grant time: the gap is OWNER_GRANTED − OWNER_UNLOCKED.
    echo "OWNER_ACQUIRED $acquired_at"
    echo "OWNER_GRANTED $(playout_granted "$new_port" || true)"
    # The previous backend's own shutdown times, from its log before it is removed: SIGTERM received, writers
    # stopping, lock released.
    { docker logs alcantara-backend 2>&1 || true; } | grep -oE 'PLAYOUT_(SIGTERM|STOPPING|UNLOCKED) [0-9T:.Z-]+' |
      sed -e 's/^PLAYOUT_UNLOCKED/OWNER_UNLOCKED/' -e 's/^PLAYOUT_/PREVIOUS_/' || true
    # Fix forward from here: the new backend serves and drives playout, so the stopped one is not kept as a rollback
    # container (one left behind would stop every later deploy for operator review).
    docker rm -f alcantara-backend >/dev/null 2>&1 || true
    docker rename alcantara-backend-next alcantara-backend
    had_previous=false
    live_port="$new_port"
    rollback_backend() {
      echo 'The new backend is serving and driving playout; it is left in place (fix forward)'
    }
  fi
else
  # Today's path always serves on 3006: nginx is pointed back at it below, whatever port a handover left. The
  # previous backend's own port is kept for the rollback.
  old_port="$live_port"
  live_port=3006
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
      # nginx may already point at 3006 for the new backend: back to where the previous one serves.
      point_nginx_at "$old_port" || echo 'NGINX_NOT_RESTORED: nginx could not be pointed back at the previous backend'
    fi
  }

  # The live container starts the server only (gaulatti/alcantara#873): the migrations ran above, from this same image,
  # before the running backend was touched, and a second run here only lengthened the time with no backend.
  # The radio check below waits for a song that started after this moment.
  radio_since="$(date +%s)"

  if ! start_backend alcantara-backend 3006 node dist/src/main; then
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

fi

# A handover whose new backend never took the lease put the previous one back: the checks below (public, radio) still
# run against it, and the deploy then ends as failed.
if [ "${handover_failed:-false}" = true ]; then
  trap 'status=$?; trap - EXIT; if [ "$status" -eq 0 ]; then echo "ALCANTARA_DEPLOY_FAILED: the new backend never took the playout lease; the previous backend is back"; exit 1; fi; exit "$status"' EXIT
fi

# The repository's nginx file is the HTTP half only; certbot writes the TLS half into the installed copy. Writing the
# repository's file over it takes 443 away until certbot puts it back (gaulatti/alcantara#873), so it is written only
# while there is no certificate, or the installed site does not use one.
certificate='/etc/letsencrypt/live/api.alcantara.gaulatti.com/fullchain.pem'
printf '%s' "$nginx_config_base64" | base64 -d > /tmp/cumulus-alcantara.conf
if [ -s "$certificate" ] && grep -q '^[[:space:]]*ssl_certificate ' "$nginx_site" 2>/dev/null; then
  echo 'NGINX_SITE_KEPT: the installed site already serves TLS'
  # Say so when the repository's file has a setting the installed one lacks: it is not applied by itself.
  sed -E 's/^[[:space:]]+//' /tmp/cumulus-alcantara.conf \
    | { grep -vE '^(#|$|listen |server \{|location |\}|proxy_pass )' || true; } \
    | while IFS= read -r directive; do
        grep -qF -- "$directive" "$nginx_site" || echo "NGINX_SITE_DRIFT: not in the installed site: $directive"
      done
else
  install -m 0644 /tmp/cumulus-alcantara.conf "$nginx_site"
  nginx -t
  systemctl reload nginx
  certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d api.alcantara.gaulatti.com
fi
# The repository's file proxies to 3006; after a handover the live backend may be on 3007.
point_nginx_at "$live_port"
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
automatic_programs="$(docker exec alcantara-backend node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/metrics',{headers:{authorization:'Bearer '+require('fs').readFileSync(process.env.METRICS_TOKEN_FILE,'utf8').trim()}}).then(async(r)=>{if(!r.ok)process.exit(1);const m=/^alcantara_radio_automatic_programs (\\d+)$/m.exec(await r.text());if(!m)process.exit(1);console.log(m[1])},()=>process.exit(1))" || true)"
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
