import { BrandLockup, IconButton, CommandSpotlight, HeaderSelect, Input, Button, Modal, Sidebar, type CommandSpotlightAction, type SidebarItem } from '@gaulatti/bleecker';
import {
  Blend,
  BookOpen,
  Boxes,
  Cable,
  CircleOff,
  Clock3,
  Clapperboard,
  Code2,
  Eye,
  ExternalLink,
  Images,
  LayoutTemplate,
  List,
  LogOut,
  Menu,
  Music,
  PhoneCall,
  Radio,
  RadioTower,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Tv,
  Volume2,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { apiUrl, getApiBaseUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';
import { resolveProgramOutputUrl, type ProgramTemplateManifest } from '../utils/programTemplate';
import { useGlobalTransitionId } from '../utils/globalTransition';
import { SCENE_TRANSITIONS, getSceneTransitionPreset } from '../utils/sceneTransitions';
import { useLogout } from '../hooks/useAuth';
import { useFeatures } from '../hooks/useFeatures';
import { isTestAuth } from '../services/session';
import { getAppNavigationSections, isNavigationItemActive, type ProgramType } from '../utils/appNavigation';

interface ProgramSummary {
  programId: string;
  type?: 'tv' | 'radio' | 'both';
  templateManifest?: ProgramTemplateManifest | null;
}

interface SceneSummary {
  id: number;
  name: string;
  layout?: {
    name?: string;
  } | null;
}

interface InstantSummary {
  id: number;
  name: string;
  audioUrl: string;
  volume: number;
  enabled: boolean;
  position: number;
}

interface BroadcastSettings {
  id: number;
  timeOverrideEnabled: boolean;
  timeOverrideStartTime: string | null;
  timeOverrideStartedAt: string | null;
  updatedAt: string;
}

const NAVIGATION_ICONS: Record<string, ReactNode> = {
  control: <SlidersHorizontal size={17} />,
  rundown: <List size={17} />,
  calls: <PhoneCall size={17} />,
  destinations: <RadioTower size={17} />,
  scenes: <Clapperboard size={17} />,
  'scene-templates': <LayoutTemplate size={17} />,
  media: <Images size={17} />,
  transitions: <Blend size={17} />,
  songs: <Music size={17} />,
  'audio-clips': <Volume2 size={17} />,
  shows: <Boxes size={17} />,
  'radio-distribution': <Cable size={17} />,
  'component-catalog': <BookOpen size={17} />,
  'console-fixture': <Code2 size={17} />
};

interface ShellLinkProps {
  children: ReactNode;
  className?: string;
  item: { href: string; external?: boolean; active?: boolean };
  onClick?: () => void;
}

function renderAppLink({ children, className, item, onClick }: ShellLinkProps) {
  if (item.external) {
    return (
      <a href={item.href} className={className} onClick={onClick} target='_blank' rel='noopener noreferrer'>
        {children}
      </a>
    );
  }

  return (
    <Link to={item.href} className={className} onClick={onClick} aria-current={item.active ? 'page' : undefined}>
      {children}
    </Link>
  );
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useLogout();
  const { hasPermission } = useFeatures();
  const [knownPrograms, setKnownPrograms] = useState<ProgramSummary[]>([]);
  const [knownScenes, setKnownScenes] = useState<SceneSummary[]>([]);
  const [knownInstants, setKnownInstants] = useState<InstantSummary[]>([]);
  const [selectedProgramId, setSelectedProgramId] = useGlobalProgramId();
  const [selectedTransitionId, setSelectedTransitionId] = useGlobalTransitionId(selectedProgramId);
  const [broadcastSettings, setBroadcastSettings] = useState<BroadcastSettings | null>(null);
  const [showBroadcastTimeModal, setShowBroadcastTimeModal] = useState(false);
  const [broadcastTimeInput, setBroadcastTimeInput] = useState('');
  const [broadcastTimeError, setBroadcastTimeError] = useState('');
  const [isSavingBroadcastTime, setIsSavingBroadcastTime] = useState(false);
  const [isTriggeringProgramReload, setIsTriggeringProgramReload] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const selectedTransition = getSceneTransitionPreset(selectedTransitionId);

  useEffect(() => {
    setMobileNavigationOpen(false);
  }, [location.pathname]);

  const loadBroadcastSettings = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/program/broadcast-settings'));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = await res.json();
      setBroadcastSettings(payload);
      setBroadcastTimeInput(payload?.timeOverrideStartTime || '');
      return payload as BroadcastSettings;
    } catch (err) {
      console.error('Failed to fetch broadcast settings for spotlight:', err);
      setBroadcastTimeError('Failed to load broadcast time settings. Please try again.');
      return null;
    }
  }, []);

  useEffect(() => {
    const loadPrograms = async () => {
      try {
        const res = await fetch(apiUrl('/program'));
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const payload = await res.json();
        if (Array.isArray(payload)) {
          setKnownPrograms(payload);
        }
      } catch (err) {
        console.error('Failed to fetch programs for site header selector:', err);
      }
    };

    void loadPrograms();
  }, []);

  useEffect(() => {
    if (knownPrograms.length === 0) {
      return;
    }

    const hasSelectedProgram = knownPrograms.some((program) => program.programId === selectedProgramId);
    if (hasSelectedProgram) {
      return;
    }

    setSelectedProgramId(knownPrograms[0].programId);
  }, [knownPrograms, selectedProgramId, setSelectedProgramId]);

  useEffect(() => {
    const loadScenes = async () => {
      try {
        const res = await fetch(apiUrl('/scenes'));
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const payload = await res.json();
        if (Array.isArray(payload)) {
          setKnownScenes(payload);
        }
      } catch (err) {
        console.error('Failed to fetch scenes for spotlight:', err);
      }
    };

    void loadScenes();
  }, []);

  useEffect(() => {
    const loadInstants = async () => {
      try {
        const res = await fetch(apiUrl('/instants'));
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const payload = await res.json();
        if (Array.isArray(payload)) {
          setKnownInstants(payload);
        } else {
          setKnownInstants([]);
        }
      } catch (err) {
        console.error('Failed to fetch instants for spotlight:', err);
        setKnownInstants([]);
      }
    };

    void loadInstants();
  }, []);

  useEffect(() => {
    void loadBroadcastSettings();
  }, [loadBroadcastSettings]);

  const saveBroadcastTimeOverride = useCallback(async () => {
    const normalized = broadcastTimeInput.trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
      setBroadcastTimeError('Use HH:mm format (24h), e.g. 19:55');
      return;
    }

    setIsSavingBroadcastTime(true);
    setBroadcastTimeError('');
    try {
      const res = await fetch(apiUrl('/program/broadcast-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          startTime: normalized
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const updated = await res.json();
      setBroadcastSettings(updated);
      setBroadcastTimeInput(updated.timeOverrideStartTime || normalized);
      setShowBroadcastTimeModal(false);
    } catch (err) {
      console.error('Failed to save broadcast time override from spotlight:', err);
      setBroadcastTimeError('Failed to apply time override. Please try again.');
    } finally {
      setIsSavingBroadcastTime(false);
    }
  }, [broadcastTimeInput]);

  const clearBroadcastTimeOverride = useCallback(async () => {
    setIsSavingBroadcastTime(true);
    setBroadcastTimeError('');
    try {
      const res = await fetch(apiUrl('/program/broadcast-settings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: false,
          startTime: null
        })
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      const updated = await res.json();
      setBroadcastSettings(updated);
      setShowBroadcastTimeModal(false);
    } catch (err) {
      console.error('Failed to clear broadcast time override from spotlight:', err);
      setBroadcastTimeError('Failed to disable time override. Please try again.');
    } finally {
      setIsSavingBroadcastTime(false);
    }
  }, []);

  const programOptions = useMemo(() => {
    const programMap = new Map(knownPrograms.map((p) => [p.programId, p]));
    const uniqueProgramIds = Array.from(new Set([selectedProgramId, ...knownPrograms.map((program) => program.programId)]));
    return uniqueProgramIds.filter(Boolean).map((programIdValue) => {
      const program = programMap.get(programIdValue);
      const type = program?.type ?? 'tv';
      const icon =
        type === 'radio' ? (
          <Radio size={14} />
        ) : type === 'both' ? (
          <>
            <Tv size={14} />
            <Radio size={14} />
          </>
        ) : (
          <Tv size={14} />
        );
      return {
        label: programIdValue,
        value: programIdValue,
        icon
      };
    });
  }, [knownPrograms, selectedProgramId]);

  const selectedProgram = knownPrograms.find((program) => program.programId === selectedProgramId) ?? { programId: selectedProgramId };
  const selectedProgramType = (selectedProgram.type ?? 'tv') as ProgramType;
  const navigationSections = useMemo(
    () =>
      getAppNavigationSections({
        programType: selectedProgramType,
        canViewBroadcasts: hasPermission('broadcast.view'),
        includeDeveloperTools: import.meta.env.DEV
      }),
    [hasPermission, selectedProgramType]
  );
  const groupedSidebarItems: SidebarItem[] = useMemo(
    () =>
      navigationSections.map((section) => ({
        id: section.id,
        label: section.label,
        icon: section.id === 'live' ? <RadioTower size={17} /> : section.id === 'library' ? <BookOpen size={17} /> : section.id === 'setup' ? <Settings size={17} /> : <Code2 size={17} />,
        active: section.items.some((item) => isNavigationItemActive(location.pathname, item.href)),
        items: section.items.map((item) => ({
          id: item.id,
          href: item.href,
          label: item.label,
          icon: NAVIGATION_ICONS[item.id],
          active: isNavigationItemActive(location.pathname, item.href)
        }))
      })),
    [location.pathname, navigationSections]
  );
  const flatSidebarItems: SidebarItem[] = useMemo(() => groupedSidebarItems.flatMap((section) => section.items ?? []), [groupedSidebarItems]);
  const isViewportConstrainedRoute = location.pathname === '/' || location.pathname === '/control';

  const renderHeaderProgramSelector = () => (
    <HeaderSelect
      value={selectedProgramId}
      onChange={(value) => {
        if (!value) return;
        setSelectedProgramId(value);
      }}
      options={programOptions}
      placeholder='Program'
      icon={<Tv size={15} className='flex-shrink-0 text-sea ' strokeWidth={1.5} />}
      wrapperClassName='max-w-[220px]'
    />
  );

  const openProgramUrl = resolveProgramOutputUrl(selectedProgram, getApiBaseUrl());
  const triggerProgramReload = useCallback(async () => {
    if (!selectedProgramId.trim()) {
      return;
    }

    setIsTriggeringProgramReload(true);
    try {
      const res = await fetch(apiUrl(`/program/${encodeURIComponent(selectedProgramId)}/reload`), {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      console.error('Failed to request program reload from header:', err);
    } finally {
      setIsTriggeringProgramReload(false);
    }
  }, [selectedProgramId]);

  const renderOpenProgramButton = () => (
    <IconButton
      type='button'
      size='sm'
      variant='subtle'
      title='Open Program Output'
      aria-label='Open Program Output'
      onClick={() => {
        window.open(openProgramUrl, '_blank', 'noopener,noreferrer');
      }}
    >
      <ExternalLink size={16} strokeWidth={1.8} />
    </IconButton>
  );

  const renderRefreshProgramButton = () => (
    <IconButton
      type='button'
      size='sm'
      variant='subtle'
      title='Refresh Program'
      aria-label='Refresh Program'
      onClick={() => {
        void triggerProgramReload();
      }}
      disabled={isTriggeringProgramReload}
    >
      <RefreshCw size={16} strokeWidth={1.8} className={isTriggeringProgramReload ? 'animate-spin' : ''} />
    </IconButton>
  );

  const renderLogoutButton = () => (
    <Button variant='ghost' size='sm' onClick={logout}>
      <LogOut size={15} strokeWidth={1.5} />
      <span>Logout</span>
    </Button>
  );

  const commandActions = useMemo<CommandSpotlightAction[]>(() => {
    const selectedProgramTitle = `Open Program Output (${selectedProgramId})`;
    const selectedProgramQuery = `programId=${encodeURIComponent(selectedProgramId)}`;

    const baseActions: CommandSpotlightAction[] = [
      {
        id: 'nav-control',
        title: 'Go to Control',
        description: 'Open the live control panel',
        group: 'Navigation',
        icon: <SlidersHorizontal size={16} />,
        onSelect: () => navigate('/')
      },
      {
        id: 'nav-flight',
        title: 'Go to Rundown',
        description: 'Open the cue list for the selected show',
        group: 'Navigation',
        icon: <List size={16} />,
        onSelect: () => navigate('/flight')
      },
      {
        id: 'nav-instants',
        title: 'Go to Audio Clips',
        description: 'Manage reusable sounders, bumpers, and audio clips',
        group: 'Navigation',
        icon: <Volume2 size={16} />,
        onSelect: () => navigate('/instants')
      },
      {
        id: 'nav-songs',
        title: 'Go to Songs',
        description: 'Manage global songs catalog',
        group: 'Navigation',
        icon: <Music size={16} />,
        onSelect: () => navigate('/songs')
      },
      {
        id: 'nav-media',
        title: 'Go to Media',
        description: 'Manage image media and media groups for slideshow scenes',
        group: 'Navigation',
        icon: <Images size={16} />,
        onSelect: () => navigate('/media')
      },
      {
        id: 'nav-calls',
        title: 'Go to Guest Calls',
        description: 'Invite and direct remote contributors',
        group: 'Navigation',
        icon: <PhoneCall size={16} />,
        onSelect: () => navigate('/calls')
      },
      ...(hasPermission('broadcast.view')
        ? [
            {
              id: 'nav-broadcasts',
              title: 'Go to Broadcasts',
              description: 'Select public destinations and operate the television leg',
              group: 'Navigation',
              icon: <Radio size={16} />,
              onSelect: () => navigate('/broadcasts')
            }
          ]
        : []),
      {
        id: 'nav-programs',
        title: 'Go to Shows',
        description: 'Manage TV, Radio, and Simulcast shows',
        group: 'Navigation',
        icon: <Tv size={16} />,
        onSelect: () => navigate('/programs')
      },
      {
        id: 'nav-scenes',
        title: 'Go to Scenes',
        description: 'Manage create/edit/delete for scenes',
        group: 'Navigation',
        icon: <Clapperboard size={16} />,
        onSelect: () => navigate('/scenes')
      },
      {
        id: 'nav-layouts',
        title: 'Go to Scene Templates',
        description: 'Manage reusable scene structures',
        group: 'Navigation',
        icon: <LayoutTemplate size={16} />,
        onSelect: () => navigate('/layouts')
      },
      {
        id: 'nav-radio-settings',
        title: 'Go to Radio Distribution',
        description: 'Configure Palazzo automation, bumpers, and now-playing delivery',
        group: 'Navigation',
        icon: <Cable size={16} />,
        onSelect: () => navigate('/radio-settings')
      },
      {
        id: 'nav-preview',
        title: 'Open Preview',
        description: 'Open component preview in a new tab',
        group: 'Navigation',
        icon: <Eye size={16} />,
        onSelect: () => {
          if (typeof window === 'undefined') return;
          window.open('/preview', '_blank', 'noopener,noreferrer');
        }
      },
      {
        id: 'open-selected-program',
        title: selectedProgramTitle,
        description: 'Launch selected program output in a new tab',
        group: 'Programs',
        icon: <Radio size={16} />,
        onSelect: () => {
          if (typeof window === 'undefined') return;
          window.open(openProgramUrl, '_blank', 'noopener,noreferrer');
        }
      },
      {
        id: 'take-selected-program-song-off-air',
        title: `Take Song Off Air (${selectedProgramId})`,
        description: 'Stop current song playback for this program only',
        group: 'Songs',
        icon: <CircleOff size={16} />,
        keywords: ['song off air', 'stop song', selectedProgramId],
        onSelect: async () => {
          const res = await fetch(apiUrl(`/program/${encodeURIComponent(selectedProgramId)}/song/off-air`), {
            method: 'POST'
          });
          if (!res.ok) {
            throw new Error(`Failed to take song off air (${res.status})`);
          }
        }
      },
      {
        id: 'stop-all-instants',
        title: 'Stop All Instants',
        description: 'Stop all currently playing instant audio clips in program outputs',
        group: 'Instants',
        icon: <Volume2 size={16} />,
        onSelect: async () => {
          const res = await fetch(apiUrl(`/instants/stop-all?${selectedProgramQuery}`), {
            method: 'POST'
          });
          if (!res.ok) {
            throw new Error(`Failed to stop all instants (${res.status})`);
          }
        }
      },
      {
        id: 'open-transition-settings',
        title: 'Go to Control Transition Settings',
        description: `Current transition: ${selectedTransition.name}`,
        group: 'Transitions',
        icon: <Blend size={16} />,
        onSelect: () => navigate('/')
      },
      {
        id: 'open-broadcast-time-override',
        title: 'Set Global Broadcast Time Override',
        description: broadcastSettings?.timeOverrideEnabled ? `Active from ${broadcastSettings.timeOverrideStartTime || '--:--'}` : 'Disabled (clocks use live timezone time)',
        group: 'Broadcast',
        icon: <Clock3 size={16} />,
        keywords: ['clock', 'time override', 'broadcast time', 'global'],
        onSelect: async () => {
          await loadBroadcastSettings();
          setBroadcastTimeError('');
          setShowBroadcastTimeModal(true);
        }
      },
      {
        id: 'disable-broadcast-time-override',
        title: 'Disable Global Broadcast Time Override',
        description: broadcastSettings?.timeOverrideEnabled ? 'Return clocks to live timezone time' : 'Already disabled',
        group: 'Broadcast',
        icon: <Clock3 size={16} />,
        disabled: !broadcastSettings?.timeOverrideEnabled,
        onSelect: async () => {
          if (!broadcastSettings?.timeOverrideEnabled) {
            return;
          }
          await clearBroadcastTimeOverride();
        }
      }
    ];

    const selectProgramActions: CommandSpotlightAction[] = programOptions.map((option) => ({
      id: `select-program-${option.value}`,
      title: `Select Program: ${option.label}`,
      description: option.value === selectedProgramId ? 'Currently selected' : 'Switch global program context',
      group: 'Programs',
      icon: option.icon ?? <Tv size={16} />,
      onSelect: () => setSelectedProgramId(option.value)
    }));

    const sceneStageActions: CommandSpotlightAction[] = knownScenes.map((scene) => ({
      id: `scene-stage-${scene.id}`,
      title: `Stage Scene: ${scene.name}`,
      description: `${scene.layout?.name || 'No layout'} · ${selectedProgramId} · verify in Preview before TAKE`,
      group: 'Scenes',
      icon: <Clapperboard size={16} />,
      keywords: [scene.layout?.name || '', selectedProgramId, selectedTransition.name],
      onSelect: async () => {
        const assignRes = await fetch(apiUrl(`/program/${encodeURIComponent(selectedProgramId)}/scenes`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: scene.id })
        });
        if (!assignRes.ok) {
          throw new Error(`Failed to assign scene (${assignRes.status})`);
        }

        const stageRes = await fetch(apiUrl(`/program/${encodeURIComponent(selectedProgramId)}/stage`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: scene.id })
        });
        if (!stageRes.ok) {
          throw new Error(`Failed to stage scene (${stageRes.status})`);
        }
      }
    }));

    const transitionActions: CommandSpotlightAction[] = SCENE_TRANSITIONS.map((transition) => ({
      id: `transition-${transition.id}`,
      title: `Set Transition: ${transition.name}`,
      description: transition.id === selectedTransition.id ? 'Currently selected' : transition.description,
      group: 'Transitions',
      icon: <Blend size={16} />,
      onSelect: () => setSelectedTransitionId(transition.id)
    }));

    const instantActions: CommandSpotlightAction[] = knownInstants
      .filter((instant) => instant.enabled)
      .map((instant) => ({
        id: `instant-play-${instant.id}`,
        title: `Play Instant: ${instant.name}`,
        description: `volume ${instant.volume}`,
        group: 'Instants',
        icon: <Volume2 size={16} />,
        keywords: [instant.audioUrl],
        onSelect: async () => {
          const res = await fetch(apiUrl(`/instants/${instant.id}/play?${selectedProgramQuery}`), {
            method: 'POST'
          });
          if (!res.ok) {
            throw new Error(`Failed to play instant (${res.status})`);
          }
        }
      }));

    const televisionOnlyActions = new Set(['nav-media', 'nav-calls', 'nav-broadcasts', 'nav-scenes', 'nav-layouts', 'nav-preview', 'open-transition-settings']);
    const visibleBaseActions = baseActions.filter((action) => {
      if (selectedProgramType === 'radio' && televisionOnlyActions.has(action.id)) return false;
      if (selectedProgramType === 'tv' && action.id === 'nav-radio-settings') return false;
      return true;
    });

    return [
      ...visibleBaseActions,
      ...selectProgramActions,
      ...(selectedProgramType === 'radio' ? [] : sceneStageActions),
      ...(selectedProgramType === 'radio' ? [] : transitionActions),
      ...instantActions
    ];
  }, [
    knownInstants,
    knownScenes,
    broadcastSettings,
    clearBroadcastTimeOverride,
    loadBroadcastSettings,
    navigate,
    openProgramUrl,
    programOptions,
    selectedProgramId,
    selectedProgramType,
    selectedTransition,
    setSelectedProgramId,
    setSelectedTransitionId
  ]);

  const programModeLabel = selectedProgramType === 'radio' ? 'Radio' : selectedProgramType === 'both' ? 'Simulcast' : 'Television';
  const programModeIcon =
    selectedProgramType === 'radio' ? (
      <Radio size={14} />
    ) : selectedProgramType === 'both' ? (
      <>
        <Tv size={14} />
        <Radio size={14} />
      </>
    ) : (
      <Tv size={14} />
    );
  const testAuthEnabled = isTestAuth();
  const testAuthBadge = (compact = false) =>
    testAuthEnabled ? (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded bg-amber-300 py-1 font-black text-black ${compact ? 'px-1 text-[8px] tracking-wide' : 'px-2 text-[9px] tracking-widest'}`}
        title='Local test authentication is active'
      >
        TEST AUTH
      </span>
    ) : null;
  const sidebarHeader = isViewportConstrainedRoute ? (
    <div className='flex flex-col items-center gap-3'>
      <Link to='/' aria-label='Alcántara live control' className='flex justify-center'>
        <img src='/logo.svg' alt='' className='h-7 w-7 object-contain' />
      </Link>
      {testAuthBadge(true)}
    </div>
  ) : (
    <div className='px-1'>
      <BrandLockup href='/' name='alcántara' logoAlt='alcántara' logoSrc='/logo.svg' renderLink={renderAppLink} />
      <div className='mt-2 flex items-center justify-between gap-2'>
        <p className='text-[11px] leading-5 text-text-secondary'>Broadcast control center</p>
        {testAuthBadge()}
      </div>
    </div>
  );
  const sidebarFooter = isViewportConstrainedRoute ? undefined : (
    <div className='space-y-3 px-1'>
      <div>
        <p className='mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary'>Active show</p>
        {renderHeaderProgramSelector()}
      </div>
      <div className='flex items-center justify-between gap-2'>
        <Button size='sm' variant='ghost' onClick={() => setCommandOpen(true)}>
          <Search size={14} /> Commands
        </Button>
        {renderLogoutButton()}
      </div>
    </div>
  );

  return (
    <>
      <CommandSpotlight
        actions={commandActions}
        showTrigger={false}
        open={commandOpen}
        onOpenChange={setCommandOpen}
        placeholder='Search pages, programs, scenes, transitions, and broadcast...'
        emptyMessage='No commands found.'
      />
      <div className='flex h-screen min-h-0 bg-background text-foreground antialiased'>
        <Sidebar
          className='hidden shrink-0 xl:flex'
          collapsed={isViewportConstrainedRoute}
          header={sidebarHeader}
          items={isViewportConstrainedRoute ? flatSidebarItems : groupedSidebarItems}
          footer={sidebarFooter}
          renderLink={renderAppLink}
        />

        <div className='flex min-w-0 flex-1 flex-col'>
          <header className='fixed inset-x-0 top-0 z-[1200] flex h-16 items-center justify-between border-b border-white/10 bg-deep-sea/95 px-4 backdrop-blur xl:hidden'>
            <BrandLockup href='/' name='alcántara' logoAlt='alcántara' logoSrc='/logo.svg' renderLink={renderAppLink} />
            <div className='flex items-center gap-2'>
              {testAuthBadge()}
              <span className='hidden items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-text-secondary sm:inline-flex'>
                {programModeIcon} {programModeLabel}
              </span>
              <IconButton variant='ghost' aria-label={mobileNavigationOpen ? 'Close navigation' : 'Open navigation'} onClick={() => setMobileNavigationOpen((open) => !open)}>
                {mobileNavigationOpen ? <X size={20} /> : <Menu size={20} />}
              </IconButton>
            </div>
          </header>

          {mobileNavigationOpen ? (
            <div className='fixed inset-0 z-[1190] xl:hidden' role='dialog' aria-modal='true' aria-label='Application navigation'>
              <button type='button' aria-label='Close navigation' className='absolute inset-0 bg-black/65' onClick={() => setMobileNavigationOpen(false)} />
              <Sidebar
                className='absolute bottom-0 right-0 top-16 w-[min(90vw,22rem)] shadow-2xl'
                header={
                  <div className='space-y-3 px-1'>
                    <p className='text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary'>Active show</p>
                    {renderHeaderProgramSelector()}
                    <span className='inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-1 text-xs font-semibold text-text-secondary'>
                      {programModeIcon} {programModeLabel}
                    </span>
                  </div>
                }
                items={groupedSidebarItems}
                footer={
                  <div className='flex flex-wrap items-center gap-2 px-1'>
                    <Button size='sm' variant='secondary' onClick={() => setCommandOpen(true)}>
                      <Search size={14} /> Commands
                    </Button>
                    {renderOpenProgramButton()}
                    {renderRefreshProgramButton()}
                    {renderLogoutButton()}
                  </div>
                }
                onItemClick={() => setMobileNavigationOpen(false)}
                renderLink={renderAppLink}
              />
            </div>
          ) : null}

          <div className='flex min-h-0 flex-1 flex-col pt-16 xl:pt-0'>
            <div className='flex min-h-13 shrink-0 items-center gap-2 border-b border-white/[0.08] bg-deep-sea px-3 py-2 sm:px-4'>
              <div className='min-w-0 flex-1 sm:max-w-[260px]'>{renderHeaderProgramSelector()}</div>
              <span className='hidden shrink-0 items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-text-secondary sm:inline-flex'>
                {programModeIcon} {programModeLabel}
              </span>
              <span className='hidden min-w-0 flex-1 truncate text-xs text-text-secondary lg:block'>
                {selectedProgramType === 'radio' ? 'Continuous audio playout' : selectedProgramType === 'both' ? 'Television and radio legs' : 'Preview and Program switching'}
              </span>
              <Button size='xs' variant='ghost' onClick={() => setCommandOpen(true)} aria-label='Open command menu'>
                <Search size={14} />
                <span className='hidden lg:inline'>Commands</span>
              </Button>
              {renderOpenProgramButton()}
              {renderRefreshProgramButton()}
            </div>

            <main className={`min-h-0 flex-1 ${isViewportConstrainedRoute ? 'overflow-hidden' : 'overflow-y-auto'}`}>
              <div className={isViewportConstrainedRoute ? 'flex h-full min-h-0 flex-col overflow-hidden' : ''}>
                <Outlet />
              </div>
            </main>
          </div>
        </div>
      </div>
      <Modal
        isOpen={showBroadcastTimeModal}
        onClose={() => {
          if (!isSavingBroadcastTime) {
            setShowBroadcastTimeModal(false);
          }
        }}
        title='Global Broadcast Time Override'
      >
        <div className='space-y-5'>
          <p className='text-sm text-text-secondary dark:text-text-secondary'>
            Applies to all programs and scenes for clock widgets.
            <br />
            {broadcastSettings?.timeOverrideEnabled
              ? `Active from ${broadcastSettings.timeOverrideStartTime || '--:--'} (started ${new Date(broadcastSettings.timeOverrideStartedAt || Date.now()).toLocaleString()})`
              : 'Disabled (clocks use live timezone time).'}
          </p>

          <div>
            <label htmlFor='globalBroadcastTimeOverride' className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>
              Start Time (HH:mm)
            </label>
            <Input
              id='globalBroadcastTimeOverride'
              type='text'
              value={broadcastTimeInput}
              onChange={(event) => {
                setBroadcastTimeInput(event.target.value);
                if (broadcastTimeError) {
                  setBroadcastTimeError('');
                }
              }}
              placeholder='19:55'
              error={!!broadcastTimeError}
              autoFocus
            />
            {broadcastTimeError ? <p className='mt-2 text-sm text-terracotta'>{broadcastTimeError}</p> : null}
          </div>

          <div className='flex justify-end gap-3'>
            <Button variant='secondary' onClick={clearBroadcastTimeOverride} disabled={isSavingBroadcastTime || !broadcastSettings?.timeOverrideEnabled}>
              Disable
            </Button>
            <Button onClick={saveBroadcastTimeOverride} disabled={isSavingBroadcastTime}>
              {isSavingBroadcastTime ? 'Saving...' : 'Apply'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
