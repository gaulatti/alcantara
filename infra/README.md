# Alcantara Infrastructure & LiveKit Ingress

This directory defines the production deployment topology and configuration templates for Alcantara media infrastructure. Production runs LiveKit Server and Redis. LiveKit Ingress is defined here but not run, and there is no LiveKit Egress. The whole calls stack is mapped in [docs/calls.md](../docs/calls.md).

## Topology & Services

Production LiveKit runs on Helix, the on-premises host behind `helix.gaulatti.com`, not on the service host that runs the backend and the radio engine (gaulatti/alcantara#354). The backend deploy does not start it. [`helix/livekit-up.sh`](helix/livekit-up.sh) does (see below).

Defined in [`helix/compose.livekit.yml`](helix/compose.livekit.yml), Compose project `alcantara-livekit`:

- **`redis` (`redis:7.4-alpine`)**: State coordination between LiveKit Server and LiveKit Ingress, which is not run. It is never published and is reached as `redis:6379` on the project's own network. It is limited to 0.5 CPU and 512 MiB.
- **`livekit` (`livekit/livekit-server:v1.13.4`)**: Core WebRTC SFU for calls and broadcast rooms.
  - It has a healthcheck (`wget` of its own `http://127.0.0.1:7880/`, which answers `OK`).
  - It is limited to one CPU and 1 GiB, because Helix also runs other services.
- **`ingress` (`livekit/ingress:v1.5.0`)**: Ingest service normalizing external media streams (WHIP, HLS, RTMP, SRT) into LiveKit rooms.
  - It is behind the `ingress` compose profile, so `docker compose up -d` starts only `redis` and `livekit`.
  - Start it with `--profile ingress` once an `ingress.yaml` is written.

All three use `restart: always`, so Docker brings them back after a reboot.

Configuration:
- [`livekit.production.example.yaml`](livekit.production.example.yaml): the shape of the LiveKit Server configuration. The real file is rendered from the runtime secret by `backend/scripts/print-livekit-config.mjs`.
- [`ingress.production.example.yaml`](ingress.production.example.yaml): LiveKit Ingress configuration.
- [`helix/nginx-livekit.conf`](helix/nginx-livekit.conf): the public name's nginx server block.
- [`helix/nginx-turn-stream.conf`](helix/nginx-turn-stream.conf) and [`helix/nginx-behind-stream.conf`](helix/nginx-behind-stream.conf): TURN over TLS on 443 (see below).

All configuration files in source control use placeholder credentials (`replace-api-key`, `replace-api-secret`, `replace-redis-password`). Real credentials live only in AWS Secrets Manager (`broadcast/production/config`).

## Starting or updating LiveKit on Helix

Run this from a machine that can read the runtime secret and pull the backend image:

```bash
AWS_REGION=us-east-1 ALCANTARA_CONFIG_SECRET_ID=broadcast/production/config infra/helix/livekit-up.sh <helix ssh target>
```

The script:
1. renders `livekit.yaml` with the image's `print-livekit-config.mjs`;
2. streams it over SSH into `~/.alcantara-livekit/livekit.yaml` (mode 0600) on Helix. The file is never printed or written on the operator's machine;
3. copies the compose file and the nginx files;
4. starts the project and waits up to two minutes for `livekit` to report healthy.

Helix holds no cloud credential.

Exit codes: 0 when LiveKit is healthy, 3 when the secret has no LiveKit group (Helix is unchanged), and 1 on any other failure.

One-time host setup, which needs root on Helix and the router's port forward:

```bash
sudo firewall-cmd --permanent --zone=FedoraServer --add-port=7881/tcp --add-port=7882/udp --add-port=3478/udp && sudo firewall-cmd --reload && sudo cp ~/.alcantara-livekit/nginx-livekit.conf /etc/nginx/sites-available/livekit-alcantara && sudo nginx -t && sudo systemctl reload nginx && sudo certbot --nginx -d livekit.alcantara.gaulatti.com
```

## Return runner

Guests hear their return from the return router, a console page (`/return-router/<program>`). `helix/compose.return-runner.yml` runs it with nobody opening anything: one container with Playwright's browsers keeps one headless page open per program that needs it.

- **It only dials out.** Every 3 s it asks the backend `GET /webrtc/return-routers` (the renderer key in `X-Renderer-Key`, the programs with its open pages in `?running=`) for `{"programs": [...]}`. An unchanged list is a 304. Nothing is published and no port is opened.
- **It never cuts a live return for a missing answer.** A backend that is restarting, unreachable or without the list leaves the open pages as they are. A program must be absent from the list for 10 s before its page closes.
- **The keys** (gaulatti/alcantara#884) are rendered from the runtime secret into a 0600 `return-runner.env` on Helix: the fleet key (`webrtcFleetKey`) for the router list, each program's key (`webrtcProgramKeys`) for that program's page, and the shared key for whichever of those the secret does not hold, until it is removed. A program's key reaches its page in session storage, never in a URL or a log. A program with neither its own key nor the shared key is not opened, and the log says so.
- **A page that fails**, or is not connected for 45 s, is opened again after 5 s, 15 s, then every 60 s.
- **Logs** (`docker logs alcantara-return-runner`) carry the page's own `[return-router] ` diagnostics, and its errors and failed requests with queries, long tokens and the renderer key removed.
- **Health and metrics** are on `127.0.0.1:8090` inside the container (`/` and `/metrics`: `return_runner_routers{state}`, `return_runner_polls_total{result}`, `return_runner_opens_total{result}`), not published.
- **Browser flags.** The page holds no microphone permission, so Chromium would hide its address and LiveKit would get no media path; the runner turns that off, and the local network checks, for its own browser only.

Deploy or update, from a machine that can read the runtime secret:

```bash
AWS_REGION=… ALCANTARA_CONFIG_SECRET_ID=… infra/helix/return-runner-up.sh <ssh-target>
```

From a machine that cannot pull the backend image, render the key in the running backend container instead:

```bash
infra/helix/return-runner-up.sh --from-container <backend-ssh-target> <ssh-target>
```

`WEBRTC_BROWSER=firefox` or `webkit` on that command changes the engine. Stop it with `docker compose -f compose.return-runner.yml down` in `~/.alcantara-return-runner` on Helix. The backend image must already contain `scripts/print-return-runner-env.mjs`.

`e2e/return-proof.mjs` proves the return from the guest's side alone: a guest joins the real page and the level of what it plays is measured (`RETURN_EXPECT=sound`, or `silence` when nothing but the guest is in the room, so its own voice would be the only thing to hear).

## On-air contribution worker (cumulus)

`cumulus/compose.contribution.yml` runs the station's one producer for Palazzo's live input beside Palazzo: it mixes the guests cued live and the host's `onair:host` mic from the program's call room and pushes them to Palazzo over RTMP on the `broadcast-control` network, only while someone is on air. It publishes nothing on the host and is capped at 256 MB and half a core. Palazzo must already listen on the address (its `RTMP_URL`, `rtmp://0.0.0.0:1935/live/contribution` inside its container); that is a Palazzo deploy, done once in the low-listener window.

```bash
infra/cumulus/contribution-up.sh <cumulus-ssh-target>
```

It renders the station's renderer key (its program's `webrtcProgramKeys` entry, else the shared key until it is removed) inside the running `alcantara-backend` container on the same host into a 0600 `contribution.env` (never printed, never written locally), copies the worker, builds and starts it, and waits for it to report healthy. `CONTRIBUTION_PROGRAM_ID` (default `modoitaliano.fm`), `CONTRIBUTION_RTMP_URL` (default `rtmp://palazzo:1935/live/contribution`) and `ALCANTARA_BACKEND_DOCKER` (for example `sudo docker`) change its defaults. Stop it with `docker rm -f alcantara-contribution` on cumulus (cumulus has no docker compose, so `contribution-run.sh` starts it with plain docker and the compose file's settings); Palazzo then simply has no live input.

## Placing the programs' renderer keys

Each program's machines (the return runner, its contribution worker, the pilot's Program window) present that program's own renderer key (gaulatti/alcantara#884). `backend/scripts/place-renderer-keys.cjs` issues the keys and places them in the runtime secret's `webrtcProgramKeys` in one command, so no key is ever shown. Its first step runs in the backend container, where the database is: it resolves the database from the container's `ARAUCO_SECRET_ID`, as the other production scripts do, so it needs no `DATABASE_URL` or wrapper. Its second runs with operator AWS credentials in the backend image, which can write the secret. The key passes only on the pipe between them:

```bash
ssh <backend-ssh-target> "docker exec -i alcantara-backend node scripts/place-renderer-keys.cjs issue --allow-remote --program <program-id> [--program <program-id>…]" \
  | docker run --rm -i -e AWS_REGION -e ALCANTARA_CONFIG_SECRET_ID ${AWS_PROFILE:+-e AWS_PROFILE} -v "$HOME/.aws:/root/.aws:ro" \
      ghcr.io/gaulatti/alcantara:latest node scripts/place-renderer-keys.cjs write
```

- **First run** issues each named program a key and writes it into the secret, keeping every other field. The output is one line per program: `<program-id>: version <n>, written`.
- **A program that already has a key is kept** (`kept, already placed`, or `kept, holder uses shared` when the secret has no copy, as for a key issued in the Shows panel or by the pilot). Its machines keep the key they hold, or the shared key. Add `--rotate` after `issue` to replace the key: every machine holding the old one stops until it is redeployed or reopened with the new one, and a key used in the last 15 minutes is warned about first.
- **`--dry-run`** on both steps changes nothing and says what each would do. A dry run of the issue step emits no key lines, so the write step's dry run then says `dry run: nothing to write`.
- **Then redeploy the holders** (`return-runner-up.sh`, `contribution-up.sh`) so their env files get the keys.
- **If the write step fails** after an issue or a rotation, the database has a key no machine holds. Run both steps again with `--rotate`. A first issue breaks nothing meanwhile, because the shared key is still accepted.
- Each issue and rotation is recorded as an operator change (via `script`), with the version only.

## Network Ports: Public vs. Private

### Public Ports (forwarded by the router to Helix)
- `7881/tcp`: WebRTC over TCP, for networks that block UDP.
- `7882/udp`: WebRTC media. Every participant is muxed on this one port (`rtc.udp_port`).
- `3478/udp`: LiveKit's built-in TURN.

Signalling is not forwarded. `7880/tcp` is published on Helix's loopback only (`127.0.0.1:7880`). nginx terminates TLS for `livekit.alcantara.gaulatti.com` on 443 and proxies to it, for browsers, the desktop pilot and the backend's API calls alike.

The TURN relay range (`30000-30100/udp`) only carries traffic from TURN to the SFU inside the container, so it is neither published nor forwarded.

TURN over TLS is on only when the runtime secret names `livekitTurnTlsDomain`. nginx then takes it on 443, and `5349/tcp` is published on Helix's loopback only. See below.

- **Ingress WHIP** (only with the `ingress` profile):
  - `8080/tcp`: WHIP HTTP/TLS ingestion endpoint.
  - `7885/udp`: WHIP WebRTC ICE UDP media transport.

### Private Ports (Loopback / Internal Network Only)
- **Redis (`6379`)**: Not published. It is reachable only on the project's network.
- **Health check (`8081`)**: Bound strictly to host loopback (`127.0.0.1:8081/tcp`) for internal orchestration and monitoring.
- **Prometheus metrics (`8082`)**: Bound strictly to host loopback (`127.0.0.1:8082/tcp`) for authenticated metric scraping.

## TURN over TLS on 443

Live in production. It is for guests whose networks block UDP and `7881/tcp`: without it, a network that allows only TCP 443 cannot join (the TCP proof on 2026-11-27, before it was turned on, connected over `7881/tcp` and the only TURN offered was UDP `3478`). LiveKit tells clients to use `turns:<domain>:443`, always on 443, so nginx must share that port between the web sites and TURN. It does that by the name a client asks for (`ssl_preread`), ends TLS for the TURN name with its own certificate, and passes the plain stream to LiveKit (`turn.external_tls`).

### What it changes

- **Every HTTPS site on Helix**, not only Alcantara's: nginx cannot have both a `stream` listener and `http` server blocks on 443, so every HTTPS server block moves to `127.0.0.1:8443` behind the stream block. All sites are interrupted for the nginx restart.
- Installs `nginx-mod-stream` 1.26.3 from Fedora's build system, labels port 5350 for nginx, and gets a certificate for `turn.alcantara.gaulatti.com`.
- Adds `livekitTurnTlsDomain` to `broadcast/production/config` and restarts LiveKit twice (**calls in progress drop**).
- No router change (443 already reaches Helix), no DNS change (the name already resolves to Helix), no backend deploy. UDP 443, if a site uses it, is not affected.

Pick a moment with nothing on air and nobody in a call.

### The owner's step: one block

Run it from a checkout of this repository, in **zsh or bash** (not fish), on a machine with `aws`, `jq`, `docker` and SSH to Helix. It asks for the sudo password on Helix once. It stops at the first failure; if nginx or any site misbehaves after the change, it puts nginx back by itself and stops.

```bash
(
set -euo pipefail
H=helix.gaulatti.com
export AWS_REGION=us-east-1 ALCANTARA_CONFIG_SECRET_ID=broadcast/production/config
test -n "$(dig +short turn.alcantara.gaulatti.com)"
infra/helix/livekit-up.sh "$H"                      # copies the nginx files; LiveKit's configuration is unchanged
ssh "$H" 'cat > /tmp/alcantara-turn.sh' <<'ROOT'
set -euo pipefail
files=$(getent passwd "$SUDO_USER" | cut -d: -f6)/.alcantara-livekit
test -f "$files/nginx-turn-stream.conf" -a -f "$files/nginx-behind-stream.conf"
if ! rpm -q nginx-mod-stream >/dev/null; then
  # Never `dnf install nginx-mod-stream`: Fedora 41's 1.28.0 module segfaults on any TLS server block.
  test "$(rpm -q nginx-core)" = nginx-core-1.26.3-1.fc41.x86_64
  curl -fsSLo /tmp/nginx-mod-stream.rpm https://kojipkgs.fedoraproject.org/packages/nginx/1.26.3/1.fc41/x86_64/nginx-mod-stream-1.26.3-1.fc41.x86_64.rpm
  echo "37b251d5c35d70ae7308d4921168939d40e1f51004d407ef55535524b3050e1b  /tmp/nginx-mod-stream.rpm" | sha256sum -c
  dnf install -y /tmp/nginx-mod-stream.rpm
fi
dnf install -y policycoreutils-python-utils
semanage port -a -t http_port_t -p tcp 5350 || semanage port -m -t http_port_t -p tcp 5350
certbot certonly --nginx --keep-until-expiring -d turn.alcantara.gaulatti.com --deploy-hook "systemctl reload nginx"
if test -e /etc/nginx/stream.d/alcantara-turn.conf; then echo "nginx is already changed"; exit 0; fi
names=$(grep -hE '^[[:space:]]*server_name[[:space:]]' /etc/nginx/sites-available/* | sed -E 's/^[[:space:]]*server_name[[:space:]]+//; s/;.*//' | tr ' ' '\n' | grep -E '^[a-z0-9.-]+\.[a-z]+$' | sort -u)
probe() { for n in $names; do echo "$n $(curl -s -o /dev/null -m 10 -w '%{http_code}' --resolve "$n:443:127.0.0.1" "https://$n/" || true)"; done; }
before=$(probe)
rm -rf /etc/nginx.before-turn && cp -a /etc/nginx /etc/nginx.before-turn
undo() { echo "FAILED: putting nginx back" >&2; rm -rf /etc/nginx && cp -a /etc/nginx.before-turn /etc/nginx && nginx -t && systemctl restart nginx; exit 1; }
trap undo ERR
sed -i -E -e 's/^([[:space:]]*)listen 443 ssl([^;]*);/\1listen 127.0.0.1:8443 ssl proxy_protocol\2;/' -e '/^[[:space:]]*listen \[::\]:443 ssl[^;]*;/d' /etc/nginx/sites-available/*
if grep -rnE '^[[:space:]]*listen[^;#]*\b443\b' /etc/nginx/sites-available /etc/nginx/conf.d; then false; fi
mkdir -p /etc/nginx/stream.d
cp "$files/nginx-turn-stream.conf" /etc/nginx/stream.d/alcantara-turn.conf
cp "$files/nginx-behind-stream.conf" /etc/nginx/conf.d/behind-stream.conf
grep -qF 'include /etc/nginx/stream.d/*.conf;' /etc/nginx/nginx.conf || echo 'include /etc/nginx/stream.d/*.conf;' >> /etc/nginx/nginx.conf
nginx -t
systemctl restart nginx
sleep 3
after=$(probe)
if [ "$before" != "$after" ]; then echo "sites changed (before, after):"; diff <(echo "$before") <(echo "$after") || true; false; fi
trap - ERR
echo "nginx changed; $(echo "$after" | wc -l) site names answer as before"
ROOT
ssh -t "$H" 'sudo bash /tmp/alcantara-turn.sh'
new=$(aws secretsmanager get-secret-value --secret-id "$ALCANTARA_CONFIG_SECRET_ID" --query SecretString --output text | jq -ce '. + {livekitTurnTlsDomain: "turn.alcantara.gaulatti.com"}')
printf '%s' "$new" | aws secretsmanager put-secret-value --secret-id "$ALCANTARA_CONFIG_SECRET_ID" --secret-string file:///dev/stdin >/dev/null
unset new
infra/helix/livekit-up.sh "$H"
ssh "$H" docker restart alcantara-livekit >/dev/null   # Compose does not restart it when only livekit.yaml changed
sleep 15
echo "--- check: both lines must be right"
echo | openssl s_client -connect turn.alcantara.gaulatti.com:443 -servername turn.alcantara.gaulatti.com 2>/dev/null | openssl x509 -noout -subject
curl -s https://livekit.alcantara.gaulatti.com; echo
)
```

**Check.** The last two lines must be `subject=CN=turn.alcantara.gaulatti.com` and `OK`. Run it from outside Helix's network. Then prove a guest gets in over TURN alone: the `chromium-relay` run of the return proof (`e2e/README.md`) fails with `no relay candidates offered` before this step and must pass with `relay over tls` after it.

### Undo

nginx back as it was (the module and certificate can stay):

```bash
ssh -t helix.gaulatti.com "sudo sh -c 'rm -rf /etc/nginx && cp -a /etc/nginx.before-turn /etc/nginx && nginx -t && systemctl restart nginx'"
```

LiveKit back to UDP TURN only (from the checkout):

```bash
(
set -euo pipefail
export AWS_REGION=us-east-1 ALCANTARA_CONFIG_SECRET_ID=broadcast/production/config
new=$(aws secretsmanager get-secret-value --secret-id "$ALCANTARA_CONFIG_SECRET_ID" --query SecretString --output text | jq -ce 'del(.livekitTurnTlsDomain)')
printf '%s' "$new" | aws secretsmanager put-secret-value --secret-id "$ALCANTARA_CONFIG_SECRET_ID" --secret-string file:///dev/stdin >/dev/null
infra/helix/livekit-up.sh helix.gaulatti.com
ssh helix.gaulatti.com docker restart alcantara-livekit
)
```

### What was proven, and what was not

Proven (2026-11-26, a Fedora 41 container with nginx 1.26.3, a copy of Helix's configuration, self-signed certificates and stand-in backends, aarch64): after these nginx edits every site name answered exactly as before (status, HTTP version, certificate, redirect, and the client address the application sees), TURN over TLS on 443 reached LiveKit 1.13.4, and the rollback restored the original behaviour. **Not proven:** SELinux, certbot, the firewall, x86_64 for the whole matrix, and the block above run as one piece. Its automatic check compares each site's status code only; after it, also confirm a site's access log shows client addresses, not `127.0.0.1`, and run `sudo certbot renew --dry-run`.

Certbot renews the TURN certificate and the hook reloads nginx. A site added later with `certbot --nginx` may get a `listen 443 ssl` line, which `nginx -t` rejects as already in use; change it to `listen 127.0.0.1:8443 ssl proxy_protocol` and drop its `[::]:443` line.

## Protocol Gates & Enablement Requirements

None of this runs in production: Ingress is not started. Per [ADR 001](../docs/adr-001-livekit-external-source-ingress.md), when it is, WHIP and HLS are enabled by default. RTMP and SRT remain disabled until their specific safety gates are satisfied:

### 1. RTMP (Disabled)
- **Current State**: Disabled via `rtmp_port: 0` in [`ingress.production.example.yaml`](ingress.production.example.yaml) and omitted from published ports in [`helix/compose.livekit.yml`](helix/compose.livekit.yml).
- **Reason**: LiveKit Ingress v1.5.0 logs the complete RTMP stream key at `info` level during publisher connection. Setting `logging.level: warn` does not suppress the underlying RTMP library log output.
- **Required Evidence to Lift Gate**: An automated canary log-redaction test must prove that full stream keys are absent from service and collector logs under production log routing.
- **Owning Ticket**: Definition tracked in [`gaulatti/alcantara#44`](https://github.com/gaulatti/alcantara/issues/44); canary test and production enablement owned by [`gaulatti/alcantara#51`](https://github.com/gaulatti/alcantara/issues/51).

### 2. SRT (Disabled)
- **Current State**: Disabled (no listener configured).
- **Reason**: Ingress v1.5.0 failed to publish usable video packets during proof execution on arm64 (`source encoder not ready`).
- **Required Evidence to Lift Gate**: Execution of certification tests proving successful ingest, stable clocking, and usable video delivery on the production Intel x86/i9 host.
- **Owning Ticket**: Owned and tracked by [`gaulatti/alcantara#47`](https://github.com/gaulatti/alcantara/issues/47) ("Certify RTMP, WHIP, HLS, and SRT ingest on the Intel production host").

## Capacity & Admission Controls

Per ADR 001 Capacity guidelines:
- **CPU Reservation**: `cpu_cost.min_idle_ratio: 0.3` is configured in `ingress.production.example.yaml`, enforcing a 30% CPU reservation before accepting new transcode sessions.
- **Relative CPU Costs**:
  - `rtmp_cpu_cost: 2.0`
  - `whip_cpu_cost: 2.0`
  - `whip_bypass_transcoding_cpu_cost: 0.1`
  - `url_cpu_cost: 2.0`
- **Per-Team Source & Bitrate Quotas**: Because LiveKit Ingress does not have native per-tenant rate/quota limiters, admission control is enforced upstream by the Alcantara backend when creating ingress sessions.
