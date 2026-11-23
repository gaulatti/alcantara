import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// gaulatti/alcantara#381: the Fifth Bell program is Brokaw's LiveProgram, placed with this API's
// origin and the /fifthbell asset path Alcántara serves.
const received: Array<Record<string, unknown>> = [];
vi.mock("../utils/apiBaseUrl", () => ({ getApiBaseUrl: () => "https://api.alcantara.example.test", apiUrl: (p: string) => p }));
vi.mock("@fifthbell/brokaw/components/live-program", () => ({
  LiveProgram: (props: Record<string, unknown>) => {
    received.push(props);
    return <div data-testid="brokaw-live-program" />;
  },
}));

import BrokawFifthBellProgramRenderer from "./BrokawFifthBellProgramRenderer";

afterEach(() => {
  cleanup();
  received.length = 0;
});

describe("BrokawFifthBellProgramRenderer", () => {
  it("renders Brokaw's LiveProgram with the scene props, this API's origin and Alcántara's asset path", async () => {
    const props = { programId: "fifthbell-demo", embedded: true, sceneMetadata: { a: 1 }, activeComponents: ["fifthbell"], masterGain: 0.4 };
    render(<BrokawFifthBellProgramRenderer {...props} />);
    expect(await screen.findByTestId("brokaw-live-program")).toBeInTheDocument();
    expect(received).toEqual([{ ...props, apiBaseUrl: "https://api.alcantara.example.test", assetBaseUrl: "/fifthbell" }]);
  });
});
