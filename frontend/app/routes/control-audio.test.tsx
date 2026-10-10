import { readFileSync } from "node:fs";
import ts from "typescript";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TvAudioMixer } from "../components/TvAudioWorkspace";
import {
  normalizeBroadcastSettingsPayload,
  normalizeMasterVolume,
  withNormalizedMixerChannels,
} from "../utils/broadcast";

const source = ts.createSourceFile(
  "control.tsx",
  readFileSync("app/routes/control.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function evaluate(name: string, bindings: Record<string, unknown>) {
  let expression: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!expression) throw new Error(`Missing route binding: ${name}`);
  const js = ts.transpileModule(`(${expression.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `return ${js}`)(
    ...Object.values(bindings),
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("sends every rendered channel through the route's normal debounced audio-bus request and consumes the acknowledgement", async () => {
  vi.useFakeTimers();
  const initial = normalizeBroadcastSettingsPayload({});
  const setMixerLevels = vi.fn();
  const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
    ok: true,
    json: async () => JSON.parse(init.body as string),
  }));
  vi.stubGlobal("fetch", fetch);
  const bindings: Record<string, any> = {
    mixerLevels: initial,
    mixerLevelsRef: { current: initial },
    mixerSaveTimeoutRef: { current: null },
    normalizeBroadcastSettingsPayload,
    normalizeMasterVolume,
    withNormalizedMixerChannels,
    setMixerLevels,
    setIsSavingMixerLevels: vi.fn(),
    setMixerSaveError: vi.fn(),
    shouldApplyControlUpdatePayload: () => true,
    activeProgramId: "tv-demo",
    apiUrl: (url: string) => `http://localhost:3007${url}`,
    shouldShowStreamStrip: true,
  };
  for (const meter of ["song", "instants", "sceneInstant", "mainMix"]) {
    for (const suffix of ["MeterFill", "PeakFill", "PeakHoldFill"])
      bindings[`${meter}${suffix}`] = 0;
  }
  for (const name of [
    "persistMixerLevels",
    "queueMixerSave",
    "commitMixerLevels",
    "setSongMasterVolume",
    "setStreamMasterVolume",
    "setInstantMasterVolume",
    "setSceneInstantMasterVolume",
    "setMainMasterVolume",
    "toggleSongMuted",
    "toggleSongSolo",
    "toggleStreamMuted",
    "toggleStreamSolo",
    "toggleInstantMuted",
    "toggleInstantSolo",
    "toggleSceneInstantMuted",
    "toggleSceneInstantSolo",
  ])
    bindings[name] = evaluate(name, bindings);
  const channels = evaluate("tvAudioInputs", bindings);
  render(
    <TvAudioMixer
      channels={channels}
      fadeMs={5000}
      onFadeChange={vi.fn()}
      loading={false}
      saving={false}
      error={null}
    />,
  );
  for (const [index, channel] of channels.entries()) {
    const volume = (index + 1) / 10;
    fireEvent.change(
      screen.getByRole("slider", { name: `${channel.label} fader` }),
      { target: { value: String(volume) } },
    );
    if (channel.id !== "main") {
      fireEvent.click(
        screen.getByRole("button", { name: `Mute ${channel.label}` }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: `Solo ${channel.label}` }),
      );
    }
    // Rapid local changes coalesce before the API call.
    expect(fetch).toHaveBeenCalledTimes(index);
    await vi.advanceTimersByTimeAsync(180);
    expect(fetch).toHaveBeenLastCalledWith(
      "http://localhost:3007/program/tv-demo/audio-bus",
      expect.objectContaining({ method: "PUT" }),
    );
    const payload = JSON.parse(fetch.mock.calls[index][1].body as string);
    if (channel.id === "main")
      expect(payload.mixerSettings.mainMasterVolume).toBe(volume);
    else
      expect(
        payload.mixerSettings.mixerChannels.find(
          (item: any) => item.id === channel.id,
        ),
      ).toMatchObject({ volume, muted: true, solo: true });
    expect(setMixerLevels).toHaveBeenLastCalledWith(
      normalizeBroadcastSettingsPayload(payload.mixerSettings),
    );
  }
  expect(bindings.setMixerSaveError).not.toHaveBeenCalledWith(
    expect.any(String),
  );
});
