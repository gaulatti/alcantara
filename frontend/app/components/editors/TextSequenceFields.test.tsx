import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProgramChyronEditorFields } from "./ProgramChyronEditorFields";
import { ToniChyronEditorFields } from "./ToniChyronEditorFields";
import { RelojDigitalEditorFields } from "./RelojDigitalEditorFields";

// gaulatti/alcantara#186: the scene fields built on the text-sequence
// editors: the Modo Italiano chyron, the Toni chyron and the Reloj digital
// clock. They are driven through their own controls and the sequence
// editors they host.

// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock("@gaulatti/bleecker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gaulatti/bleecker")>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select
        {...rest}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const handlers = () => ({
  updateProp: vi.fn(),
  replaceProps: vi.fn(),
  commitProps: vi.fn(),
});
const textSequence = (text: string) => ({
  mode: "manual",
  activeItemId: "leaf",
  items: [{ id: "leaf", kind: "preset", text }],
});

// --- Modo Italiano chyron -------------------------------------------------

it("hides the chyron editors when the chyron is off, reading the stored show value", () => {
  for (const show of [false, "false", " FALSE "]) {
    const h = handlers();
    render(
      <ProgramChyronEditorFields
        componentType="modoitaliano-chyron"
        props={{ show }}
        {...h}
      />,
    );
    expect(screen.queryByText("Main Chyron")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show Chyron" }));
    expect(h.updateProp).toHaveBeenCalledWith(
      "modoitaliano-chyron",
      "show",
      true,
    );
    cleanup();
  }
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{ show: "yes" }}
      {...handlers()}
    />,
  );
  expect(screen.getByText("Main Chyron")).toBeInTheDocument();
});

it("seeds the sequences from legacy text and replaces it with sequences on edit", () => {
  const h = handlers();
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{ text: "Ultime notizie", useMarquee: true, cta: "Seguici" }}
      {...h}
    />,
  );
  expect(screen.getByDisplayValue("Ultime notizie")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Seguici")).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue("Ultime notizie"), {
    target: { value: "Ultimissime" },
  });
  const next = h.replaceProps.mock.lastCall![1];
  expect(next).toMatchObject({ text: "", useMarquee: false, cta: "" });
  expect(next.textSequence.items[0].sequence.items[0].text).toBe("Ultimissime");
  expect(next.ctaSequence.items[0].text).toBe("Seguici");
  fireEvent.change(screen.getByDisplayValue("Seguici"), {
    target: { value: "Seguici ora" },
  });
  expect(
    h.replaceProps.mock.lastCall![1].ctaSequence.items[0].sequence.items[0]
      .text,
  ).toBe("Seguici ora");
});

it("seeds legacy marquee-only text and keeps sequences that already have text", () => {
  const h = handlers();
  const { unmount } = render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{ text: "", useMarquee: true }}
      {...h}
    />,
  );
  expect(
    screen.getByRole("checkbox", { name: "Force marquee scrolling" }),
  ).toBeChecked();
  unmount();
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{
        text: "Legacy",
        cta: "Legacy CTA",
        textSequence: textSequence("Saved"),
        ctaSequence: textSequence("Saved CTA"),
      }}
      {...h}
    />,
  );
  expect(screen.getByDisplayValue("Saved")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Saved CTA")).toBeInTheDocument();
  expect(screen.queryByDisplayValue("Legacy")).toBeNull();
});

it("seeds legacy text into an existing empty-text sequence whose first item is nested", () => {
  const nested = {
    mode: "manual",
    activeItemId: "block",
    items: [
      {
        id: "block",
        kind: "sequence",
        label: "Block",
        sequence: {
          mode: "manual",
          items: [{ id: "x", kind: "preset", text: "" }],
        },
      },
    ],
  };
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{
        text: "Legacy",
        cta: "Legacy CTA",
        textSequence: nested,
        ctaSequence: nested,
      }}
      {...handlers()}
    />,
  );
  expect(screen.getByDisplayValue("Legacy")).toBeInTheDocument();
  expect(screen.getByDisplayValue("Legacy CTA")).toBeInTheDocument();
});

