import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Layout from "./layout";
import { RadioOutputPlayer } from "../components/RadioOutputPlayer";
import { apiUrl } from "../utils/apiBaseUrl";

// gaulatti/alcantara#187, group G5: the console shell: program selection,
// navigation, the command menu's actions, the header's program buttons and
// the global broadcast time override. Bleecker's sidebar, header select,
// brand lockup and command spotlight have their own tests, so they are
// stand-ins that show what the shell hands them.

const shell = vi.hoisted(() => ({
  program: "missing",
  transition: "crescendo-prism",
  permissions: new Set<string>(["broadcast.view"]),
  testAuth: false,
  logout: vi.fn(),
}));

vi.mock("../utils/globalProgram", async () => {
  const { useSyncExternalStore } = await import("react");
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  return {
    // One shared selection, as the console's preferences are: every reader sees a change.
    useGlobalProgramId: () => {
      const value = useSyncExternalStore(subscribe, () => shell.program);
      return [
        value,
        (next: string) => {
          shell.program = next.trim() || "main";
          listeners.forEach((listener) => listener());
        },
      ] as const;
    },
  };
});
vi.mock("../utils/globalTransition", async () => {
  const { useState } = await import("react");
  return {
    useGlobalTransitionId: () => {
      const [value, setValue] = useState(shell.transition);
      return [value, setValue] as const;
    },
  };
});
vi.mock("../hooks/useAuth", () => ({
  useLogout: () => ({ logout: shell.logout }),
}));
vi.mock("../hooks/useFeatures", () => ({
  useFeatures: () => ({
    hasPermission: (permission: string) => shell.permissions.has(permission),
  }),
}));
vi.mock("../services/session", () => ({ isTestAuth: () => shell.testAuth }));

