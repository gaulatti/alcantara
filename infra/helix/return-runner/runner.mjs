// The return runner: keeps one headless return router open for every program that needs one, so a guest gets the
// program return with nothing else open. It only dials out: it asks the backend which programs need a router and
// opens the console's own /return-router/<program> page for each. The renderer key reaches the page in its session
// storage, never in a URL, and nothing here logs it or the page's own console.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const PROGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const KEY_STORAGE = "alcantara-renderer-key";
/** A page that says it could not start, or has not connected for this long, is opened again. */
export const STUCK_MS = 45_000;
/**
 * A program leaves the list for this long before its page closes: a backend that just restarted can answer with a
 * list it has not rebuilt yet, and that must not cut a live return. The backend's own linger is in front of this.
 */
export const GONE_MS = 10_000;
/** How long a program waits to be opened again after its first, second and later failures. */
export const BACKOFF_MS = [5_000, 15_000, 60_000];

export function readConfig(env) {
  const need = (name) => {
    const value = (env[name] ?? "").trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const engine = (env.WEBRTC_BROWSER ?? "chromium").trim() || "chromium";
  if (!["chromium", "webkit", "firefox"].includes(engine)) throw new Error("WEBRTC_BROWSER must be chromium, webkit or firefox");
  return {
    api: need("ALCANTARA_API_URL").replace(/\/$/, ""),
    app: need("ALCANTARA_APP_URL").replace(/\/$/, ""),
    ...readKeys(env),
    engine,
    pollMs: Number(env.RETURN_RUNNER_POLL_MS ?? 3_000),
    maxRooms: Number(env.RETURN_RUNNER_MAX_ROOMS ?? 6),
    healthPort: Number(env.RETURN_RUNNER_HEALTH_PORT ?? 8090),
  };
}

/**
 * The runner's renderer keys (gaulatti/alcantara#884): the fleet key for the router list, each program's own key for its
 * page, and the shared key for whichever of those is not configured, until it is removed. At least one of the fleet
 * and shared keys is needed for the list.
 */
export function readKeys(env) {
  const value = (name) => (env[name] ?? "").trim();
  const shared = value("WEBRTC_RENDERER_KEY");
  const fleet = value("WEBRTC_FLEET_KEY");
  if (!fleet && !shared) throw new Error("WEBRTC_FLEET_KEY or WEBRTC_RENDERER_KEY is required");
  const programs = new Map();
  const raw = value("WEBRTC_PROGRAM_KEYS");
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("WEBRTC_PROGRAM_KEYS is not JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("WEBRTC_PROGRAM_KEYS is not an object");
    for (const [programId, key] of Object.entries(parsed)) {
      if (!PROGRAM_ID.test(programId) || typeof key !== "string" || !key.trim()) throw new Error("WEBRTC_PROGRAM_KEYS has an entry that is not a program id and a key");
      programs.set(programId, key.trim());
    }
  }
  return { shared, fleet, programs };
}

/** The key a program's page presents: its own, else the shared key. Empty when it has neither. */
export function keyFor(config, programId) {
  return config.programs.get(programId) ?? config.shared;
}

/** Every key the runner holds, for redaction. */
export function allKeys(config) {
  return [config.fleet, config.shared, ...config.programs.values()].filter(Boolean);
}

/** Strips what could be a credential: queries, fragments, long token-like strings and the renderer keys themselves. */
export function redact(text, keys = []) {
  let line = String(text);
  for (const key of [keys].flat()) if (key) line = line.split(key).join("<key>");
  return line
    .replace(/\b((?:https?|wss?):\/\/[^\s?#"']+)[?#][^\s"']*/g, "$1?<redacted>")
    .replace(/[A-Za-z0-9_\-+=]{32,}(?:\.[A-Za-z0-9_\-+=]+)*/g, "<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

/**
 * What the runner's log keeps of a router page: its own `[return-router]` diagnostics as written, and errors and
 * failed requests with anything credential-like removed. Nothing else of the page's console.
 */
export function watchPage(page, programId, key, log = console.log) {
  const say = (line) => log(`${programId}: ${line}`);
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("[return-router] ")) say(redact(text, key));
    else if (message.type() === "error") say(`page console error: ${redact(text, key)}`);
  });
  page.on("pageerror", (error) => say(`page error: ${redact(error?.message ?? error, key)}`));
  page.on("requestfailed", (request) =>
    say(`request failed: ${request.method()} ${redact(request.url().split(/[?#]/)[0], key)} ${redact(request.failure()?.errorText ?? "", key)}`),
  );
  page.on("response", (response) => {
    if (response.status() >= 400) say(`HTTP ${response.status()} ${response.request().method()} ${redact(response.url().split(/[?#]/)[0], key)}`);
  });
}

/**
 * The programs that need a router now, or null when the answer says nothing: the pages then stay as they are. An
 * unchanged answer is a 304 to the last ETag and carries no body.
 */
export async function wantedPrograms(config, running, fetchImpl = fetch, last = null) {
  const query = running.length ? `?running=${running.map(encodeURIComponent).join(",")}` : "";
  const url = `${config.api}/webrtc/return-routers${query}`;
  const response = await fetchImpl(url, {
    headers: { "X-Renderer-Key": config.fleet || config.shared, ...(last?.etag && last.url === url ? { "If-None-Match": last.etag } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 304 && last) return { ...last, status: 304 };
  // 404: a backend without the list. 401: the key is wrong, which closing pages would not fix.
  if (!response.ok) return { programs: null, status: response.status };
  const body = await response.json();
  if (!Array.isArray(body?.programs)) return { programs: null, status: response.status };
  return {
    programs: [...new Set(body.programs.filter((id) => typeof id === "string" && PROGRAM_ID.test(id)))],
    status: response.status,
    etag: response.headers.get("etag"),
    url,
  };
}

/** How the router page says it is doing: its own attribute when it has one, else its status line. */
export async function pageState(page) {
  return page.evaluate(() => {
    const marked = document.querySelector("[data-return-router]")?.getAttribute("data-return-router");
    if (marked) return marked;
    const status = document.querySelector('[role="status"]')?.textContent ?? "";
    if (/could not start/i.test(status)) return "failed";
    return /mix(es)? active/i.test(status) ? "connected" : "starting";
  });
}

export function createRunner({ config, openPage, log = console.log, now = Date.now }) {
  /** program id → { page, close, since, connectedAt, missingSince, state } */
  const routers = new Map();
  /** program id → { count, until }: failures in a row, and when it may be opened again. */
  const backoff = new Map();
  const polls = { ok: 0, unchanged: 0, refused: 0, unreachable: 0 };
  const opens = { ok: 0, failed: 0 };
  let refusal = 0;
  let last = null;

  const stop = async (programId, why) => {
    const router = routers.get(programId);
    if (!router) return;
    routers.delete(programId);
    await router.close().catch(() => undefined);
    log(`return router closed for ${programId}: ${why}`);
  };

  const failed = (programId) => {
    const count = (backoff.get(programId)?.count ?? 0) + 1;
    backoff.set(programId, { count, until: now() + BACKOFF_MS[Math.min(count, BACKOFF_MS.length) - 1] });
  };

  const start = async (programId) => {
    if (now() < (backoff.get(programId)?.until ?? 0)) return;
    const router = { since: now(), connectedAt: now(), missingSince: null, state: "starting", page: null, close: async () => {} };
    routers.set(programId, router);
    try {
      Object.assign(router, await openPage(programId));
      opens.ok += 1;
      log(`return router opened for ${programId}`);
    } catch (error) {
      routers.delete(programId);
      opens.failed += 1;
      failed(programId);
      // The error's name only: a navigation error can carry the page's address and headers.
      log(`return router failed to open for ${programId}: ${error?.name ?? "Error"}`);
    }
  };

  const check = async (programId, router) => {
    if (!router.page) return;
    let state;
    try {
      state = await pageState(router.page);
    } catch {
      state = "failed";
    }
    router.state = state;
    if (state === "connected") {
      router.connectedAt = now();
      backoff.delete(programId);
      return;
    }
    if (state === "failed" && now() - router.since >= 5_000) {
      await stop(programId, "the page could not start");
      failed(programId);
    } else if (now() - router.connectedAt >= STUCK_MS) {
      await stop(programId, "not connected for too long");
      failed(programId);
    }
  };

  /** One round: learn what is wanted, close what is not, check what is open, open what is missing. */
  const tick = async (fetchImpl) => {
    let wanted = null;
    try {
      const answer = await wantedPrograms(config, [...routers.keys()], fetchImpl, last);
      wanted = answer.programs;
      if (wanted === null) {
        polls.refused += 1;
        if (answer.status !== refusal) log(`the backend gave no list of programs (HTTP ${answer.status})`);
        refusal = answer.status;
      } else {
        polls[answer.status === 304 ? "unchanged" : "ok"] += 1;
        refusal = 0;
        if (answer.status !== 304) last = answer;
      }
    } catch (error) {
      polls.unreachable += 1;
      if (refusal !== -1) log(`the backend could not be asked (${error?.name ?? "Error"}); open routers stay`);
      refusal = -1;
    }
    for (const [programId, router] of [...routers]) {
      if (wanted && !wanted.includes(programId)) {
        router.missingSince ??= now();
        if (now() - router.missingSince >= GONE_MS) await stop(programId, "no longer wanted");
        else await check(programId, router);
        continue;
      }
      if (wanted) router.missingSince = null;
      // A backend that cannot be asked leaves the count of its absence where it was.
      else if (router.missingSince !== null) router.missingSince = now();
      await check(programId, router);
    }
    for (const programId of [...backoff.keys()]) if (wanted && !wanted.includes(programId) && !routers.has(programId)) backoff.delete(programId);
    for (const programId of wanted ?? []) {
      if (routers.has(programId)) continue;
      if (routers.size >= config.maxRooms) {
        log(`not opening a router for ${programId}: ${config.maxRooms} are open`);
        continue;
      }
      await start(programId);
    }
  };

  /** Prometheus text: bounded labels only, no program id. */
  const metrics = () => {
    const states = { starting: 0, connected: 0, failed: 0 };
    for (const router of routers.values()) states[router.state in states ? router.state : "starting"] += 1;
    const lines = ["# TYPE return_runner_routers gauge", ...Object.entries(states).map(([state, n]) => `return_runner_routers{state="${state}"} ${n}`)];
    lines.push("# TYPE return_runner_polls_total counter", ...Object.entries(polls).map(([result, n]) => `return_runner_polls_total{result="${result}"} ${n}`));
    lines.push("# TYPE return_runner_opens_total counter", ...Object.entries(opens).map(([result, n]) => `return_runner_opens_total{result="${result}"} ${n}`));
    return `${lines.join("\n")}\n`;
  };

  return {
    tick,
    metrics,
    status: () => [...routers].map(([programId, router]) => ({ programId, state: router.state })),
    closeAll: async () => {
      for (const programId of [...routers.keys()]) await stop(programId, "the runner is stopping");
    },
  };
}

async function main() {
  const config = readConfig(process.env);
  const playwright = await import("playwright");
  // A browser hides a page's own addresses unless it holds a microphone permission, and the router holds none:
  // without this LiveKit never got a media path to it. The local network checks are off for the same reason, a
  // LiveKit on this host or this network.
  const launch = {
    chromium: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=WebRtcHideLocalIpsWithMdns,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests",
      ],
    },
    firefox: {
      firefoxUserPrefs: {
        "media.autoplay.default": 0,
        "media.autoplay.block-webaudio": false,
        "media.peerconnection.ice.obfuscate_host_addresses": false,
      },
    },
    webkit: {},
  }[config.engine];
  let browser = null;
  const openPage = async (programId) => {
    const key = keyFor(config, programId);
    if (!key) {
      console.log(`no renderer key for ${programId}: give it one in WEBRTC_PROGRAM_KEYS`);
      throw new Error(`no renderer key for ${programId}`);
    }
    if (!browser?.isConnected()) browser = await playwright[config.engine].launch(launch);
    // A context of its own per program, so one room's session never sees another's.
    const context = await browser.newContext();
    await context.addInitScript(
      ([origin, storage, key]) => {
        if (window.location.origin === origin) window.sessionStorage.setItem(storage, key);
      },
      [new URL(config.app).origin, KEY_STORAGE, key],
    );
    const page = await context.newPage();
    watchPage(page, programId, allKeys(config));
    // runner=1 asks for the fixed identity return-router-<program>; a page opened by hand does not take it.
    await page.goto(`${config.app}/return-router/${encodeURIComponent(programId)}?runner=1`, { timeout: 30_000 });
    return { page, close: () => context.close() };
  };
  const runner = createRunner({ config, openPage });
  let lastRound = Date.now();
  createServer((request, response) => {
    const stale = Date.now() - lastRound > 60_000;
    if (request.url === "/metrics") {
      response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      response.end(runner.metrics());
      return;
    }
    response.writeHead(stale ? 503 : 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: !stale, routers: runner.status() }));
  }).listen(config.healthPort, "127.0.0.1");
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      stopping = true;
      await runner.closeAll();
      await browser?.close().catch(() => undefined);
      process.exit(0);
    });
  console.log(`return runner started (${config.engine}), asking ${config.api}`);
  while (!stopping) {
    await runner.tick();
    lastRound = Date.now();
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
