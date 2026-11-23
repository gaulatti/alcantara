import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import RelojClone from "./RelojClone";

// gaulatti/alcantara#333: the clock draws the logo its scene gives, and none
// otherwise: no station image is built in.
afterEach(cleanup);

it("draws the scene's logo under the clock", () => {
  const { container } = render(<RelojClone logoUrl="https://example.com/logo.svg" />);
  expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/logo.svg");
});

it("draws no logo when the scene gives none", () => {
  const { container } = render(<RelojClone />);
  expect(container.querySelector("img")).toBeNull();
});
