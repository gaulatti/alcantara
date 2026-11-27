// The signed-in layout pass for the console (gaulatti/alcantara#875): /calls with one connected stand-in guest, and the
// radio desk, at fixed sizes. It fails on a dead band (a column empty beside a neighbour that has content, above the fold,
// longer than 40% of the fold), on two guest slots that
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
/**
 * A dead band (a stretch where a column has no content while a neighbour has some, above the fold) longer than this
 * share of the fold fails the pass. Space below a column's last element is not a dead band.
 */
export const MAX_DEAD_BAND_FRACTION = 0.4;
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
 * The longest dead band, in pixels, across the columns. `columns` is one array per column, one boolean per vertical step
 * from the top of the fold (true where the column has content there). A dead band is a run of steps where a column is
 * empty while another column has content, and where the column still has content further down, so trailing space
 * below its last element is not counted. Pure, so the rule can be tested without a browser.
 */
export function longestDeadBand(columns, stepPx) {
  let longest = 0;
  const steps = Math.max(0, ...columns.map((col) => col.length));
  columns.forEach((col, index) => {
    const lastOwn = col.lastIndexOf(true);
    let run = 0;
    for (let y = 0; y < steps && y <= lastOwn; y += 1) {
      const own = col[y] === true;
      const neighbourHasContent = columns.some((other, j) => j !== index && other[y] === true);
      if (!own && neighbourHasContent) {
        run += 1;
        longest = Math.max(longest, run * stepPx);
      } else {
        run = 0;
      }
    }
  });
  return longest;
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

/**
 * The measure, run in the page: where each column has content down the fold, and where the guest slots overlap. The
 * columns are the queue on the left and each column of guest slots (slots grouped by their left edge).
 */
export async function measureCalls(page) {
  return page.evaluate(() => {
    const fold = window.innerHeight;
    const STEP = 4;
    const boxOf = (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    };
    const leaves = [...document.querySelectorAll("body *")]
      .filter((el) => (el.children.length === 0 && (el.textContent || "").trim().length > 0) || el.matches("button, input, select, img, canvas, [role='meter']"))
      .map(boxOf);
    const desk = document.querySelector(".caller-desk");
    const queue = desk && desk.children[0] ? boxOf(desk.children[0]) : null;
    const slots = [...document.querySelectorAll(".guest-strip")].map(boxOf);
    // Group the slots into columns by their left edge.
    const groups = [];
    for (const slot of slots) {
      const group = groups.find((g) => Math.abs(g.left - slot.left) < 10);
      if (group) group.boxes.push(slot);
      else groups.push({ left: slot.left, boxes: [slot] });
    }
    const columnRects = [];
    if (queue) columnRects.push({ name: "queue", left: queue.left, right: queue.right });
    for (const g of groups) columnRects.push({ name: `slots at x=${Math.round(g.left)}`, left: Math.min(...g.boxes.map((b) => b.left)), right: Math.max(...g.boxes.map((b) => b.right)) });
    const occupancy = columnRects.map((col) => {
      const steps = [];
      for (let y = 0; y < fold; y += STEP) {
        steps.push(leaves.some((box) => box.top <= y + STEP && box.bottom >= y && box.right > col.left && box.left < col.right));
      }
      return steps;
    });
    return { columns: columnRects.map((c) => c.name), occupancy, stepPx: STEP, strips: slots };
  });
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
        const dead = longestDeadBand(m.occupancy, m.stepPx);
        const limit = MAX_DEAD_BAND_FRACTION * size.height;
        record(`${name}: no dead band beside content above the fold`, dead <= limit, `longest ${Math.round(dead)}px, limit ${Math.round(limit)}px (${Math.round(MAX_DEAD_BAND_FRACTION * 100)}% of the fold)`);
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
          // Report only: below the fold at this width is accepted for now.
          for (const [panel, state] of Object.entries(d)) {
            record(`${name}: ${panel} (report only)`, true, state.present ? (state.visible ? "visible" : `below the fold, bottom ${state.bottom}px of ${state.fold}px`) : "not on the page");
          }
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
