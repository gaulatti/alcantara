import { AlertContainer, Card, SectionHeader, Tabs } from "@gaulatti/bleecker";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { AppPage } from "../AppPage";

export type MediaLibrarySection = "images" | "audio" | "video" | "labels";

const MEDIA_LIBRARY_SECTIONS: Array<{
  id: MediaLibrarySection;
  label: string;
  href: string;
}> = [
  { id: "images", label: "Images", href: "/media?type=IMAGE" },
  { id: "audio", label: "Audio", href: "/media?type=AUDIO" },
  { id: "video", label: "Video", href: "/media?type=VIDEO" },
  { id: "labels", label: "Labels", href: "/media?view=labels" },
];

interface MediaLibraryPageProps {
  activeSection: MediaLibrarySection;
  actions?: ReactNode;
  children: ReactNode;
  visibleSections?: MediaLibrarySection[];
  width?: "content" | "wide" | "full";
}

export function MediaLibraryPage({
  activeSection,
  actions,
  children,
  visibleSections,
  width = "wide",
}: MediaLibraryPageProps) {
  const navigate = useNavigate();
  const sections = visibleSections
    ? MEDIA_LIBRARY_SECTIONS.filter((section) =>
        visibleSections.includes(section.id),
      )
    : MEDIA_LIBRARY_SECTIONS;

  return (
    <AppPage width={width}>
      <AlertContainer />
      <div className="space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <SectionHeader
            title="Media library"
            description="Upload files once, give them capabilities, and organize them with reusable labels."
          />
          {actions ? (
            <div className="flex flex-wrap items-center gap-3">{actions}</div>
          ) : null}
        </div>

        <Card className="overflow-hidden p-0">
          <Tabs
            activeTab={activeSection}
            onChange={(sectionId) => {
              const section = sections.find(
                (candidate) => candidate.id === sectionId,
              );
              if (section) navigate(section.href);
            }}
            tabs={sections.map(({ id, label }) => ({
              id,
              label,
            }))}
          />
        </Card>

        {children}
      </div>
    </AppPage>
  );
}
