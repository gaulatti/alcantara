// The guest-facing copy of the studio's return (components/guest/guestReturnCopy.ts), read from the guest page's visible
// text by the e2e proofs. Kept apart from the proof scripts, which run when imported.
// The guest-facing copy (components/guest/guestReturnCopy.ts). Matched on the page's visible text.
export const PLAYING_COPY = "You're hearing the studio";
export const GUEST_COPIES = [
  PLAYING_COPY,
  "Connecting you to the studio sound…",
  "The studio sound dropped. It will come back by itself.",
  "The studio sound isn't reaching you yet.",
];
/** Which guest-facing copy is on the page now, or "none" when none of them is. */
export function copyIn(text) {
  return GUEST_COPIES.find((copy) => text.includes(copy)) ?? "none";
}
/** Polls the page until the copy is `wanted`, or the time is up; returns the last copy seen. */
export async function waitForGuestCopy(page, wanted, ms) {
  const until = Date.now() + ms;
  let last = "none";
  while (Date.now() < until) {
    last = copyIn(await page.evaluate(() => document.body?.innerText ?? ""));
    if (last === wanted) return last;
    await page.waitForTimeout(500);
  }
  return last;
}

