import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: { isAuthenticated: false, isLoaded: false } }));
vi.mock("../../hooks/useAuth", () => ({ useAuthStatus: () => mocks.status }));
vi.mock("../AppLoading", () => ({ AppLoading: () => <i data-testid="loading" /> }));
vi.mock("react-router", () => ({ Navigate: ({ to, replace }: any) => <i data-testid="nav" data-to={to} data-replace={String(replace)} /> }));
import ProtectedRoute from "./ProtectedRoute";

afterEach(cleanup);
describe("ProtectedRoute", () => {
  it("waits while the session loads", () => {
    mocks.status = { isAuthenticated: false, isLoaded: false };
    render(<ProtectedRoute><span>secret</span></ProtectedRoute>);
    expect(screen.getByTestId("loading")).toBeInTheDocument();
    expect(screen.queryByText("secret")).toBeNull();
  });
  it("sends a signed-out visitor to the login page, replacing history", () => {
    mocks.status = { isAuthenticated: false, isLoaded: true };
    render(<ProtectedRoute><span>secret</span></ProtectedRoute>);
    expect(screen.getByTestId("nav")).toHaveAttribute("data-to", "/login");
    expect(screen.getByTestId("nav")).toHaveAttribute("data-replace", "true");
  });
  it("shows the page to a signed-in user", () => {
    mocks.status = { isAuthenticated: true, isLoaded: true };
    render(<ProtectedRoute><span>secret</span></ProtectedRoute>);
    expect(screen.getByText("secret")).toBeInTheDocument();
  });
});
