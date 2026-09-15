import type { MediaLibrarySection } from "../components/media/MediaLibraryPage";
import type { ProgramType } from "./appNavigation";

export type MediaType = "IMAGE" | "AUDIO" | "VIDEO";

export interface MediaLibraryView {
  activeSection: MediaLibrarySection;
  canonicalHref: string | null;
  isLabelsView: boolean;
  mediaType: MediaType;
  visibleSections: MediaLibrarySection[];
}

const ALL_SECTIONS: MediaLibrarySection[] = [
  "images",
  "audio",
  "video",
  "labels",
];

const RADIO_SECTIONS: MediaLibrarySection[] = ["audio", "labels"];

export function getMediaLibraryView(
  programType: ProgramType,
  searchParams: Pick<URLSearchParams, "get">,
): MediaLibraryView {
  const isLabelsView = searchParams.get("view") === "labels";
  const requestedType = searchParams.get("type");
  const mediaType: MediaType =
    programType === "radio"
      ? "AUDIO"
      : requestedType === "AUDIO" || requestedType === "VIDEO"
        ? requestedType
        : "IMAGE";

  return {
    activeSection: isLabelsView
      ? "labels"
      : mediaType === "AUDIO"
        ? "audio"
        : mediaType === "VIDEO"
          ? "video"
          : "images",
    canonicalHref:
      programType === "radio" && !isLabelsView && requestedType !== "AUDIO"
        ? "/media?type=AUDIO"
        : null,
    isLabelsView,
    mediaType,
    visibleSections:
      programType === "radio" ? RADIO_SECTIONS : ALL_SECTIONS,
  };
}