it("takes a chyron or CTA on air and commits it, also without a commit action", async () => {
  const h = handlers();
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{
        textSequence: textSequence("Main"),
        ctaSequence: textSequence("Call"),
      }}
      {...h}
    />,
  );
  const takes = screen.getAllByRole("button", { name: "Take" });
  await act(async () => {
    fireEvent.click(takes[0]);
  });
  expect(h.commitProps).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(takes[2]);
  });
  expect(h.commitProps).toHaveBeenCalledTimes(2);
  expect(h.commitProps.mock.lastCall![1].ctaSequence.activeItemId).toBe("leaf");
  cleanup();
  const { replaceProps, updateProp } = handlers();
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{
        textSequence: textSequence("Main"),
        ctaSequence: textSequence("Call"),
      }}
      replaceProps={replaceProps}
      updateProp={updateProp}
    />,
  );
  const again = screen.getAllByRole("button", { name: "Take" });
  await act(async () => {
    fireEvent.click(again[0]);
    fireEvent.click(again[2]);
  });
  expect(replaceProps).toHaveBeenCalledTimes(4);
});

it("selects the seeded legacy text when the saved sequence has no selection", () => {
  const blank = {
    mode: "manual",
    activeItemId: null,
    items: [{ id: "empty", kind: "preset", text: "" }],
  };
  const h = handlers();
  render(
    <ProgramChyronEditorFields
      componentType="modoitaliano-chyron"
      props={{
        text: "Legacy",
        cta: "Legacy CTA",
        textSequence: blank,
        ctaSequence: blank,
      }}
      {...h}
    />,
  );
  fireEvent.change(screen.getByDisplayValue("Legacy"), {
    target: { value: "Legacy 2" },
  });
  const next = h.replaceProps.mock.lastCall![1];
  expect(next.textSequence.activeItemId).toBe("empty");
  expect(next.ctaSequence.activeItemId).toBe("empty");
});

// --- Toni chyron ----------------------------------------------------------

it("edits a direct-text Toni chyron and its social handles", () => {
  const h = handlers();
  render(
    <ToniChyronEditorFields
      componentType="toni-chyron"
      props={{ text: "Hola", useMarquee: false }}
      {...h}
    />,
  );
  expect(
    screen.getByDisplayValue("@modoitaliano.oficial, @fifth.bell, @hnmages"),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue("Hola"), {
    target: { value: "Hola a todos" },
  });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "toni-chyron",
    "text",
    "Hola a todos",
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "toni-chyron",
    "useMarquee",
    true,
  );
  fireEvent.change(
    screen.getByPlaceholderText("@modoitaliano.oficial, @fifth.bell, @hnmages"),
    {
      target: { value: " @uno , , @dos " },
    },
  );
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "toni-chyron",
    "socialHandles",
    ["@uno", "@dos"],
  );
  fireEvent.click(screen.getByRole("button", { name: "Sequence" }));
  expect(h.replaceProps.mock.lastCall![1]).toMatchObject({
    contentMode: "sequence",
    sequence: expect.objectContaining({ mode: "manual" }),
  });
  fireEvent.click(screen.getByRole("button", { name: "Direct Text" }));
  expect(h.replaceProps.mock.lastCall![1]).toMatchObject({
    contentMode: "text",
  });
});

