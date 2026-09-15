import { Card } from "@gaulatti/bleecker";
import { InlineLabelCreator } from "../components/media/InlineLabelCreator";
import { MediaLibraryPage } from "../components/media/MediaLibraryPage";

const examples = [
  {
    name: "Morning opener",
    capabilities: ["Instant", "Background"],
    labels: ["Morning", "Station IDs"],
  },
  { name: "September", capabilities: ["Song"], labels: ["70s", "High energy"] },
  { name: "Weather bed", capabilities: ["Background"], labels: [] },
];

export default function MediaFixture() {
  return (
    <MediaLibraryPage
      activeSection="audio"
      visibleSections={["audio", "labels"]}
      width="full"
    >
      <Card className="space-y-4">
        <p className="text-sm text-text-secondary">
          Fixture: the Radio media surface exposes Audio and Labels only. Audio
          uses additive capabilities and reusable labels.
        </p>
        <InlineLabelCreator onCreate={async () => undefined} />
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {examples.map((asset) => (
            <article
              key={asset.name}
              className="rounded-[var(--radius-card)] border border-sand/25 bg-white/80 p-4 dark:border-white/10 dark:bg-dark-sand/60"
            >
              <p className="font-medium text-text-primary">{asset.name}</p>
              <p className="mt-1 text-xs uppercase tracking-wide text-text-secondary">
                Audio
              </p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {asset.capabilities.map((capability) => (
                  <span
                    key={capability}
                    className="rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-xs font-medium text-sea"
                  >
                    {capability}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {asset.labels.length > 0 ? (
                  asset.labels.map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-sand/40 bg-dark-sand/70 px-2 py-0.5 text-xs text-text-primary"
                    >
                      {label}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-text-secondary">Unlabeled</span>
                )}
              </div>
            </article>
          ))}
        </div>
      </Card>
    </MediaLibraryPage>
  );
}
