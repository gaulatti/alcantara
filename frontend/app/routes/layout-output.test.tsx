import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IconButton } from "@gaulatti/bleecker";
import { ExternalLink, Headphones } from "lucide-react";
import { resolveProgramOutputUrl } from "../utils/programTemplate";

// Exercise the actual header control, including the mode supplied to its URL resolver.
const source = ts.createSourceFile(
  "layout.tsx",
  readFileSync("app/routes/layout.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function expressionFor(name: string) {
  let expression: ts.Expression | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      expression = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (!expression) throw new Error(`Missing ${name}`);
  return ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
}
function headerOutput(
  type: "radio" | "tv",
  resolved = true,
  navigate = vi.fn(),
) {
  const action = new Function(
    "useCallback",
    "selectedProgramType",
    "openProgramUrl",
    "navigate",
    `return ${expressionFor("openSelectedProgramOutput")}`,
  )(
    (fn: () => void) => fn,
    type,
    resolveProgramOutputUrl({ programId: "station", type }, "https://api.test"),
    navigate,
  );
  const body = expressionFor("renderOpenProgramButton");
  return new Function(
    "React",
    "IconButton",
    "ExternalLink",
    "Headphones",
    "selectedProgramType",
    "resolvedSelectedProgram",
    "openSelectedProgramOutput",
    `return ${body}`,
  )(
    React,
    IconButton,
    ExternalLink,
    Headphones,
    type,
    resolved ? { programId: "station", type } : undefined,
    action,
  )();
}
it("does not open a TV renderer before the station type has loaded", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(headerOutput("tv", false));
  const button = screen.getByRole("button", { name: "Open Program Output" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(open).not.toHaveBeenCalled();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens TV output in a separate tab", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(headerOutput("tv"));
  fireEvent.click(screen.getByRole("button", { name: "Open Program Output" }));
  expect(open).toHaveBeenCalledWith(
    "/program/station",
    "_blank",
    "noopener,noreferrer",
  );
});

it("navigates to the inline Radio monitor without opening a new tab", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const navigate = vi.fn();
  render(headerOutput("radio", true, navigate));
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Radio Program" }),
  );
  expect(navigate).toHaveBeenCalledWith("/#radio-monitor");
  expect(open).not.toHaveBeenCalled();
});

it("focuses the existing Radio monitor without navigating or interrupting audio", () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const navigate = vi.fn();
  render(
    <>
      <div id="radio-monitor" tabIndex={-1} />
      <div>{headerOutput("radio", true, navigate)}</div>
    </>,
  );
  const monitor = document.getElementById("radio-monitor")!;
  monitor.scrollIntoView = vi.fn();
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Radio Program" }),
  );
  expect(monitor).toHaveFocus();
  expect(monitor.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(navigate).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
