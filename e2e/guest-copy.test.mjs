import assert from "node:assert/strict";
import { test } from "node:test";
import { GUEST_COPIES, PLAYING_COPY, copyIn } from "./guest-copy.mjs";

test("reads which guest-facing copy is on the page", () => {
  assert.equal(copyIn("ALCÁNTARA\nYou're hearing the studio\n"), PLAYING_COPY);
  assert.equal(copyIn("Connecting you to the studio sound…"), "Connecting you to the studio sound…");
  assert.equal(copyIn("The studio sound isn't reaching you yet. The producer can see this; you can keep talking."), "The studio sound isn't reaching you yet.");
  assert.equal(copyIn("Welcome back."), "none");
  assert.equal(GUEST_COPIES.length, 4);
});
