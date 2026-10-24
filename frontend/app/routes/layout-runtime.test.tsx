import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  mount,
  command,
  writes,
  session,
  programs,
  requests,
  failures,
  clock,
  setSelectedProgram,
  setPermissions,
  setClock,
} from "../../test/layoutRuntimeFixture";
it("renders the selected television shell and passes its type to the nested page", async () => {
  await mount();
  expect(screen.getByTestId("location")).toHaveTextContent("/songs");
  expect(screen.getAllByText("Television").length).toBeGreaterThan(0);
  expect(screen.getByRole("link", { name: "TV control" })).toHaveAttribute(
    "href",
    "/",
  );
  expect(screen.getByRole("link", { name: "TV destinations" })).toHaveAttribute(
    "href",
    "/broadcasts",
  );
  expect(screen.getByRole("button", { name: "Refresh Program" })).toBeEnabled();
});
it("keeps protected destination navigation hidden without its capability", async () => {
  setPermissions([]);
  await mount();
  expect(
    screen.queryByRole("link", { name: "TV destinations" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
  expect(screen.queryByText("Go to Broadcasts")).not.toBeInTheDocument();
});
it("opens the selected output using a separate isolated browser tab", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Open Program Output" }));
  expect(window.open).toHaveBeenCalledWith(
    "/program/main",
    "_blank",
    "noopener,noreferrer",
  );
});
it("requests a refresh for the selected television output", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Refresh Program" }));
  await waitFor(() => expect(writes("/program/main/reload")).toHaveLength(1));
});
it("re-enables refresh after a failed reload and preserves the nested page", async () => {
  await mount();
  failures["POST /program/main/reload"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Refresh Program" }));
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Failed to request program reload from header:",
      expect.any(Error),
    ),
  );
  expect(screen.getByRole("button", { name: "Refresh Program" })).toBeEnabled();
  expect(screen.getByTestId("location")).toHaveTextContent("/songs");
});
it("selects radio context through the real command menu and changes available tools", async () => {
  await mount();
  await command("Select Program: radio");
  await waitFor(() =>
    expect(screen.getByTestId("program-type")).toHaveTextContent("radio"),
  );
  expect(screen.getByRole("link", { name: "Radio desk" })).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Radio distribution" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Refresh Program" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: "Guest calls" }),
  ).not.toBeInTheDocument();
});
it.each([
  ["Go to Control", "/"],
  ["Go to Rundown", "/flight"],
  ["Go to Audio Clips", "/instants"],
  ["Go to Media", "/media"],
  ["Go to Guest Calls", "/calls"],
  ["Go to Broadcasts", "/broadcasts"],
  ["Go to Shows", "/programs"],
  ["Go to Scenes", "/scenes"],
  ["Go to Scene Templates", "/layouts"],
])("navigates %s through the actual router command", async (label, path) => {
  await mount();
  await command(label);
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent(path),
  );
});
it("opens the component preview from a command", async () => {
  await mount();
  await command("Open Preview");
  expect(window.open).toHaveBeenCalledWith(
    "/preview",
    "_blank",
    "noopener,noreferrer",
  );
});
it("assigns then stages a scene without taking it on air", async () => {
  await mount();
  await command("Stage Scene: Opening camera");
  await waitFor(() => expect(writes("/program/main/stage")).toHaveLength(1));
  expect(writes("/program/main/scenes")[0].body).toEqual({ sceneId: 4 });
  expect(writes("/program/main/stage")[0].body).toEqual({ sceneId: 4 });
  expect(
    requests.findIndex((request) => request.path === "/program/main/scenes"),
  ).toBeLessThan(
    requests.findIndex((request) => request.path === "/program/main/stage"),
  );
  expect(requests.some((request) => request.path.endsWith("/activate"))).toBe(
    false,
  );
});
it("stops scene staging if assignment is rejected", async () => {
  await mount();
  failures["POST /program/main/scenes"] = 403;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await command("Stage Scene: Opening camera");
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Command spotlight action failed:",
      expect.any(Error),
    ),
  );
  expect(writes("/program/main/stage")).toHaveLength(0);
});
it("plays an enabled instant and omits disabled clips from commands", async () => {
  await mount();
  await command("Play Instant: News sting");
  await waitFor(() =>
    expect(writes("/instants/8/play?programId=main")).toHaveLength(1),
  );
  fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
  expect(
    screen.queryByText("Play Instant: Disabled sting"),
  ).not.toBeInTheDocument();
});
it.each([
  ["Stop All Instants", "/instants/stop-all?programId=main"],
  ["Take Song Off Air (main)", "/program/main/song/off-air"],
])("runs %s for the selected show", async (label, path) => {
  await mount();
  await command(label);
  await waitFor(() => expect(writes(path)).toHaveLength(1));
});
it("logs out through the actual authentication dispatcher and router", async () => {
  const { store } = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Logout" }));
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("/login"),
  );
  expect(session.clear).toHaveBeenCalledOnce();
  expect(store.getState().auth.currentUser).toBeUndefined();
});
it("opens mobile navigation and closes it after navigation", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  const menu = screen.getByRole("dialog", { name: "Application navigation" });
  fireEvent.click(within(menu).getByRole("button", { name: "Live" }));
  fireEvent.click(within(menu).getByRole("link", { name: "Guest calls" }));
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("/calls"),
  );
  expect(
    screen.queryByRole("dialog", { name: "Application navigation" }),
  ).not.toBeInTheDocument();
});
it("exposes local test authentication distinctly in the shell", async () => {
  session.testAuth = true;
  await mount("/");
  expect(screen.getAllByText("TEST AUTH").length).toBeGreaterThan(0);
  expect(
    screen.getAllByTitle("Local test authentication is active").length,
  ).toBeGreaterThan(0);
});
it("uses the accepted template entrypoint and runtime parameter names for output", async () => {
  programs[0].templateManifest = {
    entrypointUrl: "https://output.example/player?theme=night",
    control: { runtimeParameters: { programId: "show", apiBaseUrl: "api" } },
  };
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Open Program Output" }));
  expect(window.open).toHaveBeenCalledWith(
    "https://output.example/player?theme=night&show=main&api=https%3A%2F%2Fshell.example",
    "_blank",
    "noopener,noreferrer",
  );
});
it("renders radio tools and routes the listener to its monitor", async () => {
  setSelectedProgram("radio");
  await mount();
  expect(screen.getByRole("link", { name: "Radio desk" })).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Radio Program" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("/#radio-monitor"),
  );
  expect(window.open).not.toHaveBeenCalled();
});
it("renders both legs for a simulcast and retains television controls", async () => {
  setSelectedProgram("simulcast");
  await mount();
  expect(screen.getAllByText("Simulcast").length).toBeGreaterThan(0);
  expect(
    screen.getByRole("link", { name: "Simulcast control" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Radio distribution" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Refresh Program" }),
  ).toBeInTheDocument();
});
it("does not offer television-only commands in a radio context", async () => {
  setSelectedProgram("radio");
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
  expect(screen.queryByText("Go to Guest Calls")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Stage Scene: Opening camera"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Go to Radio Distribution")).toBeInTheDocument();
});
it("retains a failed logout diagnostic while clearing auth state and navigating", async () => {
  const { store } = await mount();
  session.clear.mockRejectedValueOnce(new Error("Fixture session outage"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Logout" }));
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("/login"),
  );
  expect(store.getState().auth.currentUser).toBeUndefined();
  expect(errors).toHaveBeenCalledWith("Error signing out: ", expect.any(Error));
});
it("rejects malformed broadcast time locally without issuing a write", async () => {
  await mount();
  await command("Set Global Broadcast Time Override");
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Start Time (HH:mm)" }),
    { target: { value: "24:61" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(
    screen.getByText("Use HH:mm format (24h), e.g. 19:55"),
  ).toBeInTheDocument();
  expect(writes("/program/broadcast-settings")).toHaveLength(0);
});
it("applies a valid global broadcast time from the real modal", async () => {
  await mount();
  await command("Set Global Broadcast Time Override");
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Start Time (HH:mm)" }),
    { target: { value: "19:55" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(writes("/program/broadcast-settings")).toHaveLength(1),
  );
  expect(writes("/program/broadcast-settings")[0].body).toEqual({
    enabled: true,
    startTime: "19:55",
  });
  expect(clock.timeOverrideEnabled).toBe(true);
});
it("disables an accepted override from the modal", async () => {
  setClock({
    timeOverrideEnabled: true,
    timeOverrideStartTime: "18:00",
    timeOverrideStartedAt: "2026-10-24T12:00:00Z",
  });
  await mount();
  await command("Set Global Broadcast Time Override");
  fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
  await waitFor(() =>
    expect(writes("/program/broadcast-settings")).toHaveLength(1),
  );
  expect(writes("/program/broadcast-settings")[0].body).toEqual({
    enabled: false,
    startTime: null,
  });
  expect(clock.timeOverrideEnabled).toBe(false);
});
it("keeps rejected clock changes visible as errors without claiming success", async () => {
  await mount();
  await command("Set Global Broadcast Time Override");
  failures["PUT /program/broadcast-settings"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Start Time (HH:mm)" }),
    { target: { value: "19:55" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await screen.findByText("Failed to apply time override. Please try again.");
  expect(clock.timeOverrideEnabled).toBe(false);
  expect(errors).toHaveBeenCalledWith(
    "Failed to save broadcast time override from spotlight:",
    expect.any(Error),
  );
});
it("keeps output unavailable when the program catalogue cannot be verified", async () => {
  failures["GET /program"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await mount("/songs", "unresolved");
  expect(
    screen.getByRole("button", { name: "Open Program Output" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Refresh Program" }),
  ).not.toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch programs for site header selector:",
    expect.any(Error),
  );
});
it("retains usable navigation when scene and instant catalogues fail", async () => {
  failures["GET /scenes"] = 503;
  failures["GET /instants"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Open command menu" }));
  expect(
    screen.queryByText("Stage Scene: Opening camera"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Play Instant: News sting"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Go to Rundown")).toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch scenes for spotlight:",
    expect.any(Error),
  );
  expect(errors).toHaveBeenCalledWith(
    "Failed to fetch instants for spotlight:",
    expect.any(Error),
  );
});
it.each([
  [
    "Stage Scene: Opening camera",
    "/program/main/stage",
    "Failed to stage scene (503)",
  ],
  [
    "Play Instant: News sting",
    "/instants/8/play",
    "Failed to play instant (503)",
  ],
  [
    "Stop All Instants",
    "/instants/stop-all",
    "Failed to stop all instants (503)",
  ],
  [
    "Take Song Off Air (main)",
    "/program/main/song/off-air",
    "Failed to take song off air (503)",
  ],
])("preserves a rejected %s diagnostic", async (label, path, message) => {
  await mount();
  failures[`POST ${path}`] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  await command(label);
  await waitFor(() =>
    expect(errors).toHaveBeenCalledWith(
      "Command spotlight action failed:",
      expect.objectContaining({ message }),
    ),
  );
  expect(screen.getByTestId("location")).toHaveTextContent("/songs");
});
it("disables the global clock override directly from the command menu", async () => {
  setClock({
    timeOverrideEnabled: true,
    timeOverrideStartTime: "18:00",
    timeOverrideStartedAt: "2026-10-24T12:00:00Z",
  });
  await mount();
  await command("Disable Global Broadcast Time Override");
  await waitFor(() =>
    expect(writes("/program/broadcast-settings")).toHaveLength(1),
  );
  expect(writes("/program/broadcast-settings")[0].body).toEqual({
    enabled: false,
    startTime: null,
  });
});
it("retains a failed clock-disable error in the open modal", async () => {
  setClock({
    timeOverrideEnabled: true,
    timeOverrideStartTime: "18:00",
    timeOverrideStartedAt: "2026-10-24T12:00:00Z",
  });
  await mount();
  await command("Set Global Broadcast Time Override");
  failures["PUT /program/broadcast-settings"] = 503;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
  await screen.findByText("Failed to disable time override. Please try again.");
  expect(clock.timeOverrideEnabled).toBe(true);
  expect(errors).toHaveBeenCalledWith(
    "Failed to clear broadcast time override from spotlight:",
    expect.any(Error),
  );
});
it("closes navigation from its backdrop without navigating", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
  fireEvent.click(
    within(
      screen.getByRole("dialog", { name: "Application navigation" }),
    ).getByRole("button", { name: "Close navigation" }),
  );
  expect(
    screen.queryByRole("dialog", { name: "Application navigation" }),
  ).not.toBeInTheDocument();
  expect(screen.getByTestId("location")).toHaveTextContent("/songs");
});
it("persists a selected transition in the accepted program context", async () => {
  await mount();
  await command("Set Transition: Velvet Eclipse");
  await waitFor(() =>
    expect(writes("/operator-preferences/desktop")).toHaveLength(1),
  );
  expect(
    writes("/operator-preferences/desktop")[0].body.profile.transitions.main,
  ).toBe("velvet-eclipse");
  expect(requests.some((request) => request.path.endsWith("/activate"))).toBe(
    false,
  );
});
it("focuses the existing radio monitor instead of opening another page", async () => {
  setSelectedProgram("radio");
  await mount();
  const monitor = document.createElement("div");
  monitor.id = "radio-monitor";
  monitor.tabIndex = -1;
  screen.getByRole("main").append(monitor);
  fireEvent.click(
    screen.getByRole("button", { name: "Listen to Radio Program" }),
  );
  expect(monitor.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  expect(document.activeElement).toBe(monitor);
  expect(screen.getByTestId("location")).toHaveTextContent("/songs");
  expect(window.open).not.toHaveBeenCalled();
});
