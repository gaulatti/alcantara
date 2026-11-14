# Alcantara Infrastructure & LiveKit Ingress

This directory defines the production deployment topology and configuration templates for Alcantara media infrastructure, including LiveKit Server, LiveKit Ingress, and Redis.

## Topology & Services

Defined in [`compose.production.yml`](compose.production.yml):

- **`redis` (`redis:7.4-alpine`)**: State coordination and inter-service messaging between LiveKit Server and LiveKit Ingress.
- **`livekit` (`livekit/livekit-server:v1.13.4`)**: Core WebRTC SFU for calls and broadcast rooms.
- **`ingress` (`livekit/ingress:v1.5.0`)**: Ingest service normalizing external media streams (WHIP, HLS, RTMP, SRT) into LiveKit rooms.

Configuration templates:
- [`livekit.production.example.yaml`](livekit.production.example.yaml): LiveKit Server configuration.
- [`ingress.production.example.yaml`](ingress.production.example.yaml): LiveKit Ingress configuration.

All configuration files in source control use placeholder credentials (`replace-api-key`, `replace-api-secret`, `replace-redis-password`). Real credentials are provisioned at deployment time via AWS Secrets Manager (`broadcast/production/config`).

## Network Ports: Public vs. Private

### Public Ports (External Ingest & WebRTC Media)
- **LiveKit Signaling & Media**:
  - `7880/tcp`: LiveKit HTTP/WebSocket signaling (TLS terminated at ingress/reverse proxy).
  - `7881/tcp`: LiveKit WebRTC TCP fallback.
  - `3478/udp`, `5349/tcp`: TURN server.
  - `30000-30100/udp`: TURN relay port range.
  - `50000-50100/udp`: WebRTC ICE UDP media port range.
- **Ingress WHIP**:
  - `8080/tcp`: WHIP HTTP/TLS ingestion endpoint.
  - `7885/udp`: WHIP WebRTC ICE UDP media transport.

### Private Ports (Loopback / Internal Network Only)
- **Redis (`6379`)**: Unexposed to the host; accessible strictly across the internal `broadcast-control` container network.
- **Health check (`8081`)**: Bound strictly to host loopback (`127.0.0.1:8081/tcp`) for internal orchestration and monitoring.
- **Prometheus metrics (`8082`)**: Bound strictly to host loopback (`127.0.0.1:8082/tcp`) for authenticated metric scraping.

## Protocol Gates & Enablement Requirements

Per [ADR 001](../docs/adr-001-livekit-external-source-ingress.md), WHIP and HLS are enabled by default. RTMP and SRT remain disabled until their specific safety gates are satisfied:

### 1. RTMP (Disabled)
- **Current State**: Disabled via `rtmp_port: 0` in [`ingress.production.example.yaml`](ingress.production.example.yaml) and omitted from published ports in [`compose.production.yml`](compose.production.yml).
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