vi.mock("@gaulatti/bleecker", async (original) => {
  const actual = await original<typeof import("@gaulatti/bleecker")>();
  function Sidebar(p: any) {
    const link = (item: any) =>
      p.renderLink({
        item,
        children: (
          <>
            {item.icon}
            {item.label}
          </>
        ),
        className: "item",
        onClick: p.onItemClick,
      });
    return (
      <nav
        aria-label={
          p.collapsed
            ? "Collapsed sidebar"
            : p.onItemClick
              ? "Mobile sidebar"
              : "Sidebar"
        }
      >
        {p.header}
        {p.items.map((item: any) =>
          item.items ? (
            <section
              key={item.id}
              aria-label={`${item.label}${item.active ? " (active)" : ""}`}
            >
              {item.items.map((child: any) => (
                <span key={child.id}>{link(child)}</span>
              ))}
            </section>
          ) : (
            <span key={item.id}>{link(item)}</span>
          ),
        )}
        {p.footer}
      </nav>
    );
  }
  function CommandSpotlight(p: any) {
    const [error, setError] = useState("");
    if (!p.open) return null;
    return (
      <div role="dialog" aria-label="Command menu">
        <p>{p.placeholder}</p>
        {p.actions.map((action: any) => (
          <button
            key={action.id}
            type="button"
            disabled={action.disabled}
            data-group={action.group}
            title={action.description}
            onClick={async () => {
              setError("");
              try {
                await action.onSelect();
              } catch (caught) {
                setError((caught as Error).message);
              }
            }}
          >
            {action.title}
          </button>
        ))}
        {error ? <p role="alert">{error}</p> : null}
        <button type="button" onClick={() => p.onOpenChange(false)}>
          Close command menu
        </button>
      </div>
    );
  }
  return {
    ...actual,
    Sidebar,
    CommandSpotlight,
    BrandLockup: (p: any) =>
      p.renderLink({
        item: { href: p.href },
        children: p.name,
        className: "brand",
      }),
    HeaderSelect: (p: any) => (
      <select
        aria-label={p.placeholder}
        value={p.value}
        onChange={(event) => p.onChange(event.target.value)}
      >
        <option value="">None</option>
        {p.options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

function Page() {
  const location = useLocation();
  const navigate = useNavigate();
  const context = useOutletContext<{ programType: string | null }>();
  return (
    <div>
      <output aria-label="location">
        {location.pathname + location.search + location.hash}
      </output>
      <output aria-label="program type">{String(context.programType)}</output>
      {location.pathname === "/radio" ? (
        <div id="radio-monitor" tabIndex={-1}>
          Listener monitor
        </div>
      ) : null}
      <button type="button" onClick={() => navigate("/scenes")}>
        Go elsewhere
      </button>
    </div>
  );
}

type Handler = (init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let network: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const programs = [
  { programId: "news", type: "tv" },
  { programId: "radio one", type: "radio" },
  {
    programId: "sim",
    type: "both",
    templateManifest: {
      entrypointUrl: "https://templates.test/sim/index.html",
      control: { runtimeParameters: { programId: "pid", apiBaseUrl: "api" } },
    },
  },
  { programId: "plain" },
];

beforeEach(() => {
  shell.program = "missing";
  shell.transition = "crescendo-prism";
  shell.permissions = new Set(["broadcast.view"]);
  shell.testAuth = false;
  shell.logout.mockReset();
  routes = {
    "GET /program": () => json(programs),
    "GET /scenes": () =>
      json([
        { id: 4, name: "Wide", layout: { name: "Full" } },
        { id: 5, name: "Close", layout: null },
      ]),
    "GET /instants": () =>
      json([
        {
          id: 1,
          name: "Applause",
          audioUrl: "https://media.test/a.mp3",
          volume: 0.8,
          enabled: true,
          position: 0,
        },
        {
          id: 2,
          name: "Off",
          audioUrl: "https://media.test/b.mp3",
          volume: 1,
          enabled: false,
          position: 1,
        },
      ]),
    "GET /program/broadcast-settings": () =>
      json({
        id: 1,
        timeOverrideEnabled: false,
        timeOverrideStartTime: null,
        timeOverrideStartedAt: null,
        updatedAt: "",
      }),
  };
  network = vi.fn(async (url: string, init?: RequestInit) => {
    const path =
      decodeURIComponent(new URL(url).pathname) + new URL(url).search;
    const key = `${init?.method ?? "GET"} ${path}`;
    const handler = routes[key];
    if (!handler) return json({ error: `unexpected ${key}` }, 500);
    return handler(init);
  });
  vi.stubGlobal("fetch", network);
  // The shell owns the listener's audio element, which jsdom cannot play.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function open(path = "/songs") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<Page />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}
const where = () =>
  screen.getByRole("status", { name: "location" }).textContent;
const programSelects = () =>
  screen.getAllByRole("combobox", { name: "Program" }) as HTMLSelectElement[];
const choose = (program: string) =>
  fireEvent.change(programSelects()[0], { target: { value: program } });
const commands = () => screen.getByRole("dialog", { name: "Command menu" });
const command = (title: string) =>
  within(commands()).getByRole("button", { name: title });
async function openCommands() {
  fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
  return commands();
}

it("selects the first known show when the saved one is gone, and opens its television output", async () => {
  const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  open("/media/library");
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  expect(
    screen.getByRole("status", { name: "program type" }),
  ).toHaveTextContent("tv");
  expect(screen.getAllByText("Television").length).toBeGreaterThan(0);
  expect(screen.getByText("Preview and Program switching")).toBeInTheDocument();
  expect(
    within(programSelects()[0])
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["None", "news", "radio one", "sim", "plain"]);
  // A blank choice is ignored.
  fireEvent.change(programSelects()[0], { target: { value: "" } });
  expect(programSelects()[0]).toHaveValue("news");
  choose("sim");
  expect(programSelects()[0]).toHaveValue("sim");
  choose("news");

  fireEvent.click(screen.getByRole("button", { name: "Open Program Output" }));
  expect(windowOpen).toHaveBeenCalledWith(
    "/program/news",
    "_blank",
    "noopener,noreferrer",
  );

  // The full sidebar groups the navigation and marks the current page.
  const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
  expect(
    within(sidebar).getByText("Broadcast control center"),
  ).toBeInTheDocument();
  expect(within(sidebar).getByRole("link", { name: "Media" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    within(sidebar).getByRole("link", { name: "Shows" }),
  ).not.toHaveAttribute("aria-current");
  expect(screen.queryByText("TEST AUTH")).toBeNull();
  fireEvent.click(within(sidebar).getByRole("button", { name: "Logout" }));
  expect(shell.logout).toHaveBeenCalled();
});

it("gives Logout its own room in the sidebar footer, and an icon to every Development item", async () => {
  open("/songs");
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
  // Commands, Access and Logout used to share one row of the 256px sidebar, which clipped Logout.
  const footer = within(sidebar).getByTestId("sidebar-footer-actions");
  const commands = within(footer).getByRole("button", { name: /Commands/ });
  const access = within(footer).getByRole("button", { name: "Access" });
  const logout = within(footer).getByRole("button", { name: "Logout" });
  expect(commands.parentElement).toBe(footer);
  expect(access.parentElement).toBe(logout.parentElement);
  expect(access.parentElement).not.toBe(footer);
  expect(footer).toHaveClass("flex-col");

  for (const label of [
    "Component catalog",
    "Console",
    "Radio workflow",
    "Continuous radio",
    "Rundown desk",
    "Rundown fillers",
    "Media states",
    "Access states",
  ]) {
    const links = within(sidebar).getAllByRole("link", { name: label });
    expect(
      links.some((link) => link.querySelector("svg")),
      label,
    ).toBe(true);
  }
});

it("opens the Access page from the sidebar and from the mobile navigation", async () => {
  open("/songs");
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
  expect(
    within(sidebar).getByRole("button", { name: "Access" }),
  ).not.toHaveAttribute("aria-current");
  fireEvent.click(within(sidebar).getByRole("button", { name: "Access" }));
  expect(where()).toBe("/access");
  expect(
    within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole(
      "button",
      { name: "Access" },
    ),
  ).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  const mobile = screen.getByRole("navigation", { name: "Mobile sidebar" });
  fireEvent.click(within(mobile).getByRole("button", { name: "Access" }));
  expect(where()).toBe("/access");
});

it("reloads the program from the header and reports a refused reload in the console", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let reload: (response: Response) => void = () => {};
  routes["POST /program/news/reload"] = () =>
    new Promise((resolve) => (reload = resolve));
  open();
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  const refresh = screen.getByRole("button", { name: "Refresh Program" });
  fireEvent.click(refresh);
  await waitFor(() => expect(refresh).toBeDisabled());
  expect(refresh.querySelector("svg")).toHaveClass("animate-spin");
  await act(async () => reload(json({})));
  await waitFor(() => expect(refresh).toBeEnabled());
  routes["POST /program/news/reload"] = () => json({}, 503);
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Failed to request program reload from header:",
      expect.any(Error),
    ),
  );
});

it("keeps a show it cannot find, and logs catalogs that fail to load", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  routes["GET /program"] = () => json({}, 500);
  routes["GET /scenes"] = () => json({}, 502);
  routes["GET /instants"] = () => json({}, 503);
  routes["GET /program/broadcast-settings"] = () => json({}, 504);
  shell.program = "solo";
  open("/");
  await waitFor(() => expect(errors).toHaveBeenCalledTimes(4));
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch programs for site header selector:",
    expect.any(Error),
  );
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch scenes for spotlight:",
    expect.any(Error),
  );
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch instants for spotlight:",
    expect.any(Error),
  );
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch broadcast settings for spotlight:",
    expect.any(Error),
  );
  expect(programSelects()[0]).toHaveValue("solo");
  // Unknown show: no output to open, no reload, and no show type for the page.
  expect(
    screen.getByRole("button", { name: "Open Program Output" }),
  ).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Refresh Program" })).toBeNull();
  expect(
    screen.getByRole("status", { name: "program type" }),
  ).toHaveTextContent("null");
  // The live desk keeps a collapsed sidebar with the flat list.
  const collapsed = screen.getByRole("navigation", {
    name: "Collapsed sidebar",
  });
  expect(
    within(collapsed).getByRole("link", { name: "Alcántara live control" }),
  ).toBeInTheDocument();
  expect(
    within(collapsed).getByRole("link", { name: "TV control" }),
  ).toHaveAttribute("aria-current", "page");

  const dialog = await openCommands();
  expect(
    within(dialog).queryByRole("button", { name: /Open Program Output/ }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: /^Stage Scene/ }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: /^Play Instant/ }),
  ).toBeNull();
});

