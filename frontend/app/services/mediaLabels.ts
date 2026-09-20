import { authFetch } from "./api";

const LABEL_PAGE_SIZE = 200;

export async function fetchAllMediaLabels<
  T extends { id: string; name: string },
>(): Promise<T[]> {
  const labels = new Map<string, T>();
  let page = 1;
  let totalPages: number;

  do {
    const response = await authFetch(
      `/media-labels?page=${page}&limit=${LABEL_PAGE_SIZE}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to load labels: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: T[];
      meta?: { totalPages?: number };
    };
    if (
      !Array.isArray(payload.data) ||
      !Number.isInteger(payload.meta?.totalPages) ||
      (payload.meta?.totalPages ?? -1) < 0
    ) {
      throw new Error("Invalid media labels response");
    }
    totalPages = payload.meta!.totalPages!;
    for (const label of payload.data) labels.set(label.id, label);
    page += 1;
  } while (page <= totalPages);

  return [...labels.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
