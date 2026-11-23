import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// gaulatti/alcantara#381: the Fifth Bell program comes from Brokaw when the pinned version
// exports LiveProgram by name, and from the local renderer otherwise.
const received: Array<Record<string, unknown>> = [];
const stand = (name: string) =>
  function Stand(props: Record<string, unknown>) {
    received.push({ name, ...props });
    return <div data-testid={name} />;
  };

const props = { programId: "fifthbell-demo", embedded: true, sceneMetadata: { a: 1 }, activeComponents: ["fifthbell"], masterGain: 0.4 };

beforeEach(() => {
  received.length = 0;
  vi.resetModules();
  vi.doMock("../utils/apiBaseUrl", () => ({ getApiBaseUrl: () => "https://api.alcantara.example.test", apiUrl: (p: string) => p }));
  vi.doMock("../programs/fifthbell/FifthBellProgram", () => ({ default: stand("local") }));
});
afterEach(() => {
  cleanup();
  vi.doUnmock("@fifthbell/brokaw/components/live-program");
});

describe("BrokawFifthBellProgramRenderer", () => {
  it("renders Brokaw's LiveProgram with the same props and this API's origin when the pin exports it", async () => {
    vi.doMock("@fifthbell/brokaw/components/live-program", () => ({ LiveProgram: stand("brokaw"), default: stand("brokaw-default") }));
    const { default: Renderer } = await import("./BrokawFifthBellProgramRenderer");
    render(<Renderer {...props} />);
    expect(await screen.findByTestId("brokaw")).toBeInTheDocument();
    expect(screen.queryByTestId("local")).toBeNull();
    expect(received).toEqual([{ name: "brokaw", ...props, apiBaseUrl: "https://api.alcantara.example.test" }]);
  });

  it("keeps the local renderer when the pinned Brokaw has no named LiveProgram", async () => {
    vi.doMock("@fifthbell/brokaw/components/live-program", () => ({ default: stand("brokaw-default") }));
    const { default: Renderer } = await import("./BrokawFifthBellProgramRenderer");
    render(<Renderer {...props} />);
    expect(await screen.findByTestId("local")).toBeInTheDocument();
    expect(received).toEqual([{ name: "local", ...props }]);
  });
});
