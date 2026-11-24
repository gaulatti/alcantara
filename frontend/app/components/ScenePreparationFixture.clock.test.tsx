import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ScenePreparationFixture } from "./ScenePreparationFixture";

// gaulatti/alcantara#404 follow-up (#527 item 1): a timezone picked on a clock widget becomes that widget's value.
// Bleecker's Radix select cannot open in jsdom, so this file swaps in the route specs' native select.
vi.mock("@gaulatti/bleecker", async (original) => {
  const kit = await import("../../test/routeKit");
  return kit.nativeSelect(original as () => Promise<typeof import("@gaulatti/bleecker")>);
});

afterEach(cleanup);

it("applies a timezone picked for the clock widget", () => {
  render(<ScenePreparationFixture timezone />);
  const panel = screen.getByRole("tabpanel", { name: "Clock Widget" });
  const picker = within(panel).getByRole("combobox") as HTMLSelectElement;
  expect(picker.value).toBe("Asia/Kolkata");
  fireEvent.change(picker, { target: { value: "Europe/Madrid" } });
  expect(within(panel).getByRole("combobox")).toHaveValue("Europe/Madrid");
});
