import { useFeatures } from "../../hooks/useFeatures";
import { HostMicOnAir, useHostMic } from "../HostMicOnAir";
import { HeadphonesToggle } from "../LocalAudioGuard";

/** Mic on air on the radio desk (gaulatti/alcantara#879). Only inside the console, which holds the microphone. */
export function DeskHostMic({ programId }: { programId: string }) {
  return useHostMic() ? <Allowed programId={programId} /> : null;
}

function Allowed({ programId }: { programId: string }) {
  const { hasPermission, loading } = useFeatures();
  return (
    <span className="flex flex-wrap items-center gap-x-2">
      <HostMicOnAir programId={programId} canOperate={!loading && hasPermission("alcantara:webrtc:operate")} />
      <HeadphonesToggle />
    </span>
  );
}
