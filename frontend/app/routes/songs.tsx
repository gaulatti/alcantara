import { ArtistLabelField } from '../components/ArtistLabelField';
import { TooltipButton } from "../components/BleeckerButtons";
import { AlertContainer, Button, Card, Checkbox, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, Empty, FileInput, IconButton, Input, LoadingSpinner, Modal, Pagination, SectionHeader, Switch, showAlert } from '@gaulatti/bleecker';
import { ArrowDown, ArrowUp, ArrowUpDown, MoreHorizontal, Pencil, Play, Plus, Music2, Search, Trash2 } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import type { Route } from './+types/songs';
import { AppPage } from '../components/AppPage';
import { uploadFileToMediaBucket } from '../services/uploads';
import { apiUrl } from '../utils/apiBaseUrl';
import { fetchSongsPage } from '../services/songs';
import { fetchInstants } from '../services/instants';
import type { InstantItem, SongCatalogItem } from '../models/broadcast';
import { useGlobalProgramId } from '../utils/globalProgram';
import { SongIntroField } from '../components/editors/SongIntroField';
import { CatalogFilter } from '../components/songs/CatalogFilter';
import { Transport } from '../components/songs/PreviewTransport';
import { useSongPreview } from '../hooks/useSongPreview';
import { catalogCounts, formatLength, formatRuntime, songLengthSeconds, type LengthSource } from '../utils/songCatalog';

async function extractErrorMessage(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) {
    return `HTTP ${res.status}`;
  }

  try {
    const parsed = JSON.parse(text) as { message?: string | string[] };
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message;
    }
    if (Array.isArray(parsed.message)) {
      const joined = parsed.message.filter((value) => typeof value === 'string' && value.trim()).join(', ');
      if (joined) {
        return joined;
      }
    }
  } catch {
    // Not JSON; fallback to plain text.
  }

  return text;
}

function formatSongTitle(song: SongCatalogItem): string {
  const artist = song.artist.trim();
  const title = song.title.trim();
  if (artist && title) {
    return `${artist} - ${title}`;
  }
  return artist || title || 'Untitled song';
}

function formatSongDuration(durationMs: number | null): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 'Unknown';
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}


async function readAudioDurationFromFile(file: File): Promise<number | null> {
  const objectUrl = URL.createObjectURL(file);

  return new Promise<number | null>((resolve) => {
    const audio = new Audio();
    const cleanup = () => {
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.src = '';
      URL.revokeObjectURL(objectUrl);
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const seconds = Number(audio.duration);
      cleanup();
      if (!Number.isFinite(seconds) || seconds <= 0) {
        resolve(null);
        return;
      }
      resolve(Math.max(1, Math.round(seconds * 1000)));
    };
    audio.onerror = () => {
      cleanup();
      resolve(null);
    };
    audio.src = objectUrl;
    audio.load();
  });
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Songs - TV Broadcast' },
    {
      name: 'description',
      content: 'Manage global songs catalog for ModoItaliano sequences'
    }
  ];
}

