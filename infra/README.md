# Alcantara Infrastructure & LiveKit Ingress

This directory defines the production deployment topology and configuration templates for Alcantara media infrastructure, including LiveKit Server, LiveKit Ingress, and Redis.

## Topology & Services

Production LiveKit runs on Helix, the on-premises host behind `helix.gaulatti.com`, not on the service host that runs the backend and the radio engine (gaulatti/alcantara#354). The backend deploy does not start it. [`helix/livekit-up.sh`](helix/livekit-up.sh) does (see below).

Defined in [`helix/compose.livekit.yml`](helix/compose.livekit.yml), Compose project `alcantara-livekit`:

- **`redis` (`redis:7.4-alpine`)**: State coordination between LiveKit Server and LiveKit Ingress. It is never published and is reached as `redis:6379` on the project's own network. It is limited to 0.5 CPU and 512 MiB.
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

For guests whose networks block UDP and `7881/tcp`. LiveKit tells clients to use `turns:<domain>:443`, always on 443, so nginx must share that port between the web sites and TURN. It does that by the name a client asks for (`ssl_preread`), ends TLS for the TURN name with its own certificate, and passes the plain stream to LiveKit (`turn.external_tls`).

**This changes every HTTPS site on Helix, not only Alcantara's.** nginx cannot have both a `stream` listener and `http` server blocks on 443, so every HTTPS server block moves to `127.0.0.1:8443`. Pick a moment when a short interruption of all of them is acceptable and nothing is on air or in a call.

No router change is needed: 443 already reaches Helix. UDP 443 (HTTP/3), if any site uses it, is not affected.

1. **DNS.** Deploy the `infra/aws` stack, which adds `turn.alcantara.gaulatti.com` as a CNAME to `helix.gaulatti.com`. Check: `dig +short turn.alcantara.gaulatti.com`.
2. **Backend image.** Deploy the backend, so that `ghcr.io/gaulatti/alcantara:latest` has the new renderer.
3. **Copy the files.** Run `livekit-up.sh` as above. With no `livekitTurnTlsDomain` yet, LiveKit's configuration does not change. The compose file gains the loopback port, so LiveKit restarts and calls in progress drop.
4. **The stream module, without upgrading nginx** (on Helix). **Do not run `dnf install nginx-mod-stream`:** Helix has nginx 1.26.3, the repositories only carry the module for 1.26.2 or 1.28.0, and Fedora 41's 1.28.0 stream module **segfaults on any TLS server block**. Take the 1.26.3 module from Fedora's build system. It installs one package and does not touch the running nginx. The build is unsigned there, so check its hash; every command below stops if a check fails.

   ```bash
   rpm -q nginx-core
   ```

   It must print `nginx-core-1.26.3-1.fc41.x86_64`. If it does not, stop: these steps were proven on that version.

   ```bash
   curl -fsSLo /tmp/nginx-mod-stream.rpm https://kojipkgs.fedoraproject.org/packages/nginx/1.26.3/1.fc41/x86_64/nginx-mod-stream-1.26.3-1.fc41.x86_64.rpm && echo "37b251d5c35d70ae7308d4921168939d40e1f51004d407ef55535524b3050e1b  /tmp/nginx-mod-stream.rpm" | sha256sum -c && sudo dnf install -y /tmp/nginx-mod-stream.rpm
   ```

5. **SELinux port and certificate** (no interruption):

   ```bash
   sudo dnf install -y policycoreutils-python-utils
   ```

   ```bash
   sudo semanage port -a -t http_port_t -p tcp 5350 || sudo semanage port -m -t http_port_t -p tcp 5350
   ```

   ```bash
   sudo certbot certonly --nginx -d turn.alcantara.gaulatti.com --deploy-hook "systemctl reload nginx"
   ```

6. **Move the web sites and add the stream block.** Sites are the files in `/etc/nginx/sites-available`. Nothing changes for visitors until the restart.

   Back up. This copy is what the rollback restores, so run it once, before editing:

   ```bash
   sudo test ! -e /etc/nginx.before-turn && sudo cp -a /etc/nginx /etc/nginx.before-turn
   ```

   Check that only nginx holds TCP 443:

   ```bash
   sudo ss -ltnp 'sport = :443'
   ```

   Move every HTTPS server block to `127.0.0.1:8443` and drop its IPv6 `443` line (the stream block listens on IPv6):

   ```bash
   sudo sed -i -E -e 's/^([[:space:]]*)listen 443 ssl([^;]*);/\1listen 127.0.0.1:8443 ssl proxy_protocol\2;/' -e '/^[[:space:]]*listen \[::\]:443 ssl[^;]*;/d' /etc/nginx/sites-available/*
   ```

   This must print nothing:

   ```bash
   sudo grep -rnE '^[[:space:]]*listen[^;#]*\b443\b' /etc/nginx/sites-available /etc/nginx/conf.d
   ```

   Install the two files and include the stream directory:

   ```bash
   sudo mkdir -p /etc/nginx/stream.d && sudo cp ~/.alcantara-livekit/nginx-turn-stream.conf /etc/nginx/stream.d/alcantara-turn.conf && sudo cp ~/.alcantara-livekit/nginx-behind-stream.conf /etc/nginx/conf.d/behind-stream.conf
   ```

   ```bash
   grep -qF 'include /etc/nginx/stream.d/*.conf;' /etc/nginx/nginx.conf || echo 'include /etc/nginx/stream.d/*.conf;' | sudo tee -a /etc/nginx/nginx.conf
   ```

   Test, then restart (`restart`, not `reload`, because 443 passes from one context to the other):

   ```bash
   sudo nginx -t && sudo systemctl restart nginx
   ```

   **Rollback, one command.** If the test or the restart fails, or a site misbehaves, this puts nginx back as it was and starts it (a break-glass for the host's configuration; the module and certificate can stay):

   ```bash
   sudo sh -c 'rm -rf /etc/nginx && cp -a /etc/nginx.before-turn /etc/nginx && nginx -t && systemctl restart nginx'
   ```

   Then check certificate renewal still works with the new layout:

   ```bash
   sudo certbot renew --dry-run
   ```

   **What was proven** (2026-11-26, a Fedora 41 container with nginx 1.26.3, a copy of Helix's configuration, self-signed certificates and stand-in backends, aarch64): after these edits every site name answered exactly as before (status, HTTP version, certificate, redirect, and the client address the application sees), TURN over TLS on 443 reached LiveKit 1.13.4, and the rollback restored the original behaviour. **Not proven there:** SELinux, certbot, the firewall and x86_64 for the whole matrix.

7. **Check the sites** before going on: open each HTTPS site, `curl https://livekit.alcantara.gaulatti.com` (answers `OK`), and confirm that a site's access log shows client addresses, not `127.0.0.1`. If something is wrong, run the rollback above, or fix the nginx file and restart.

8. **Name it in the secret.** Add `"livekitTurnTlsDomain": "turn.alcantara.gaulatti.com"` to `broadcast/production/config`. Only the renderer reads it. It must differ from the signalling host.
9. **Render and restart LiveKit.** Run `livekit-up.sh` again, then restart the container, which Compose does not do when only `livekit.yaml` changed (calls in progress drop):

   ```bash
   ssh <helix ssh target> docker restart alcantara-livekit
   ```

10. **Verify.** From outside Helix's network, the certificate below must be the TURN name's:

   ```bash
   openssl s_client -connect turn.alcantara.gaulatti.com:443 -servername turn.alcantara.gaulatti.com </dev/null 2>/dev/null | openssl x509 -noout -subject -enddate
   ```

   Then join a call from a network that allows only TCP 443 (or with UDP and 7881 blocked on the guest's machine). In `chrome://webrtc-internals` the selected candidate pair is `relay` with relay protocol `tls`.

Certbot renews the TURN certificate and the hook reloads nginx. A site added later with `certbot --nginx` may get a `listen 443 ssl` line, which `nginx -t` rejects as already in use; change it as in step 5.

## Protocol Gates & Enablement Requirements

Per [ADR 001](../docs/adr-001-livekit-external-source-ingress.md), WHIP and HLS are enabled by default. RTMP and SRT remain disabled until their specific safety gates are satisfied:

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
