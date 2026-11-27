// The signed-in layout pass for the console (gaulatti/alcantara#875): /calls with one connected stand-in guest, and the
// radio desk, at fixed sizes. It fails on a column that is more than 60% empty above the fold, on two guest slots that
// overlap, and on a radio-desk panel that is not visible without scrolling at 1440. It saves a screenshot per size.
//
// LOCAL ONLY. It refuses any origin that is not localhost or 127.0.0.1, and it signs in with the local test auth of
// the seeded operator, never with production credentials. It changes only the local stack's data: one invitation,
// one guest joined and admitted, and the operator's own selected show.

import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const CALLS_SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
];
export const DESK_SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
];
/** A column more than this share empty, above the fold, fails the pass. */
export const MAX_EMPTY_FRACTION = 0.6;
/** The radio show the desk is checked on, the seeded local show. */
export const DESK_PROGRAM = "radio-demo.fm";

/** Refuses anything but the local stack, so the pass cannot touch production. */
export function assertLocalOrigin(origin) {
  const host = new URL(origin).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`refusing: the layout pass is local-only (got ${host})`);
  }
}

/**
 * Share of sample points in the visible area that no content covers. `covered` is one boolean per sample point, true
 * where some piece of content sits. Pure, so the measure itself can be tested without a browser.
 */
export function emptyFraction(covered) {
  if (covered.length === 0) return 1;
  const empty = covered.filter((hit) => !hit).length;
  return empty / covered.length;
}

/** Pairs of boxes that overlap by more than one pixel in both directions. Pure. */
export function overlappingPairs(boxes) {
  const pairs = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 1 && y > 1) pairs.push([i, j]);
    }
  }
  return pairs;
}

/** The measure, run in the page: the emptiness of each column above the fold, and the guest slots' overlaps. */
export async function measureCalls(page) {
  return page.evaluate((max) => {
    const fold = window.innerHeight;
    const covered = (rect, leaves) => {
      const samples = [];
      const cols = 20;
      const rows = 20;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const x = rect.left + ((c + 0.5) / cols) * rect.width;
          const y = rect.top + ((r + 0.5) / rows) * rect.height;
          samples.push(leaves.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom));
        }
      }
      return samples;
    };
    const boxOf = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    };
    const leaves = [...document.querySelectorAll("body *")]
      .filter((el) => el.children.length === 0 && (el.textContent || "").trim().length > 0 || el.matches("button, input, select, img, canvas, [role='meter']"))
      .map(boxOf);
    const desk = document.querySelector(".caller-desk");
    const columns = desk ? [...desk.children].filter((el) => el.getBoundingClientRect().width > 0) : [];
    const columnReports = columns.map((col) => {
      const b = col.getBoundingClientRect();
      const visible = { left: b.left, right: b.right, top: Math.max(0, b.top), bottom: Math.min(fold, b.bottom) };
      const rect = { left: visible.left, width: Math.max(0, visible.right - visible.left), top: visible.top, height: Math.max(0, visible.bottom - visible.top) };
      const inside = leaves.filter((box) => box.bottom > visible.top && box.top < visible.bottom && box.right > visible.left && box.left < visible.right);
      const samples = rect.width > 0 && rect.height > 0 ? covered(rect, inside) : [];
      const empty = samples.length ? samples.filter((hit) => !hit).length / samples.length : 1;
      return { name: col.className || col.tagName, empty: Number(empty.toFixed(3)), failed: empty > max };
    });
    const strips = [...document.querySelectorAll(".guest-strip")].map(boxOf);
    return { columns: columnReports, strips };
  }, MAX_EMPTY_FRACTION);
}

/** The radio desk: which of its panels are visible without scrolling at this size. */
export async function measureDesk(page) {
  return page.evaluate(() => {
    const fold = window.innerHeight;
    const panels = {
      guests: document.querySelector("[aria-label='Guest pre-fade listen']"),
      mixer: document.querySelector(".console-mixer"),
      cartwall: document.querySelector(".radio-cartwall"),
    };
    return Object.fromEntries(
      Object.entries(panels).map(([name, el]) => {
        if (!el) return [name, { present: false, visible: false }];
        const b = el.getBoundingClientRect();
        return [name, { present: true, visible: b.width > 0 && b.top >= 0 && b.bottom <= fold, bottom: Math.round(b.bottom), fold }];
      }),
    );
  });
}

