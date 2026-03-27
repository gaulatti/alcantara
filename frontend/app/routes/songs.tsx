import { AlertContainer, Button, Card, Empty, IconButton, LoadingSpinner, Modal, SectionHeader, showAlert } from '@gaulatti/bleecker';
import { Pencil, Play, Plus, Music2, Search, Trash2 } from 'lucide-react';
import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/songs';
import { uploadFileToMediaBucket } from '../services/uploads';
import { apiUrl } from '../utils/apiBaseUrl';

interface SongItem {
  id: number;
  artist: string;
  title: string;
  audioUrl: string;
  coverUrl: string | null;
  durationMs: number | null;
  earoneSongId: string | null;
  earoneRank: string | null;
  earoneSpins: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

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

function formatSongTitle(song: SongItem): string {
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

function formatLastUpdatedLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
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
  return [{ title: 'Songs - TV Broadcast' }, { name: 'description', content: 'Manage global songs catalog for ModoItaliano sequences' }];
}

export default function SongsCatalog() {
  const navigate = useNavigate();
  const [songs, setSongs] = useState<SongItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDisabledSongs, setShowDisabledSongs] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSong, setEditingSong] = useState<SongItem | null>(null);
  const [artistInput, setArtistInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [audioUrlInput, setAudioUrlInput] = useState('');
  const [coverUrlInput, setCoverUrlInput] = useState('');
  const [durationMsInput, setDurationMsInput] = useState('');
  const [earoneSongIdInput, setEaroneSongIdInput] = useState('');
  const [earoneRankInput, setEaroneRankInput] = useState('');
  const [earoneSpinsInput, setEaroneSpinsInput] = useState('');
  const [enabledInput, setEnabledInput] = useState(true);
  const [songFile, setSongFile] = useState<File | null>(null);
  const [isUploadingSong, setIsUploadingSong] = useState(false);
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [batchItems, setBatchItems] = useState<Array<{ name: string; status: 'pending' | 'uploading' | 'done' | 'error'; error?: string }>>([]);

  const sortedSongs = useMemo(() => [...songs].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()), [songs]);

  const filteredSongs = useMemo(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase();
    return sortedSongs.filter((song) => {
      if (!showDisabledSongs && !song.enabled) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      const haystack = [song.artist, song.title, song.earoneSongId]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [searchQuery, showDisabledSongs, sortedSongs]);

  const enabledSongCount = useMemo(() => songs.filter((song) => song.enabled).length, [songs]);
  const knownDurationCount = useMemo(
    () => songs.filter((song) => typeof song.durationMs === 'number' && Number.isFinite(song.durationMs) && song.durationMs > 0).length,
    [songs]
  );
  const totalKnownDurationMs = useMemo(
    () =>
      songs.reduce((acc, song) => {
        if (typeof song.durationMs === 'number' && Number.isFinite(song.durationMs) && song.durationMs > 0) {
          return acc + song.durationMs;
        }
        return acc;
      }, 0),
    [songs]
  );

  const fetchSongs = async () => {
    const res = await fetch(apiUrl('/songs'));
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }

    const payload = (await res.json()) as SongItem[];
    setSongs(payload);
  };

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await fetchSongs();
      } catch (err) {
        console.error('Failed to load songs:', err);
        showAlert('Failed to load songs catalog.', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, []);

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
    setSongFile(null);
    setError('');
    setIsUploadingSong(false);
    setIsUploadingCover(false);
    setIsSaving(false);
    setBatchItems([]);
  };

  const batchCreateSongs = async (files: File[]) => {
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
          body: JSON.stringify({ artist, title, audioUrl: upload.url, coverUrl: coverUrl || null, durationMs: durationMs ?? null, enabled: true })
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

  const openEditModal = (song: SongItem) => {
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
    setSongFile(null);
    setError('');
    setIsModalOpen(true);
  };

  const playSongPreview = async (song: SongItem) => {
    try {
      const audio = new Audio(song.audioUrl);
      audio.preload = 'auto';
      await audio.play();
    } catch (err) {
      console.error('Failed to play song preview:', err);
      showAlert('Failed to play song preview.', 'error');
    }
  };

  const uploadSongFile = async () => {
    if (!songFile) {
      return;
    }

    setIsUploadingSong(true);
    setError('');
    try {
      const upload = await uploadFileToMediaBucket('song', songFile);
      const fallbackDurationMs = await readAudioDurationFromFile(songFile);
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
        typeof upload.metadata?.durationMs === 'number' && Number.isFinite(upload.metadata.durationMs) && upload.metadata.durationMs > 0
          ? Math.round(upload.metadata.durationMs)
          : fallbackDurationMs;
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

    if (durationMsRaw && (!Number.isFinite(durationMs) || (durationMs ?? 0) <= 0)) {
      setError('Duration must be a positive number in milliseconds.');
      return;
    }

    setIsSaving(true);
    setError('');

    try {
      const isEditing = Boolean(editingSong);
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
          enabled: enabledInput
        })
      });

      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      await fetchSongs();
      closeModal();
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

  const deleteSong = async (song: SongItem) => {
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

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-6xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Songs Catalog' description='Global library used by ModoItaliano song sequences.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/control')}>
              Back to Control
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} />
              Add Song
            </Button>
          </div>
        </div>

        <Card className='space-y-4'>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary'>Songs</span>
              <p className='mt-1 text-2xl font-semibold text-text-primary dark:text-text-primary'>{songs.length}</p>
              <p className='text-xs text-text-secondary dark:text-text-secondary'>{enabledSongCount} enabled</p>
            </div>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary'>Duration</span>
              <p className='mt-1 text-2xl font-semibold text-text-primary dark:text-text-primary'>{formatSongDuration(totalKnownDurationMs)}</p>
              <p className='text-xs text-text-secondary dark:text-text-secondary'>{knownDurationCount} with known runtime</p>
            </div>
            <div className='rounded-xl border border-sand/25 bg-white/70 p-3 dark:border-sand/40 dark:bg-dark-sand/50'>
              <span className='text-[11px] font-semibold uppercase tracking-wide text-text-secondary dark:text-text-secondary'>View</span>
              <p className='mt-1 text-2xl font-semibold text-text-primary dark:text-text-primary'>{filteredSongs.length}</p>
              <p className='text-xs text-text-secondary dark:text-text-secondary'>matching current filters</p>
            </div>
          </div>

          <div className='flex flex-col gap-3 md:flex-row md:items-center'>
            <label className='relative block flex-1'>
              <Search size={14} className='pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary dark:text-text-secondary' />
              <input
                type='text'
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder='Search by artist, title, or EarOne ID'
                className='w-full rounded-xl border border-sand/40 bg-white py-2.5 pl-9 pr-3 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
              />
            </label>
            <label className='inline-flex items-center gap-2 rounded-xl border border-sand/30 bg-white/70 px-3 py-2 text-sm text-text-primary dark:border-sand/45 dark:bg-dark-sand/55 dark:text-text-primary'>
              <input type='checkbox' checked={showDisabledSongs} onChange={(event) => setShowDisabledSongs(event.target.checked)} />
              Show disabled songs
            </label>
          </div>

          {isLoading ? (
            <div className='flex flex-col items-center justify-center gap-3 py-10 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading songs...</p>
            </div>
          ) : sortedSongs.length === 0 ? (
            <Empty
              title='No songs yet'
              description='Upload your first song into the global catalog.'
              action={<Button onClick={openCreateModal}>Add Song</Button>}
            />
          ) : filteredSongs.length === 0 ? (
            <Empty
              title='No songs match this search'
              description='Try another artist/title query or include disabled songs.'
              action={
                <Button
                  variant='secondary'
                  onClick={() => {
                    setSearchQuery('');
                    setShowDisabledSongs(true);
                  }}
                >
                  Clear Filters
                </Button>
              }
            />
          ) : (
            <div className='overflow-hidden rounded-xl border border-sand/20 dark:border-sand/40'>
              {/* Header row */}
              <div className='grid grid-cols-[2.5rem_2rem_1fr_1fr_6rem_6rem] items-center gap-2 border-b border-sand/20 bg-sand/5 px-3 py-2 text-[11px] font-semibold uppercase tracking-widest text-text-secondary dark:border-sand/35 dark:bg-dark-sand/40 dark:text-text-secondary'>
                <span />
                <span className='text-center'>#</span>
                <span>Title</span>
                <span>Artist</span>
                <span className='text-right'>Duration</span>
                <span />
              </div>
              <div className='divide-y divide-sand/15 dark:divide-sand/25'>
                {filteredSongs.map((song, index) => (
                  <div
                    key={song.id}
                    className={`group grid grid-cols-[2.5rem_2rem_1fr_1fr_6rem_6rem] items-center gap-2 px-3 py-2 transition-colors hover:bg-sand/10 dark:hover:bg-dark-sand/50 ${!song.enabled ? 'opacity-50' : ''}`}
                  >
                    {/* Cover art */}
                    <div className='h-9 w-9 shrink-0 overflow-hidden rounded-md border border-sand/30 bg-sand/10 dark:border-sand/45 dark:bg-dark-sand'>
                      {song.coverUrl ? (
                        <img src={song.coverUrl} alt='' className='h-full w-full object-cover' />
                      ) : (
                        <div className='flex h-full w-full items-center justify-center'>
                          <Music2 size={14} className='text-text-secondary/40' />
                        </div>
                      )}
                    </div>

                    {/* Track number */}
                    <span className='text-center text-xs tabular-nums text-text-secondary dark:text-text-secondary'>{index + 1}</span>

                    {/* Title only */}
                    <div className='min-w-0'>
                      <div className='truncate text-sm font-medium text-text-primary dark:text-text-primary'>{song.title || 'Untitled'}</div>
                    </div>

                    {/* Artist */}
                    <div className='min-w-0'>
                      <button
                        type='button'
                        onClick={() => setSearchQuery(song.artist || '')}
                        className='max-w-full truncate text-left text-sm text-text-secondary transition-colors hover:text-sea dark:text-text-secondary dark:hover:text-accent-blue'
                        title={`Filter by ${song.artist}`}
                      >
                        {song.artist || '—'}
                      </button>
                    </div>

                    {/* Duration */}
                    <span className='text-right text-xs tabular-nums text-text-secondary dark:text-text-secondary'>{formatSongDuration(song.durationMs)}</span>

                    {/* Actions — visible on hover */}
                    <div className='flex items-center justify-end gap-1'>
                      <IconButton
                        onClick={() => {
                          void playSongPreview(song);
                        }}
                        className='text-sea opacity-0 transition-opacity group-hover:opacity-100 dark:text-accent-blue'
                        title={`Preview ${formatSongTitle(song)}`}
                        aria-label={`Preview ${formatSongTitle(song)}`}
                      >
                        <Play size={14} />
                      </IconButton>
                      <IconButton
                        onClick={() => openEditModal(song)}
                        className='text-sea opacity-0 transition-opacity group-hover:opacity-100 dark:text-accent-blue'
                        title={`Edit ${formatSongTitle(song)}`}
                        aria-label={`Edit ${formatSongTitle(song)}`}
                      >
                        <Pencil size={14} />
                      </IconButton>
                      <IconButton
                        onClick={() => {
                          void deleteSong(song);
                        }}
                        className='text-terracotta opacity-0 transition-opacity group-hover:opacity-100'
                        title={`Delete ${formatSongTitle(song)}`}
                        aria-label={`Delete ${formatSongTitle(song)}`}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      <Modal isOpen={isModalOpen} onClose={closeModal} title={editingSong ? 'Edit Song' : 'Add Song'}>
        <div className='space-y-4'>
          {!editingSong ? (
            <>
              <label
                className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                  batchItems.some((i) => i.status === 'uploading')
                    ? 'cursor-not-allowed border-sand/30 bg-sand/5 opacity-60'
                    : 'border-sand/40 bg-sand/5 hover:border-sea dark:border-sand/50 dark:bg-dark-sand/30 dark:hover:border-accent-blue'
                }`}
              >
                <input
                  type='file'
                  accept='audio/*'
                  multiple
                  className='hidden'
                  disabled={batchItems.some((i) => i.status === 'uploading')}
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    if (files.length > 0) void batchCreateSongs(files);
                  }}
                />
                <Music2 size={28} className='text-text-secondary dark:text-text-secondary' />
                <span className='text-sm font-medium text-text-primary dark:text-text-primary'>
                  {batchItems.some((i) => i.status === 'uploading') ? 'Uploading…' : 'Click to select audio files'}
                </span>
                <span className='text-xs text-text-secondary dark:text-text-secondary'>Multiple files supported — metadata read automatically</span>
              </label>

              {batchItems.length > 0 && (
                <ul className='space-y-1.5'>
                  {batchItems.map((item, idx) => (
                    <li
                      key={idx}
                      className='flex items-center gap-2 rounded-lg border border-sand/30 bg-white/60 px-3 py-2 text-sm dark:border-sand/40 dark:bg-dark-sand/50'
                    >
                      <span
                        className={`shrink-0 text-base ${
                          item.status === 'done'
                            ? 'text-green-500'
                            : item.status === 'error'
                              ? 'text-terracotta'
                              : item.status === 'uploading'
                                ? 'text-sea dark:text-accent-blue'
                                : 'text-text-secondary'
                        }`}
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
                <label className='inline-flex cursor-pointer items-center rounded-lg border border-sand/40 px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-sea hover:text-text-primary dark:border-sand/50 dark:text-text-secondary dark:hover:border-accent-blue dark:hover:text-text-primary'>
                  <input
                    type='file'
                    accept='audio/*'
                    className='hidden'
                    disabled={isUploadingSong || isSaving}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = '';
                      if (file) {
                        setSongFile(file);
                        void uploadSongFile();
                      }
                    }}
                  />
                  {isUploadingSong ? 'Uploading…' : songFile ? `Replace: ${songFile.name}` : 'Replace Song File'}
                </label>
              </div>

              <div className='grid gap-3 sm:grid-cols-2'>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>Artist</label>
                  <input
                    type='text'
                    value={artistInput}
                    onChange={(event) => setArtistInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>Title</label>
                  <input
                    type='text'
                    value={titleInput}
                    onChange={(event) => setTitleInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
              </div>

              <div>
                <label className='mb-1 block text-xs text-gray-600'>Audio URL</label>
                <input
                  type='text'
                  value={audioUrlInput}
                  onChange={(event) => setAudioUrlInput(event.target.value)}
                  className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  placeholder='Uploaded automatically after song upload'
                />
              </div>

              <div className='grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end'>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>Cover URL</label>
                  <input
                    type='text'
                    value={coverUrlInput}
                    onChange={(event) => setCoverUrlInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
                <label className='inline-flex cursor-pointer items-center rounded-lg border border-sand/40 px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-sea hover:text-text-primary dark:border-sand/50 dark:text-text-secondary dark:hover:border-accent-blue dark:hover:text-text-primary'>
                  <input
                    type='file'
                    accept='image/*'
                    className='hidden'
                    disabled={isUploadingCover || isSaving}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = '';
                      void uploadCoverFile(file);
                    }}
                  />
                  {isUploadingCover ? 'Uploading Cover...' : 'Upload Cover'}
                </label>
              </div>

              <div className='grid gap-3 sm:grid-cols-2'>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>Duration (ms)</label>
                  <input
                    type='number'
                    min={1}
                    value={durationMsInput}
                    onChange={(event) => setDurationMsInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
                <label className='mt-7 inline-flex items-center gap-2 text-sm text-text-primary dark:text-text-primary'>
                  <input type='checkbox' checked={enabledInput} onChange={(event) => setEnabledInput(event.target.checked)} />
                  Enabled
                </label>
              </div>

              <div className='grid gap-3 sm:grid-cols-3'>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>EarOne Song ID</label>
                  <input
                    type='text'
                    value={earoneSongIdInput}
                    onChange={(event) => setEaroneSongIdInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>EarOne Rank</label>
                  <input
                    type='text'
                    value={earoneRankInput}
                    onChange={(event) => setEaroneRankInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
                <div>
                  <label className='mb-1 block text-xs text-gray-600'>EarOne Spins</label>
                  <input
                    type='text'
                    value={earoneSpinsInput}
                    onChange={(event) => setEaroneSpinsInput(event.target.value)}
                    className='w-full rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm text-text-primary outline-none transition-colors focus:border-sea focus:ring-2 focus:ring-sea dark:border-sand/50 dark:bg-dark-sand dark:focus:border-accent-blue dark:focus:ring-accent-blue'
                  />
                </div>
              </div>

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
    </div>
  );
}
