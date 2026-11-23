import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./ClockWidget", () => ({ ClockWidget: ({ timezone }: any) => <i data-testid="clock" data-tz={String(timezone)} /> }));
vi.mock("./LogoWidget", () => ({ LogoWidget: () => <i data-testid="logo" /> }));

import { CronicaLayout } from "./CronicaLayout";
import { CronicaReiteramos } from "./CronicaReiteramos";
import { Scoreboard } from "./Scoreboard";

afterEach(cleanup);

describe("Scoreboard", () => {
  it("shows the defaults", () => {
    const { container } = render(<Scoreboard />);
    expect(container.querySelector(".scoreboard-title")!.textContent).toBe("MATCH");
    expect([...container.querySelectorAll(".scoreboard-team-label")].map((n) => n.textContent)).toEqual(["HOME", "AWAY"]);
    expect([...container.querySelectorAll(".scoreboard-team-score")].map((n) => n.textContent)).toEqual(["0", "0"]);
    expect(container.querySelector(".scoreboard-period")!.textContent).toBe("1ST");
    expect(container.querySelector(".scoreboard-clock")!.textContent).toBe("00:00");
    expect(container.querySelector(".scoreboard-status")!.textContent).toBe("LIVE");
  });
  it("shows the given match and can hide period and clock", () => {
    const { container } = render(<Scoreboard title="Final" homeTeam="Lions" awayTeam="Bears" homeScore={3} awayScore="2" period="2ND" clock="45:10" status="HT" showPeriod={false} showClock={false} />);
    expect([...container.querySelectorAll(".scoreboard-team-score")].map((n) => n.textContent)).toEqual(["3", "2"]);
    expect(container.querySelector(".scoreboard-period")).toBeNull();
    expect(container.querySelector(".scoreboard-clock")).toBeNull();
    expect(container.querySelector(".scoreboard-status")!.textContent).toBe("HT");
  });
});

describe("Cronica overlays", () => {
  it("shows the chyron lines, the reiteramos strip, the logo and the clock", () => {
    const { container } = render(<CronicaLayout headline={"UNO\nDOS"} reiteramosText="AGAIN" timezone="UTC" />);
    expect([...container.querySelectorAll(".cronica-chyron-line")].map((n) => n.textContent)).toEqual(["UNO", "DOS"]);
    expect(screen.getByText("AGAIN")).toBeInTheDocument();
    expect(screen.getByTestId("logo")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveAttribute("data-tz", "UTC");
  });
  it("uses the default headline and can hide the strip", () => {
    const { container } = render(<CronicaLayout showReiteramos={false} />);
    expect(container.querySelectorAll(".cronica-chyron-line")).toHaveLength(3);
    expect(container.querySelector(".cronica-reiteramos")).toBeNull();
  });
  it("renders the reiteramos strip alone, or nothing when hidden", () => {
    const { container, rerender } = render(<CronicaReiteramos />);
    expect(screen.getByText("REITERAMOS")).toBeInTheDocument();
    rerender(<CronicaReiteramos text="OTRA VEZ" />);
    expect(screen.getByText("OTRA VEZ")).toBeInTheDocument();
    rerender(<CronicaReiteramos show={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
