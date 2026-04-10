import {
  AppShell,
  CommandSpotlight,
  Footer as BleeckerFooter,
  Header as BleeckerHeader,
  HeaderSelect,
  Input,
  Button,
  Modal,
  ThemeToggle,
  type CommandSpotlightAction,
  type NavItem,
  type RenderLinkProps
} from '@gaulatti/bleecker';
import { Blend, CircleOff, Clock3, Clapperboard, Eye, Home, Images, LayoutTemplate, LogOut, Music, Radio, SlidersHorizontal, Tv, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { apiUrl } from '../utils/apiBaseUrl';
import { useGlobalProgramId } from '../utils/globalProgram';
import { useGlobalTransitionId } from '../utils/globalTransition';
import { SCENE_TRANSITIONS, getSceneTransitionPreset } from '../utils/sceneTransitions';
import { useLogout } from '../hooks/useAuth';

const GITHUB_REPO_URL = 'https://github.com/gaulatti/alcantara';

interface ProgramSummary {
  programId: string;
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

function renderAppLink({ children, className, item, onClick }: RenderLinkProps<NavItem>) {
  if (item.external) {
    return (
      <a href={item.href} className={className} onClick={onClick} target='_blank' rel='noopener noreferrer'>
        {children}
      </a>
    );
  }

  return (
    <Link to={item.href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout } = useLogout();
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
  const selectedTransition = getSceneTransitionPreset(selectedTransitionId);

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
    const uniqueProgramIds = Array.from(new Set([selectedProgramId, ...knownPrograms.map((program) => program.programId)]));
    return uniqueProgramIds.filter(Boolean).map((programIdValue) => ({
      label: programIdValue,
      value: programIdValue
    }));
  }, [knownPrograms, selectedProgramId]);

  const navigation: NavItem[] = [
    { href: '/', label: 'Home' },
    { href: '/control', label: 'Control' },
    { href: '/instants', label: 'Instants' },
    { href: '/songs', label: 'Songs' },
    { href: '/media', label: 'Media' },
    { href: '/scenes', label: 'Scenes' },
    { href: '/programs', label: 'Programs' },
    { href: '/preview', label: 'Preview' },
    { href: '/layouts', label: 'Layouts' }
  ];

  const footerSections: Array<{ title: string; items: NavItem[] }> = [
    {
      title: 'Navigation',
      items: [
        { href: '/', label: 'Home' },
        { href: '/control', label: 'Control' },
        { href: '/instants', label: 'Instants' },
        { href: '/songs', label: 'Songs' },
        { href: '/media', label: 'Media' },
        { href: '/scenes', label: 'Scenes' },
        { href: '/programs', label: 'Programs' }
      ]
    },
    {
      title: 'Resources',
      items: [{ href: GITHUB_REPO_URL, label: 'GitHub', external: true }]
    },
    {
      title: 'Legal',
      items: [
        { href: '/privacy', label: 'Privacy Policy' },
        { href: '/terms', label: 'Terms of Service' }
      ]
    }
  ];
  const hideFooter = location.pathname === '/control';

  const renderHeaderProgramSelector = () => (
    <HeaderSelect
      value={selectedProgramId}
      onChange={(value) => {
        if (!value) return;
        setSelectedProgramId(value);
      }}
      options={programOptions}
      placeholder='Program'
      icon={<Tv size={15} className='flex-shrink-0 text-sea dark:text-accent-blue' strokeWidth={1.5} />}
      wrapperClassName='max-w-[220px]'
    />
  );

  const openProgramUrl = `/program/${encodeURIComponent(selectedProgramId)}`;
  const renderOpenProgramButton = () => (
    <a
      href={openProgramUrl}
      target='_blank'
      rel='noopener noreferrer'
      className='inline-flex items-center rounded-full border border-sand/20 bg-white px-3 py-1.5 text-sm text-text-primary transition-colors hover:bg-sand/10 dark:border-sand/50 dark:bg-dark-sand dark:text-text-primary dark:hover:bg-sand/10'
    >
      Open Program
    </a>
  );

  const renderLogoutButton = () => (
    <Button variant='destructive' size='sm' onClick={logout}>
      <LogOut size={15} strokeWidth={1.5} />
      <span>Logout</span>
    </Button>
  );

  const commandActions = useMemo<CommandSpotlightAction[]>(() => {
    const selectedProgramPath = `/program/${encodeURIComponent(selectedProgramId)}`;
    const selectedProgramTitle = `Open Program Output (${selectedProgramId})`;
    const selectedProgramQuery = `programId=${encodeURIComponent(selectedProgramId)}`;

    const baseActions: CommandSpotlightAction[] = [
      {
        id: 'nav-home',
        title: 'Go to Home',
        description: 'Return to dashboard home',
        group: 'Navigation',
        icon: <Home size={16} />,
        onSelect: () => navigate('/')
      },
      {
        id: 'nav-control',
        title: 'Go to Control',
        description: 'Open the live control panel',
        group: 'Navigation',
        icon: <SlidersHorizontal size={16} />,
        onSelect: () => navigate('/control')
      },
      {
        id: 'nav-instants',
        title: 'Go to Instants',
        description: 'Manage instant audio triggers for selected program',
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
        id: 'nav-programs',
        title: 'Go to Programs',
        description: 'Manage create/edit/delete for programs',
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
        title: 'Go to Layouts',
        description: 'Manage reusable layouts',
        group: 'Navigation',
        icon: <LayoutTemplate size={16} />,
        onSelect: () => navigate('/layouts')
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
          window.open(selectedProgramPath, '_blank', 'noopener,noreferrer');
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
        onSelect: () => navigate('/control')
      },
      {
        id: 'open-broadcast-time-override',
        title: 'Set Global Broadcast Time Override',
        description: broadcastSettings?.timeOverrideEnabled
          ? `Active from ${broadcastSettings.timeOverrideStartTime || '--:--'}`
          : 'Disabled (clocks use live timezone time)',
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
      icon: <Tv size={16} />,
      onSelect: () => setSelectedProgramId(option.value)
    }));

    const sceneTakeActions: CommandSpotlightAction[] = knownScenes.map((scene) => ({
      id: `scene-take-${scene.id}`,
      title: `Take Scene: ${scene.name}`,
      description: `${scene.layout?.name || 'No layout'} · ${selectedProgramId} · ${selectedTransition.name}`,
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

        const activateRes = await fetch(apiUrl(`/program/${encodeURIComponent(selectedProgramId)}/activate`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sceneId: scene.id, transitionId: selectedTransition.id })
        });
        if (!activateRes.ok) {
          throw new Error(`Failed to activate scene (${activateRes.status})`);
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

    return [...baseActions, ...selectProgramActions, ...sceneTakeActions, ...transitionActions, ...instantActions];
  }, [
    knownInstants,
    knownScenes,
    broadcastSettings,
    clearBroadcastTimeOverride,
    loadBroadcastSettings,
    navigate,
    programOptions,
    selectedProgramId,
    selectedTransition,
    setSelectedProgramId,
    setSelectedTransitionId
  ]);

  return (
    <>
      <CommandSpotlight
        actions={commandActions}
        showTrigger={false}
        placeholder='Search pages, programs, scenes, transitions, and broadcast...'
        emptyMessage='No commands found.'
      />
      <AppShell
        className='antialiased'
        header={
          <BleeckerHeader
            brand={{
              href: '/',
              logoAlt: 'alcantara',
              logoSrc: '/logo.svg',
              name: 'alcantara'
            }}
            navigation={navigation}
            actions={
              <>
                {renderHeaderProgramSelector()}
                {renderOpenProgramButton()}
                <ThemeToggle />
                {renderLogoutButton()}
              </>
            }
            mobileActions={
              <>
                {renderHeaderProgramSelector()}
                {renderOpenProgramButton()}
                <ThemeToggle />
                {renderLogoutButton()}
              </>
            }
            renderLink={renderAppLink}
          />
        }
        footer={
          hideFooter ? undefined : (
            <BleeckerFooter
              brand={{
                href: '/',
                logoAlt: 'alcantara',
                logoSrc: '/logo.svg',
                name: 'alcantara',
                description: 'Advanced broadcast control.'
              }}
              sections={footerSections}
              bottomLeft={
                <>
                  © {new Date().getFullYear()}{' '}
                  <a href='https://gaulatti.com' target='_blank' rel='noopener noreferrer' className='font-semibold hover:underline underline-offset-4'>
                    gaulatti
                  </a>
                  . All rights reserved.
                </>
              }
              bottomRight={
                <a href={GITHUB_REPO_URL} target='_blank' rel='noopener noreferrer' className='hover:underline underline-offset-4'>
                  View source on GitHub
                </a>
              }
              renderLink={renderAppLink}
            />
          )
        }
      >
        <Outlet />
      </AppShell>
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
              ? `Active from ${broadcastSettings.timeOverrideStartTime || '--:--'} (started ${new Date(
                  broadcastSettings.timeOverrideStartedAt || Date.now()
                ).toLocaleString()})`
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
