import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: { authenticated: true, loaded: true },
  dispatch: vi.fn(),
  navigate: vi.fn(),
  clearAppSession: vi.fn(),
  logout: vi.fn(() => ({ type: "logout" })),
}));
vi.mock("react-redux", () => ({
  useDispatch: () => mocks.dispatch,
  useSelector: (selector: string) => (selector === "auth" ? mocks.state.authenticated : mocks.state.loaded),
}));
vi.mock("react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../state/dispatchers/auth", () => ({ logout: mocks.logout }));
vi.mock("../state/selectors/auth", () => ({ isAuthenticated: "auth", isLoaded: "loaded" }));
vi.mock("../services/session", () => ({ clearAppSession: mocks.clearAppSession }));

import { useAuthStatus, useLogout } from "./useAuth";

beforeEach(() => {
  mocks.state = { authenticated: true, loaded: true };
  mocks.dispatch.mockReset();
  mocks.navigate.mockReset();
  mocks.clearAppSession.mockReset();
});

describe("auth hooks", () => {
  it("reports the authentication status", () => {
    const { result } = renderHook(() => useAuthStatus());
    expect(result.current).toEqual({ isAuthenticated: true, isLoaded: true });
  });
  it("signs out, clears the store and returns to the login page", async () => {
    mocks.clearAppSession.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLogout());
    await act(async () => result.current.logout());
    expect(mocks.dispatch).toHaveBeenCalledWith({ type: "logout" });
    expect(mocks.navigate).toHaveBeenCalledWith("/login");
  });
  it("still leaves when the sign-out call fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.clearAppSession.mockRejectedValue(new Error("x"));
    const { result } = renderHook(() => useLogout());
    await act(async () => result.current.logout());
    expect(error).toHaveBeenCalledWith("Error signing out: ", expect.any(Error));
    expect(mocks.dispatch).toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith("/login");
  });
  it("does nothing unless the session is authenticated and loaded", () => {
    for (const state of [{ authenticated: false, loaded: true }, { authenticated: true, loaded: false }]) {
      mocks.state = state;
      const { result } = renderHook(() => useLogout());
      result.current.logout();
    }
    expect(mocks.clearAppSession).not.toHaveBeenCalled();
  });
});
