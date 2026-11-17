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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

// gaulatti/alcantara#198: the IANA ids that Node 22.22 (ICU 77.1) and
// Chromium 145 list under another name (Step 0). Whether an id is an alias,
// listed itself, or unknown depends on the runtime's tz database (Node
// 22.23's ICU resolves the POSIX ids to themselves), so the expected outcome
// is derived from the same Intl resolution the picker uses. Whatever it is,
// the saved id shows as one selected option, labelled by its own name when it
// names a city, and saving stores the same id.
const STEP0_ALIASES = [
  "America/Argentina/Buenos_Aires",
  "America/Argentina/Catamarca",
  "America/Argentina/Cordoba",
  "America/Argentina/Jujuy",
  "America/Argentina/Mendoza",
  "America/Indiana/Indianapolis",
  "America/Kentucky/Louisville",
  "America/Nuuk",
  "Asia/Ho_Chi_Minh",
  "Asia/Kathmandu",
  "Asia/Kolkata",
  "Asia/Yangon",
  "Atlantic/Faroe",
  "Europe/Kyiv",
  "Pacific/Kanton",
  "CST6CDT",
  "EST5EDT",
  "MST7MDT",
  "PST8PDT",
];

const cityOf = (id: string) => id.split("/").pop()!.replace(/_/g, " ");
const resolve = (id: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: id }).resolvedOptions().timeZone;

it.each(STEP0_ALIASES)(
  "shows a saved %s as the one selected option for its zone and saves it unchanged",
  (saved) => {
    const zones = Intl.supportedValuesOf("timeZone");
    const resolved = resolve(saved);
    // listed: the runtime lists the saved id itself; alias: only under the
    // name it resolves to; otherwise the saved id is listed first.
    const outcome = zones.includes(saved)
      ? "listed"
      : resolved !== saved && zones.includes(resolved)
        ? "alias"
        : "prepended";

    const updateProp = picker("clock-widget", { timezone: saved });
    const zone = zoneSelect();
    const values = within(zone)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(zone).toHaveValue(saved);
    expect(values.filter((value) => value === saved)).toHaveLength(1);
    expect(values).toHaveLength(
      outcome === "prepended" ? zones.length + 1 : zones.length,
    );
    if (outcome === "alias") expect(values).not.toContain(resolved);
    expect(updateProp).not.toHaveBeenCalled();
    const name =
      outcome === "alias" && !saved.includes("/")
        ? cityOf(resolved)
        : cityOf(saved);
    expect(
      within(zone).getByRole("option", { selected: true }).textContent,
    ).toMatch(new RegExp(`^${name} \\(GMT`));

    // Saving the selection without a change stores the id that was saved.
    fireEvent.change(zone, { target: { value: saved } });
    expect(updateProp).toHaveBeenLastCalledWith(
      "clock-widget",
      "timezone",
      saved,
    );
  },
);

/** Makes Intl resolve each id in `resolutions` to the given name. */
function stubResolution(resolutions: Record<string, string>) {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    const real = new RealDateTimeFormat(locales, options);
    const forced = options?.timeZone && resolutions[options.timeZone];
    if (forced) {
      const resolved = real.resolvedOptions();
      real.resolvedOptions = () => ({ ...resolved, timeZone: forced });
    }
    return real;
  } as unknown as typeof Intl.DateTimeFormat);
}

const POSIX_ZONES: [saved: string, city: string, cityLabel: string][] = [
  ["CST6CDT", "America/Chicago", "Chicago (GMT-6)"],
  ["EST5EDT", "America/New_York", "New York (GMT-5)"],
  ["MST7MDT", "America/Denver", "Denver (GMT-7)"],
  ["PST8PDT", "America/Los_Angeles", "Los Angeles (GMT-8)"],
];

