import { useOutletContext } from "react-router";
import { RundownWorkspace } from "../components/RundownWorkspace";
import type { ProgramType } from "../utils/appNavigation";
export function meta() {
  return [{ title: "Rundown - Alcantara" }];
}
export default function RundownPage() {
  const { programType } = useOutletContext<{
    programType: ProgramType | null;
  }>();
  return <RundownWorkspace programType={programType} />;
}
