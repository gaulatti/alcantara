import {
  Button,
  Card,
  Checkbox,
  Empty,
  FileInput,
  IconButton,
  Input,
  LoadingSpinner,
  Modal,
  Pagination,
  Select,
  Textarea,
  showAlert,
} from "@gaulatti/bleecker";
import {
  ArrowDown,
  ArrowUp,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useNavigate,
  useOutletContext,
  useSearchParams,
} from "react-router";
import { AppPage } from "../components/AppPage";
import { InlineLabelCreator } from "../components/media/InlineLabelCreator";
import {
  MediaLibraryPage,
} from "../components/media/MediaLibraryPage";
import { uploadFileToMediaBucket } from "../services/uploads";
import { authFetch } from "../services/api";
import { fetchAllMediaLabels } from "../services/mediaLabels";
import type { ProgramType } from "../utils/appNavigation";
import {
  getMediaLibraryView,
  type MediaType,
} from "../utils/mediaLibrary";
import type { Route } from "./+types/media";

type MediaCapability =
  | "INSTANT"
  | "BACKGROUND"
  | "SONG"
  | "COVER"
  | "TRANSITION";

interface AssetLabel {
  id: string;
  name: string;
  description: string | null;
  position: number;
}

interface MediaAsset {
  id: string;
  mediaType: MediaType;
  name: string;
  sourceUrl: string;
  enabled: boolean;
  capabilities: MediaCapability[];
  labels: AssetLabel[];
  image: { id: number } | null;
  instant: { id: number; volume: number } | null;
  background: { defaultVolume: number } | null;
  song: {
    id: number;
    artist: string;
    title: string;
    coverUrl: string | null;
    durationMs: number | null;
  } | null;
  coverForSongIds: number[];
  transition: { id: number; cutPointMs: number } | null;
  updatedAt: string;
}

interface LabelAsset {
  position: number;
  asset: MediaAsset;
}

interface MediaLabel {
  id: string;
  name: string;
  description: string | null;
  assetCount: number;
  assets: LabelAsset[];
  createdAt: string;
  updatedAt: string;
}

interface ImageRecord {
  id: number;
  assetId: string;
  name: string;
  imageUrl: string;
}

function stripFileExtension(filename: string): string {
  const trimmed = filename.trim();
  const dotIndex = trimmed.lastIndexOf(".");
  return dotIndex > 0 ? trimmed.slice(0, dotIndex).trim() : trimmed;
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    if (typeof parsed.message === "string") return parsed.message;
    if (Array.isArray(parsed.message)) return parsed.message.join(", ");
  } catch {
    // The server did not return JSON.
  }
  return text;
}

async function requestJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await authFetch(path, init);
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json() as Promise<T>;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Media - Alcantara" },
    {
      name: "description",
      content: "Manage images, audio, video, capabilities, and labels.",
    },
  ];
}

const capabilityLabels: Record<MediaCapability, string> = {
  INSTANT: "Instant",
  BACKGROUND: "Background",
  SONG: "Song",
  COVER: "Song cover",
  TRANSITION: "Transition",
};

function CapabilityBadges({
  capabilities,
}: {
  capabilities: MediaCapability[];
}) {
  if (capabilities.length === 0)
    return <span className="text-xs text-text-secondary">No capability</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {capabilities.map((item) => (
        <span
          key={item}
          className="rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-xs font-medium text-sea"
        >
          {capabilityLabels[item]}
        </span>
      ))}
    </div>
  );
}

function LabelBadges({ labels }: { labels: AssetLabel[] }) {
  if (labels.length === 0)
    return <span className="text-xs text-text-secondary">Unlabeled</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span
          key={label.id}
          className="rounded-full border border-sand/40 bg-dark-sand/70 px-2 py-0.5 text-xs text-text-primary"
        >
          {label.name}
        </span>
      ))}
    </div>
  );
}

