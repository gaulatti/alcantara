import { describe, expect, it } from "vitest";
import {
  hasProgramCapability,
  resolveProgramOutputUrl,
  type ProgramTemplateManifest,
} from "./programTemplate";

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
    runtimeParameters: {
      programId: "programId",
      apiBaseUrl: "apiBaseUrl",
    },
    signals: ["program_state_snapshot", "scene_change"],
  },
};

describe("program template URLs", () => {
  it("opens a registered renderer with its declared runtime parameters", () => {
    expect(
      resolveProgramOutputUrl(
        { programId: "fifthbell", templateManifest: manifest },
        "https://api.alcantara.gaulatti.com/",
      ),
    ).toBe(
      "https://cdn.fifthbell.com/html/program-releases/0.1.65/index.html?programId=fifthbell&apiBaseUrl=https%3A%2F%2Fapi.alcantara.gaulatti.com",
    );
  });

  it("retains the transitional Alcantara renderer for unregistered programs", () => {
    expect(
      resolveProgramOutputUrl(
        { programId: "modo italiano" },
        "https://api.test",
      ),
    ).toBe("/program/modo%20italiano");
  });

  it("reports only capabilities declared by the template", () => {
    expect(hasProgramCapability(manifest, "audio.playback")).toBe(true);
    expect(hasProgramCapability(manifest, "media.groups")).toBe(false);
  });
});
