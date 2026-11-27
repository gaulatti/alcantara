import { useEffect, useState } from "react";

// A small level meter for the studio sound the guest hears. It reads the return's level on a short tick; it changes no
// audio, and an unreadable level shows as silence rather than an error.
export function GuestReturnLevel({ read }: { read: () => number }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = read();
      setLevel(Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : 0);
    }, 100);
    return () => window.clearInterval(timer);
  }, [read]);
  const percent = Math.round(level * 100);
  return (
    <div
      role="meter"
      aria-label="Studio sound level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 w-24 overflow-hidden rounded-full bg-white/20"
    >
      <div className="h-full rounded-full bg-emerald-300" style={{ width: `${percent}%` }} />
    </div>
  );
}
