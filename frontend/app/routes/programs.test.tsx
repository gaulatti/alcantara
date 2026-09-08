import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProgramsAdmin from "./programs";
import type { ProgramTemplateManifest } from "../utils/programTemplate";

const { setSelectedProgramId } = vi.hoisted(() => ({
  setSelectedProgramId: vi.fn(),
}));

vi.mock("../utils/globalProgram", () => ({
  useGlobalProgramId: () => ["fifthbell", setSelectedProgramId],
}));

const templateUrl =
  "https://cdn.fifthbell.com/html/program-releases/0.1.65/live-program-manifest.json";
const manifest: ProgramTemplateManifest = {
  kind: "alcantara.program-template",
  contractVersion: 1,
  id: "fifthbell.live-program",
  name: "Fifthbell Live Program",
  package: "@fifthbell/brokaw",
  bundleVersion: "0.1.65",
  schemaVersion: 1,
  entrypoint: "index.html",
  entrypointUrl:
    "https://cdn.fifthbell.com/html/program-releases/0.1.65/index.html",
  capabilities: ["audio.playback", "scene.configuration"],
  control: {
    protocol: "alcantara.program.v1",
    transport: "server-sent-events",
    snapshotPath: "state",
    eventsPath: "events",
    runtimeParameters: { programId: "programId", apiBaseUrl: "apiBaseUrl" },
    signals: ["program_state_snapshot", "scene_change"],
  },
};

describe("Programs template registration", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/program")) {
          return Response.json([
            {
              id: 1,
              programId: "fifthbell",
              type: "tv",
              activeSceneId: null,
              scenes: [],
              mediaGroups: [],
              stingers: [],
              templateUrl,
              templateManifest: manifest,
              templateVerifiedAt: "2026-09-08T18:00:00.000Z",
            },
            {
              id: 2,
              programId: "unregistered",
              type: "tv",
              activeSceneId: null,
              scenes: [],
              mediaGroups: [],
              stingers: [],
              templateUrl: null,
              templateManifest: null,
              templateVerifiedAt: null,
            },
          ]);
        }
        if (url.includes("/media-groups")) {
          return Response.json({ data: [] });
        }
        return Response.json([]);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the registered renderer and gates editor sections by capabilities", async () => {
    render(
      <MemoryRouter>
        <ProgramsAdmin />
      </MemoryRouter>,
    );

    const outputLink = await screen.findByRole("link", {
      name: /open renderer/i,
    });
    expect(outputLink).toHaveAttribute(
      "href",
      "https://cdn.fifthbell.com/html/program-releases/0.1.65/index.html?programId=fifthbell&apiBaseUrl=http%3A%2F%2Flocalhost%3A3000",
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit fifthbell" }));
    expect(screen.getByDisplayValue(templateUrl)).toBeInTheDocument();
    expect(screen.getByText("Program Scenes")).toBeInTheDocument();
    expect(screen.queryByText("Program Media Groups")).not.toBeInTheDocument();
    expect(screen.queryByText("Program Stingers")).not.toBeInTheDocument();
  });

  it("shows an unavailable output instead of a local renderer fallback", async () => {
    render(
      <MemoryRouter>
        <ProgramsAdmin />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("No external template registered · output unavailable"),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /open renderer/i })).toHaveLength(
      1,
    );
  });
});
