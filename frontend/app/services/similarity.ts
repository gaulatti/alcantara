import { apiUrl } from "../utils/apiBaseUrl";

export type SimilarityMode = "off" | "shadow" | "on";
export type SimilarityPool = "sequence" | "catalog";

export interface SimilaritySettings {
  similarityMode: SimilarityMode;
  similarityThreshold: number;
  similarityWindowSeconds: number;
  similarityPool: SimilarityPool;
}

export interface SimilarityCoverage {
  model: { name: string; version: string; license: string };
  windowSeconds: number;
  enabledSongs: number;
  embeddedSongs: number;
  missingSongs: number;
}

export interface SimilarityDecisionSong {
  songId: number;
  artist: string;
  title: string;
}

export interface SimilarityDecision {
  id: number;
  mode: "shadow" | "on";
  outcome: "selected" | "fallback-no-embedding" | "fallback-no-candidate";
  createdAt: string;
  score: number | null;
  current: SimilarityDecisionSong | null;
  proposed: SimilarityDecisionSong | null;
  played: SimilarityDecisionSong | null;
}

export interface EmbeddingUploadResult {
  songId: number | null;
  status: "stored" | "rejected";
  reason?: string;
}

export const UPLOAD_BATCH_SIZE = 10;

async function readError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "message" in body ? body.message : null;
  return new Error(
    typeof detail === "string"
      ? detail
      : Array.isArray(detail)
        ? detail.join("; ")
        : `${fallback} (${response.status})`,
  );
}

const base = (programId: string) =>
  `/radio/${encodeURIComponent(programId)}`;

export async function fetchSimilaritySettings(
  programId: string,
): Promise<SimilaritySettings | null> {
  const response = await fetch(apiUrl(`${base(programId)}/settings`));
  if (!response.ok) throw await readError(response, "Settings unavailable");
  const body = await response.json();
  if (!body) return null;
  return {
    similarityMode: body.similarityMode ?? "off",
    similarityThreshold: body.similarityThreshold ?? 0.8,
    similarityWindowSeconds: body.similarityWindowSeconds ?? 30,
    similarityPool: body.similarityPool ?? "sequence",
  };
}

export async function saveSimilaritySettings(
  programId: string,
  settings: SimilaritySettings,
): Promise<void> {
  const response = await fetch(apiUrl(`${base(programId)}/settings`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw await readError(response, "Save failed");
}

export async function fetchSimilarityCoverage(
  programId: string,
): Promise<SimilarityCoverage> {
  const response = await fetch(
    apiUrl(`${base(programId)}/similarity/coverage`),
  );
  if (!response.ok) throw await readError(response, "Coverage unavailable");
  return response.json();
}

export async function fetchSimilarityDecisions(
  programId: string,
): Promise<SimilarityDecision[]> {
  const response = await fetch(
    apiUrl(`${base(programId)}/similarity/decisions?limit=50`),
  );
  if (!response.ok) throw await readError(response, "Decisions unavailable");
  return response.json();
}

export async function exportSimilaritySongs(
  programId: string,
  scope: "sequence" | "catalog",
  missingOnly: boolean,
): Promise<string> {
  const response = await fetch(
    apiUrl(
      `${base(programId)}/similarity/export?scope=${scope}&missingOnly=${missingOnly}`,
    ),
  );
  if (!response.ok) throw await readError(response, "Export failed");
  return JSON.stringify(await response.json(), null, 2);
}

/** Uploads an analyze.py result in small batches to stay within request limits. */
export async function uploadSimilarityEmbeddings(
  programId: string,
  fileText: string,
  onProgress?: (done: number, total: number) => void,
): Promise<EmbeddingUploadResult[]> {
  let parsed: {
    schema?: number;
    model?: unknown;
    windowSeconds?: number;
    songs?: unknown[];
  };
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error("The file is not valid JSON.");
  }
  if (!Array.isArray(parsed.songs))
    throw new Error("The file has no songs array.");
  const results: EmbeddingUploadResult[] = [];
  for (let i = 0; i < parsed.songs.length; i += UPLOAD_BATCH_SIZE) {
    const response = await fetch(
      apiUrl(`${base(programId)}/similarity/embeddings`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema: parsed.schema,
          model: parsed.model,
          windowSeconds: parsed.windowSeconds,
          songs: parsed.songs.slice(i, i + UPLOAD_BATCH_SIZE),
        }),
      },
    );
    if (!response.ok) throw await readError(response, "Upload failed");
    const body = (await response.json()) as {
      results: EmbeddingUploadResult[];
    };
    results.push(...body.results);
    onProgress?.(Math.min(i + UPLOAD_BATCH_SIZE, parsed.songs.length), parsed.songs.length);
  }
  return results;
}