it("ignores catalogs that are not lists", async () => {
  routes["GET /program"] = () => json({ programs: [] });
  routes["GET /scenes"] = () => json({ scenes: [] });
  routes["GET /instants"] = () => json({ instants: [] });
  open();
  await waitFor(() => expect(network).toHaveBeenCalledTimes(4));
  const dialog = await openCommands();
  expect(
    within(dialog).getByRole("button", { name: "Select Program: missing" }),
  ).toHaveAttribute("title", "Currently selected");
  expect(
    within(dialog).queryByRole("button", { name: /^Stage Scene/ }),
  ).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: /^Play Instant/ }),
  ).toBeNull();
});

it("runs the television command menu: navigation, output, songs, instants, scenes and transitions", async () => {
  const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  routes["POST /program/news/song/off-air"] = () => json({});
  routes["POST /instants/stop-all?programId=news"] = () => json({});
  routes["POST /program/news/scenes"] = () => json({});
  routes["POST /program/news/stage"] = () => json({});
  routes["POST /instants/1/play?programId=news"] = () => json({});
  open();
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  await openCommands();
  expect(
    within(commands()).getByText(
      "Search pages, programs, scenes, transitions, and broadcast...",
    ),
  ).toBeInTheDocument();
  expect(
    within(commands()).queryByRole("button", {
      name: "Go to Radio Distribution",
    }),
  ).toBeNull();

  const navigation: [string, string][] = [
    ["Go to Control", "/"],
    ["Go to Rundown", "/flight"],
    ["Go to Audio Clips", "/instants"],
    ["Go to Songs", "/songs"],
    ["Go to Media", "/media"],
    ["Go to Guest Calls", "/calls"],
    ["Go to Broadcasts", "/broadcasts"],
    ["Go to Shows", "/programs"],
    ["Go to Scenes", "/scenes"],
    ["Go to Scene Templates", "/layouts"],
    ["Go to Control Transition Settings", "/"],
  ];
  for (const [title, path] of navigation) {
    fireEvent.click(command(title));
    await waitFor(() => expect(where()).toBe(path));
  }
  expect(command("Go to Control Transition Settings")).toHaveAttribute(
    "title",
    "Current transition: Crescendo Prism",
  );

  fireEvent.click(command("Open Preview"));
  expect(windowOpen).toHaveBeenCalledWith(
    "/preview",
    "_blank",
    "noopener,noreferrer",
  );
  fireEvent.click(command("Open Program Output (news)"));
  expect(windowOpen).toHaveBeenLastCalledWith(
    "/program/news",
    "_blank",
    "noopener,noreferrer",
  );

  fireEvent.click(command("Take Song Off Air (news)"));
  await waitFor(() =>
    expect(network).toHaveBeenCalledWith(apiUrl("/program/news/song/off-air"), {
      method: "POST",
    }),
  );
  routes["POST /program/news/song/off-air"] = () => json({}, 409);
  fireEvent.click(command("Take Song Off Air (news)"));
  expect(await within(commands()).findByRole("alert")).toHaveTextContent(
    "Failed to take song off air (409)",
  );

  fireEvent.click(command("Stop All Instants"));
  await waitFor(() =>
    expect(within(commands()).queryByRole("alert")).toBeNull(),
  );
  routes["POST /instants/stop-all?programId=news"] = () => json({}, 500);
  fireEvent.click(command("Stop All Instants"));
  expect(await within(commands()).findByRole("alert")).toHaveTextContent(
    "Failed to stop all instants (500)",
  );

  // Scenes: assigned to the show, then staged.
  expect(command("Stage Scene: Wide")).toHaveAttribute(
    "title",
    "Full · news · verify in Preview before TAKE",
  );
  expect(command("Stage Scene: Close")).toHaveAttribute(
    "title",
    "No layout · news · verify in Preview before TAKE",
  );
  fireEvent.click(command("Stage Scene: Wide"));
  await waitFor(() =>
    expect(network).toHaveBeenCalledWith(
      apiUrl("/program/news/stage"),
      expect.objectContaining({ body: JSON.stringify({ sceneId: 4 }) }),
    ),
  );
  routes["POST /program/news/stage"] = () => json({}, 409);
  fireEvent.click(command("Stage Scene: Close"));
  expect(await within(commands()).findByRole("alert")).toHaveTextContent(
    "Failed to stage scene (409)",
  );
  routes["POST /program/news/scenes"] = () => json({}, 403);
  fireEvent.click(command("Stage Scene: Close"));
  expect(await within(commands()).findByRole("alert")).toHaveTextContent(
    "Failed to assign scene (403)",
  );

  // Instants: only enabled ones.
  expect(
    within(commands()).queryByRole("button", { name: "Play Instant: Off" }),
  ).toBeNull();
  expect(command("Play Instant: Applause")).toHaveAttribute(
    "title",
    "volume 0.8",
  );
  fireEvent.click(command("Play Instant: Applause"));
  await waitFor(() =>
    expect(within(commands()).queryByRole("alert")).toBeNull(),
  );
  routes["POST /instants/1/play?programId=news"] = () => json({}, 500);
  fireEvent.click(command("Play Instant: Applause"));
  expect(await within(commands()).findByRole("alert")).toHaveTextContent(
    "Failed to play instant (500)",
  );

  // Transitions.
  expect(command("Set Transition: Crescendo Prism")).toHaveAttribute(
    "title",
    "Currently selected",
  );
  const other = within(commands())
    .getAllByRole("button", { name: /^Set Transition:/ })
    .find((button) => button.getAttribute("title") !== "Currently selected")!;
  const name = other.textContent!.replace("Set Transition: ", "");
  fireEvent.click(other);
  await waitFor(() =>
    expect(command(`Set Transition: ${name}`)).toHaveAttribute(
      "title",
      "Currently selected",
    ),
  );
  expect(command("Go to Control Transition Settings")).toHaveAttribute(
    "title",
    `Current transition: ${name}`,
  );

  // Programs.
  expect(command("Select Program: news")).toHaveAttribute(
    "title",
    "Currently selected",
  );
  expect(command("Select Program: sim")).toHaveAttribute(
    "title",
    "Switch global program context",
  );
  fireEvent.click(command("Select Program: sim"));
  await waitFor(() => expect(programSelects()[0]).toHaveValue("sim"));
  fireEvent.click(screen.getByRole("button", { name: "Close command menu" }));
  expect(screen.queryByRole("dialog", { name: "Command menu" })).toBeNull();
});

