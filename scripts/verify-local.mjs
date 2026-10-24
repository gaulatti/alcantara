import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Only repository verification orchestration lives here. Native tools produce
// coverage; the shared Clouseau verifier owns coverage acceptance.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const container = `alcantara-verification-${randomUUID()}`;
const scrape = join(root, "backend/coverage/authenticated-metrics.prom");
let created = false;
let failed = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
  return result;
}

function capture(command, args) {
  const result = run(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      `${command} failed before isolated verification could start`,
    );
  }
  return result.stdout.trim();
}

try {
  if (Number(process.versions.node.split(".")[0]) !== 22) {
    throw new Error("Repository verification requires Node 22");
  }
  if (!capture("pnpm", ["--version"]).startsWith("9.")) {
    throw new Error("Repository verification requires pnpm 9");
  }
  const context = capture("docker", ["context", "show"]);
  const endpoint = capture("docker", [
    "context",
    "inspect",
    context,
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (!endpoint.startsWith("unix://")) {
    throw new Error(
      "Verification requires a local Docker context with a Unix socket",
    );
  }

  // Reserve a free local port explicitly: separate Colima contexts can otherwise
  // publish the same automatically selected host port.
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  capture("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    container,
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--publish",
    `127.0.0.1:${port}:5432`,
    "--env",
    "POSTGRES_DB=alcantara_ci",
    "--env",
    "POSTGRES_USER=alcantara",
    "--env",
    "POSTGRES_PASSWORD=alcantara-ci-password",
    "postgres:17-alpine",
  ]);
  created = true;
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    const result = spawnSync(
      "docker",
      [
        "exec",
        container,
        "pg_isready",
        "-U",
        "alcantara",
        "-d",
        "alcantara_ci",
      ],
      { cwd: root, stdio: "ignore" },
    );
    if (result.error) throw result.error;
    if (result.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Isolated PostgreSQL did not become ready");

  mkdirSync(dirname(scrape), { recursive: true });
  for (const artifact of [
    scrape,
    join(root, "backend/coverage/coverage-final.json"),
    join(root, "frontend/coverage/coverage-final.json"),
  ]) {
    rmSync(artifact, { force: true });
  }
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://alcantara:alcantara-ci-password@127.0.0.1:${port}/alcantara_ci?schema=public`,
    AWS_EC2_METADATA_DISABLED: "true",
    METRICS_SCRAPE_OUTPUT: scrape,
  };
  const commands = [
    ["--dir", "backend", "run", "prisma:generate"],
    ["--dir", "backend", "run", "db:migrate:prisma"],
    ["--dir", "backend", "run", "test:cov", "--runInBand"],
    ["--dir", "backend", "run", "test:e2e", "--runInBand"],
    ["--dir", "backend", "run", "test:deployment"],
    ["--dir", "frontend", "run", "typecheck"],
    ["--dir", "frontend", "run", "build"],
    ["--dir", "frontend", "run", "test:coverage"],
    ["--dir", "infra/aws", "exec", "jest", "--runInBand"],
    ["--dir", "infra/aws", "run", "build"],
  ];
  for (const args of commands) run("pnpm", args, { env });
  if (!existsSync(scrape))
    throw new Error(
      "End-to-end tests produced no authenticated metrics scrape",
    );
  run(
    "docker",
    [
      "run",
      "--rm",
      "--interactive",
      "--entrypoint",
      "/bin/promtool",
      "prom/prometheus:v3.9.0",
      "check",
      "metrics",
    ],
    { input: readFileSync(scrape), stdio: ["pipe", "inherit", "inherit"] },
  );
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  if (created) run("docker", ["rm", "--force", container]);
}
process.exitCode = failed ? 1 : 0;
