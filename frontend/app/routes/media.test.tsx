import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProgramType } from "../utils/appNavigation";
import { getMediaLibraryView } from "../utils/mediaLibrary";
import MediaRoute from "./media";

const { authFetch } = vi.hoisted(() => ({
  authFetch: vi.fn(),
}));

vi.mock("../services/api", () => ({ authFetch }));
vi.mock("../services/uploads", () => ({
  uploadFileToMediaBucket: vi.fn(),
}));

const createdLabel = {
  id: "label:editorial",
  name: "Editorial",
  description: null,
  assetCount: 0,
  assets: [],
  createdAt: "2026-09-15T00:00:00.000Z",
  updatedAt: "2026-09-15T00:00:00.000Z",
};

function TestLayout({ programType }: { programType: ProgramType }) {
  const location = useLocation();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <Outlet context={{ programType }} />
    </>
  );
}

function renderMedia(programType: ProgramType, initialEntry = "/media") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<TestLayout programType={programType} />}>
          <Route path="media" element={<MediaRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("program-aware media library", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
    };
    authFetch.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/media-labels" && init?.method === "POST") {
          return Response.json(createdLabel);
        }
        if (path.startsWith("/media-labels")) {
          return Response.json({ data: [] });
        }
        if (path.startsWith("/media-assets")) {
          return Response.json({
            data: [],
            meta: { total: 0, totalPages: 1 },
          });
        }
        return Response.json({});
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("limits radio to Audio and Labels and canonicalizes visual URLs", async () => {
    renderMedia("radio", "/media?type=IMAGE");

    expect(await screen.findByRole("tab", { name: "Audio" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Labels" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Images" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Video" })).toBeNull();
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/media?type=AUDIO",
    );

    await waitFor(() => {
      const assetRequests = authFetch.mock.calls.map(([path]) => String(path));
      expect(
        assetRequests.some((path) => path.includes("mediaType=AUDIO")),
      ).toBe(true);
      expect(
        assetRequests.some((path) => path.includes("mediaType=IMAGE")),
      ).toBe(false);
    });
  });

  it("creates and selects a label without leaving image upload", async () => {
    renderMedia("tv");

    fireEvent.click(await screen.findByRole("button", { name: "Add images" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New label name" }), {
      target: { value: "  Editorial  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create and select" }),
    );

    expect(
      await screen.findByRole("checkbox", { name: "Editorial" }),
    ).toBeChecked();
    expect(authFetch).toHaveBeenCalledWith("/media-labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Editorial", description: null }),
    });
    expect(screen.getByRole("dialog", { name: "Add images" })).toBeVisible();
  });
});

describe("media library view rules", () => {
  it("retains every physical media type for simulcast", () => {
    const view = getMediaLibraryView(
      "both",
      new URLSearchParams("type=VIDEO"),
    );

    expect(view.mediaType).toBe("VIDEO");
    expect(view.visibleSections).toEqual([
      "images",
      "audio",
      "video",
      "labels",
    ]);
    expect(view.canonicalHref).toBeNull();
  });
});