it("hides broadcasts from an operator without broadcast.view", async () => {
  shell.permissions = new Set();
  open();
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  await openCommands();
  expect(
    within(commands()).queryByRole("button", { name: "Go to Broadcasts" }),
  ).toBeNull();
});

it("switches the shell to a radio show: listener monitor, radio-only commands", async () => {
  shell.program = "radio one";
  open("/radio");
  await waitFor(() => expect(network).toHaveBeenCalledTimes(4));
  expect(screen.getAllByText("Radio").length).toBeGreaterThan(0);
  expect(screen.getByText("Continuous audio playout")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh Program" })).toBeNull();
  const monitor = screen.getByText("Listener monitor");
  monitor.scrollIntoView = vi.fn();
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Radio Program" }),
  );
  expect(monitor.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(monitor).toHaveFocus();

  await openCommands();
  for (const hidden of [
    "Go to Media",
    "Go to Guest Calls",
    "Go to Broadcasts",
    "Go to Scenes",
    "Go to Scene Templates",
    "Open Preview",
    "Go to Control Transition Settings",
  ]) {
    expect(
      within(commands()).queryByRole("button", { name: hidden }),
    ).toBeNull();
  }
  expect(
    within(commands()).queryByRole("button", { name: /^Stage Scene/ }),
  ).toBeNull();
  expect(
    within(commands()).queryByRole("button", { name: /^Set Transition/ }),
  ).toBeNull();
  fireEvent.click(command("Go to Radio Distribution"));
  await waitFor(() => expect(where()).toBe("/radio-settings"));
  // Away from the desk, the monitor is reached by navigating to it.
  fireEvent.click(command("Listen to Radio Program (radio one)"));
  await waitFor(() => expect(where()).toBe("/#radio-monitor"));
  expect(command("Listen to Radio Program (radio one)")).toHaveAttribute(
    "title",
    "Focus the listener monitor in the Radio desk",
  );
});

it("opens a simulcast show's template output and labels it", async () => {
  const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);
  shell.program = "sim";
  open();
  await waitFor(() => expect(network).toHaveBeenCalledTimes(4));
  expect(screen.getAllByText("Simulcast").length).toBeGreaterThan(0);
  expect(screen.getByText("Television and radio legs")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open Program Output" }));
  const opened = new URL(windowOpen.mock.lastCall![0] as string);
  expect(opened.origin + opened.pathname).toBe(
    "https://templates.test/sim/index.html",
  );
  expect(opened.searchParams.get("pid")).toBe("sim");
  await openCommands();
  expect(command("Go to Radio Distribution")).toBeInTheDocument();
  expect(command("Go to Media")).toBeInTheDocument();
  // A show with no type reads as television.
  fireEvent.click(command("Select Program: plain"));
  await waitFor(() =>
    expect(
      screen.getByText("Preview and Program switching"),
    ).toBeInTheDocument(),
  );
});

it("sets, validates and disables the global broadcast time override", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  let settings = {
    id: 1,
    timeOverrideEnabled: false,
    timeOverrideStartTime: null as string | null,
    timeOverrideStartedAt: null as string | null,
    updatedAt: "",
  };
  routes["GET /program/broadcast-settings"] = () => json(settings);
  routes["PUT /program/broadcast-settings"] = (init) => {
    const body = JSON.parse(String(init!.body));
    settings = {
      ...settings,
      timeOverrideEnabled: body.enabled,
      timeOverrideStartTime: body.startTime,
      timeOverrideStartedAt: body.enabled ? "2026-11-17T19:55:00.000Z" : null,
    };
    return json(
      body.startTime === "19:56"
        ? { ...settings, timeOverrideStartTime: null }
        : settings,
    );
  };
  open();
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  await openCommands();
  expect(command("Set Global Broadcast Time Override")).toHaveAttribute(
    "title",
    "Disabled (clocks use live timezone time)",
  );
  expect(command("Disable Global Broadcast Time Override")).toBeDisabled();
  expect(command("Disable Global Broadcast Time Override")).toHaveAttribute(
    "title",
    "Already disabled",
  );

  fireEvent.click(command("Set Global Broadcast Time Override"));
  const modal = await screen.findByRole("dialog", {
    name: "Global Broadcast Time Override",
  });
  expect(modal).toHaveTextContent("Disabled (clocks use live timezone time).");
  expect(within(modal).getByRole("button", { name: "Disable" })).toBeDisabled();
  const input = within(modal).getByPlaceholderText("19:55");
  fireEvent.change(input, { target: { value: "25:00" } });
  fireEvent.click(within(modal).getByRole("button", { name: "Apply" }));
  expect(
    await within(modal).findByText("Use HH:mm format (24h), e.g. 19:55"),
  ).toBeInTheDocument();
  fireEvent.change(input, { target: { value: " 19:55 " } });
  expect(
    within(modal).queryByText("Use HH:mm format (24h), e.g. 19:55"),
  ).toBeNull();
  fireEvent.change(input, { target: { value: "19:55" } });
  fireEvent.click(within(modal).getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Global Broadcast Time Override" }),
    ).toBeNull(),
  );
  expect(command("Set Global Broadcast Time Override")).toHaveAttribute(
    "title",
    "Active from 19:55",
  );
  expect(command("Disable Global Broadcast Time Override")).toHaveAttribute(
    "title",
    "Return clocks to live timezone time",
  );

  // Disable from the command menu.
  fireEvent.click(command("Disable Global Broadcast Time Override"));
  await waitFor(() =>
    expect(command("Disable Global Broadcast Time Override")).toBeDisabled(),
  );

  // An answer without a start time keeps the one entered; a refused save or
  // disable is shown in the dialog.
  fireEvent.click(command("Set Global Broadcast Time Override"));
  let dialog = await screen.findByRole("dialog", {
    name: "Global Broadcast Time Override",
  });
  fireEvent.change(within(dialog).getByPlaceholderText("19:55"), {
    target: { value: "19:56" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Global Broadcast Time Override" }),
    ).toBeNull(),
  );
  expect(command("Set Global Broadcast Time Override")).toHaveAttribute(
    "title",
    "Active from --:--",
  );
  fireEvent.click(command("Set Global Broadcast Time Override"));
  dialog = await screen.findByRole("dialog", {
    name: "Global Broadcast Time Override",
  });
  expect(dialog).toHaveTextContent("Active from 19:56");
  expect(within(dialog).getByPlaceholderText("19:55")).toHaveValue("19:56");
  routes["PUT /program/broadcast-settings"] = () => json({}, 500);
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
  expect(
    await within(dialog).findByText(
      "Failed to apply time override. Please try again.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
  expect(
    await within(dialog).findByText(
      "Failed to disable time override. Please try again.",
    ),
  ).toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith(
    "Failed to save broadcast time override from spotlight:",
    expect.any(Error),
  );
  expect(errors).toHaveBeenCalledWith(
    "Failed to clear broadcast time override from spotlight:",
    expect.any(Error),
  );

  // The dialog's Disable button, and Escape while nothing is saving.
  routes["PUT /program/broadcast-settings"] = (init) => {
    settings = {
      ...settings,
      timeOverrideEnabled: false,
      timeOverrideStartTime: null,
      timeOverrideStartedAt: null,
    };
    return json(settings);
  };
  fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Global Broadcast Time Override" }),
    ).toBeNull(),
  );
  fireEvent.click(command("Set Global Broadcast Time Override"));
  dialog = await screen.findByRole("dialog", {
    name: "Global Broadcast Time Override",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Global Broadcast Time Override" }),
    ).toBeNull(),
  );
});

