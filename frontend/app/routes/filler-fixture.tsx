import { FillerLegSummary } from "../components/ProgramFillerPanel";
import { FILLER_FIXTURE } from "../components/fillerFixture";

/** Visual fixture for the program filler legs (gaulatti/alcantara#127). */
export default function FillerFixture() {
  const names = new Map([
    ["media:7", "Station slate"],
    ["media:3", "Night loop"],
    ["song:1", "Track one"],
    ["song:2", "Track two"],
  ]);
  return (
    <main
      className="min-h-screen broadcast-console bg-dark-sand p-6 text-text-primary"
      data-visual-fixture="program-filler"
    >
      <h1 className="mb-3 text-lg font-semibold">Program filler</h1>
      <div className="space-y-6">
        <section aria-label="Television filler">
          <h2 className="mb-2 text-sm font-semibold">Television filler</h2>
          <FillerLegSummary leg="television" state={FILLER_FIXTURE} names={names} />
        </section>
        <section aria-label="Radio filler">
          <h2 className="mb-2 text-sm font-semibold">Radio filler</h2>
          <FillerLegSummary leg="radio" state={FILLER_FIXTURE} names={names} />
        </section>
      </div>
    </main>
  );
}
