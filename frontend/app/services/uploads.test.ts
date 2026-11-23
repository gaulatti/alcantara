import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("./api", () => ({ authFetch: mocks.authFetch }));
import { uploadFileToMediaBucket } from "./uploads";

beforeEach(() => {
  mocks.authFetch.mockReset();
});

describe("uploadFileToMediaBucket", () => {
  const file = new File(["x"], "a.png", { type: "image/png" });
  it("posts the file as form data to the kind's endpoint and returns the stored object", async () => {
    mocks.authFetch.mockResolvedValue({ ok: true, json: async () => ({ key: "k", url: "u" }) });
    expect(await uploadFileToMediaBucket("artwork", file)).toEqual({ key: "k", url: "u" });
    const [path, init] = mocks.authFetch.mock.calls[0];
    expect(path).toBe("/uploads/artwork");
    expect(init.method).toBe("POST");
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
  });
  it("fails with the server's text, or the status when there is none", async () => {
    mocks.authFetch.mockResolvedValue({ ok: false, status: 413, text: async () => "Too large" });
    await expect(uploadFileToMediaBucket("song", file)).rejects.toThrow("Too large");
    mocks.authFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "" });
    await expect(uploadFileToMediaBucket("song", file)).rejects.toThrow("Upload failed (500)");
  });
});
