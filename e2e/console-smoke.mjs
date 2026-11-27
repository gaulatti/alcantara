#!/usr/bin/env node
// Console smoke check after a deploy: the key console routes in Chromium, signed out, read-only. A broken bundle (a
// chunk that does not load, an uncaught error, a blank page) is caught in minutes, not hours.
//
//   node console-smoke.mjs
//
// Routes: the console at / (the radio desk), /calls, /flight (the rundown) and /guest with a token that does not exist.
// The protected routes show the sign-in screen when signed out; that screen is asserted, not treated as a failure.
// Nothing is clicked, no credentials are used, and nothing changes on the server. One JSON line per route; exits 1 if
// any route fails.
//
// A route fails on: an uncaught page error; a JavaScript or CSS file that fails to load (a request failure or an HTTP
// status of 400 or more); a blank page (nothing rendered under the root); or, for a protected route, no sign-in screen.
//
// Configuration (environment):
//   ALCANTARA_APP_URL  the frontend origin (default https://alcantara.gaulatti.com)
//   SMOKE_TIMEOUT_MS   per route (default 60000)

import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const APP = (process.env.ALCANTARA_APP_URL || "https://alcantara.gaulatti.com").replace(/\/$/, "");
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 60_000);
const VIEW = { width: 1280, height: 800 };

/** The routes checked. `signIn` routes must show the sign-in screen when signed out. */
export const ROUTES = [
  { path: "/", name: "console (radio desk)", signIn: true },
  { path: "/calls", name: "calls", signIn: true },
  { path: "/flight", name: "rundown", signIn: true },
  { path: "/guest/console-smoke-no-such-token", name: "guest page (unknown token)", signIn: false },
];

const SIGN_IN = /Welcome back|Sign in with Google/;
const CHUNK = /\.(?:js|css)(?:[?#]|$)/;

/** Checks one route and returns { ok, detail }. */
export async function checkRoute(browser, route) {
  const context = await browser.newContext({ viewport: VIEW });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`uncaught error: ${String(error.message || error).slice(0, 160)}`));
  page.on("requestfailed", (request) => {
    if (CHUNK.test(request.url())) problems.push(`chunk failed to load: ${new URL(request.url()).pathname}`);
  });
  page.on("response", (response) => {
    if (CHUNK.test(response.url()) && response.status() >= 400) {
      problems.push(`chunk failed to load (${response.status()}): ${new URL(response.url()).pathname}`);
    }
  });

  try {
    await page.goto(`${APP}${route.path}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    // Something must render. A page still loading is not blank; one that stays empty is.
    await page
      .waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: TIMEOUT })
      .catch(() => undefined);
    // The app's root is not always #root: judge the whole body, which the wait above already found with text in it.
    const blank = await page.evaluate(() => !document.body || document.body.innerText.trim().length === 0);
    if (blank) problems.push("blank page: nothing rendered");

    let detail = "content rendered";
    if (route.signIn) {
      const shown = await page
        .waitForFunction((pattern) => new RegExp(pattern).test(document.body.innerText), SIGN_IN.source, { timeout: TIMEOUT })
        .then(() => true)
        .catch(() => false);
      if (shown) detail = "sign-in screen";
      else problems.push("no sign-in screen for a protected route");
    }
    // A failure that comes after first render (a lazy chunk) is still caught: let the page settle before judging.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    if (problems.length) return { ok: false, detail: problems.slice(0, 3).join("; ") };
    return { ok: true, detail };
  } catch (error) {
    return { ok: false, detail: `did not load: ${String(error.message || error).split("\n")[0].slice(0, 160)}` };
  } finally {
    await context.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  try {
    for (const route of ROUTES) {
      const result = await checkRoute(browser, route);
      if (!result.ok) failed += 1;
      console.log(JSON.stringify({ route: route.path, name: route.name, status: result.ok ? "ok" : "fail", detail: result.detail }));
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ summary: { routes: ROUTES.length, failed } }));
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