/** Signs in as the seeded operator through the local test auth, then opens a route. */
async function openOperatorPage(browser, app, size, path) {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  await page.goto(`${app}${path}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  return { context, page };
}

/**
 * Joins one stand-in guest through the guest page, with fake media, and admits it. Returns the invitation id so the
 * caller can revoke it. Uses the same steps the WebRTC check uses.
 */
async function joinStandInGuest(browser, { app, api, token }) {
  const invite = await fetch(`${api}/webrtc/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ programId: "main", displayName: "Layout stand-in", expiresInHours: 1, returnVideo: "program", returnAudioBus: "master" }),
  }).then((r) => r.json());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  await page.goto(`${app}/guest/${encodeURIComponent(invite.invitation)}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("button", { name: /Speaker test/ }).click({ timeout: 120_000 });
  await page.getByLabel(/I am wearing headphones/).check({ timeout: 120_000 });
  await page.getByRole("button", { name: /Join studio/ }).click({ timeout: 120_000 });
  await page.getByRole("button", { name: /Leave/ }).waitFor({ timeout: 120_000 });
  await fetch(`${api}/webrtc/invitations/${encodeURIComponent(invite.id)}/admit`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return { invitation: invite, guest: { context, page } };
}

/** Runs the layout pass. Returns a list of { check, ok, detail } for the caller to print and count. */
export async function runLayoutPass(browser, { app, api, token, shots }) {
  assertLocalOrigin(app);
  assertLocalOrigin(api);
  mkdirSync(shots, { recursive: true });
  const results = [];
  const record = (check, ok, detail) => results.push({ check, ok, detail });

  const stand = await joinStandInGuest(browser, { app, api, token });
  try {
    for (const size of CALLS_SIZES) {
      const { context, page } = await openOperatorPage(browser, app, size, "/calls");
      try {
        await page.getByText("Guest slots").first().waitFor({ timeout: 120_000 }).catch(() => undefined);
        await page.locator(".guest-strip").first().waitFor({ timeout: 60_000 }).catch(() => undefined);
        const m = await measureCalls(page);
        const name = `calls ${size.width}x${size.height}`;
        const empty = m.columns.filter((c) => c.failed);
        record(`${name}: columns mostly empty above the fold`, empty.length === 0, empty.length ? empty.map((c) => `${c.name} ${Math.round(c.empty * 100)}%`).join("; ") : m.columns.map((c) => `${Math.round(c.empty * 100)}%`).join(", "));
        const overlaps = overlappingPairs(m.strips);
        record(`${name}: guest slots do not overlap`, overlaps.length === 0, overlaps.length ? `${overlaps.length} overlapping pair(s)` : `${m.strips.length} slot(s)`);
        await page.screenshot({ path: join(shots, `calls-${size.width}x${size.height}.png`) });
      } finally {
        await context.close();
      }
    }

    for (const size of DESK_SIZES) {
      const { context, page } = await openOperatorPage(browser, app, size, "/");
      try {
        // The header's program picker is a combobox labelled "Program"; the show is chosen from its list.
        await page.getByRole("combobox", { name: "Program" }).click({ timeout: 120_000 });
        await page.getByRole("option", { name: DESK_PROGRAM }).click({ timeout: 120_000 });
        await page.locator(".radio-cartwall").first().waitFor({ timeout: 120_000 }).catch(() => undefined);
        const d = await measureDesk(page);
        const name = `radio desk ${size.width}x${size.height}`;
        if (size.width === 1440) {
          for (const [panel, state] of Object.entries(d)) {
            record(`${name}: ${panel} visible without scrolling`, state.visible, state.present ? `bottom ${state.bottom}px of ${state.fold}px fold` : "not on the page");
          }
        } else {
          record(`${name}: panels on the page`, Object.values(d).every((s) => s.present), JSON.stringify(d));
        }
        await page.screenshot({ path: join(shots, `desk-${size.width}x${size.height}.png`) });
      } finally {
        await context.close();
      }
    }
  } finally {
    await stand.guest.context.close();
    await fetch(`${api}/webrtc/invitations/${encodeURIComponent(stand.invitation.id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  return results;
}
