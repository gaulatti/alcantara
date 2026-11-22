import { Card } from "@gaulatti/bleecker";
import { useState } from "react";
import {
  AudioLibrary,
  type AudioLibraryAsset,
} from "../components/media/AudioLibrary";
import { InlineLabelCreator } from "../components/media/InlineLabelCreator";
import { MediaLibraryPage } from "../components/media/MediaLibraryPage";

const measured = {
  status: "success" as const,
  fadeInSeconds: null,
  fadeOutSeconds: null,
  overlapSeconds: null,
  updatedAt: "2026-11-22T09:12:00.000Z",
};

// Fictional audio assets, one for each state the Audio tab shows: a measured song with both
// cue points, a measured song with only a cue out, a pending and a failed analysis, a clip with
// no stored length, an asset with no analysis row and one from a server that sends no analysis.
const examples: AudioLibraryAsset[] = [
  {
    id: "harbor-lights",
    name: "Harbor Lights",
    sourceUrl: "https://media.example/harbor-lights.mp3",
    capabilities: ["SONG"],
    labels: [{ id: "evening", name: "Evening" }],
    song: { durationMs: 214_000 },
    analysis: {
      ...measured,
      cueInSeconds: 0.42,
      cueOutSeconds: 209.8,
      integratedLufs: -9.8,
      truePeakDbtp: -0.6,
    },
  },
  {
    id: "paper-satellites",
    name: "Paper Satellites",
    sourceUrl: "https://media.example/paper-satellites.mp3",
    capabilities: ["SONG", "COVER"],
    labels: [{ id: "nineties", name: "90s" }],
    song: { durationMs: 198_000 },
    analysis: {
      ...measured,
      cueInSeconds: null,
      cueOutSeconds: 191.5,
      integratedLufs: -8.9,
      truePeakDbtp: 0.3,
    },
  },
  {
    id: "slow-weather",
    name: "Slow Weather",
    sourceUrl: "https://media.example/slow-weather.mp3",
    capabilities: ["SONG"],
    labels: [],
    song: { durationMs: 263_000 },
    analysis: {
      status: "pending",
      cueInSeconds: null,
      cueOutSeconds: null,
      fadeInSeconds: null,
      fadeOutSeconds: null,
      overlapSeconds: null,
      integratedLufs: null,
      truePeakDbtp: null,
      attempts: 1,
      nextAttemptAt: "14:20",
    },
  },
  {
    id: "northbound",
    name: "Northbound",
    sourceUrl: "https://media.example/northbound.mp3",
    capabilities: ["SONG"],
    labels: [],
    song: { durationMs: 229_000 },
    analysis: {
      status: "failed",
      cueInSeconds: null,
      cueOutSeconds: null,
      fadeInSeconds: null,
      fadeOutSeconds: null,
      overlapSeconds: null,
      integratedLufs: null,
      truePeakDbtp: null,
      error: "decode-failed",
      attempts: 2,
      nextAttemptAt: "14:50",
    },
  },
  {
    id: "morning-opener",
    name: "Morning opener",
    sourceUrl: "https://media.example/morning-opener.mp3",
    capabilities: ["INSTANT", "BACKGROUND"],
    labels: [
      { id: "morning", name: "Morning" },
      { id: "station-ids", name: "Station IDs" },
    ],
    song: null,
    analysis: {
      ...measured,
      cueInSeconds: 0.08,
      cueOutSeconds: null,
      integratedLufs: -12.4,
      truePeakDbtp: -2.1,
    },
  },
  {
    id: "weather-bed",
    name: "Weather bed",
    sourceUrl: "https://media.example/weather-bed.mp3",
    capabilities: ["BACKGROUND"],
    labels: [],
    song: null,
    analysis: {
      ...measured,
      cueInSeconds: null,
      cueOutSeconds: null,
      integratedLufs: -18.6,
      truePeakDbtp: -6.2,
    },
  },
  {
    id: "sweep",
    name: "Sweep · Top of hour",
    sourceUrl: "https://media.example/sweep.mp3",
    capabilities: ["TRANSITION"],
    labels: [{ id: "station-ids", name: "Station IDs" }],
    song: null,
    analysis: null,
  },
  {
    id: "legacy-clip",
    name: "Legacy clip",
    sourceUrl: "https://media.example/legacy-clip.mp3",
    capabilities: ["INSTANT"],
    labels: [],
    song: null,
  },
];

export default function MediaFixture() {
  const [capability, setCapability] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const query = search.trim().toLowerCase();
  const shown = examples.filter(
    (asset) =>
      (!capability || asset.capabilities.includes(capability)) &&
      (!query || asset.name.toLowerCase().includes(query)),
  );

  return (
    <MediaLibraryPage
      activeSection="audio"
      visibleSections={["audio", "labels"]}
      width="full"
    >
      <Card className="space-y-4">
        <p className="text-sm text-text-secondary">
          Fixture: the Radio media surface exposes Audio and Labels only. Audio
          shows each asset's stored analysis, one shared transport and the
          states of the analysis: measured, measuring, failed, not analysed and
          unavailable.
        </p>
        <InlineLabelCreator onCreate={async () => undefined} />
        <AudioLibrary
          assets={shown}
          total={shown.length}
          loading={false}
          capability={capability}
          onCapabilityChange={setCapability}
          search={search}
          onSearchChange={setSearch}
          filtered={Boolean(capability || query)}
          selectedIds={selected}
          onToggleSelected={(id, checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(id);
              else next.delete(id);
              return next;
            })
          }
          canDelete={() => false}
          onDelete={() => undefined}
        />
      </Card>
    </MediaLibraryPage>
  );
}
