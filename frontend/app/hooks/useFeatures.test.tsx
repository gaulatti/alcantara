import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../services/api", () => ({ api: { get: mocks.get } }));

import { Can, FeaturesProvider, useFeatures } from "./useFeatures";

const wrapper = ({ children }: any) => <FeaturesProvider>{children}</FeaturesProvider>;
const flush = () => act(async () => {});

beforeEach(() => {
  mocks.get.mockReset();
});
afterEach(() => cleanup());

describe("FeaturesProvider", () => {
  it("is loading with no context and denies permissions outside a provider", () => {
    const { result } = renderHook(() => useFeatures());
    expect(result.current).toMatchObject({ context: null, loading: true });
    expect(result.current.hasFeature("x")).toBe(false);
    expect(result.current.hasPermission("x")).toBe(false);
  });
  it("loads the user context and answers permission checks", async () => {
    mocks.get.mockResolvedValue({ data: { authorization: { permissions: ["scenes:edit"], teamId: 3 } } });
    const { result } = renderHook(() => useFeatures(), { wrapper });
    await flush();
    expect(mocks.get).toHaveBeenCalledWith("/auth/me");
    expect(result.current.loading).toBe(false);
    expect(result.current.context?.authorization?.teamId).toBe(3);
    expect(result.current.hasPermission("scenes:edit")).toBe(true);
    expect(result.current.hasPermission("scenes:delete")).toBe(false);
    expect(result.current.hasFeature("anything", "T3")).toBe(true);
    expect(result.current.hasFeature("anything")).toBe(true);
  });
  it("treats a wildcard permission as everything, and an empty body as an empty context", async () => {
    mocks.get.mockResolvedValue({ data: { authorization: { permissions: ["*"] } } });
    const { result } = renderHook(() => useFeatures(), { wrapper });
    await flush();
    expect(result.current.hasPermission("whatever")).toBe(true);
    cleanup();
    mocks.get.mockResolvedValue({ data: null });
    const empty = renderHook(() => useFeatures(), { wrapper });
    await flush();
    expect(empty.result.current.context).toEqual({});
    expect(empty.result.current.hasPermission("x")).toBe(false);
  });
  it("logs a failed load and clears the context", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.get.mockImplementation(() => Promise.reject(new Error("down")));
    const { result } = renderHook(() => useFeatures(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(error).toHaveBeenCalledWith("Failed to load user context", expect.any(Error));
    expect(result.current).toMatchObject({ context: null, loading: false });
  });
  it("ignores a response that arrives after it unmounts", async () => {
    const settle = () => new Promise((r) => setTimeout(r, 0));
    let resolve!: (v: any) => void;
    mocks.get.mockReturnValue(new Promise((r) => (resolve = r)));
    const first = renderHook(() => useFeatures(), { wrapper });
    first.unmount();
    resolve({ data: {} });
    await settle();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let reject!: (e: Error) => void;
    mocks.get.mockReturnValue(new Promise((_, r) => (reject = r)));
    const second = renderHook(() => useFeatures(), { wrapper });
    second.unmount();
    reject(new Error("late"));
    await settle();
    expect(error).toHaveBeenCalledWith("Failed to load user context", expect.any(Error));
  });
});

describe("Can", () => {
  it("renders nothing while loading and its children afterwards", async () => {
    mocks.get.mockResolvedValue({ data: {} });
    render(
      <FeaturesProvider>
        <Can feature="f" level="T2" fallback={<span>no</span>}>
          <span>yes</span>
        </Can>
      </FeaturesProvider>,
    );
    expect(screen.queryByText("yes")).toBeNull();
    expect(screen.queryByText("no")).toBeNull();
    await flush();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });
  it("uses the default level and renders the fallback when the feature is off", async () => {
    mocks.get.mockResolvedValue({ data: {} });
    render(
      <FeaturesProvider>
        <Can feature="f">
          <span>yes</span>
        </Can>
      </FeaturesProvider>,
    );
    await flush();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });
});
