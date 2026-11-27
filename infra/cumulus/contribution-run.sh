#!/bin/sh
# Runs on cumulus from ~/.alcantara-contribution (copied there by contribution-up.sh). Cumulus has no docker compose,
# so this builds the worker image and (re)starts the container with the same settings as compose.contribution.yml:
# the broadcast-control network, no published ports, 0.5 CPU, 256 MB with no swap, restart always, local logs.
set -eu
docker_cmd=${1:-docker}
dir=$(cd "$(dirname "$0")" && pwd)
$docker_cmd build -q -t alcantara-contribution:local "$dir/contribution" >/dev/null
$docker_cmd rm -f alcantara-contribution >/dev/null 2>&1 || true
$docker_cmd run -d --name alcantara-contribution \
  --env-file "$dir/contribution.env" \
  --init --cpus 0.5 --memory 256m --memory-swap 256m \
  --restart always --network broadcast-control \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  --health-cmd "node -e \"fetch('http://127.0.0.1:8091/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\"" \
  --health-interval 10s --health-timeout 5s --health-retries 6 --health-start-period 20s \
  alcantara-contribution:local >/dev/null
