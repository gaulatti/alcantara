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

All configuration files in source control use placeholder credentials (`replace-api-key`, `replace-api-secret`, `replace-redis-password`). Real credentials live only in AWS Secrets Manager (`broadcast/production/config`).

## Starting or updating LiveKit on Helix

Run this from a machine that can read the runtime secret and pull the backend image:

```bash
AWS_REGION=us-east-1 ALCANTARA_CONFIG_SECRET_ID=broadcast/production/config infra/helix/livekit-up.sh <helix ssh target>
```

The script:
1. renders `livekit.yaml` with the image's `print-livekit-config.mjs`;
2. streams it over SSH into `~/.alcantara-livekit/livekit.yaml` (mode 0600) on Helix. The file is never printed or written on the operator's machine;
3. copies the compose file and the nginx server block;
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

TURN over TLS (`5349`) is not enabled.

- **Ingress WHIP** (only with the `ingress` profile):
  - `8080/tcp`: WHIP HTTP/TLS ingestion endpoint.
  - `7885/udp`: WHIP WebRTC ICE UDP media transport.

### Private Ports (Loopback / Internal Network Only)
- **Redis (`6379`)**: Not published. It is reachable only on the project's network.
- **Health check (`8081`)**: Bound strictly to host loopback (`127.0.0.1:8081/tcp`) for internal orchestration and monitoring.
- **Prometheus metrics (`8082`)**: Bound strictly to host loopback (`127.0.0.1:8082/tcp`) for authenticated metric scraping.

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
