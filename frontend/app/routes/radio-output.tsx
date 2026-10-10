import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { useGlobalProgramId } from "../utils/globalProgram";

// Existing monitor links now return to that station's inline Radio desk.
export default function RadioOutput() {
  const { programId = "" } = useParams();
  const [, setSelectedProgram] = useGlobalProgramId();
  const navigate = useNavigate();
  useEffect(() => {
    setSelectedProgram(programId);
    void navigate("/#radio-monitor", { replace: true });
  }, [programId, setSelectedProgram, navigate]);
  return null;
}
