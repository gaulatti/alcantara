import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RundownRecipeFixture } from "./RundownRecipeFixture";

afterEach(cleanup);

it("draws the rundown-recipe fixture: uses as rows, the one on air open, a partial use and detached cues", () => {
  render(<RundownRecipeFixture />);
  const harbor = screen.getAllByRole("region", { name: "Song: Harbor Light · Song" });
  expect(harbor).toHaveLength(1);
  expect(harbor[0]).toHaveTextContent("On air");
  expect(within(harbor[0]).getAllByRole("listitem")).toHaveLength(8);
  expect(screen.getByRole("region", { name: "Song: Second Tide · Song" })).toHaveTextContent("8 steps");
  const parts = screen.getAllByRole("region", { name: "Song: Paper Lanterns · Song" });
  expect(parts).toHaveLength(2);
  expect(parts[0]).toHaveTextContent("Partial use");
  expect(screen.getByRole("button", { name: "Recipes" })).toBeInTheDocument();
});

it("runs every control on the fixture: the use row buttons and the library entries", () => {
  render(<RundownRecipeFixture />);
  for (const title of ["Move the use up", "Move the use down", "Change the label", "Detach: edit these steps by hand", "Remove the use"])
    for (const button of screen.queryAllByRole("button", { name: title })) if (!(button as HTMLButtonElement).disabled) fireEvent.click(button);
  fireEvent.keyDown(screen.getByLabelText("Search the library"), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "Recipes" }));
  fireEvent.keyDown(screen.getByLabelText("Search the library"), { key: "Enter" });
  expect(screen.getByRole("region", { name: "Rundown library" })).toBeInTheDocument();
});
