import { Card } from "@gaulatti/bleecker";
import { useState } from "react";
import {
  LabelsView,
  type LabelsViewAsset,
  type LabelsViewLabel,
} from "../components/media/LabelsView";
import { MediaLibraryPage } from "../components/media/MediaLibraryPage";

const asset = (id: string, name: string, mediaType: string): LabelsViewAsset => ({
  id,
  name,
  mediaType,
  sourceUrl: `https://media.example/${id}`,
});

const ASSETS = {
  copper: asset("copper", "Copper Season", "AUDIO"),
  paper: asset("paper", "Paper Satellites", "AUDIO"),
  tide: asset("tide", "Low Tide Radio", "AUDIO"),
  bloom: asset("bloom", "Static Bloom", "AUDIO"),
  pier: asset("pier", "Video · Live at Pier 9", "VIDEO"),
  harbor: asset("harbor", "Harbor Lights", "AUDIO"),
  weather: asset("weather", "Slow Weather", "AUDIO"),
  morning: asset("morning", "Station ID · Morning", "AUDIO"),
  sweep: asset("sweep", "Sweep · Top of hour", "AUDIO"),
  night: asset("night", "Station ID · Night", "AUDIO"),
  bakery: asset("bakery", "Sponsor read · Bakery", "AUDIO"),
  slide: asset("slide", "Sponsor slide · Bakery", "IMAGE"),
  snow: asset("snow", "Snow on the Wire", "AUDIO"),
  card: asset("card", "Holiday card", "IMAGE"),
};

const at = (days: number, hour = 9) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, 12, 0, 0);
  return date.toISOString();
};

// Fictional labels, one for each state the Labels view shows: media of several types, a label
// with more media than the drawer lists, and one that was changed today, yesterday and long ago.
const INITIAL: LabelsViewLabel[] = [
  {
    id: "nineties",
    name: "90s",
    description: "Songs released 1990–1999",
    assetCount: 38,
    updatedAt: at(0),
    assets: [ASSETS.copper, ASSETS.paper, ASSETS.tide, ASSETS.bloom, ASSETS.pier].map(
      (entry, position) => ({ position, asset: entry }),
    ),
  },
  {
    id: "evening",
    name: "Evening",
    description: "Rotation after 19:00",
    assetCount: 3,
    updatedAt: at(1),
    assets: [ASSETS.harbor, ASSETS.tide, ASSETS.weather].map((entry, position) => ({
      position,
      asset: entry,
    })),
  },
  {
    id: "station-ids",
    name: "Station IDs",
    description: "Identifiers and sweepers",
    assetCount: 3,
    updatedAt: at(4),
    assets: [ASSETS.morning, ASSETS.sweep, ASSETS.night].map((entry, position) => ({
      position,
      asset: entry,
    })),
  },
  {
    id: "sponsor",
    name: "Sponsor",
    description: "Paid placements; check dates",
    assetCount: 2,
    updatedAt: at(10),
    assets: [ASSETS.bakery, ASSETS.slide].map((entry, position) => ({
      position,
      asset: entry,
    })),
  },
  {
    id: "christmas",
    name: "Christmas",
    description: "Seasonal, off until December",
    assetCount: 2,
    updatedAt: at(23),
    assets: [ASSETS.snow, ASSETS.card].map((entry, position) => ({
      position,
      asset: entry,
    })),
  },
  {
    id: "unused",
    name: "Unused",
    description: null,
    assetCount: 0,
    updatedAt: at(60),
    assets: [],
  },
];

export default function LabelsFixture() {
  const [labels, setLabels] = useState(INITIAL);
  const [selectedId, setSelectedId] = useState<string | null>("nineties");
  const [search, setSearch] = useState("");

  const setAssets = (label: LabelsViewLabel, ids: string[]) =>
    setLabels((current) =>
      current.map((entry) =>
        entry.id === label.id
          ? {
              ...entry,
              assets: ids.map((id, position) => ({
                position,
                asset: Object.values(ASSETS).find((candidate) => candidate.id === id)!,
              })),
              assetCount: Math.max(ids.length, entry.assetCount - (entry.assets.length - ids.length)),
            }
          : entry,
      ),
    );

  return (
    <MediaLibraryPage
      activeSection="labels"
      visibleSections={["audio", "labels"]}
      width="full"
    >
      <Card className="space-y-4">
        <p className="text-sm text-text-secondary">
          Fixture: the Labels view with fictional labels. Drag the rows of the drawer, or use their
          buttons, to change the order.
        </p>
        <LabelsView
          labels={labels}
          loading={false}
          selectedId={selectedId}
          onSelect={setSelectedId}
          search={search}
          onSearchChange={setSearch}
          onCreate={() => undefined}
          onEdit={() => undefined}
          onDelete={() => undefined}
          addableAssets={Object.values(ASSETS)}
          onAddAsset={async (label, assetId) => {
            setAssets(label, [...label.assets.map((entry) => entry.asset.id), assetId]);
            return true;
          }}
          onRemoveAsset={async (label, assetId) =>
            setAssets(
              label,
              label.assets.map((entry) => entry.asset.id).filter((id) => id !== assetId),
            )
          }
          onReorder={async (label, ids) => setAssets(label, ids)}
        />
      </Card>
    </MediaLibraryPage>
  );
}
