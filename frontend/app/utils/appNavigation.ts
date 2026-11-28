export type ProgramType = "tv" | "radio" | "both";

export interface AppNavigationItem {
  id: string;
  href: string;
  label: string;
}

export interface AppNavigationSection {
  id: string;
  label: string;
  items: AppNavigationItem[];
}

interface NavigationOptions {
  programType: ProgramType;
  canViewBroadcasts: boolean;
  includeDeveloperTools: boolean;
}

export function getAppNavigationSections({
  programType,
  canViewBroadcasts,
  includeDeveloperTools,
}: NavigationOptions): AppNavigationSection[] {
  const hasTelevision = programType !== "radio";
  const hasRadio = programType !== "tv";
  const controlLabel =
    programType === "radio"
      ? "Radio desk"
      : programType === "both"
        ? "Simulcast control"
        : "TV control";

  const sections: AppNavigationSection[] = [
    {
      id: "live",
      label: "Live",
      items: [
        { id: "control", href: "/", label: controlLabel },
        { id: "rundown", href: "/flight", label: "Rundown" },
        ...(hasRadio
          ? [{ id: "dayparts", href: "/dayparts", label: "Dayparts" }]
          : []),
        // Every show takes calls: a cued guest also goes out on the radio (alcantara#875).
        { id: "calls", href: "/calls", label: "Guest calls" },
        ...(hasTelevision
          ? [
              { id: "sources", href: "/sources", label: "External sources" },
              ...(canViewBroadcasts
                ? [
                    {
                      id: "destinations",
                      href: "/broadcasts",
                      label: "TV destinations",
                    },
                  ]
                : []),
            ]
          : []),
      ],
    },
    {
      id: "library",
      label: "Library",
      items: [
        ...(hasTelevision
          ? [
              { id: "scenes", href: "/scenes", label: "Scenes" },
              {
                id: "scene-templates",
                href: "/layouts",
                label: "Scene templates",
              },
            ]
          : []),
        { id: "media", href: "/media", label: "Media" },
      ],
    },
    {
      id: "setup",
      label: "Show setup",
      items: [
        { id: "shows", href: "/programs", label: "Shows" },
        ...(hasRadio
          ? [
              {
                id: "radio-distribution",
                href: "/radio-settings",
                label: "Radio distribution",
              },
            ]
          : []),
      ],
    },
  ];

  if (includeDeveloperTools) {
    sections.push({
      id: "developer",
      label: "Development",
      items: [
        {
          id: "component-catalog",
          href: "/preview",
          label: "Component catalog",
        },
        {
          id: "console-fixture",
          href: "/console-fixture",
          label: "Console",
        },
        {
          id: "radio-workflow-fixture",
          href: "/console-fixture?state=radio-workflow",
          label: "Radio workflow",
        },
        {
          id: "radio-continuous-fixture",
          href: "/console-fixture?state=radio-continuous",
          label: "Continuous radio",
        },
        {
          id: "radio-skipped-fixture",
          href: "/console-fixture?state=radio-skipped",
          label: "Skipped cue",
        },
        {
          id: "rundown-desk-fixture",
          href: "/console-fixture?state=rundown-desk",
          label: "Rundown desk",
        },
        {
          id: "rundown-filler-fixture",
          href: "/console-fixture?state=rundown-fillers",
          label: "Rundown fillers",
        },
        {
          id: "media-fixture",
          href: "/media-fixture",
          label: "Media states",
        },
        {
          id: "labels-fixture",
          href: "/labels-fixture",
          label: "Label states",
        },
        {
          id: "access-fixture",
          href: "/access-fixture",
          label: "Access states",
        },
      ],
    });
  }

  return sections;
}

export function isNavigationItemActive(
  pathname: string,
  href: string,
): boolean {
  if (href === "/") return pathname === "/" || pathname === "/control";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * What the sidebar's open sections depend on. The sidebar decides which section is open when it mounts, so it is
 * keyed by this: it changes when a section gains or loses items (permissions arrive after the first render) or the
 * page on screen moves to another section (alcantara#875).
 */
export function sidebarSectionsKey(
  sections: { id: string; active?: boolean; items?: unknown[] }[],
): string {
  return sections
    .map((section) => `${section.id}:${section.items?.length ?? 0}${section.active ? "*" : ""}`)
    .join("|");
}