it("keeps saved social handles and edits the sequence, its fallback and takes", async () => {
  const h = handlers();
  const sequence = {
    mode: "manual",
    activeItemId: "leaf",
    items: [{ id: "leaf", kind: "preset", text: "Saved" }],
  };
  render(
    <ToniChyronEditorFields
      componentType="toni-chyron"
      props={{
        contentMode: "sequence",
        sequence,
        socialHandles: [" @uno ", 7, ""],
        text: "Fallback",
        useMarquee: true,
      }}
      {...h}
    />,
  );
  expect(screen.getByDisplayValue("@uno")).toBeInTheDocument();
  fireEvent.change(screen.getByDisplayValue("Fallback"), {
    target: { value: "Riserva" },
  });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "toni-chyron",
    "text",
    "Riserva",
  );
  const marquees = screen.getAllByRole("checkbox");
  fireEvent.click(marquees[marquees.length - 1]);
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "toni-chyron",
    "useMarquee",
    false,
  );
  fireEvent.change(screen.getByDisplayValue("Saved"), {
    target: { value: "Edited" },
  });
  expect(h.replaceProps.mock.lastCall![1]).toMatchObject({
    contentMode: "sequence",
  });
  fireEvent.click(screen.getByRole("button", { name: "Sequence" }));
  expect(h.replaceProps.mock.lastCall![1].sequence.items[0].id).toBe("leaf");
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);
  });
  expect(h.commitProps).toHaveBeenCalledWith(
    "toni-chyron",
    expect.objectContaining({ contentMode: "sequence" }),
  );
});

it("shows an empty direct text for a new Toni chyron", () => {
  render(
    <ToniChyronEditorFields
      componentType="toni-chyron"
      props={{}}
      {...handlers()}
    />,
  );
  expect(screen.getByPlaceholderText("Chyron message")).toHaveValue("");
});

it("opens an empty sequence for a Toni chyron in sequence mode without one, and takes without committing", async () => {
  const { updateProp, replaceProps } = handlers();
  render(
    <ToniChyronEditorFields
      componentType="toni-chyron"
      props={{ contentMode: "sequence" }}
      updateProp={updateProp}
      replaceProps={replaceProps}
    />,
  );
  expect(
    screen.getByPlaceholderText("Used only if the sequence is empty"),
  ).toHaveValue("");
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Take" })[0]);
  });
  expect(replaceProps).toHaveBeenCalled();
});

// --- Reloj digital --------------------------------------------------------

const timezones = [
  { value: "America/New_York", label: "New York" },
  { value: "Europe/Rome", label: "Rome" },
];
const scenes = [{ id: 5, name: "Studio" }] as any;

it("edits a Reloj clock: mode and starting timezone", () => {
  const h = handlers();
  render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{}}
      timezoneOptions={timezones}
      {...h}
    />,
  );
  const [mode, zone] = screen.getAllByRole("combobox");
  expect(mode).toHaveValue("clock");
  expect(zone).toHaveValue("America/New_York");
  fireEvent.change(zone, { target: { value: "Europe/Rome" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "timezone",
    "Europe/Rome",
  );
  fireEvent.change(mode, { target: { value: "countdown" } });
  expect(h.updateProp).toHaveBeenLastCalledWith("reloj", "mode", "countdown");
});