export default function SongsCatalog() {
  const [activeProgramId] = useGlobalProgramId();
  const [songs, setSongs] = useState<SongCatalogItem[]>([]);
  const [instants, setInstants] = useState<InstantItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [selectedSongId, setSelectedSongId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const preview = useSongPreview();
  const [toggleNotice, setToggleNotice] = useState<{ song: SongCatalogItem; enabled: boolean } | null>(null);
  const [sortBy, setSortBy] = useState('artist');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogEnabled, setCatalogEnabled] = useState(0);
  const [catalogTotalDurationMs, setCatalogTotalDurationMs] = useState(0);
  const [catalogKnownDurationCount, setCatalogKnownDurationCount] = useState(0);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSong, setEditingSong] = useState<SongCatalogItem | null>(null);
  const [artistInput, setArtistInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [audioUrlInput, setAudioUrlInput] = useState('');
  const [coverUrlInput, setCoverUrlInput] = useState('');
  const [durationMsInput, setDurationMsInput] = useState('');
  const [earoneSongIdInput, setEaroneSongIdInput] = useState('');
  const [earoneRankInput, setEaroneRankInput] = useState('');
  const [earoneSpinsInput, setEaroneSpinsInput] = useState('');
  const [enabledInput, setEnabledInput] = useState(true);
  const [introInstantIdInput, setIntroInstantIdInput] = useState('');
  const [previewingIntroId, setPreviewingIntroId] = useState<number | null>(null);
  const [songFile, setSongFile] = useState<File | null>(null);
  const [isUploadingSong, setIsUploadingSong] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [batchItems, setBatchItems] = useState<
    Array<{
      name: string;
      status: 'pending' | 'uploading' | 'done' | 'error';
      error?: string;
    }>
  >([]);

  const fetchSongs = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await fetchSongsPage({
        search: debouncedSearch || undefined,
        ...(enabledFilter !== 'all' ? { enabled: enabledFilter === 'enabled' } : {}),
        sortBy,
        sortOrder,
        page,
        programId: activeProgramId
      });
      setSongs(result.data);
      setTotalPages(result.meta.totalPages);
      setTotalCount(result.meta.total);
      setCatalogTotal(result.meta.catalogTotal);
      setCatalogEnabled(result.meta.catalogEnabled);
      setCatalogTotalDurationMs(result.meta.catalogTotalDurationMs);
      setCatalogKnownDurationCount(result.meta.catalogKnownDurationCount);
    } catch (err) {
      console.error('Failed to load songs:', err);
      showAlert('Failed to load songs catalog.', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [debouncedSearch, enabledFilter, sortBy, sortOrder, page, activeProgramId]);

  const loadInstants = useCallback(async () => {
    setInstants(await fetchInstants(activeProgramId));
  }, [activeProgramId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, enabledFilter, sortBy, sortOrder]);

  useEffect(() => {
    fetchSongs();
  }, [fetchSongs]);

  useEffect(() => {
    void loadInstants().catch((err) => {
      console.error('Failed to load song intro assets:', err);
      showAlert('Failed to load audio clips for song intros.', 'error');
    });
  }, [loadInstants]);

  const handleSort = (field: string) => {
    if (sortBy === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortOrder('asc');
    }
  };

  const SortHeader = ({ field, children }: { field: string; children: React.ReactNode }) => {
    const isActive = sortBy === field;
    return (
      <TooltipButton
        type='button'
        onClick={() => handleSort(field)}
        className='inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-widest text-text-secondary dark:text-text-secondary hover:text-sea dark:hover:text-sea transition-colors'
      >
        {children}
        {isActive ? sortOrder === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={12} className='opacity-30' />}
      </TooltipButton>
    );
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingSong(null);
    setArtistInput('');
    setTitleInput('');
    setAudioUrlInput('');
    setCoverUrlInput('');
    setDurationMsInput('');
    setEaroneSongIdInput('');
    setEaroneRankInput('');
    setEaroneSpinsInput('');
    setEnabledInput(true);
    setIntroInstantIdInput('');
    setPreviewingIntroId(null);
    setSongFile(null);
    setError('');
    setIsUploadingSong(false);
    setIsUploadingCover(false);
    setIsSaving(false);
    setBatchItems([]);
  };

  const batchCreateSongs = async (files: File[]) => {
    /* v8 ignore next -- the only caller, the batch picker's change handler, calls this only when files.length > 0; this guard is defensive. */
    if (files.length === 0) return;
    setBatchItems(files.map((f) => ({ name: f.name, status: 'pending' })));
    let anyDone = false;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setBatchItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: 'uploading' } : item)));
      try {
        const upload = await uploadFileToMediaBucket('song', file);
        const fallbackDurationMs = await readAudioDurationFromFile(file);
        const artist = (typeof upload.metadata?.artist === 'string' ? upload.metadata.artist.trim() : '') || file.name.replace(/\.[^.]+$/, '');
        const title = typeof upload.metadata?.title === 'string' ? upload.metadata.title.trim() : '';
        const coverUrl = typeof upload.metadata?.coverUrl === 'string' ? upload.metadata.coverUrl.trim() : '';
        const durationMs =
          typeof upload.metadata?.durationMs === 'number' && Number.isFinite(upload.metadata.durationMs) && upload.metadata.durationMs > 0
            ? Math.round(upload.metadata.durationMs)
            : fallbackDurationMs;
        const res = await fetch(apiUrl('/songs'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artist,
            title,
            audioUrl: upload.url,
            coverUrl: coverUrl || null,
            durationMs: durationMs ?? null,
            enabled: true
          })
        });
        if (!res.ok) throw new Error(await extractErrorMessage(res));
        setBatchItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: 'done' } : item)));
        anyDone = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setBatchItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, status: 'error', error: msg } : item)));
      }
    }
    if (anyDone) await fetchSongs();
  };

  const openCreateModal = () => {
    closeModal();
    setIsModalOpen(true);
  };

  const openEditModal = (song: SongCatalogItem) => {
    setEditingSong(song);
    setArtistInput(song.artist);
    setTitleInput(song.title);
    setAudioUrlInput(song.audioUrl);
    setCoverUrlInput(song.coverUrl || '');
    setDurationMsInput(song.durationMs ? String(song.durationMs) : '');
    setEaroneSongIdInput(song.earoneSongId || '');
    setEaroneRankInput(song.earoneRank || '');
    setEaroneSpinsInput(song.earoneSpins || '');
    setEnabledInput(song.enabled);
    setIntroInstantIdInput(song.intro ? String(song.intro.instantId) : '');
    setSongFile(null);
    setError('');
    setIsModalOpen(true);
  };

  // The preview plays in this browser only: a local audio element, never the program's output.
  const playSongPreview = (song: SongCatalogItem) => {
    setSelectedSongId(song.id);
    preview.toggle(song);
  };

  const selectSong = (song: SongCatalogItem) => {
    setSelectedSongId(song.id);
    if (preview.currentId !== song.id) preview.load(song);
  };

  const setSongEnabled = async (song: SongCatalogItem, enabled: boolean, undoing = false) => {
    // A change by the switch or the E key is announced, with an Undo, so a stray key is visible.
    setToggleNotice(undoing ? null : { song, enabled });
    // The change is applied to the row at once and undone if the server refuses it.
    setSongs((current) => current.map((entry) => (entry.id === song.id ? { ...entry, enabled } : entry)));
    try {
      const res = await fetch(apiUrl(`/songs/${song.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!res.ok) throw new Error(await extractErrorMessage(res));
      await fetchSongs();
    } catch (err) {
      setSongs((current) => current.map((entry) => (entry.id === song.id ? { ...entry, enabled: song.enabled } : entry)));
      setToggleNotice(null);
      showAlert(err instanceof Error ? err.message : 'Failed to update the song.', 'error');
    }
  };

  useEffect(() => {
    if (!toggleNotice) return;
    const timer = setTimeout(() => setToggleNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [toggleNotice]);

  // The desk's keys on this page: / searches, and a selected row takes the arrows, Space and E.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (typing || isModalOpen) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const index = songs.findIndex((song) => song.id === selectedSongId);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const next = songs[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (index >= 0 && next) {
          event.preventDefault();
          selectSong(next);
        } else if (index < 0 && songs[0]) {
          event.preventDefault();
          selectSong(songs[0]);
        }
      } else if (event.key === ' ' && index >= 0 && !(target instanceof HTMLButtonElement)) {
        event.preventDefault();
        preview.toggle(songs[index]);
      } else if ((event.key === 'e' || event.key === 'E') && index >= 0) {
        event.preventDefault();
        void setSongEnabled(songs[index], !songs[index].enabled);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Takes the file just picked: the songFile state is not updated yet when the
  // picker's change handler calls this.
  const uploadSongFile = async (file: File) => {
    setIsUploadingSong(true);
    setError('');
    try {
      const upload = await uploadFileToMediaBucket('song', file);
      const fallbackDurationMs = await readAudioDurationFromFile(file);
      setAudioUrlInput(upload.url);
      if (typeof upload.metadata?.artist === 'string' && upload.metadata.artist.trim()) {
        setArtistInput(upload.metadata.artist.trim());
      }
      if (typeof upload.metadata?.title === 'string' && upload.metadata.title.trim()) {
        setTitleInput(upload.metadata.title.trim());
      }
      if (typeof upload.metadata?.coverUrl === 'string' && upload.metadata.coverUrl.trim()) {
        setCoverUrlInput(upload.metadata.coverUrl.trim());
      }
      const durationMs =
        typeof upload.metadata?.durationMs === 'number' && Number.isFinite(upload.metadata.durationMs) && upload.metadata.durationMs > 0 ? Math.round(upload.metadata.durationMs) : fallbackDurationMs;
      if (typeof durationMs === 'number' && durationMs > 0) {
        setDurationMsInput(String(durationMs));
      }
      showAlert('Song file uploaded.', 'success');
    } catch (err) {
      console.error('Failed to upload song file:', err);
      setError('Failed to upload song file.');
      showAlert('Failed to upload song file.', 'error');
    } finally {
      setIsUploadingSong(false);
    }
  };

  const uploadCoverFile = async (file: File | null) => {
    if (!file) {
      return;
    }

    setIsUploadingCover(true);
    setError('');
    try {
      const upload = await uploadFileToMediaBucket('artwork', file);
      setCoverUrlInput(upload.url);
      showAlert('Cover uploaded.', 'success');
    } catch (err) {
      console.error('Failed to upload cover:', err);
      setError('Failed to upload cover file.');
      showAlert('Failed to upload cover file.', 'error');
    } finally {
      setIsUploadingCover(false);
    }
  };

  const saveSong = async () => {
    const artist = artistInput.trim();
    const title = titleInput.trim();
    const audioUrl = audioUrlInput.trim();
    const coverUrl = coverUrlInput.trim();
    const durationMsRaw = durationMsInput.trim();
    const durationMs = durationMsRaw ? Number(durationMsRaw) : null;

    if (!audioUrl) {
      setError('Audio URL is required. Upload a song file first.');
      return;
    }

    if (!artist && !title) {
      setError('Artist or title is required.');
      return;
    }

    /* v8 ignore next -- durationMs is Number(durationMsRaw) whenever the raw text is non-empty, so it is never null here and the `?? 0` fallback cannot run; this line also holds the reached `<= 0` check that the zero-duration test covers. */
    if (durationMsRaw && (!Number.isFinite(durationMs) || (durationMs ?? 0) <= 0)) {
      setError('Duration must be a positive number in milliseconds.');
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      const isEditing = Boolean(editingSong);
      /* v8 ignore next 2 -- the add dialog offers only the batch picker (which creates songs itself) and no Audio URL field, so saveSong is reached only from the edit dialog, where isEditing holds; the create branch is unreachable from the UI. */
      const endpoint = isEditing ? apiUrl(`/songs/${editingSong!.id}`) : apiUrl('/songs');
      const method = isEditing ? 'PUT' : 'POST';
      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artist,
          title,
          audioUrl,
          coverUrl: coverUrl || null,
          durationMs: durationMsRaw ? Math.max(1, Math.round(durationMs!)) : null,
          earoneSongId: earoneSongIdInput.trim() || null,
          earoneRank: earoneRankInput.trim() || null,
          earoneSpins: earoneSpinsInput.trim() || null,
          enabled: enabledInput,
          programId: activeProgramId,
          introInstantId: introInstantIdInput ? Number(introInstantIdInput) : null
        })
      });

      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      await fetchSongs();
      await loadInstants();
      closeModal();
      /* v8 ignore next -- the create branch of saveSong is unreachable from the UI (see the endpoint marker above). */
      showAlert(isEditing ? 'Song updated.' : 'Song created.', 'success');
    } catch (err) {
      console.error('Failed to save song:', err);
      const message = err instanceof Error ? err.message : 'Failed to save song.';
      setError(message);
      showAlert(message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSong = async (song: SongCatalogItem) => {
    if (!confirm(`Delete song "${formatSongTitle(song)}"?`)) {
      return;
    }

    try {
      const res = await fetch(apiUrl(`/songs/${song.id}`), {
        method: 'DELETE'
      });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }
      await fetchSongs();
      showAlert('Song deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete song:', err);
      showAlert('Failed to delete song.', 'error');
    }
  };

  const counts = catalogCounts({ catalogTotal, catalogEnabled, catalogKnownDurationCount });
  const songsWithIntro = songs.filter((song) => song.intro).length;

  return (
    <AppPage width='wide'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Song catalog' description='Global library used by ModoItaliano song sequences.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Add song
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4' data-testid='catalog-strip'>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary'>Songs</span>
              <p className='mt-1 font-mono text-2xl font-semibold tabular-nums text-text-primary'>{counts.total}</p>
              <p className='text-xs text-text-secondary'>{counts.enabled} enabled</p>
            </div>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary'>With length</span>
              <p className='mt-1 font-mono text-2xl font-semibold tabular-nums text-text-primary'>
                {counts.withLength} <span className='text-sm font-normal text-text-secondary'>of {counts.total}</span>
              </p>
              <p className='text-xs text-text-secondary'>
                {counts.withoutLength === 0 ? 'Every song has a stored length' : `${counts.withoutLength} ${counts.withoutLength === 1 ? 'has' : 'have'} no stored length`}
              </p>
            </div>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary'>Runtime</span>
              <p className='mt-1 font-mono text-2xl font-semibold tabular-nums text-text-primary'>{counts.withLength === 0 ? '—' : formatRuntime(catalogTotalDurationMs)}</p>
              <p className='text-xs text-text-secondary'>h:mm, known lengths only</p>
            </div>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary'>With intro</span>
              <p className='mt-1 font-mono text-2xl font-semibold tabular-nums text-text-primary'>{songsWithIntro}</p>
              <p className='text-xs text-text-secondary'>of {songs.length} listed on this page</p>
            </div>
          </div>

          {toggleNotice ? (
            <p role='status' className='flex items-center gap-3 rounded-lg border border-sand/30 bg-dark-sand/60 px-3 py-2 text-sm text-text-primary'>
              <span>
                {toggleNotice.enabled ? 'Enabled' : 'Disabled'} {formatSongTitle(toggleNotice.song)}
              </span>
              <button
                type='button'
                className='font-semibold text-sea hover:underline'
                onClick={() => {
                  const { song, enabled } = toggleNotice;
                  setToggleNotice(null);
                  void setSongEnabled(song, !enabled, true);
                }}
              >
                Undo
              </button>
            </p>
          ) : null}

          <div className='flex flex-col gap-3 md:flex-row md:items-center'>
            <div className='flex-1'>
              <Input
                type='text'
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                }}
                ref={searchRef}
                placeholder='Search by artist, title, or EarOne ID'
                startIcon={<Search size={14} className='text-text-secondary dark:text-text-secondary' />}
              />
            </div>
            <CatalogFilter
              label='Show songs'
              value={enabledFilter}
              onChange={setEnabledFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'enabled', label: 'Enabled' },
                { value: 'disabled', label: 'Disabled' }
              ]}
            />
          </div>

          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading songs...</p>
            </div>
          ) : catalogTotal === 0 ? (
            <Empty title='No songs yet' description='Upload your first song into the global catalog.' action={<Button onClick={openCreateModal}>Add song</Button>} />
          ) : totalCount === 0 ? (
            <Empty
              title='No songs match this search'
              description='Try another artist, title or EarOne ID, or show all songs.'
              action={
                <Button
                  variant='secondary'
                  onClick={() => {
                    setSearchQuery('');
                    setEnabledFilter('all');
                  }}
                >
                  Clear Filters
                </Button>
              }
            />
          ) : (
            <>
              <div className='space-y-3 md:hidden'>
                {songs.map((song, index) => (
                  <article
                    key={song.id}
                    className={`rounded-[var(--radius-card)] border border-sand/25 bg-white/80 p-4 dark:border-white/10 dark:bg-dark-sand/60 ${!song.enabled ? 'opacity-60' : ''}`}
                  >
                    <div className='flex gap-3'>
                      <div className='h-12 w-12 shrink-0 overflow-hidden rounded-md border border-sand/30 bg-sand/10 dark:border-sand/45 dark:bg-dark-sand'>
                        {song.coverUrl ? (
                          <img src={song.coverUrl} alt='' className='h-full w-full object-cover' />
                        ) : (
                          <div className='flex h-full w-full items-center justify-center'>
                            <Music2 size={16} className='text-text-secondary/40' />
                          </div>
                        )}
                      </div>
                      <div className='min-w-0 flex-1'>
                        <p className='truncate font-medium text-text-primary'>{song.title || 'Untitled'}</p>
                        <p className='truncate text-sm text-text-secondary'>{song.artist || 'Unknown artist'}</p>
                        <p className='mt-1 text-xs text-text-secondary'>
                          #{(page - 1) * 50 + index + 1} · {formatSongDuration(song.durationMs)} · {song.intro ? 'Intro assigned' : 'No intro'}
                        </p>
                      </div>
                    </div>
                    <div className='mt-3 grid grid-cols-3 gap-2'>
                      <Button size='sm' variant='secondary' onClick={() => playSongPreview(song)}>
                        <Play size={14} /> Preview
                      </Button>
                      <Button size='sm' variant='secondary' onClick={() => openEditModal(song)}>
                        <Pencil size={14} /> Edit
                      </Button>
                      <Button size='sm' variant='destructive' onClick={() => void deleteSong(song)}>
                        <Trash2 size={14} /> Delete
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              <div className='hidden overflow-hidden rounded-xl border border-sand/20 dark:border-sand/40 md:block'>
                <div className='grid grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_5rem_3.5rem_2.5rem] items-center gap-2 border-b border-sand/20 bg-sand/5 px-3 py-2 dark:border-sand/35 dark:bg-dark-sand/40'>
                  <span />
                  <SortHeader field='title'>Title</SortHeader>
                  <SortHeader field='artist'>Artist</SortHeader>
                  <div className='text-right'>
                    <SortHeader field='durationMs'>Length</SortHeader>
                  </div>
                  <span className='text-[11px] font-semibold uppercase tracking-widest text-text-secondary'>Intro</span>
                  <span className='text-[11px] font-semibold uppercase tracking-widest text-text-secondary'>On</span>
                  <span />
                </div>
                <div className='divide-y divide-sand/15 dark:divide-sand/25'>
                  {songs.map((song) => {
                    const seconds = songLengthSeconds(song as unknown as LengthSource);
                    const isSelected = song.id === selectedSongId;
                    const isPlaying = isSelected && preview.currentId === song.id && preview.playing;
                    return (
                      <div
                        key={song.id}
                        role='row'
                        aria-selected={isSelected}
                        onClick={() => selectSong(song)}
                        className={`group grid grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_5.5rem_5rem_3.5rem_2.5rem] items-center gap-2 px-3 py-2 transition-colors ${isSelected ? 'bg-sea/10' : 'hover:bg-sand/10 dark:hover:bg-dark-sand/50'} ${!song.enabled ? 'opacity-60' : ''}`}
                      >
                        <div className='h-9 w-9 shrink-0 overflow-hidden rounded-md border border-sand/30 bg-sand/10 dark:border-sand/45 dark:bg-dark-sand'>
                          {song.coverUrl ? (
                            <img src={song.coverUrl} alt='' className='h-full w-full object-cover' />
                          ) : (
                            <div className='flex h-full w-full items-center justify-center'>
                              <Music2 size={14} className='text-text-secondary/40' />
                            </div>
                          )}
                        </div>
                        <div className='min-w-0'>
                          <div className='flex items-center gap-2 truncate text-sm font-medium text-text-primary'>
                            <span className='truncate'>{song.title || 'Untitled'}</span>
                            {isPlaying ? <span className='text-[10px] font-semibold uppercase text-sea'>Previewing</span> : null}
                          </div>
                          <div className='truncate text-[11px] text-text-secondary'>
                            {song.earoneSongId ? `EarOne ${song.earoneSongId}${song.earoneRank ? ` · rank ${song.earoneRank}` : ''}` : 'No EarOne ID'}
                          </div>
                        </div>
                        <div className='min-w-0'>
                          <Button
                            type='button'
                            variant='ghost'
                            size='sm'
                            onClick={(event) => {
                              event.stopPropagation();
                              setSearchQuery(song.artist || '');
                            }}
                            className='h-auto max-w-full justify-start truncate p-0 text-left text-sm font-normal text-text-secondary transition-colors hover:bg-transparent hover:text-sea'
                            title={`Filter by ${song.artist}`}
                          >
                            {song.artist || '—'}
                          </Button>
                        </div>
                        <span className='text-right font-mono text-xs tabular-nums'>
                          {seconds === null ? <span className='text-amber-300'>no length</span> : <span className='text-text-secondary'>{formatLength(seconds)}</span>}
                        </span>
                        <span className='text-xs text-text-secondary'>
                          {song.intro ? <span title={song.intro.instant.name} className='rounded-full border border-sea/30 bg-sea/10 px-2 py-0.5 text-[11px] font-medium text-sea'>Intro</span> : '—'}
                        </span>
                        <span onClick={(event) => event.stopPropagation()}>
                          <Switch
                            checked={song.enabled}
                            aria-label={`${song.enabled ? 'Disable' : 'Enable'} ${formatSongTitle(song)}`}
                            onCheckedChange={(checked) => void setSongEnabled(song, checked)}
                          />
                        </span>
                        <span onClick={(event) => event.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton aria-label={`Actions for ${formatSongTitle(song)}`} title='Edit or delete'>
                                <MoreHorizontal size={14} />
                              </IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align='end'>
                              <DropdownMenuItem onSelect={() => openEditModal(song)}>
                                <Pencil size={14} className='mr-2' /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void deleteSong(song)}>
                                <Trash2 size={14} className='mr-2' /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <Pagination currentPage={page} totalPages={totalPages} hasNextPage={page < totalPages} hasPrevPage={page > 1} onPageChange={setPage} />
              {(() => {
                const loaded = songs.find((song) => song.id === (preview.currentId ?? selectedSongId)) ?? null;
                const index = loaded ? songs.indexOf(loaded) : -1;
                return (
                  <Transport
                    title={loaded ? formatSongTitle(loaded) : 'Nothing loaded'}
                    subtitle={preview.error ?? 'Preview plays in this browser only, never on air.'}
                    position={preview.position}
                    duration={loaded ? (preview.length ?? songLengthSeconds(loaded as unknown as LengthSource)) : null}
                    playing={preview.playing}
                    disabled={!loaded}
                    onToggle={() => loaded && preview.toggle(loaded)}
                    onSeek={preview.seek}
                    onPrev={index > 0 ? () => selectSong(songs[index - 1]) : undefined}
                    onNext={index >= 0 && index < songs.length - 1 ? () => selectSong(songs[index + 1]) : undefined}
                  />
                );
              })()}
            </>
          )}
        </Card>
      </div>

      <Modal isOpen={isModalOpen} onClose={closeModal} title={editingSong ? 'Edit song' : 'Add song'}>
        <div className='space-y-4'>
          {!editingSong ? (
            <>
              <div className='space-y-2 rounded-xl border-2 border-dashed border-sand/40 bg-sand/5 px-6 py-6 text-center dark:border-sand/50 dark:bg-dark-sand/30'>
                <Music2 size={28} className='text-text-secondary dark:text-text-secondary' />
                <FileInput
                  accept='audio/*'
                  multiple
                  disabled={batchItems.some((i) => i.status === 'uploading')}
                  onChange={(event) => {
                    /* v8 ignore next -- a file input's files is always a FileList, never null, so the ?? [] fallback cannot run in a browser; defensive. */
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    if (files.length > 0) void batchCreateSongs(files);
                  }}
                />
                <span className='text-xs text-text-secondary dark:text-text-secondary'>Multiple files supported — metadata read automatically</span>
              </div>

              {batchItems.length > 0 && (
                <ul className='space-y-1.5'>
                  {batchItems.map((item, idx) => (
                    <li key={idx} className='flex items-center gap-2 rounded-lg border border-sand/30 bg-white/60 px-3 py-2 text-sm dark:border-sand/40 dark:bg-dark-sand/50'>
                      <span
                        className={`shrink-0 text-base ${item.status === 'done' ? '' : item.status === 'error' ? 'text-terracotta' : item.status === 'uploading' ? 'text-sea ' : 'text-text-secondary'}`}
                      >
                        {item.status === 'done' ? '✓' : item.status === 'error' ? '✗' : item.status === 'uploading' ? '⟳' : '·'}
                      </span>
                      <span className='min-w-0 flex-1 truncate text-text-primary dark:text-text-primary'>{item.name}</span>
                      {item.error && <span className='shrink-0 text-xs text-terracotta'>{item.error}</span>}
                    </li>
                  ))}
                </ul>
              )}

              <div className='flex justify-end gap-3'>
                <Button variant='secondary' onClick={closeModal}>
                  {batchItems.length > 0 && batchItems.every((i) => i.status === 'done' || i.status === 'error') ? 'Done' : 'Cancel'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className='rounded-xl border border-sand/30 bg-sand/5 p-3 space-y-2'>
                <FileInput
                  accept='audio/*'
                  disabled={isUploadingSong || isSaving}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    event.target.value = '';
                    if (file) {
                      setSongFile(file);
                      void uploadSongFile(file);
                    }
                  }}
                />
                <p className='text-xs text-text-secondary dark:text-text-secondary'>{isUploadingSong ? 'Uploading…' : songFile ? `Replace: ${songFile.name}` : 'Replace song file'}</p>
              </div>

              <div className='grid gap-3 sm:grid-cols-2'>
                <div>
                  <label className='mb-1 block text-xs '>Artist</label>
                  <Input type='text' value={artistInput} onChange={(event) => setArtistInput(event.target.value)} />
                </div>
                <div>
                  <label className='mb-1 block text-xs '>Title</label>
                  <Input type='text' value={titleInput} onChange={(event) => setTitleInput(event.target.value)} />
                </div>
              </div>

              <ArtistLabelField artist={artistInput} />

              <div>
                <label className='mb-1 block text-xs '>Audio URL</label>
                <Input type='text' value={audioUrlInput} onChange={(event) => setAudioUrlInput(event.target.value)} placeholder='Uploaded automatically after song upload' />
              </div>

              <div className='grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end'>
                <div className='flex-1'>
                  <label className='mb-1 block text-xs '>Cover URL</label>
                  <Input type='text' value={coverUrlInput} onChange={(event) => setCoverUrlInput(event.target.value)} />
                </div>
                <div className='space-y-1'>
                  <FileInput
                    accept='image/*'
                    disabled={isUploadingCover || isSaving}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = '';
                      void uploadCoverFile(file);
                    }}
                  />
                  <p className='text-xs text-text-secondary dark:text-text-secondary'>{isUploadingCover ? 'Uploading cover…' : 'Upload cover image'}</p>
                </div>
              </div>

              <div className='grid gap-3 sm:grid-cols-2'>
                <div>
                  <label className='mb-1 block text-xs '>Duration (ms)</label>
                  <Input type='number' min={1} value={durationMsInput} onChange={(event) => setDurationMsInput(event.target.value)} />
                </div>
                <div className='mt-7 flex items-center'>
                  <Checkbox checked={enabledInput} onChange={(event) => setEnabledInput(event.target.checked)} label='Enabled' />
                </div>
              </div>

              <div className='grid gap-3 sm:grid-cols-3'>
                <div>
                  <label className='mb-1 block text-xs '>EarOne Song ID</label>
                  <Input type='text' value={earoneSongIdInput} onChange={(event) => setEaroneSongIdInput(event.target.value)} />
                </div>
                <div>
                  <label className='mb-1 block text-xs '>EarOne Rank</label>
                  <Input type='text' value={earoneRankInput} onChange={(event) => setEaroneRankInput(event.target.value)} />
                </div>
                <div>
                  <label className='mb-1 block text-xs '>EarOne Spins</label>
                  <Input type='text' value={earoneSpinsInput} onChange={(event) => setEaroneSpinsInput(event.target.value)} />
                </div>
              </div>

              <SongIntroField
                instants={instants}
                songId={editingSong.id}
                currentIntroInstantId={editingSong.intro?.instantId}
                selectedInstantId={introInstantIdInput}
                previewing={previewingIntroId === Number(introInstantIdInput)}
                onChange={setIntroInstantIdInput}
                onPreview={(instant) => {
                  const audio = new Audio(instant.audioUrl);
                  setPreviewingIntroId(instant.id);
                  const clear = () => setPreviewingIntroId(null);
                  audio.onended = clear;
                  audio.onerror = clear;
                  void audio.play().catch(clear);
                }}
              />

              {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

              <div className='flex justify-end gap-3'>
                <Button variant='secondary' onClick={closeModal} disabled={isSaving || isUploadingSong || isUploadingCover}>
                  Cancel
                </Button>
                <Button onClick={() => void saveSong()} disabled={isSaving || isUploadingSong || isUploadingCover}>
                  {isSaving ? 'Saving...' : 'Update Song'}
                </Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </AppPage>
  );
}
