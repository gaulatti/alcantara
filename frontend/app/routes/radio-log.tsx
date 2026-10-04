import { Navigate } from "react-router";
export function meta() {
  return [{ title: "Rundown - Alcantara" }];
}
export default function LegacyRadioLog() {
  return <Navigate to="/flight" replace />;
}
