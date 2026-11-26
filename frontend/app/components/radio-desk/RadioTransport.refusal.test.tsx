import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RadioTransport } from "./RadioTransport";

// gaulatti/alcantara#527 (untriaged gaps): a take the desk refuses with something other than an Error shows the plain text.

afterEach(cleanup);

const next = { itemId: "s2", via: "rotation" as const, title: "Copper Season", artist: "The Paper Hours", durationMs: 241_000 };

it("shows the plain refusal text when the take is refused with a non-Error value", async () => {
  const onTake = vi.fn(async () => {
    throw "studio busy";
  });
  render(<RadioTransport next={next} onTake={onTake} onTakeOffAir={vi.fn()} />);
  fireEvent.keyDown(window, { key: "n" });
  await act(async () => {
    fireEvent.keyDown(window, { key: " " });
  });
  expect(onTake).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("The take was refused")).toBeInTheDocument();
});
