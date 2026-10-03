import { useEffect, useState, type ReactNode } from "react";

/** Operator surfaces share Bleecker typography and broadcast-specific tokens. */
export function ConsolePanel({
  title,
  eyebrow,
  actions,
  children,
  className = "",
}: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`console-panel ${className}`} aria-label={title}>
      <header className="console-panel-heading">
        <div>
          {eyebrow && <span className="console-eyebrow">{eyebrow}</span>}
          <h2>{title}</h2>
        </div>
        {actions && <div className="console-panel-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function ConsoleClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="console-clock" aria-label="Local wall clock">
      <span className="console-eyebrow">Local time</span>
      <time>
        {now?.toLocaleTimeString(undefined, { hour12: false }) ?? "—"}
      </time>
    </div>
  );
}
