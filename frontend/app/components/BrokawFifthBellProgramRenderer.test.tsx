import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen, configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

// These tests import the packaged scenes after resetting the module registry, which is slow on a loaded
// CI runner: wait for the lazy load for as long as it takes rather than a fixed second.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });

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
