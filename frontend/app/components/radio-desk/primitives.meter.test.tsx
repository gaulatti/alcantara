import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Meter } from "./primitives";

// gaulatti/alcantara#527 (untriaged gaps): a meter whose range has no width draws its level at zero, rather than dividing by zero.

it("draws the level and its warning at zero when the range is empty", () => {
  render(<Meter label="Empty range" value={5} min={3} max={3} warnFrom={3} peak={4} />);
  expect(screen.getByRole("meter", { name: "Empty range" })).toHaveAttribute("aria-valuenow", "5");
  expect(screen.getByTestId("meter-fill")).toHaveStyle({ width: "0%" });
  expect(screen.getByTestId("meter-warn")).toHaveStyle({ left: "0%" });
});
