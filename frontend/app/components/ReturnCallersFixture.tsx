import { useEffect, useState } from "react";
import "./BroadcastConsole.css";
import { ConfidenceMonitor } from "./BroadcastSwitcherDeck";
import { GuestStrip, type StripParticipant } from "./GuestStrip";
import type { ReturnSource } from "../utils/programReturn";
import type { Scene } from "../models/broadcast";

/**
 * Visual fixtures for alcantara#301 (`/console-fixture?state=program-return`
 * and `?state=caller-desk`). Names and numbers are fictional; nothing is sent.
 */
const scene = { id: 1, name: "Morning desk" } as Scene;

export function ProgramReturnFixture() {
  // The clock keeps moving, so Live and Delayed keep a fresh last frame and the frozen and lost
  // timers count, as a real return would.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const sources: Array<[string, ReturnSource]> = [
    ["Today: local render", { kind: "local" }],
    ["Live", { kind: "return", from: "Alana", connected: true, latencyMs: 1_800, lastFrameAt: now }],
    ["Delayed", { kind: "return", from: "Alana", connected: true, latencyMs: 4_200, lastFrameAt: now }],
    ["Frozen", { kind: "return", from: "Alana", connected: true, latencyMs: 1_900, lastFrameAt: now - 6_000 }],
    ["Signal lost", { kind: "return", from: "Alana", connected: false, latencyMs: null, lastFrameAt: now - 7_000 }],
  ];
  return (
    <main className="broadcast-console grid gap-4 p-6 md:grid-cols-2" data-visual-fixture="program-return">
      {sources.map(([name, source]) => (
        <figure key={name} className="grid gap-2">
          <figcaption className="text-xs text-text-secondary">{name}</figcaption>
          <ConfidenceMonitor
            label="PROGRAM"
            tone="program"
            scene={scene}
            src="about:blank"
            returnSource={source}
          />
        </figure>
      ))}
    </main>
  );
}

const guests: StripParticipant[] = [
  { identity: "g1", name: "Lucía Ferrer", slotNumber: 1, connectionState: "connected", returnVideo: "program", returnAudioBus: "master", sourceGain: 0.75, sourceMuted: false, sourceDelayMs: 100, tracks: [{ sid: "m1", source: "microphone", muted: false }, { sid: "c1", source: "camera", muted: false }], commands: [{ type: "cue", status: "acknowledged", payload: { cue: "live" } }], icePath: "udp" },
  { identity: "g2", name: "Diego Montes", slotNumber: 2, connectionState: "connected", returnVideo: "preview", returnAudioBus: "aux-1", sourceGain: 0.75, sourceMuted: false, sourceDelayMs: 0, tracks: [{ sid: "m2", source: "microphone", muted: false }, { sid: "c2", source: "camera", muted: true }], commands: [{ type: "cue", status: "acknowledged", payload: { cue: "standby" } }], icePath: "relay" },
  { identity: "g4", name: "Marco Ibáñez", slotNumber: 4, connectionState: "reconnecting", returnVideo: "program", returnAudioBus: "master", sourceGain: 1, sourceMuted: true, sourceDelayMs: 0, tracks: [], commands: [], joinFailure: "ice_failed" },
];

export function CallerDeskFixture() {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <main className="grid gap-3 p-6 md:grid-cols-3" data-visual-fixture="caller-desk">
      {guests.map((guest) => (
        <GuestStrip
          key={guest.identity}
          participant={guest}
          expiresAt="2027-01-12T14:00:00Z"
          canOperate
          busy={false}
          talking={false}
          draft={drafts[guest.identity] ?? ""}
          onDraftChange={(value) => setDrafts((current) => ({ ...current, [guest.identity]: value }))}
          onReturn={() => undefined}
          onCommand={() => undefined}
          onTalkStart={() => undefined}
          onTalkStop={() => undefined}
          onReplace={() => undefined}
          onRemove={() => undefined}
          onRevoke={() => undefined}
        />
      ))}
    </main>
  );
}
