import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComponentPropsFields } from "./ComponentPropsFields";
import { withTimezoneOption } from "../../utils/timezones";

// The timezone pickers list the zones the browser's Intl reports. Chromium and
// Node spell Buenos Aires "America/Buenos_Aires" and Kolkata "Asia/Calcutta",
// so the editors' Buenos Aires default and a zone saved under another name
// matched no option, and the picker showed its "Select…" placeholder. The
// saved or default value must stay selectable, and must not be rewritten.

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

afterEach(cleanup);

function picker(componentType: string, props: Record<string, unknown>) {
  const updateProp = vi.fn();
  render(
    <ComponentPropsFields
      componentType={componentType}
      props={props}
      updateProp={updateProp}
      replaceProps={vi.fn()}
      songCatalog={[]}
      mediaGroups={[]}
      isLoadingMediaGroups={false}
      mediaLabels={[]}
      isLoadingMediaLabels={false}
    />,
  );
  return updateProp;
}

function zoneSelect() {
  return screen
    .getAllByRole("combobox")
    .find(
      (select) =>
        within(select).queryAllByRole("option", { name: /\(GMT/ }).length > 0,
    ) as HTMLSelectElement;
}

it("keeps the Buenos Aires default selected in every picker that defaults to it", () => {
  expect(Intl.supportedValuesOf("timeZone")).not.toContain(
    "America/Argentina/Buenos_Aires",
  );
  for (const type of ["clock-widget", "reloj-clock", "broadcast-layout"]) {
    const updateProp = picker(type, {});
    const zone = zoneSelect();
    expect(zone).toHaveValue("America/Argentina/Buenos_Aires");
    expect(
      within(zone).getByRole("option", {
        name: /^Buenos Aires \(GMT/,
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(updateProp).not.toHaveBeenCalled();
    cleanup();
  }
});

it("keeps a saved zone the browser lists under another name, without rewriting it", () => {
  for (const [type, prop] of [
    ["clock-widget", "timezone"],
    ["reloj-loop-clock", "timezone"],
    ["broadcast-layout", "clockTimezone"],
    ["reloj-digital-loop-clock", "timezone"],
  ]) {
    const updateProp = picker(type, { [prop]: "Asia/Kolkata" });
    const zone = zoneSelect();
    expect(zone).toHaveValue("Asia/Kolkata");
    expect(
      within(zone)
        .getAllByRole("option")
        .filter(
          (option) => (option as HTMLOptionElement).value === "Asia/Kolkata",
        ),
    ).toHaveLength(1);
    expect(updateProp).not.toHaveBeenCalled();
    cleanup();
  }
});

it("does not add a listed zone twice", () => {
  picker("clock-widget", { timezone: "Europe/Rome" });
  const zone = zoneSelect();
  expect(zone).toHaveValue("Europe/Rome");
  const listed = Intl.supportedValuesOf("timeZone").length;
  expect(within(zone).getAllByRole("option")).toHaveLength(listed);
});

it("adds nothing for an empty value", () => {
  const options = [{ value: "Europe/Rome", label: "Rome (GMT+1)" }];
  expect(withTimezoneOption(options, "")).toBe(options);
});

// gaulatti/alcantara#198: every IANA id that the engine lists under another
// name (Step 0, from tzdata against Intl.supportedValuesOf in Node 22 and
// Chromium). Each saved id must show as the one option for its zone, selected,
// and saving must store the same id.
const ALIAS_PAIRS: [saved: string, listed: string][] = [
  ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"],
  ["America/Argentina/Catamarca", "America/Catamarca"],
  ["America/Argentina/Cordoba", "America/Cordoba"],
  ["America/Argentina/Jujuy", "America/Jujuy"],
  ["America/Argentina/Mendoza", "America/Mendoza"],
  ["America/Indiana/Indianapolis", "America/Indianapolis"],
  ["America/Kentucky/Louisville", "America/Louisville"],
  ["America/Nuuk", "America/Godthab"],
  ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
  ["Asia/Kathmandu", "Asia/Katmandu"],
  ["Asia/Kolkata", "Asia/Calcutta"],
  ["Asia/Yangon", "Asia/Rangoon"],
  ["Atlantic/Faroe", "Atlantic/Faeroe"],
  ["Europe/Kyiv", "Europe/Kiev"],
  ["Pacific/Kanton", "Pacific/Enderbury"],
  ["CST6CDT", "America/Chicago"],
  ["EST5EDT", "America/New_York"],
  ["MST7MDT", "America/Denver"],
  ["PST8PDT", "America/Los_Angeles"],
];

it.each(ALIAS_PAIRS)(
  "shows a saved %s as the one selected option for its zone and saves it unchanged",
  (saved, listed) => {
    // The engine under test lists the zone only under its alias.
    const zones = Intl.supportedValuesOf("timeZone");
    expect(zones).toContain(listed);
    expect(zones).not.toContain(saved);
    expect(
      new Intl.DateTimeFormat("en-US", { timeZone: saved }).resolvedOptions()
        .timeZone,
    ).toBe(listed);

    const updateProp = picker("clock-widget", { timezone: saved });
    const zone = zoneSelect();
    const values = within(zone)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(zone).toHaveValue(saved);
    expect(values.filter((value) => value === saved)).toHaveLength(1);
    expect(values).not.toContain(listed);
    expect(values).toHaveLength(zones.length);
    expect(updateProp).not.toHaveBeenCalled();
    const selected = within(zone).getByRole("option", { selected: true });
    expect(selected.textContent).toMatch(
      saved.includes("/")
        ? new RegExp(`^${saved.split("/").pop()!.replace(/_/g, " ")} \\(GMT`)
        : new RegExp(`^${listed.split("/").pop()!.replace(/_/g, " ")} \\(GMT`),
    );

    // Saving the selection without a change stores the id that was saved.
    fireEvent.change(zone, { target: { value: saved } });
    expect(updateProp).toHaveBeenLastCalledWith(
      "clock-widget",
      "timezone",
      saved,
    );
  },
);

it("stores the listed id when another zone is picked", () => {
  const updateProp = picker("clock-widget", { timezone: "Asia/Kolkata" });
  fireEvent.change(zoneSelect(), { target: { value: "Asia/Tokyo" } });
  expect(updateProp).toHaveBeenLastCalledWith(
    "clock-widget",
    "timezone",
    "Asia/Tokyo",
  );
});

it("still lists first a saved zone the engine does not list under any name", () => {
  for (const saved of ["Etc/GMT+3", "Not/A_Zone"]) {
    const options = [{ value: "Europe/Rome", label: "Rome (GMT+1)" }];
    expect(
      withTimezoneOption(options, saved).map((option) => option.value),
    ).toEqual([saved, "Europe/Rome"]);
  }
});
