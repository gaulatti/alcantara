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

for value in "$broadcast_secret_id" "$database_secret_id" "$media_bucket"; do
  test -n "$value"
done

database_payload="$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id "$database_secret_id" \
  --query SecretString \
  --output text)"
database_url="$(DATABASE_PAYLOAD="$database_payload" python3 - <<'PY'
import json
import os
from urllib.parse import quote

payload = json.loads(os.environ['DATABASE_PAYLOAD'])
required = ('username', 'password', 'host', 'port', 'dbname')
if any(key not in payload or payload[key] in ('', None) for key in required):
    raise SystemExit('Arauco database secret is incomplete')
username = quote(str(payload['username']), safe='')
password = quote(str(payload['password']), safe='')
host = str(payload['host'])
port = int(payload['port'])
database = quote(str(payload['dbname']), safe='')
print(f'postgresql://{username}:{password}@{host}:{port}/{database}?schema=public')
PY
)"
unset database_payload

rm -rf "$docker_config_dir"
install -d -m 0700 "$docker_config_dir"
printf '%s' "$ghcr_token_base64" | base64 -d | docker --config "$docker_config_dir" login ghcr.io --username "$ghcr_user" --password-stdin
docker --config "$docker_config_dir" pull "$image"
rm -rf "$docker_config_dir"

docker network inspect broadcast-control >/dev/null
docker inspect palazzo >/dev/null
test -s /etc/palazzo/control-token
if docker inspect alcantara-backend-previous >/dev/null 2>&1; then
  echo 'An Alcantara rollback container requires operator review'
  exit 1
fi

docker run --rm -i \
  -e DATABASE_URL="$database_url" \
  "$image" \
  node - <<'NODE'
const { Client } = require('pg');

async function verifyRestore() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const table = await client.query(`SELECT to_regclass('public."ProgramState"') AS name`);
    if (!table.rows[0]?.name) {
      throw new Error('Arauco has not been restored: ProgramState is absent');
    }
    const data = await client.query('SELECT count(*)::int AS count FROM "ProgramState"');
    if ((data.rows[0]?.count ?? 0) < 1) {
      throw new Error('Arauco has not been restored: ProgramState is empty');
    }
  } finally {
    await client.end();
  }
}

verifyRestore().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
NODE

docker run --rm \
  -e NODE_ENV=production \
  -e AWS_REGION=us-east-1 \
  -e ALCANTARA_CONFIG_SECRET_ID="$broadcast_secret_id" \
  "$image" \
  pnpm run preflight:runtime

docker run --rm \
  -e DATABASE_URL="$database_url" \
  "$image" \
  pnpm run db:migrate:deploy

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

if ! docker run -d --name alcantara-backend \
  --network broadcast-control \
  -p 127.0.0.1:3006:3006 \
  -e NODE_ENV=production \
  -e HTTP_PORT=3006 \
  -e PORT=3006 \
  -e AWS_REGION=us-east-1 \
  -e ALCANTARA_BUILD_VERSION="${image##*:}" \
  -e ALCANTARA_CONFIG_SECRET_ID="$broadcast_secret_id" \
  -e DATABASE_URL="$database_url" \
  -e ALLOWED_ORIGINS=https://alcantara.gaulatti.com \
  -e POMPEII_TEAM_ID=1 \
  -e MEDIA_S3_BUCKET="$media_bucket" \
  -e CONTAINERIZED=true \
  --volume /etc/palazzo/control-token:/run/secrets/palazzo-control-token:ro \
  --restart=always \
  --log-driver=awslogs \
  --log-opt awslogs-region=us-east-1 \
  --log-opt awslogs-group=/services/alcantara \
  --log-opt "awslogs-stream=alcantara-$(date +%Y%m%dT%H%M%S)" \
  "$image"; then
  rollback_backend
  exit 1
fi
unset database_url

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
  docker logs --tail 200 alcantara-backend || true
  rollback_backend
  exit 1
fi

printf '%s' "$nginx_config_base64" | base64 -d > /tmp/cumulus-alcantara.conf
install -m 0644 /tmp/cumulus-alcantara.conf /etc/nginx/conf.d/cumulus-alcantara.conf
rm -f /tmp/cumulus-alcantara.conf
nginx -t
systemctl reload nginx
certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d api.alcantara.gaulatti.com
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
echo ALCANTARA_HEALTHY
