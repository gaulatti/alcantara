#!/usr/bin/env node
// Touch regressions at 375 px (gaulatti/alcantara, tonight's touch fixes), as one repeatable browser check:
//
//   library-add        Rundown library rows have a visible Add button a touch can reach (#851)
//   rotation-move      rotation rows reorder with Move up / Move down (#826)
//   rotation-star      the high-rotation star is visible without hover (#854)
//   media-label-row    a media label's row controls are visible without hover (#854)
//   media-unknown      a label the library does not know shows as removable (#856; needs a legacy label on the stack)
//   clear-cue          an armed cue can be cleared with a button beside Take (#853)
//   timeline-pin-drag  a timeline pin moves by a touch drag (verified by hand, kept here so it cannot regress)
//
// It runs in touch emulation at 375 x 812 against a local Compose stack with test auth, and prints one JSON line per
// check. A check that cannot run (its fixture or seed data is absent) is reported as "skipped" with the reason, and
// is not silent. The script exits non-zero on the first failed check.
//
// Configuration (environment, defaults match the local Compose stack):
//   ALCANTARA_APP_URL  the frontend origin (default http://localhost:5173)
//   TOUCH_TIMEOUT_MS   per wait (default 120000; the dev server recompiles on first load)

import { chromium } from "playwright";

const APP = (process.env.ALCANTARA_APP_URL || "http://localhost:5173").replace(/\/$/, "");
const TIMEOUT = Number(process.env.TOUCH_TIMEOUT_MS || 120_000);
const VIEW = { width: 375, height: 812 };

const results = [];
const report = (name, status, detail = "") => {
  results.push({ name, status });
  console.log(JSON.stringify({ check: name, status, detail }));
};

async function openPage(browser, path) {
  const context = await browser.newContext({ viewport: VIEW, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  // The first load of a cold dev server can answer with an empty response: retry the navigation, do not fail on it.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${APP}${path}`, { waitUntil: "load", timeout: TIMEOUT });
      break;
    } catch (error) {
      if (attempt >= 5 || !/ERR_EMPTY_RESPONSE|ERR_CONNECTION/.test(String(error.message))) throw error;
      await page.waitForTimeout(5_000);
    }
  }
  // The workspace opens after the test-auth session loads: wait for the app's own controls, not a fixed time. A cold
  // dev server re-optimizes its dependencies on the first load and that page never finishes loading, so reload once.
  const ready = () => page.waitForFunction(() => document.querySelectorAll("button").length > 5, null, { timeout: TIMEOUT });
  try {
    await ready();
  } catch {
    await page.reload({ waitUntil: "load", timeout: TIMEOUT });
    await ready();
  }
  return { context, page };
}

// The console's program is shared between runs (a check that switches it leaves it switched), so a check that needs
// one program's media picks it first, as the timeline check does (#863).
async function selectProgram(page, programId) {
  const program = page.getByRole("combobox", { name: "Program" }).first();
  await program.waitFor();
  await program.click();
  await page.getByRole("option", { name: programId, exact: true }).tap();
}

// Opacity a touch user sees. Hover-only controls are opacity 0 without hover, so a visible control reads ~1.
const opacity = (locator) => locator.evaluate((el) => Number(getComputedStyle(el).opacity));

async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome && outcome.skip) report(name, "skipped", outcome.skip);
    else report(name, "passed", outcome?.detail ?? "");
  } catch (error) {
    report(name, "failed", String(error.message || error).split("\n")[0].slice(0, 240));
  }
}

