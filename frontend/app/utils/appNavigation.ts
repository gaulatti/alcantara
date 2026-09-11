export type ProgramType = 'tv' | 'radio' | 'both';

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

export function getAppNavigationSections({ programType, canViewBroadcasts, includeDeveloperTools }: NavigationOptions): AppNavigationSection[] {
  const hasTelevision = programType !== 'radio';
  const hasRadio = programType !== 'tv';
  const controlLabel = programType === 'radio' ? 'Radio desk' : programType === 'both' ? 'Simulcast control' : 'TV control';

  const sections: AppNavigationSection[] = [
    {
      id: 'live',
      label: 'Live',
      items: [
        { id: 'control', href: '/', label: controlLabel },
        { id: 'rundown', href: '/flight', label: 'Rundown' },
        ...(hasTelevision
          ? [
              { id: 'calls', href: '/calls', label: 'Guest calls' },
              ...(canViewBroadcasts
                ? [
                    {
                      id: 'destinations',
                      href: '/broadcasts',
                      label: 'TV destinations'
                    }
                  ]
                : [])
            ]
          : [])
      ]
    },
    {
      id: 'library',
      label: 'Library',
      items: [
        ...(hasTelevision
          ? [
              { id: 'scenes', href: '/scenes', label: 'Scenes' },
              {
                id: 'scene-templates',
                href: '/layouts',
                label: 'Scene templates'
              },
              { id: 'media', href: '/media', label: 'Media' },
              {
                id: 'transitions',
                href: '/stingers',
                label: 'Transitions'
              }
            ]
          : []),
        { id: 'songs', href: '/songs', label: 'Songs' },
        { id: 'audio-clips', href: '/instants', label: 'Audio clips' }
      ]
    },
    {
      id: 'setup',
      label: 'Show setup',
      items: [
        { id: 'shows', href: '/programs', label: 'Shows' },
        ...(hasRadio
          ? [
              {
                id: 'radio-distribution',
                href: '/radio-settings',
                label: 'Radio distribution'
              }
            ]
          : [])
      ]
    }
  ];

  if (includeDeveloperTools) {
    sections.push({
      id: 'developer',
      label: 'Development',
      items: [
        {
          id: 'component-catalog',
          href: '/preview',
          label: 'Component catalog'
        },
        {
          id: 'console-fixture',
          href: '/console-fixture',
          label: 'Console fixture'
        }
      ]
    });
  }

  return sections;
}

export function isNavigationItemActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/' || pathname === '/control';
  return pathname === href || pathname.startsWith(`${href}/`);
}
