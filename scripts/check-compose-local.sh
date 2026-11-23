#!/usr/bin/env sh
# Confirms the local Compose stack reaches no real AWS or hosted sign-in
# configuration (gaulatti/alcantara#206). It reads the resolved
# `docker compose config`, which includes whatever backend/.env and
# frontend/.env hold, and checks each name against its local value. It prints
# variable NAMES only, never a value, and exits non-zero on any mismatch.
set -eu

cd "$(dirname "$0")/.."

docker compose config --format json | node -e '
const expected = {
  backend: {
    MEDIA_S3_BUCKET: "alcantara-local-only",
    MEDIA_S3_ENDPOINT: "http://localstack:4566",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "local-only-access-key",
    AWS_SECRET_ACCESS_KEY: "local-only-secret-key",
    AWS_SESSION_TOKEN: "",
    AWS_PROFILE: "",
    AWS_CONFIG_FILE: "",
    AWS_SHARED_CREDENTIALS_FILE: "",
    AWS_ROLE_ARN: "",
    AWS_WEB_IDENTITY_TOKEN_FILE: "",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "",
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "",
    ARAUCO_SECRET_ID: "",
    NODE_ENV: "development",
  },
  frontend: {
    VITE_COGNITO_USER_POOL_ID: "",
    VITE_COGNITO_CLIENT_ID: "",
    VITE_COGNITO_DOMAIN: "",
    VITE_FQDN: "",
  },
};
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  const services = JSON.parse(input).services ?? {};
  const failures = [];
  for (const [service, names] of Object.entries(expected)) {
    const environment = services[service]?.environment ?? {};
    for (const [name, value] of Object.entries(names)) {
      if ((environment[name] ?? null) !== value) failures.push(`${service} ${name}`);
    }
  }
  const backend = services.backend ?? {};
  const base = backend.environment?.LOCAL_MEDIA_PUBLIC_BASE_URL ?? "";
  if (!/^http:\/\/localstack\.localhost:\d+\/alcantara-local-only$/.test(base)) {
    failures.push("backend LOCAL_MEDIA_PUBLIC_BASE_URL");
  }
  for (const volume of backend.volumes ?? []) {
    if (String(volume.target ?? "").includes(".aws")) failures.push("backend ~/.aws mount");
  }
  if (!services.localstack) failures.push("localstack service");
  if (failures.length) {
    console.error(`Not local: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("Compose keeps the backend and frontend on local values only.");
});
'