export default function MediaRoute() {
  const navigate = useNavigate();
  const { programType } = useOutletContext<{
    programType: ProgramType | null;
  }>();
  const [searchParams] = useSearchParams();
  const {
    activeSection,
    canonicalHref,
    isLabelsView,
    mediaType,
    visibleSections,
  } = getMediaLibraryView(programType ?? "tv", searchParams);

  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [labels, setLabels] = useState<MediaLabel[]>([]);
  const labelsRequestVersion = useRef(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [capability, setCapability] = useState<MediaCapability | "">("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(
    () => new Set(),
  );

  const [showImageModal, setShowImageModal] = useState(false);
  const [editingAsset, setEditingAsset] = useState<MediaAsset | null>(null);
  const [imageName, setImageName] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imageLabelIds, setImageLabelIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isSavingImage, setIsSavingImage] = useState(false);

  const [showBackgroundModal, setShowBackgroundModal] = useState(false);
  const [backgroundName, setBackgroundName] = useState("");
  const [backgroundUrl, setBackgroundUrl] = useState("");
  const [backgroundFile, setBackgroundFile] = useState<File | null>(null);
  const [backgroundVolume, setBackgroundVolume] = useState("1");
  const [backgroundLabelIds, setBackgroundLabelIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isSavingBackground, setIsSavingBackground] = useState(false);

  const [showLabelModal, setShowLabelModal] = useState(false);
  const [editingLabel, setEditingLabel] = useState<MediaLabel | null>(null);
  const [labelName, setLabelName] = useState("");
  const [labelDescription, setLabelDescription] = useState("");
  const [isSavingLabel, setIsSavingLabel] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState<MediaLabel | null>(null);
  const [assetToAdd, setAssetToAdd] = useState("");
  const [bulkLabelId, setBulkLabelId] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (canonicalHref) navigate(canonicalHref, { replace: true });
  }, [canonicalHref, navigate]);

  useEffect(() => {
    setPage(1);
    setSelectedAssetIds(new Set());
    if (mediaType !== "AUDIO") setCapability("");
  }, [debouncedSearch, mediaType, isLabelsView]);

  const fetchLabels = useCallback(async () => {
    const version = ++labelsRequestVersion.current;
    const loaded = await fetchAllMediaLabels<MediaLabel>();
    if (version === labelsRequestVersion.current) setLabels(loaded);
  }, []);

  const fetchAssets = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      limit: isLabelsView ? "200" : "50",
    });
    if (!isLabelsView) params.set("mediaType", mediaType);
    if (!isLabelsView && debouncedSearch) params.set("search", debouncedSearch);
    if (!isLabelsView && capability) params.set("capability", capability);
    const payload = await requestJson<{
      data: MediaAsset[];
      meta?: { total?: number; totalPages?: number };
    }>(`/media-assets?${params}`);
    setAssets(Array.isArray(payload.data) ? payload.data : []);
    setTotalCount(payload.meta?.total ?? 0);
    setTotalPages(payload.meta?.totalPages ?? 1);
  }, [capability, debouncedSearch, isLabelsView, mediaType, page]);

  const refresh = useCallback(async () => {
    if (programType === null) return;
    setIsLoading(true);
    try {
      await Promise.all([fetchAssets(), fetchLabels()]);
    } catch (error) {
      console.error("Failed to load media library:", error);
      showAlert("Failed to load the media library.", "error");
    } finally {
      setIsLoading(false);
    }
  }, [fetchAssets, fetchLabels, programType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedLabel) return;
    setSelectedLabel(
      labels.find((label) => label.id === selectedLabel.id) ?? null,
    );
  }, [labels, selectedLabel?.id]);

  const openCreateImage = () => {
    setEditingAsset(null);
    setImageName("");
    setImageUrl("");
    setImageFiles([]);
    setImageLabelIds(new Set());
    setShowImageModal(true);
  };

  const openEditImage = (asset: MediaAsset) => {
    setEditingAsset(asset);
    setImageName(asset.name);
    setImageUrl(asset.sourceUrl);
    setImageFiles([]);
    setImageLabelIds(new Set(asset.labels.map((label) => label.id)));
    setShowImageModal(true);
  };

  const closeImageModal = () => {
    if (isSavingImage) return;
    setShowImageModal(false);
    setEditingAsset(null);
  };

  const saveImage = async () => {
    setIsSavingImage(true);
    try {
      if (editingAsset?.image) {
        let nextUrl = imageUrl.trim();
        if (imageFiles[0])
          nextUrl = (await uploadFileToMediaBucket("artwork", imageFiles[0]))
            .url;
        if (!imageName.trim() || !nextUrl)
          throw new Error("Name and image are required.");
        await requestJson<ImageRecord>(`/media/${editingAsset.image.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: imageName.trim(), imageUrl: nextUrl }),
        });
        await requestJson(
          `/media-assets/${encodeURIComponent(editingAsset.id)}/labels`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ labelIds: [...imageLabelIds] }),
          },
        );
        showAlert("Image updated.", "success");
      } else {
        if (imageFiles.length === 0 && !imageUrl.trim())
          throw new Error("Select at least one image or provide an image URL.");
        const created: ImageRecord[] = [];
        if (imageFiles.length > 0) {
          for (let index = 0; index < imageFiles.length; index += 1) {
            const file = imageFiles[index];
            const upload = await uploadFileToMediaBucket("artwork", file);
            const baseName = imageName.trim();
            const name = baseName
              ? imageFiles.length > 1
                ? `${baseName} ${index + 1}`
                : baseName
              : stripFileExtension(file.name) || `Image ${index + 1}`;
            created.push(
              await requestJson<ImageRecord>("/media", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, imageUrl: upload.url }),
              }),
            );
          }
        } else {
          if (!imageName.trim())
            throw new Error("Name is required for a direct URL.");
          created.push(
            await requestJson<ImageRecord>("/media", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: imageName.trim(),
                imageUrl: imageUrl.trim(),
              }),
            }),
          );
        }
        if (imageLabelIds.size > 0) {
          await Promise.all(
            created.map((record) =>
              requestJson(
                `/media-assets/${encodeURIComponent(record.assetId)}/labels`,
                {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ labelIds: [...imageLabelIds] }),
                },
              ),
            ),
          );
        }
        showAlert(
          `Added ${created.length} image${created.length === 1 ? "" : "s"}.`,
          "success",
        );
      }
      setShowImageModal(false);
      await refresh();
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to save image.",
        "error",
      );
    } finally {
      setIsSavingImage(false);
    }
  };

  const deleteImage = async (asset: MediaAsset) => {
    if (!asset.image || !window.confirm(`Delete “${asset.name}”?`)) return;
    try {
      await requestJson(`/media/${asset.image.id}`, { method: "DELETE" });
      await refresh();
      showAlert("Image deleted.", "success");
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to delete image.",
        "error",
      );
    }
  };

  const openCreateBackground = () => {
    setBackgroundName("");
    setBackgroundUrl("");
    setBackgroundFile(null);
    setBackgroundVolume("1");
    setBackgroundLabelIds(new Set());
    setShowBackgroundModal(true);
  };

  const saveBackground = async () => {
    setIsSavingBackground(true);
    try {
      let sourceUrl = backgroundUrl.trim();
      if (backgroundFile)
        sourceUrl = (
          await uploadFileToMediaBucket("background", backgroundFile)
        ).url;
      if (!backgroundName.trim() || !sourceUrl)
        throw new Error("Name and audio file are required.");
      const created = await requestJson<MediaAsset>(
        "/media-assets/background-audio",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: backgroundName.trim(),
            sourceUrl,
            defaultVolume: Number(backgroundVolume),
          }),
        },
      );
      if (backgroundLabelIds.size > 0) {
        await requestJson(
          `/media-assets/${encodeURIComponent(created.id)}/labels`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ labelIds: [...backgroundLabelIds] }),
          },
        );
      }
      setShowBackgroundModal(false);
      await refresh();
      showAlert("Background audio added.", "success");
    } catch (error) {
      showAlert(
        error instanceof Error
          ? error.message
          : "Failed to add background audio.",
        "error",
      );
    } finally {
      setIsSavingBackground(false);
    }
  };

  const deleteStandaloneAsset = async (asset: MediaAsset) => {
    if (!window.confirm(`Delete “${asset.name}”?`)) return;
    try {
      await requestJson(`/media-assets/${encodeURIComponent(asset.id)}`, {
        method: "DELETE",
      });
      await refresh();
      showAlert("Media deleted.", "success");
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to delete media.",
        "error",
      );
    }
  };

  const openCreateLabel = () => {
    setEditingLabel(null);
    setLabelName("");
    setLabelDescription("");
    setShowLabelModal(true);
  };

  const openEditLabel = (label: MediaLabel) => {
    setEditingLabel(label);
    setLabelName(label.name);
    setLabelDescription(label.description ?? "");
    setShowLabelModal(true);
  };

  const saveLabel = async () => {
    if (!labelName.trim()) return showAlert("Label name is required.", "error");
    setIsSavingLabel(true);
    try {
      const saved = await requestJson<MediaLabel>(
        editingLabel
          ? `/media-labels/${encodeURIComponent(editingLabel.id)}`
          : "/media-labels",
        {
          method: editingLabel ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: labelName.trim(),
            description: labelDescription.trim() || null,
          }),
        },
      );
      setShowLabelModal(false);
      await refresh();
      setSelectedLabel(saved);
      showAlert(editingLabel ? "Label updated." : "Label created.", "success");
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to save label.",
        "error",
      );
    } finally {
      setIsSavingLabel(false);
    }
  };

  const createInlineLabel = async (
    name: string,
    selectLabel: (labelId: string) => void,
  ) => {
    const saved = await requestJson<MediaLabel>("/media-labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: null }),
    });
    labelsRequestVersion.current += 1;
    setLabels((current) =>
      [...current.filter((label) => label.id !== saved.id), saved].sort(
        (left, right) => left.name.localeCompare(right.name),
      ),
    );
    selectLabel(saved.id);
    showAlert(`Created and selected “${saved.name}”.`, "success");
  };

  const deleteLabel = async (label: MediaLabel) => {
    if (
      !window.confirm(
        `Delete label “${label.name}”? Files will remain in the library.`,
      )
    )
      return;
    try {
      await requestJson(`/media-labels/${encodeURIComponent(label.id)}`, {
        method: "DELETE",
      });
      if (selectedLabel?.id === label.id) setSelectedLabel(null);
      await refresh();
      showAlert("Label deleted. Its media files were kept.", "success");
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to delete label.",
        "error",
      );
    }
  };

  const persistLabelOrder = async (label: MediaLabel, assetIds: string[]) => {
    const updated = await requestJson<MediaLabel>(
      `/media-labels/${encodeURIComponent(label.id)}/assets`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetIds }),
      },
    );
    setSelectedLabel(updated);
    await refresh();
  };

  const moveLabelAsset = async (index: number, direction: -1 | 1) => {
    if (!selectedLabel) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= selectedLabel.assets.length) return;
    const next = selectedLabel.assets.map((entry) => entry.asset.id);
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    try {
      await persistLabelOrder(selectedLabel, next);
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to reorder label.",
        "error",
      );
    }
  };

  const removeLabelAsset = async (assetId: string) => {
    if (!selectedLabel) return;
    try {
      await persistLabelOrder(
        selectedLabel,
        selectedLabel.assets
          .map((entry) => entry.asset.id)
          .filter((id) => id !== assetId),
      );
    } catch (error) {
      showAlert(
        error instanceof Error ? error.message : "Failed to remove label.",
        "error",
      );
    }
  };

  const addAssetToLabel = async () => {
    if (!selectedLabel || !assetToAdd) return;
    try {
      await persistLabelOrder(selectedLabel, [
        ...selectedLabel.assets.map((entry) => entry.asset.id),
        assetToAdd,
      ]);
      setAssetToAdd("");
    } catch (error) {
      showAlert(
        error instanceof Error
          ? error.message
          : "Failed to add media to label.",
        "error",
      );
    }
  };

  const applyBulkLabel = async () => {
    if (!bulkLabelId || selectedAssetIds.size === 0) return;
    try {
      await Promise.all(
        assets
          .filter((asset) => selectedAssetIds.has(asset.id))
          .map((asset) =>
            requestJson(
              `/media-assets/${encodeURIComponent(asset.id)}/labels`,
              {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  labelIds: [
                    ...new Set([
                      ...asset.labels.map((label) => label.id),
                      bulkLabelId,
                    ]),
                  ],
                }),
              },
            ),
          ),
      );
      setSelectedAssetIds(new Set());
      setBulkLabelId("");
      await refresh();
      showAlert("Label added to selected media.", "success");
    } catch (error) {
      showAlert(
        error instanceof Error
          ? error.message
          : "Failed to label selected media.",
        "error",
      );
    }
  };

  const allAssetsForLabels = useMemo(
    () =>
      [...assets].sort((left, right) => left.name.localeCompare(right.name)),
    [assets],
  );
  const availableForSelectedLabel = selectedLabel
    ? allAssetsForLabels.filter(
        (asset) =>
          !selectedLabel.assets.some((entry) => entry.asset.id === asset.id),
      )
    : [];

  if (programType === null) {
    return (
      <AppPage width="full">
        <div className="flex justify-center py-16">
          <LoadingSpinner />
        </div>
      </AppPage>
    );
  }

  const actions =
    !isLabelsView && mediaType === "IMAGE" ? (
      <Button onClick={openCreateImage}>
        <Plus size={16} />
        Add images
      </Button>
    ) : isLabelsView ? (
      <Button onClick={openCreateLabel}>
        <Plus size={16} />
        Create label
      </Button>
    ) : mediaType === "AUDIO" ? (
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={openCreateBackground}>
          <Plus size={16} />
          Add background audio
        </Button>
        <Button variant="secondary" onClick={() => navigate("/instants")}>
          Manage instant audio
        </Button>
        <Button onClick={() => navigate("/songs")}>Manage songs</Button>
      </div>
    ) : (
      <Button onClick={() => navigate("/stingers")}>Manage transitions</Button>
    );

  return (
    <MediaLibraryPage
      activeSection={activeSection}
      actions={actions}
      visibleSections={visibleSections}
      width="full"
    >
      {!isLabelsView ? (
        <Card className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-md">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
                size={16}
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search ${mediaType.toLowerCase()} media…`}
                className="pl-9 pr-9"
              />
              {search ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-text-secondary"
                >
                  <X size={16} />
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {mediaType === "AUDIO" ? (
                <Select
                  value={capability}
                  onChange={(value) =>
                    setCapability(value as MediaCapability | "")
                  }
                  options={[
                    { value: "", label: "All audio" },
                    { value: "INSTANT", label: "Instant" },
                    { value: "BACKGROUND", label: "Background" },
                    { value: "SONG", label: "Song" },
                  ]}
                />
              ) : null}
              {selectedAssetIds.size > 0 ? (
                <div className="flex min-w-[18rem] flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Select
                      value={bulkLabelId}
                      onChange={setBulkLabelId}
                      options={[
                        { value: "", label: "Choose label…" },
                        ...labels.map((label) => ({
                          value: label.id,
                          label: label.name,
                        })),
                      ]}
                    />
                    <Button
                      size="sm"
                      onClick={() => void applyBulkLabel()}
                      disabled={!bulkLabelId}
                    >
                      <Tag size={14} />
                      Label {selectedAssetIds.size}
                    </Button>
                  </div>
                  <InlineLabelCreator
                    onCreate={(name) =>
                      createInlineLabel(name, setBulkLabelId)
                    }
                  />
                </div>
              ) : null}
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : assets.length === 0 ? (
            <Empty
              title={`No ${mediaType.toLowerCase()} media found`}
              description={
                debouncedSearch || capability
                  ? "Clear the filters and try again."
                  : "This physical media type has no assets yet."
              }
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {assets.map((asset) => (
                <article
                  key={asset.id}
                  className="rounded-[var(--radius-card)] border border-sand/25 bg-white/80 p-4 dark:border-white/10 dark:bg-dark-sand/60"
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selectedAssetIds.has(asset.id)}
                      onChange={(event) =>
                        setSelectedAssetIds((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(asset.id);
                          else next.delete(asset.id);
                          return next;
                        })
                      }
                    />
                    {asset.mediaType === "IMAGE" ? (
                      <img
                        src={asset.sourceUrl}
                        alt=""
                        className="h-16 w-24 rounded-lg bg-sand/10 object-cover"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-text-primary">
                        {asset.name}
                      </p>
                      <p className="mt-1 text-xs uppercase tracking-wide text-text-secondary">
                        {asset.mediaType}
                      </p>
                    </div>
                    {asset.image ? (
                      <div className="flex gap-1">
                        <IconButton
                          aria-label={`Edit ${asset.name}`}
                          onClick={() => openEditImage(asset)}
                        >
                          <Pencil size={15} />
                        </IconButton>
                        <IconButton
                          aria-label={`Delete ${asset.name}`}
                          onClick={() => void deleteImage(asset)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    ) : !asset.instant && !asset.song && asset.coverForSongIds.length === 0 && !asset.transition ? (
                      <IconButton
                        aria-label={`Delete ${asset.name}`}
                        onClick={() => void deleteStandaloneAsset(asset)}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    ) : null}
                  </div>
                  {asset.mediaType === "AUDIO" ? (
                    <audio
                      className="mt-3 w-full"
                      controls
                      preload="none"
                      src={asset.sourceUrl}
                    />
                  ) : null}
                  {asset.mediaType === "VIDEO" ? (
                    <video
                      className="mt-3 aspect-video w-full rounded-lg bg-black object-contain"
                      controls
                      preload="metadata"
                      src={asset.sourceUrl}
                    />
                  ) : null}
                  <div className="mt-3 space-y-2">
                    <CapabilityBadges capabilities={asset.capabilities} />
                    <LabelBadges labels={asset.labels} />
                  </div>
                </article>
              ))}
            </div>
          )}
          {totalPages > 1 ? (
            <Pagination
              currentPage={page}
              totalPages={totalPages}
              hasNextPage={page < totalPages}
              hasPrevPage={page > 1}
              onPageChange={setPage}
            />
          ) : null}
          <p className="text-xs text-text-secondary">
            {totalCount} asset{totalCount === 1 ? "" : "s"}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(18rem,0.8fr)_minmax(0,1.7fr)]">
          <Card className="space-y-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary"
                size={16}
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search labels…"
                className="pl-9"
              />
            </div>
            {labels
              .filter(
                (label) =>
                  !debouncedSearch ||
                  label.name
                    .toLowerCase()
                    .includes(debouncedSearch.toLowerCase()),
              )
              .map((label) => (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => setSelectedLabel(label)}
                  className={`w-full rounded-xl border p-3 text-left transition ${selectedLabel?.id === label.id ? "border-sea/60 bg-sea/10" : "border-sand/25 hover:border-sea/30"}`}
                >
                  <span className="block font-medium text-text-primary">
                    {label.name}
                  </span>
                  <span className="mt-1 block text-xs text-text-secondary">
                    {label.assetCount} asset{label.assetCount === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            {!isLoading && labels.length === 0 ? (
              <Empty
                title="No labels yet"
                description="Create a label, then apply it to any media asset."
              />
            ) : null}
          </Card>

          <Card className="space-y-4">
            {!selectedLabel ? (
              <Empty
                title="Select a label"
                description="Labels can group and order any media without creating a separate collection."
              />
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">
                      {selectedLabel.name}
                    </h2>
                    {selectedLabel.description ? (
                      <p className="mt-1 text-sm text-text-secondary">
                        {selectedLabel.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-1">
                    <IconButton
                      aria-label={`Edit ${selectedLabel.name}`}
                      onClick={() => openEditLabel(selectedLabel)}
                    >
                      <Pencil size={16} />
                    </IconButton>
                    <IconButton
                      aria-label={`Delete ${selectedLabel.name}`}
                      onClick={() => void deleteLabel(selectedLabel)}
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Select
                    value={assetToAdd}
                    onChange={setAssetToAdd}
                    options={[
                      { value: "", label: "Choose media…" },
                      ...availableForSelectedLabel.map((asset) => ({
                        value: asset.id,
                        label: `${asset.name} · ${asset.mediaType.toLowerCase()}`,
                      })),
                    ]}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void addAssetToLabel()}
                    disabled={!assetToAdd}
                  >
                    Add
                  </Button>
                </div>
                {selectedLabel.assets.length === 0 ? (
                  <Empty
                    title="No media with this label"
                    description="Add existing media here, or apply this label while uploading images."
                  />
                ) : (
                  <div className="space-y-2">
                    {selectedLabel.assets.map(({ asset }, index) => (
                      <div
                        key={asset.id}
                        className="flex items-center gap-3 rounded-xl border border-sand/25 p-3"
                      >
                        <span className="w-6 text-center text-xs text-text-secondary">
                          {index + 1}
                        </span>
                        {asset.mediaType === "IMAGE" ? (
                          <img
                            src={asset.sourceUrl}
                            alt=""
                            className="h-10 w-14 rounded object-cover"
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-text-primary">
                            {asset.name}
                          </p>
                          <p className="text-xs text-text-secondary">
                            {asset.mediaType.toLowerCase()}
                          </p>
                        </div>
                        <IconButton
                          aria-label="Move up"
                          disabled={index === 0}
                          onClick={() => void moveLabelAsset(index, -1)}
                        >
                          <ArrowUp size={15} />
                        </IconButton>
                        <IconButton
                          aria-label="Move down"
                          disabled={index === selectedLabel.assets.length - 1}
                          onClick={() => void moveLabelAsset(index, 1)}
                        >
                          <ArrowDown size={15} />
                        </IconButton>
                        <IconButton
                          aria-label="Remove label from media"
                          onClick={() => void removeLabelAsset(asset.id)}
                        >
                          <Trash2 size={15} />
                        </IconButton>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      <Modal
        isOpen={showImageModal}
        onClose={closeImageModal}
        title={editingAsset ? "Edit image" : "Add images"}
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Name
            </label>
            <Input
              value={imageName}
              onChange={(event) => setImageName(event.target.value)}
              placeholder={
                editingAsset ? "Image name" : "Optional for file uploads"
              }
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              {editingAsset ? "Replace image" : "Image files"}
            </label>
            <FileInput
              accept="image/*"
              multiple={!editingAsset}
              onChange={(event) => {
                setImageFiles(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Direct URL
            </label>
            <Input
              value={imageUrl}
              onChange={(event) => setImageUrl(event.target.value)}
              placeholder="https://…"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text-primary">
              Labels
            </legend>
            <InlineLabelCreator
              onCreate={(name) =>
                createInlineLabel(name, (labelId) =>
                  setImageLabelIds((current) =>
                    new Set(current).add(labelId),
                  ),
                )
              }
            />
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {labels.length === 0 ? (
                <p className="text-xs text-text-secondary">
                  No labels yet. Create one above and it will be selected.
                </p>
              ) : (
                labels.map((label) => (
                  <Checkbox
                    key={label.id}
                    label={label.name}
                    checked={imageLabelIds.has(label.id)}
                    onChange={(event) =>
                      setImageLabelIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(label.id);
                        else next.delete(label.id);
                        return next;
                      })
                    }
                  />
                ))
              )}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={closeImageModal}
              disabled={isSavingImage}
            >
              Cancel
            </Button>
            <Button onClick={() => void saveImage()} disabled={isSavingImage}>
              {isSavingImage
                ? "Saving…"
                : editingAsset
                  ? "Save image"
                  : "Add images"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showLabelModal}
        onClose={() => setShowLabelModal(false)}
        title={editingLabel ? "Edit label" : "Create label"}
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Name
            </label>
            <Input
              value={labelName}
              onChange={(event) => setLabelName(event.target.value)}
              placeholder="80s, Headlines, Sponsor photos…"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Description
            </label>
            <Textarea
              value={labelDescription}
              onChange={(event) => setLabelDescription(event.target.value)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setShowLabelModal(false)}
              disabled={isSavingLabel}
            >
              Cancel
            </Button>
            <Button onClick={() => void saveLabel()} disabled={isSavingLabel}>
              {isSavingLabel
                ? "Saving…"
                : editingLabel
                  ? "Save label"
                  : "Create label"}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={showBackgroundModal}
        onClose={() => setShowBackgroundModal(false)}
        title="Add background audio"
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Name
            </label>
            <Input
              value={backgroundName}
              onChange={(event) => setBackgroundName(event.target.value)}
              placeholder="Weather bed"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Audio file
            </label>
            <FileInput
              accept="audio/*"
              onChange={(event) => {
                setBackgroundFile(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Direct URL
            </label>
            <Input
              value={backgroundUrl}
              onChange={(event) => setBackgroundUrl(event.target.value)}
              placeholder="https://…"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-text-primary">
              Default volume
            </label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={backgroundVolume}
              onChange={(event) => setBackgroundVolume(event.target.value)}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text-primary">
              Labels
            </legend>
            <InlineLabelCreator
              onCreate={(name) =>
                createInlineLabel(name, (labelId) =>
                  setBackgroundLabelIds((current) =>
                    new Set(current).add(labelId),
                  ),
                )
              }
            />
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {labels.length === 0 ? (
                <p className="text-xs text-text-secondary">
                  No labels yet. Create one above and it will be selected.
                </p>
              ) : (
                labels.map((label) => (
                  <Checkbox
                    key={label.id}
                    label={label.name}
                    checked={backgroundLabelIds.has(label.id)}
                    onChange={(event) =>
                      setBackgroundLabelIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(label.id);
                        else next.delete(label.id);
                        return next;
                      })
                    }
                  />
                ))
              )}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setShowBackgroundModal(false)}
              disabled={isSavingBackground}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveBackground()}
              disabled={isSavingBackground}
            >
              {isSavingBackground ? "Saving…" : "Add background audio"}
            </Button>
          </div>
        </div>
      </Modal>
    </MediaLibraryPage>
  );
}
