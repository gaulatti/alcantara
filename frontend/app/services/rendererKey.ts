import { apiUrl } from "../utils/apiBaseUrl";

/** A program's renderer key as the backend may show it (gaulatti/alcantara#884): never the key itself. */
export interface RendererKeyMetadata {
  programId: string;
  exists: boolean;
  version: number | null;
  createdAt: string | null;
  rotatedAt: string | null;
  lastUsedAt: string | null;
}

async function request<T>(programId: string, path: string, method?: "POST") {
  const url = apiUrl(
    `/program/${encodeURIComponent(programId)}/renderer-key${path}`,
  );
  const response = await (method ? fetch(url, { method }) : fetch(url));
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "You do not have permission for this show's renderer key."
        : `Renderer key request failed (${response.status})`,
    );
  return (await response.json()) as T;
}

export const fetchRendererKey = (programId: string) =>
  request<RendererKeyMetadata>(programId, "");

/** Issues or replaces the key. The answer is the only time the clear key exists. */
export const rotateRendererKey = (programId: string) =>
  request<RendererKeyMetadata & { key: string }>(programId, "/rotate", "POST");
