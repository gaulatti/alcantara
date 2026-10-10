import { Button, Card, SectionHeader } from "@gaulatti/bleecker";
import { Link, useParams } from "react-router";
import { AppPage } from "../components/AppPage";
import { RadioOutputPlayer } from "../components/RadioOutputPlayer";
import { useGlobalProgramId } from "../utils/globalProgram";

export default function RadioOutput() {
  const { programId = "" } = useParams();
  const [, setSelectedProgram] = useGlobalProgramId();
  return (
    <AppPage className="space-y-6">
      <SectionHeader
        title={`Radio Program · ${programId}`}
        description="Listen to Palazzo’s Icecast output through Alcántara."
      />
      <Card>
        <RadioOutputPlayer programId={programId} />
      </Card>
      <div className="flex flex-wrap items-center gap-4">
        <Link to="/" onClick={() => setSelectedProgram(programId)}>
          Back to Radio desk
        </Link>
        <Button
          as="a"
          href="/radio-settings"
          variant="secondary"
          onClick={() => setSelectedProgram(programId)}
        >
          Radio distribution
        </Button>
      </div>
    </AppPage>
  );
}
