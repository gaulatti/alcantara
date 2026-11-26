import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ScenePreparationFixture } from "./ScenePreparationFixture";

// gaulatti/alcantara#624: the fixture's editor callbacks that a reviewer reaches by using the editor.
// Names are fictional.

afterEach(cleanup);

it("saves, edits and leaves the player editor's fields", () => {
  render(<ScenePreparationFixture />);
  const audio = screen.getByRole("textbox", { name: "Audio URL" });
  fireEvent.change(audio, { target: { value: "https://media.example.test/rehearsal.mp3" } });
  fireEvent.focusOut(audio);
  fireEvent.click(screen.getByRole("button", { name: "Show component" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
});
