import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ install: vi.fn(), isRouteErrorResponse: vi.fn() }));
vi.mock("react-router", () => ({
  isRouteErrorResponse: (e: any) => mocks.isRouteErrorResponse(e),
  Links: () => <i data-testid="links" />,
  Meta: () => <i data-testid="meta" />,
  Outlet: () => <i data-testid="outlet" />,
  Scripts: () => <i data-testid="scripts" />,
  ScrollRestoration: () => <i data-testid="scroll" />,
}));
vi.mock("react-redux", () => ({ Provider: ({ children, store }: any) => <div data-store={String(store.id)}>{children}</div> }));
vi.mock("aws-amplify/auth/enable-oauth-listener", () => ({}));
vi.mock("./app.css", () => ({}));
vi.mock("./services/auth", () => ({}));
vi.mock("./services/authenticatedFetch", () => ({ installAuthenticatedFetch: mocks.install }));
vi.mock("./components/common/AuthListener", () => ({ default: () => <i data-testid="auth" /> }));
vi.mock("./components/AppLoading", () => ({ AppLoading: () => <i data-testid="loading" /> }));
vi.mock("./state", () => ({ getStore: () => ({ store: { id: 7 } }) }));

import App, { ErrorBoundary, HydrateFallback, Layout, links } from "./root";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  mocks.isRouteErrorResponse.mockReset();
});

describe("root route", () => {
  it("installs authenticated fetch when the module loads", () => {
    expect(mocks.install).toHaveBeenCalledTimes(1);
  });
  it("links the icon and the fonts", () => {
    const list = (links as any)();
    expect(list.map((l: any) => l.rel)).toEqual(["icon", "preconnect", "preconnect", "stylesheet"]);
    expect(list[2].crossOrigin).toBe("anonymous");
    expect(list[3].href).toContain("fonts.googleapis.com/css2");
  });
  it("wraps the app in the document shell", () => {
    const html = renderToStaticMarkup(<Layout><span>child</span></Layout>);
    expect(html).toContain('<html lang="en" class="dark h-full">');
    expect(html).toContain('<meta charSet="utf-8"/>');
    for (const id of ["meta", "links", "scroll", "scripts"]) expect(html).toContain(`data-testid="${id}"`);
    expect(html).toContain("<span>child</span>");
    expect(html).toContain("bg-dark-sand");
  });
  it("provides the store, listens for auth, and renders the matched route", () => {
    const { container } = render(<App />);
    expect(container.querySelector("[data-store='7']")).not.toBeNull();
    expect(screen.getByTestId("auth")).toBeInTheDocument();
    expect(screen.getByTestId("outlet")).toBeInTheDocument();
  });
  it("shows the loading screen while hydrating", () => {
    render(<HydrateFallback />);
    expect(screen.getByTestId("loading")).toBeInTheDocument();
  });
});

describe("ErrorBoundary", () => {
  it("explains a missing page", () => {
    mocks.isRouteErrorResponse.mockReturnValue(true);
    render(<ErrorBoundary error={{ status: 404, statusText: "Not Found" } as any} params={{} as any} />);
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("The requested page could not be found.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Control" })).toHaveAttribute("href", "/");
  });
  it("shows the status text of other route errors, or a generic line without one", () => {
    mocks.isRouteErrorResponse.mockReturnValue(true);
    render(<ErrorBoundary error={{ status: 500, statusText: "Boom" } as any} params={{} as any} />);
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Boom")).toBeInTheDocument();
    cleanup();
    render(<ErrorBoundary error={{ status: 500, statusText: "" } as any} params={{} as any} />);
    expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
  });
  it("shows the message and stack of an unexpected error in development only", () => {
    mocks.isRouteErrorResponse.mockReturnValue(false);
    const error = new Error("kaput");
    const { container } = render(<ErrorBoundary error={error} params={{} as any} />);
    expect(screen.getByText("kaput")).toBeInTheDocument();
    expect(container.querySelector("pre code")!.textContent).toContain("kaput");
    cleanup();
    render(<ErrorBoundary error={"weird" as any} params={{} as any} />);
    expect(screen.getByText("Oops!")).toBeInTheDocument();
    expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
    cleanup();
    vi.stubEnv("DEV", false);
    const prod = render(<ErrorBoundary error={error} params={{} as any} />);
    expect(prod.container.querySelector("pre")).toBeNull();
    expect(screen.getByText("An unexpected error occurred.")).toBeInTheDocument();
  });
});