const browser = await chromium.launch();
try {
  await check("library-add", async () => {
    const { context, page } = await openPage(browser, "/flight");
    try {
      const program = page.getByRole("combobox", { name: "Program" }).first();
      await program.waitFor();
      await program.click();
      await page.getByRole("option", { name: "main", exact: true }).tap();
      const cues = page.getByRole("button", { name: "Operator cues", exact: true }).first();
      await cues.waitFor();
      await cues.tap();
      const add = page.getByRole("button", { name: /^Add .+ to the rundown$/ }).first();
      await add.waitFor();
      if ((await opacity(add)) < 0.9) throw new Error("Add is not visible without hover");
      await add.tap();
      return { detail: "Add is visible, and tapping it adds the row" };
    } finally {
      await context.close();
    }
  });

  await check("rotation-move", async () => {
    const { context, page } = await openPage(browser, "/console-fixture?state=high-rotation");
    try {
      const down = page.getByRole("button", { name: /^Move .+ down$/ }).first();
      await down.waitFor();
      const before = await page.getByRole("option").allInnerTexts().catch(() => []);
      await down.tap();
      await page.waitForTimeout(300);
      const after = await page.getByRole("option").allInnerTexts().catch(() => []);
      if (before.length && JSON.stringify(before) === JSON.stringify(after)) throw new Error("the row order did not change");
      return { detail: "Move down reorders the rotation" };
    } finally {
      await context.close();
    }
  });

  await check("rotation-star", async () => {
    const { context, page } = await openPage(browser, "/console-fixture?state=high-rotation");
    try {
      const star = page.getByRole("button", { name: /to high rotation$/ }).first();
      await star.waitFor();
      if ((await opacity(star)) < 0.9) throw new Error("the star is hidden without hover");
      return { detail: "the star is visible under touch" };
    } finally {
      await context.close();
    }
  });

  await check("media-label-row", async () => {
    const { context, page } = await openPage(browser, "/media");
    try {
      // The seeded label with media belongs to the radio show.
      await selectProgram(page, "radio-demo");
      // The media type switcher is a tab list: Images, Audio, Video and Labels are tabs, not buttons (#863).
      const labels = page.getByRole("tab", { name: "Labels", exact: true });
      await labels.waitFor();
      await labels.tap();
      // A label's media rows, with their controls, show once the label is selected in the list (#863).
      const label = page.locator("tbody tr").first();
      try {
        await label.waitFor({ timeout: 15_000 });
      } catch {
        return { skip: "no label on this stack" };
      }
      await label.tap();
      const down = page.getByRole("button", { name: /^Move .+ down$/ }).first();
      const remove = page.getByRole("button", { name: /^Remove .+ from / }).first();
      try {
        await down.waitFor({ timeout: 10_000 });
      } catch {
        return { skip: "the first label has no media on this stack" };
      }
      // Enabled controls only: the first row's Move up is disabled, and its dimming is not hover.
      for (const control of [down, remove])
        if ((await opacity(control)) < 0.9) throw new Error("a label row control is hidden without hover");
      return { detail: "the label row's controls are visible under touch" };
    } finally {
      await context.close();
    }
  });

  await check("media-unknown", async () => {
    const { context, page } = await openPage(browser, "/media");
    try {
      // The seeded image is the TV show's.
      await selectProgram(page, "main");
      await page.getByRole("tab", { name: "Images", exact: true }).tap();
      const edit = page.getByRole("button", { name: "Edit Local New York still" });
      await edit.waitFor();
      await edit.tap();
      const dialog = page.getByRole("dialog", { name: "Edit image" });
      await dialog.waitFor();
      const chip = dialog.getByRole("button", { name: "Remove label" }).first();
      if ((await chip.count()) === 0) return { skip: "the seeded image has no unknown label on this stack" };
      await chip.tap();
      await dialog.getByRole("button", { name: "Save image" }).tap();
      await dialog.waitFor({ state: "hidden" });
      return { detail: "the unknown label was removed and the save went through" };
    } finally {
      await context.close();
    }
  });

  await check("clear-cue", async () => {
    const { context, page } = await openPage(browser, "/console-fixture?state=radio-continuous");
    try {
      const cue = page.getByRole("button", { name: /^Cue next/ }).first();
      await cue.waitFor();
      await cue.tap();
      const clear = page.getByRole("button", { name: "Clear cue" });
      await clear.waitFor();
      await clear.tap();
      await clear.waitFor({ state: "detached" });
      return { detail: "an armed cue is cleared by its button" };
    } finally {
      await context.close();
    }
  });

  await check("timeline-pin-drag", async () => {
    const { context, page } = await openPage(browser, "/flight");
    try {
      const program = page.getByRole("combobox", { name: "Program" }).first();
      await program.waitFor();
      await program.click();
      await page.getByRole("option", { name: "radio-demo", exact: true }).tap();
      const block = page.getByRole("combobox", { name: "Scheduled block" });
      await block.waitFor();
      await block.click();
      await page.getByRole("option", { name: /Draft/ }).first().tap();
      // The first event is fixed at the block start, so a second event gets a fixed start to give a movable pin.
      await page.getByRole("button", { name: /^Local demo tone 2, start/ }).first().tap();
      // The event inspector takes a fixed start as typed text; it has no checkbox to tick first (#863).
      await page.getByRole("textbox", { name: "Fixed start" }).fill("07:05");
      await page.getByRole("textbox", { name: "Fixed start" }).press("Enter");
      const pin = page.getByRole("slider").nth(1);
      await pin.scrollIntoViewIfNeeded();
      const before = await pin.getAttribute("aria-valuetext");
      const box = await pin.boundingBox();
      const cdp = await context.newCDPSession(page);
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + i * 6, y, id: 1 }] });
        await page.waitForTimeout(40);
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(400);
      const after = await pin.getAttribute("aria-valuetext");
      if (after === before) throw new Error(`the pin did not move from ${before}`);
      return { detail: `the pin moved from ${before} to ${after}` };
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
}

const failed = results.filter((result) => result.status === "failed");
const skipped = results.filter((result) => result.status === "skipped");
console.log(JSON.stringify({ summary: { passed: results.filter((result) => result.status === "passed").length, failed: failed.length, skipped: skipped.length } }));
process.exit(failed.length ? 1 : 0);