it("sets a countdown duration, target scene and transition", () => {
  const h = handlers();
  render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{
        mode: "countdown",
        countdownDuration: 3_725,
        countdownTargetSceneId: 5,
        countdownTransitionId: "velvet-eclipse",
      }}
      timezoneOptions={timezones}
      scenes={scenes}
      {...h}
    />,
  );
  const [hours, minutes, seconds] = screen.getAllByRole("spinbutton");
  expect(
    [hours, minutes, seconds].map((input) => (input as HTMLInputElement).value),
  ).toEqual(["1", "2", "5"]);
  fireEvent.change(hours, { target: { value: "2" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownDuration",
    7_325,
  );
  fireEvent.change(minutes, { target: { value: "" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownDuration",
    3_605,
  );
  fireEvent.change(seconds, { target: { value: "x" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownDuration",
    3_720,
  );
  fireEvent.change(hours, { target: { value: "" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownDuration",
    125,
  );
  fireEvent.change(hours, { target: { value: "-5" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownDuration",
    0,
  );
  const [, target, transition] = screen.getAllByRole("combobox");
  expect(target).toHaveValue("5");
  fireEvent.change(target, { target: { value: "" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownTargetSceneId",
    null,
  );
  fireEvent.change(target, { target: { value: "5" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownTargetSceneId",
    5,
  );
  expect(transition).toHaveValue("velvet-eclipse");
  fireEvent.change(transition, { target: { value: "cut" } });
  expect(h.updateProp).toHaveBeenLastCalledWith(
    "reloj",
    "countdownTransitionId",
    "cut",
  );
});

it("starts and stops a countdown, keeping control when the commit fails", async () => {
  const h = handlers();
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  h.commitProps.mockRejectedValueOnce(new Error("offline"));
  render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{
        mode: "countdown",
        countdownTargetSceneId: 5,
        countdownCommand: 3,
      }}
      timezoneOptions={timezones}
      scenes={scenes}
      {...h}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start Countdown" }));
  });
  expect(h.replaceProps).toHaveBeenLastCalledWith(
    "reloj",
    expect.objectContaining({ countdownCommand: 4 }),
  );
  expect(errors).toHaveBeenCalledWith(
    "[Countdown] toggle error:",
    expect.any(Error),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop Countdown" }));
  });
  expect(h.commitProps).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole("button", { name: "Start Countdown" }),
  ).toBeInTheDocument();
});

it("needs a target scene to start, uses defaults, and counts without a commit action", async () => {
  const { updateProp, replaceProps } = handlers();
  const { unmount } = render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{ mode: "countdown" }}
      timezoneOptions={timezones}
      updateProp={updateProp}
      replaceProps={replaceProps}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Start Countdown" }),
  ).toBeDisabled();
  expect(
    screen
      .getAllByRole("spinbutton")
      .map((input) => (input as HTMLInputElement).value),
  ).toEqual(["0", "5", "0"]);
  expect(screen.getAllByRole("combobox")[2]).toHaveValue("cut");
  unmount();
  render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{ mode: "countdown", countdownTargetSceneId: 5 }}
      timezoneOptions={timezones}
      updateProp={updateProp}
      replaceProps={replaceProps}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Start Countdown" }));
  });
  expect(replaceProps).toHaveBeenLastCalledWith(
    "reloj",
    expect.objectContaining({ countdownCommand: 1 }),
  );
  expect(
    screen.getByRole("button", { name: "Stop Countdown" }),
  ).toBeInTheDocument();
});

it("edits and takes the Reloj lower third and CTA sequences", async () => {
  const h = handlers();
  render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{
        textSequence: textSequence("Title"),
        ctaSequence: textSequence("Up next"),
      }}
      timezoneOptions={timezones}
      {...h}
    />,
  );
  fireEvent.change(screen.getByDisplayValue("Title"), {
    target: { value: "New title" },
  });
  expect(
    h.replaceProps.mock.lastCall![1].textSequence.items[0].sequence.items[0]
      .text,
  ).toBe("New title");
  fireEvent.change(screen.getByDisplayValue("Up next"), {
    target: { value: "Coming up" },
  });
  expect(
    h.replaceProps.mock.lastCall![1].ctaSequence.items[0].sequence.items[0]
      .text,
  ).toBe("Coming up");
  const takes = screen.getAllByRole("button", { name: "Take" });
  await act(async () => {
    fireEvent.click(takes[0]);
    fireEvent.click(takes[2]);
  });
  expect(h.commitProps).toHaveBeenCalledTimes(2);
  cleanup();
  const { updateProp, replaceProps } = handlers();
  render(
    <RelojDigitalEditorFields
      componentType="reloj"
      props={{}}
      timezoneOptions={timezones}
      updateProp={updateProp}
      replaceProps={replaceProps}
    />,
  );
  const blank = screen.getAllByRole("button", { name: "Take" });
  await act(async () => {
    fireEvent.click(blank[0]);
    fireEvent.click(blank[2]);
  });
  // Each take updates the sequence and then takes it: two replacements.
  expect(replaceProps).toHaveBeenCalledTimes(4);
});
