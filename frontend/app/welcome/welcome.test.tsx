import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Welcome } from "./welcome";

it("links to the documentation and the community in new tabs", () => {
  render(<Welcome />);
  const docs = screen.getByRole("link", { name: "React Router Docs" });
  expect(docs).toHaveAttribute("href", "https://reactrouter.com/docs");
  expect(docs).toHaveAttribute("target", "_blank");
  expect(docs).toHaveAttribute("rel", "noreferrer");
  expect(screen.getByRole("link", { name: "Join Discord" })).toHaveAttribute("href", "https://rmx.as/discord");
  expect(screen.getAllByAltText("React Router")).toHaveLength(2);
});
