import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IconButton } from "@gaulatti/bleecker";
import { ExternalLink } from "lucide-react";
import { resolveProgramOutputUrl } from "../utils/programTemplate";

// Exercise the actual header control, including the mode supplied to its URL resolver.
const source = ts.createSourceFile(
  "layout.tsx",
  readFileSync("app/routes/layout.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function headerOutput(type: "radio" | "tv", resolved = true) {
  let expression: ts.Expression | undefined;
  const walk = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "renderOpenProgramButton"
    )
      expression = node.initializer;
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (!expression) throw new Error("Missing Program header control");
  const body = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(
    "React",
    "IconButton",
    "ExternalLink",
    "selectedProgramType",
    "resolvedSelectedProgram",
    "openProgramUrl",
    `return ${body}`,
  )(
    React,
    IconButton,
    ExternalLink,
    type,
    resolved ? { programId: "station", type } : undefined,
    resolveProgramOutputUrl({ programId: "station", type }, "https://api.test"),
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

it.each([
  ["radio", "Listen to Radio Program", "/radio-output/station"],
  ["tv", "Open Program Output", "/program/station"],
] as const)(
  "opens the correct %s output when the header Program button is clicked",
  (type, label, path) => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(headerOutput(type));
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(open).toHaveBeenCalledWith(path, "_blank", "noopener,noreferrer");
  },
);