it("does not close the time override dialog while it is saving, and shows a running override's start", async () => {
  let save: (response: Response) => void = () => {};
  routes["GET /program/broadcast-settings"] = () =>
    json({
      id: 1,
      timeOverrideEnabled: true,
      timeOverrideStartTime: "07:00",
      timeOverrideStartedAt: null,
      updatedAt: "",
    });
  routes["PUT /program/broadcast-settings"] = () =>
    new Promise((resolve) => (save = resolve));
  open();
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  await openCommands();
  fireEvent.click(command("Set Global Broadcast Time Override"));
  const dialog = await screen.findByRole("dialog", {
    name: "Global Broadcast Time Override",
  });
  expect(dialog).toHaveTextContent(/Active from 07:00 \(started .+\)/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
  expect(
    await within(dialog).findByRole("button", { name: "Saving..." }),
  ).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    screen.getByRole("dialog", { name: "Global Broadcast Time Override" }),
  ).toBeInTheDocument();
  await act(async () =>
    save(
      json({
        id: 1,
        timeOverrideEnabled: true,
        timeOverrideStartTime: "07:00",
        timeOverrideStartedAt: null,
        updatedAt: "",
      }),
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Global Broadcast Time Override" }),
    ).toBeNull(),
  );
});

it("opens and closes the phone navigation, which closes on navigation", async () => {
  shell.testAuth = true;
  open("/console-fixture");
  await waitFor(() => expect(programSelects()[0]).toHaveValue("news"));
  expect(screen.getAllByText("TEST AUTH").length).toBeGreaterThan(1);
  expect(
    screen.getByRole("navigation", { name: "Collapsed sidebar" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  let mobile = screen.getByRole("dialog", { name: "Application navigation" });
  const phoneSidebar = within(mobile).getByRole("navigation", {
    name: "Mobile sidebar",
  });
  expect(
    within(phoneSidebar).getAllByText("Television").length,
  ).toBeGreaterThan(0);
  fireEvent.click(
    within(phoneSidebar).getByRole("button", { name: /Commands/ }),
  );
  expect(commands()).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close command menu" }));
  fireEvent.click(within(phoneSidebar).getByRole("link", { name: "Shows" }));
  await waitFor(() => expect(where()).toBe("/programs"));
  expect(
    screen.queryByRole("dialog", { name: "Application navigation" }),
  ).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  mobile = screen.getByRole("dialog", { name: "Application navigation" });
  fireEvent.click(
    within(mobile).getAllByRole("button", { name: "Close navigation" })[0],
  );
  expect(
    screen.queryByRole("dialog", { name: "Application navigation" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  fireEvent.click(
    screen.getAllByRole("button", { name: "Close navigation" }).at(-1)!,
  );
  expect(
    screen.queryByRole("dialog", { name: "Application navigation" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  fireEvent.click(screen.getByRole("button", { name: "Go elsewhere" }));
  await waitFor(() => expect(where()).toBe("/scenes"));
  expect(
    screen.queryByRole("dialog", { name: "Application navigation" }),
  ).toBeNull();

  // The full sidebar's own Commands button.
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole(
      "button",
      { name: /Commands/ },
    ),
  );
  expect(commands()).toBeInTheDocument();
});

// gaulatti/alcantara#287: the listener audio lives in the shell, so it survives page changes.
function openWithPlayer() {
  function Player() {
    const navigate = useNavigate();
    return (
      <div>
        <RadioOutputPlayer programId="radio one" />
        <button type="button" onClick={() => navigate("/scenes")}>
          Go to songs page
        </button>
      </div>
    );
  }
  return render(
    <MemoryRouter initialEntries={["/player"]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/player" element={<Player />} />
          <Route path="*" element={<Page />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}
async function startListening() {
  shell.program = "radio one";
  let grant = 0;
  routes["POST /radio/radio one/monitor-ticket"] = () =>
    json({
      streamPath: `/radio/radio%20one/monitor-audio?ticket=g${++grant}`,
      expiresInMs: 600000,
    });
  openWithPlayer();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Listen" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Listen" }));
  await waitFor(() =>
    expect(screen.getByText("Listening · radio one")).toBeInTheDocument(),
  );
  return document.querySelector("audio")!;
}
const grantRequests = () =>
  network.mock.calls.filter((call) => String(call[0]).includes("monitor-ticket"));

it("keeps listening while the operator moves to another console page, with a chip to stop it", async () => {
  const audio = await startListening();
  const source = audio.getAttribute("src");
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Go to songs page" }));
  await waitFor(() => expect(where()).toBe("/scenes"));
  expect(document.querySelectorAll("audio")).toHaveLength(1);
  expect(document.querySelector("audio")).toBe(audio);
  expect(audio.getAttribute("src")).toBe(source);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  expect(screen.getByText("Listening · radio one")).toBeInTheDocument();
  expect(grantRequests()).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
  expect(audio).not.toHaveAttribute("src");
  expect(screen.queryByText("Listening · radio one")).toBeNull();
});

it("stops the stream when the program is changed from the header", async () => {
  const audio = await startListening();
  choose("news");
  await waitFor(() => expect(audio).not.toHaveAttribute("src"));
  expect(screen.queryByText("Listening · radio one")).toBeNull();
});

it("stops the stream at Logout, before signing out", async () => {
  const audio = await startListening();
  shell.logout.mockImplementation(() => {
    expect(audio).not.toHaveAttribute("src");
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Logout" })[0]);
  expect(shell.logout).toHaveBeenCalledTimes(1);
  expect(audio).not.toHaveAttribute("src");
  expect(screen.queryByText("Listening · radio one")).toBeNull();
});

it("shows no listening chip, and asks for no grant, on a page without a player", async () => {
  shell.program = "radio one";
  open("/songs");
  await waitFor(() => expect(network).toHaveBeenCalledTimes(4));
  expect(screen.queryByText(/Listening ·/)).toBeNull();
  expect(grantRequests()).toHaveLength(0);
});