it.each(POSIX_ZONES)(
  "keeps a saved %s whether the runtime resolves it to a city zone or to itself",
  (saved, city, cityLabel) => {
    const date = new Date("2026-01-15T12:00:00Z");
    const cityOption = { value: city, label: cityLabel };
    const rome = { value: "Europe/Rome", label: "Rome (GMT+1)" };

    // Resolved to the city zone (tz 2024b and later in ICU 77): the city's
    // option carries the saved id and keeps the city's label.
    stubResolution({ [saved]: city });
    expect(withTimezoneOption([rome, cityOption], saved, date)).toEqual([
      rome,
      { value: saved, label: cityLabel },
    ]);
    vi.restoreAllMocks();

    // Resolved to itself and listed: the list is used as it is.
    stubResolution({ [saved]: saved });
    const listed = [rome, { value: saved, label: `${saved} (GMT)` }];
    expect(withTimezoneOption(listed, saved, date)).toBe(listed);

    // Resolved to itself and not listed: the saved id is listed first, once,
    // and the city zone keeps its own option.
    const prepended = withTimezoneOption([rome, cityOption], saved, date);
    expect(prepended.map((option) => option.value)).toEqual([
      saved,
      "Europe/Rome",
      city,
    ]);
    expect(prepended[0].label).toMatch(new RegExp(`^${saved} \\(GMT`));
  },
);

// WebKit (Safari 26) lists the old spellings (Asia/Calcutta, Europe/Kiev,
// ...) and resolves both spellings to themselves, so Intl links nothing; the
// tz database's links do. Observed with Playwright's WebKit 26.0.
const WEBKIT_LISTED_AS: [saved: string, listed: string][] = [
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
];

/** Makes the runtime behave like WebKit: `listed` zones, each resolving to itself. */
function stubWebKit(listed: string[]) {
  vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(listed);
  const RealDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    const real = new RealDateTimeFormat(locales, options);
    const own = options?.timeZone;
    if (own) {
      const resolved = real.resolvedOptions();
      real.resolvedOptions = () => ({ ...resolved, timeZone: own });
    }
    return real;
  } as unknown as typeof Intl.DateTimeFormat);
}

it.each(WEBKIT_LISTED_AS)(
  "shows a saved %s once, by its own name, where WebKit lists it as %s",
  (saved, listed) => {
    const zones = [listed, "Europe/Rome", "Asia/Tokyo"];
    stubWebKit(zones);
    const updateProp = picker("clock-widget", { timezone: saved });
    const zone = zoneSelect();
    const values = within(zone)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(zone).toHaveValue(saved);
    expect(values.filter((value) => value === saved)).toHaveLength(1);
    expect(values).not.toContain(listed);
    expect(values).toHaveLength(zones.length);
    expect(
      within(zone).getByRole("option", { selected: true }).textContent,
    ).toMatch(new RegExp(`^${cityOf(saved)} \\(GMT`));
    expect(updateProp).not.toHaveBeenCalled();
    fireEvent.change(zone, { target: { value: saved } });
    expect(updateProp).toHaveBeenLastCalledWith(
      "clock-widget",
      "timezone",
      saved,
    );
  },
);

it("matches through the tz links in either direction and through older link names", () => {
  stubWebKit([]);
  const date = new Date("2026-01-15T12:00:00Z");
  const rome = { value: "Europe/Rome", label: "Rome (GMT+1)" };
  // A saved old spelling, with the new one listed.
  expect(
    withTimezoneOption(
      [rome, { value: "Asia/Kolkata", label: "Kolkata (GMT+5:30)" }],
      "Asia/Calcutta",
      date,
    ).map((option) => [option.value, option.label]),
  ).toEqual([
    ["Europe/Rome", "Rome (GMT+1)"],
    ["Asia/Calcutta", "Calcutta (GMT+5:30)"],
  ]);
  // Two link names of the same zone.
  expect(
    withTimezoneOption(
      [rome, { value: "US/Eastern", label: "Eastern (GMT-5)" }],
      "America/New_York",
      date,
    ).map((option) => option.value),
  ).toEqual(["Europe/Rome", "America/New_York"]);
  // A POSIX id is its own zone in this tz release: listed first, and the
  // city keeps its own option.
  expect(
    withTimezoneOption(
      [rome, { value: "America/Chicago", label: "Chicago (GMT-6)" }],
      "CST6CDT",
      date,
    ).map((option) => option.value),
  ).toEqual(["CST6CDT", "Europe/Rome", "America/Chicago"]);
});

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
