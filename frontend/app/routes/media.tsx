import {
  AlertContainer,
  Button,
  Card,
  Empty,
  FileInput,
  IconButton,
  Input,
  LoadingSpinner,
  Modal,
  SectionHeader,
  showAlert
} from '@gaulatti/bleecker';
import { Pencil, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Route } from './+types/media';
import { uploadFileToMediaBucket } from '../services/uploads';
import { apiUrl } from '../utils/apiBaseUrl';

interface MediaItem {
  id: number;
  name: string;
  imageUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface MediaGroupItem {
  id: number;
  mediaGroupId: number;
  mediaId: number;
  position: number;
  media: MediaItem;
}

interface MediaGroup {
  id: number;
  name: string;
  description: string | null;
  items: MediaGroupItem[];
  createdAt: string;
  updatedAt: string;
}

type MediaGroupAssignMode = 'none' | 'existing' | 'new';

function stripFileExtension(filename: string): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return '';
  }
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex <= 0) {
    return trimmed;
  }
  return trimmed.slice(0, dotIndex).trim();
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
    // fall back to raw text
  }

  return text;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Media - TV Broadcast' }, { name: 'description', content: 'Manage image media and media groups for slideshow scenes.' }];
}

export default function MediaRoute() {
  const navigate = useNavigate();
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaGroups, setMediaGroups] = useState<MediaGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const [showMediaModal, setShowMediaModal] = useState(false);
  const [editingMedia, setEditingMedia] = useState<MediaItem | null>(null);
  const [mediaNameInput, setMediaNameInput] = useState('');
  const [mediaUrlInput, setMediaUrlInput] = useState('');
  const [selectedImageFiles, setSelectedImageFiles] = useState<File[]>([]);
  const [groupAssignMode, setGroupAssignMode] = useState<MediaGroupAssignMode>('none');
  const [groupAssignExistingId, setGroupAssignExistingId] = useState('');
  const [groupAssignNewName, setGroupAssignNewName] = useState('');
  const [groupAssignNewDescription, setGroupAssignNewDescription] = useState('');
  const [isSavingMedia, setIsSavingMedia] = useState(false);
  const [isUploadingMediaImage, setIsUploadingMediaImage] = useState(false);

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<MediaGroup | null>(null);
  const [groupNameInput, setGroupNameInput] = useState('');
  const [groupDescriptionInput, setGroupDescriptionInput] = useState('');
  const [isSavingGroup, setIsSavingGroup] = useState(false);

  const [error, setError] = useState('');

  const fetchMedia = useCallback(async () => {
    const res = await fetch(apiUrl('/media'));
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    const payload = (await res.json()) as MediaItem[];
    setMedia(Array.isArray(payload) ? payload : []);
  }, []);

  const fetchMediaGroups = useCallback(async () => {
    const res = await fetch(apiUrl('/media-groups'));
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    const payload = (await res.json()) as MediaGroup[];
    setMediaGroups(Array.isArray(payload) ? payload : []);
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      try {
        await Promise.all([fetchMedia(), fetchMediaGroups()]);
      } catch (err) {
        console.error('Failed to load media admin data:', err);
        showAlert('Failed to load media and groups.', 'error');
      } finally {
        setIsLoading(false);
      }
    };

    void load();
  }, [fetchMedia, fetchMediaGroups]);

  const sortedMedia = useMemo(() => {
    return [...media].sort((a, b) => b.id - a.id);
  }, [media]);

  const sortedGroups = useMemo(() => {
    return [...mediaGroups].sort((a, b) => a.name.localeCompare(b.name));
  }, [mediaGroups]);

  useEffect(() => {
    if (!sortedGroups.length) {
      setSelectedGroupId(null);
      return;
    }

    if (selectedGroupId === null) {
      setSelectedGroupId(sortedGroups[0].id);
      return;
    }

    if (!sortedGroups.some((group) => group.id === selectedGroupId)) {
      setSelectedGroupId(sortedGroups[0].id);
    }
  }, [selectedGroupId, sortedGroups]);

  const selectedGroup = useMemo(() => {
    if (selectedGroupId === null) {
      return null;
    }
    return sortedGroups.find((group) => group.id === selectedGroupId) ?? null;
  }, [selectedGroupId, sortedGroups]);

  const selectedGroupMediaIds = useMemo(() => {
    return new Set((selectedGroup?.items ?? []).map((item) => item.mediaId));
  }, [selectedGroup]);

  const availableMediaForGroup = useMemo(() => {
    return sortedMedia.filter((item) => !selectedGroupMediaIds.has(item.id));
  }, [selectedGroupMediaIds, sortedMedia]);

  const openCreateMediaModal = () => {
    setEditingMedia(null);
    setMediaNameInput('');
    setMediaUrlInput('');
    setSelectedImageFiles([]);
    if (selectedGroupId !== null) {
      setGroupAssignMode('existing');
      setGroupAssignExistingId(String(selectedGroupId));
    } else {
      setGroupAssignMode('none');
      setGroupAssignExistingId('');
    }
    setGroupAssignNewName('');
    setGroupAssignNewDescription('');
    setError('');
    setShowMediaModal(true);
  };

  const openEditMediaModal = (item: MediaItem) => {
    setEditingMedia(item);
    setMediaNameInput(item.name);
    setMediaUrlInput(item.imageUrl);
    setSelectedImageFiles([]);
    setGroupAssignMode('none');
    setGroupAssignExistingId('');
    setGroupAssignNewName('');
    setGroupAssignNewDescription('');
    setError('');
    setShowMediaModal(true);
  };

  const closeMediaModal = () => {
    setShowMediaModal(false);
    setEditingMedia(null);
    setMediaNameInput('');
    setMediaUrlInput('');
    setSelectedImageFiles([]);
    setGroupAssignMode('none');
    setGroupAssignExistingId('');
    setGroupAssignNewName('');
    setGroupAssignNewDescription('');
    setError('');
  };

  const openCreateGroupModal = () => {
    setEditingGroup(null);
    setGroupNameInput('');
    setGroupDescriptionInput('');
    setError('');
    setShowGroupModal(true);
  };

  const openEditGroupModal = (group: MediaGroup) => {
    setEditingGroup(group);
    setGroupNameInput(group.name);
    setGroupDescriptionInput(group.description ?? '');
    setError('');
    setShowGroupModal(true);
  };

  const closeGroupModal = () => {
    setShowGroupModal(false);
    setEditingGroup(null);
    setGroupNameInput('');
    setGroupDescriptionInput('');
    setError('');
  };

  const saveMedia = async () => {
    const normalizedName = mediaNameInput.trim();
    const normalizedUrl = mediaUrlInput.trim();
    const selectedFiles = selectedImageFiles;

    setIsSavingMedia(true);
    setError('');

    try {
      if (editingMedia) {
        let nextUrl = normalizedUrl;
        if (selectedFiles.length > 0) {
          setIsUploadingMediaImage(true);
          const upload = await uploadFileToMediaBucket('artwork', selectedFiles[0]);
          nextUrl = upload.url;
        }

        if (!normalizedName) {
          setError('Name is required.');
          return;
        }
        if (!nextUrl) {
          setError('Image URL is required.');
          return;
        }

        const res = await fetch(apiUrl(`/media/${editingMedia.id}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: normalizedName,
            imageUrl: nextUrl,
          }),
        });

        if (!res.ok) {
          throw new Error(await extractErrorMessage(res));
        }

        await Promise.all([fetchMedia(), fetchMediaGroups()]);
        closeMediaModal();
        showAlert('Media updated.', 'success');
        return;
      }

      if (selectedFiles.length === 0 && !normalizedUrl) {
        setError('Select one or more files, or provide an image URL.');
        return;
      }

      const createdMediaIds: number[] = [];

      const createMediaRecord = async (payload: { name: string; imageUrl: string }) => {
        const createRes = await fetch(apiUrl('/media'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!createRes.ok) {
          throw new Error(await extractErrorMessage(createRes));
        }
        const created = (await createRes.json()) as MediaItem;
        createdMediaIds.push(created.id);
      };

      if (selectedFiles.length > 0) {
        setIsUploadingMediaImage(true);

        for (let index = 0; index < selectedFiles.length; index += 1) {
          const file = selectedFiles[index];
          const upload = await uploadFileToMediaBucket('artwork', file);
          const derivedName = stripFileExtension(file.name) || `Media ${index + 1}`;
          const mediaName =
            normalizedName && selectedFiles.length === 1
              ? normalizedName
              : normalizedName && selectedFiles.length > 1
                ? `${normalizedName} ${index + 1}`
                : derivedName;

          await createMediaRecord({
            name: mediaName,
            imageUrl: upload.url,
          });
        }
      } else {
        if (!normalizedName) {
          setError('Name is required when using direct URL.');
          return;
        }
        await createMediaRecord({
          name: normalizedName,
          imageUrl: normalizedUrl,
        });
      }

      let assignedGroupId: number | null = null;

      if (groupAssignMode === 'existing') {
        const parsedGroupId = Number(groupAssignExistingId);
        if (!Number.isFinite(parsedGroupId) || parsedGroupId <= 0) {
          setError('Select a valid existing group.');
          return;
        }

        const groupRes = await fetch(apiUrl(`/media-groups/${parsedGroupId}`));
        if (!groupRes.ok) {
          throw new Error(await extractErrorMessage(groupRes));
        }
        const currentGroup = (await groupRes.json()) as MediaGroup;
        const currentIds = currentGroup.items.map((item) => item.mediaId);
        const nextIds = [...new Set([...currentIds, ...createdMediaIds])];

        const updateRes = await fetch(apiUrl(`/media-groups/${parsedGroupId}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mediaIds: nextIds }),
        });
        if (!updateRes.ok) {
          throw new Error(await extractErrorMessage(updateRes));
        }

        assignedGroupId = parsedGroupId;
      } else if (groupAssignMode === 'new') {
        const groupName = groupAssignNewName.trim();
        if (!groupName) {
          setError('New group name is required.');
          return;
        }

        const createGroupRes = await fetch(apiUrl('/media-groups'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: groupName,
            description: groupAssignNewDescription.trim() || null,
            mediaIds: createdMediaIds,
          }),
        });
        if (!createGroupRes.ok) {
          throw new Error(await extractErrorMessage(createGroupRes));
        }
        const createdGroup = (await createGroupRes.json()) as MediaGroup;
        assignedGroupId = createdGroup.id;
      }

      await Promise.all([fetchMedia(), fetchMediaGroups()]);
      if (assignedGroupId !== null) {
        setSelectedGroupId(assignedGroupId);
      }
      closeMediaModal();
      showAlert(`Created ${createdMediaIds.length} media item${createdMediaIds.length === 1 ? '' : 's'}.`, 'success');
    } catch (err) {
      console.error('Failed to save media:', err);
      const message = err instanceof Error ? err.message : 'Failed to save media.';
      setError(message);
      showAlert(message, 'error');
    } finally {
      setIsUploadingMediaImage(false);
      setIsSavingMedia(false);
    }
  };

  const deleteMedia = async (item: MediaItem) => {
    if (!confirm(`Delete media "${item.name}"?`)) return;

    try {
      const res = await fetch(apiUrl(`/media/${item.id}`), { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      await Promise.all([fetchMedia(), fetchMediaGroups()]);
      showAlert('Media deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete media:', err);
      showAlert('Failed to delete media.', 'error');
    }
  };

  const saveGroup = async () => {
    const normalizedName = groupNameInput.trim();
    if (!normalizedName) {
      setError('Group name is required.');
      return;
    }

    setIsSavingGroup(true);
    setError('');

    try {
      const endpoint = editingGroup ? apiUrl(`/media-groups/${editingGroup.id}`) : apiUrl('/media-groups');
      const method = editingGroup ? 'PUT' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizedName,
          description: groupDescriptionInput.trim() || null,
        }),
      });

      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      const saved = (await res.json()) as MediaGroup;
      setMediaGroups((prev) => {
        const existingIndex = prev.findIndex((group) => group.id === saved.id);
        if (existingIndex === -1) {
          return [...prev, saved];
        }

        const next = [...prev];
        next[existingIndex] = saved;
        return next;
      });
      setSelectedGroupId(saved.id);
      closeGroupModal();
      showAlert(editingGroup ? 'Media group updated.' : 'Media group created.', 'success');
    } catch (err) {
      console.error('Failed to save media group:', err);
      const message = err instanceof Error ? err.message : 'Failed to save media group.';
      setError(message);
      showAlert(message, 'error');
    } finally {
      setIsSavingGroup(false);
    }
  };

  const deleteGroup = async (group: MediaGroup) => {
    if (!confirm(`Delete group "${group.name}"?`)) return;

    try {
      const res = await fetch(apiUrl(`/media-groups/${group.id}`), { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(await extractErrorMessage(res));
      }

      setMediaGroups((prev) => prev.filter((item) => item.id !== group.id));
      showAlert('Media group deleted.', 'success');
    } catch (err) {
      console.error('Failed to delete media group:', err);
      showAlert('Failed to delete media group.', 'error');
    }
  };

  const persistSelectedGroupMediaIds = async (groupId: number, mediaIds: number[]) => {
    const res = await fetch(apiUrl(`/media-groups/${groupId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaIds }),
    });

    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }

    const updated = (await res.json()) as MediaGroup;
    setMediaGroups((prev) => prev.map((group) => (group.id === updated.id ? updated : group)));
  };

  const addMediaToSelectedGroup = async (mediaId: number) => {
    if (!selectedGroup) {
      return;
    }

    const nextMediaIds = selectedGroup.items.map((item) => item.mediaId);
    if (nextMediaIds.includes(mediaId)) {
      return;
    }
    nextMediaIds.push(mediaId);

    try {
      await persistSelectedGroupMediaIds(selectedGroup.id, nextMediaIds);
      showAlert('Media added to group.', 'success');
    } catch (err) {
      console.error('Failed to add media to group:', err);
      showAlert('Failed to add media to group.', 'error');
    }
  };

  const removeMediaFromSelectedGroup = async (mediaId: number) => {
    if (!selectedGroup) {
      return;
    }

    const nextMediaIds = selectedGroup.items.map((item) => item.mediaId).filter((id) => id !== mediaId);

    try {
      await persistSelectedGroupMediaIds(selectedGroup.id, nextMediaIds);
      showAlert('Media removed from group.', 'success');
    } catch (err) {
      console.error('Failed to remove media from group:', err);
      showAlert('Failed to remove media from group.', 'error');
    }
  };

  const moveMediaInSelectedGroup = async (mediaId: number, direction: -1 | 1) => {
    if (!selectedGroup) {
      return;
    }

    const current = selectedGroup.items.map((item) => item.mediaId);
    const currentIndex = current.findIndex((id) => id === mediaId);
    if (currentIndex === -1) {
      return;
    }

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= current.length) {
      return;
    }

    const next = [...current];
    const [moved] = next.splice(currentIndex, 1);
    next.splice(nextIndex, 0, moved);

    try {
      await persistSelectedGroupMediaIds(selectedGroup.id, next);
    } catch (err) {
      console.error('Failed to reorder group media:', err);
      showAlert('Failed to reorder group media.', 'error');
    }
  };

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-7xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Media & Media Groups' description='Create image assets once, then reuse them across slideshow scenes via groups.' />
          <div className='flex flex-wrap items-center gap-3'>
            <Button variant='secondary' onClick={() => navigate('/control')}>
              Back to Control
            </Button>
            <Button variant='secondary' onClick={openCreateGroupModal}>
              <Plus size={16} />
              Create Group
            </Button>
            <Button onClick={openCreateMediaModal}>
              <Plus size={16} />
              Add Media
            </Button>
          </div>
        </div>

        {isLoading ? (
          <Card>
            <div className='flex flex-col items-center justify-center gap-3 py-12 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading media library and groups...</p>
            </div>
          </Card>
        ) : (
          <div className='grid gap-6 xl:grid-cols-[1.2fr_1fr]'>
            <Card className='space-y-4'>
              <div className='flex items-center justify-between'>
                <h2 className='text-xl font-semibold text-text-primary dark:text-text-primary'>Media Library ({sortedMedia.length})</h2>
                <Button size='sm' onClick={openCreateMediaModal}>
                  <Plus size={14} />
                  Add
                </Button>
              </div>

              {sortedMedia.length === 0 ? (
                <Empty title='No media yet' description='Upload your first image asset.' action={<Button onClick={openCreateMediaModal}>Add Media</Button>} />
              ) : (
                <div className='grid gap-3 sm:grid-cols-2'>
                  {sortedMedia.map((item) => (
                    <article
                      key={item.id}
                      className='rounded-2xl border border-sand/20 bg-white/80 p-3 transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 dark:hover:border-accent-blue/60'
                    >
                      <div className='flex items-start gap-3'>
                        <img src={item.imageUrl} alt={item.name} className='h-20 w-28 rounded-md border border-sand/20 bg-sand/10 object-cover dark:border-sand/40' />
                        <div className='min-w-0 flex-1'>
                          <h3 className='line-clamp-2 text-sm font-semibold text-text-primary dark:text-text-primary'>{item.name}</h3>
                          <p className='mt-1 line-clamp-2 text-xs text-text-secondary dark:text-text-secondary'>{item.imageUrl}</p>
                        </div>
                      </div>
                      <div className='mt-3 flex items-center justify-end gap-2'>
                        <IconButton
                          onClick={() => openEditMediaModal(item)}
                          className='text-sea dark:text-accent-blue'
                          title={`Edit ${item.name}`}
                          aria-label={`Edit ${item.name}`}
                        >
                          <Pencil size={16} />
                        </IconButton>
                        <IconButton
                          onClick={() => {
                            void deleteMedia(item);
                          }}
                          className='text-terracotta'
                          title={`Delete ${item.name}`}
                          aria-label={`Delete ${item.name}`}
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Card>

            <Card className='space-y-4'>
              <div className='flex items-center justify-between'>
                <h2 className='text-xl font-semibold text-text-primary dark:text-text-primary'>Media Groups ({sortedGroups.length})</h2>
                <Button size='sm' onClick={openCreateGroupModal}>
                  <Plus size={14} />
                  Add
                </Button>
              </div>

              {sortedGroups.length === 0 ? (
                <Empty
                  title='No groups yet'
                  description='Create a media group, then assign images to it.'
                  action={<Button onClick={openCreateGroupModal}>Create Group</Button>}
                />
              ) : (
                <div className='grid gap-4 lg:grid-cols-[220px_1fr]'>
                  <div className='space-y-2'>
                    {sortedGroups.map((group) => {
                      const isSelected = selectedGroupId === group.id;
                      return (
                        <button
                          key={group.id}
                          type='button'
                          onClick={() => setSelectedGroupId(group.id)}
                          className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                            isSelected
                              ? 'border-sea bg-sea/10 dark:border-accent-blue dark:bg-accent-blue/10'
                              : 'border-sand/20 bg-white/70 hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/50 dark:hover:border-accent-blue/60'
                          }`}
                        >
                          <div className='truncate text-sm font-semibold text-text-primary dark:text-text-primary'>{group.name}</div>
                          <div className='text-xs text-text-secondary dark:text-text-secondary'>{group.items.length} images</div>
                        </button>
                      );
                    })}
                  </div>

                  {selectedGroup ? (
                    <div className='space-y-4'>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <div>
                          <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{selectedGroup.name}</h3>
                          {selectedGroup.description ? (
                            <p className='text-sm text-text-secondary dark:text-text-secondary'>{selectedGroup.description}</p>
                          ) : (
                            <p className='text-sm text-text-secondary dark:text-text-secondary'>No description.</p>
                          )}
                        </div>
                        <div className='flex items-center gap-2'>
                          <Button size='sm' variant='secondary' onClick={() => openEditGroupModal(selectedGroup)}>
                            Edit Group
                          </Button>
                          <Button size='sm' variant='secondary' onClick={() => void deleteGroup(selectedGroup)}>
                            Delete Group
                          </Button>
                        </div>
                      </div>

                      <div className='space-y-2'>
                        <h4 className='text-sm font-semibold text-text-primary dark:text-text-primary'>Assigned Media</h4>
                        {selectedGroup.items.length === 0 ? (
                          <p className='text-sm text-text-secondary dark:text-text-secondary'>No media assigned yet.</p>
                        ) : (
                          <div className='space-y-2'>
                            {selectedGroup.items.map((item, index) => (
                              <div
                                key={item.id}
                                className='flex items-center gap-3 rounded-lg border border-sand/20 bg-white/70 px-2 py-2 dark:border-sand/40 dark:bg-dark-sand/50'
                              >
                                <img src={item.media.imageUrl} alt={item.media.name} className='h-12 w-16 rounded border border-sand/20 object-cover dark:border-sand/40' />
                                <div className='min-w-0 flex-1'>
                                  <div className='truncate text-sm font-medium text-text-primary dark:text-text-primary'>{item.media.name}</div>
                                  <div className='text-xs text-text-secondary dark:text-text-secondary'>#{index + 1}</div>
                                </div>
                                <div className='flex items-center gap-1'>
                                  <IconButton
                                    onClick={() => {
                                      void moveMediaInSelectedGroup(item.mediaId, -1);
                                    }}
                                    title='Move up'
                                    aria-label='Move up'
                                    disabled={index === 0}
                                  >
                                    <ArrowUp size={14} />
                                  </IconButton>
                                  <IconButton
                                    onClick={() => {
                                      void moveMediaInSelectedGroup(item.mediaId, 1);
                                    }}
                                    title='Move down'
                                    aria-label='Move down'
                                    disabled={index === selectedGroup.items.length - 1}
                                  >
                                    <ArrowDown size={14} />
                                  </IconButton>
                                  <IconButton
                                    onClick={() => {
                                      void removeMediaFromSelectedGroup(item.mediaId);
                                    }}
                                    className='text-terracotta'
                                    title='Remove from group'
                                    aria-label='Remove from group'
                                  >
                                    <Trash2 size={14} />
                                  </IconButton>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className='space-y-2'>
                        <h4 className='text-sm font-semibold text-text-primary dark:text-text-primary'>Add Media To Group</h4>
                        {availableMediaForGroup.length === 0 ? (
                          <p className='text-sm text-text-secondary dark:text-text-secondary'>All media are already in this group.</p>
                        ) : (
                          <div className='max-h-64 space-y-2 overflow-y-auto pr-1'>
                            {availableMediaForGroup.map((item) => (
                              <div
                                key={item.id}
                                className='flex items-center gap-3 rounded-lg border border-sand/20 bg-white/70 px-2 py-2 dark:border-sand/40 dark:bg-dark-sand/50'
                              >
                                <img src={item.imageUrl} alt={item.name} className='h-10 w-14 rounded border border-sand/20 object-cover dark:border-sand/40' />
                                <div className='min-w-0 flex-1 truncate text-sm text-text-primary dark:text-text-primary'>{item.name}</div>
                                <Button
                                  size='sm'
                                  variant='secondary'
                                  onClick={() => {
                                    void addMediaToSelectedGroup(item.id);
                                  }}
                                >
                                  Add
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className='text-sm text-text-secondary dark:text-text-secondary'>Select a media group to manage members.</p>
                  )}
                </div>
              )}
            </Card>
          </div>
        )}

        <Modal isOpen={showMediaModal} onClose={closeMediaModal} title={editingMedia ? 'Edit Media' : 'Create Media'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>
                {editingMedia ? 'Name' : 'Name (optional for multi-upload)'}
              </label>
              <Input
                value={mediaNameInput}
                onChange={(e) => {
                  setMediaNameInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder={editingMedia ? 'Morning Headlines 01' : 'Optional base name'}
                autoFocus
                error={!!error && editingMedia && !mediaNameInput.trim()}
              />
              {!editingMedia ? (
                <p className='mt-2 text-xs text-text-secondary dark:text-text-secondary'>
                  For one file, name is used directly. For multiple files, we append numbers.
                </p>
              ) : null}
            </div>

            {editingMedia ? (
              <>
                <div>
                  <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Replace Image (optional)</label>
                  <FileInput
                    accept='image/*'
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      event.target.value = '';
                      setSelectedImageFiles(file ? [file] : []);
                      if (error) setError('');
                    }}
                    disabled={isUploadingMediaImage}
                  />
                  <span className='mt-2 block text-xs text-text-secondary dark:text-text-secondary'>
                    {selectedImageFiles.length > 0 ? `Selected: ${selectedImageFiles[0].name}` : 'No replacement file selected.'}
                  </span>
                </div>

                <div>
                  <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Image URL</label>
                  <Input
                    value={mediaUrlInput}
                    onChange={(e) => {
                      setMediaUrlInput(e.target.value);
                      if (error) setError('');
                    }}
                    placeholder='https://...'
                    error={!!error && !mediaUrlInput.trim() && selectedImageFiles.length === 0}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Upload Images</label>
                  <label
                    className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
                      isUploadingMediaImage ? 'cursor-not-allowed border-sand/30 bg-sand/5 opacity-60' : 'border-sand/40 bg-sand/5 hover:border-sea'
                    }`}
                  >
                    <input
                      type='file'
                      accept='image/*'
                      multiple
                      className='hidden'
                      disabled={isUploadingMediaImage}
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = '';
                        setSelectedImageFiles(files);
                        if (error) setError('');
                      }}
                    />
                    <span className='text-sm font-medium text-text-primary dark:text-text-primary'>
                      {isUploadingMediaImage ? 'Uploading…' : 'Click to select one or more images'}
                    </span>
                    <span className='text-xs text-text-secondary dark:text-text-secondary'>Multi-upload supported</span>
                  </label>
                  {selectedImageFiles.length > 0 ? (
                    <div className='mt-2 rounded-lg border border-sand/20 bg-white/70 p-2 text-xs text-text-secondary dark:border-sand/40 dark:bg-dark-sand/50 dark:text-text-secondary'>
                      <p>{selectedImageFiles.length} file(s) selected</p>
                      <ul className='mt-1 list-disc pl-5'>
                        {selectedImageFiles.slice(0, 5).map((file) => (
                          <li key={file.name}>{file.name}</li>
                        ))}
                      </ul>
                      {selectedImageFiles.length > 5 ? <p className='mt-1'>+ {selectedImageFiles.length - 5} more</p> : null}
                    </div>
                  ) : null}
                </div>

                <div>
                  <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Or Single Image URL</label>
                  <Input
                    value={mediaUrlInput}
                    onChange={(e) => {
                      setMediaUrlInput(e.target.value);
                      if (error) setError('');
                    }}
                    placeholder='https://...'
                    error={!!error && !mediaUrlInput.trim() && selectedImageFiles.length === 0}
                  />
                </div>

                <div className='space-y-3 rounded-xl border border-sand/20 bg-sand/5 p-3 dark:border-sand/40 dark:bg-dark-sand/40'>
                  <h4 className='text-sm font-semibold text-text-primary dark:text-text-primary'>Assign To Group</h4>
                  <select
                    value={groupAssignMode}
                    onChange={(event) => {
                      const nextMode = event.target.value as MediaGroupAssignMode;
                      setGroupAssignMode(nextMode);
                      if (nextMode !== 'existing') {
                        setGroupAssignExistingId('');
                      }
                      if (nextMode !== 'new') {
                        setGroupAssignNewName('');
                        setGroupAssignNewDescription('');
                      }
                    }}
                    className='w-full rounded border border-sand/30 bg-white px-3 py-2 text-sm text-text-primary outline-none focus:border-sea dark:border-sand/40 dark:bg-dark-sand dark:text-text-primary dark:focus:border-accent-blue'
                  >
                    <option value='none'>Do not assign</option>
                    <option value='existing'>Assign to existing group</option>
                    <option value='new'>Create a new group and assign</option>
                  </select>

                  {groupAssignMode === 'existing' ? (
                    <select
                      value={groupAssignExistingId}
                      onChange={(event) => setGroupAssignExistingId(event.target.value)}
                      className='w-full rounded border border-sand/30 bg-white px-3 py-2 text-sm text-text-primary outline-none focus:border-sea dark:border-sand/40 dark:bg-dark-sand dark:text-text-primary dark:focus:border-accent-blue'
                    >
                      <option value=''>Select a group</option>
                      {sortedGroups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} ({group.items.length} images)
                        </option>
                      ))}
                    </select>
                  ) : null}

                  {groupAssignMode === 'new' ? (
                    <div className='space-y-2'>
                      <Input
                        value={groupAssignNewName}
                        onChange={(event) => setGroupAssignNewName(event.target.value)}
                        placeholder='New group name'
                      />
                      <textarea
                        value={groupAssignNewDescription}
                        onChange={(event) => setGroupAssignNewDescription(event.target.value)}
                        rows={2}
                        className='w-full rounded border border-sand/30 bg-white px-3 py-2 text-sm text-text-primary outline-none focus:border-sea dark:border-sand/40 dark:bg-dark-sand dark:text-text-primary dark:focus:border-accent-blue'
                        placeholder='Optional group description'
                      />
                    </div>
                  ) : null}
                </div>
              </>
            )}

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeMediaModal} disabled={isSavingMedia}>
                Cancel
              </Button>
              <Button onClick={saveMedia} disabled={isSavingMedia || isUploadingMediaImage}>
                {isUploadingMediaImage ? 'Uploading...' : isSavingMedia ? 'Saving...' : editingMedia ? 'Update Media' : 'Create Media'}
              </Button>
            </div>
          </div>
        </Modal>

        <Modal isOpen={showGroupModal} onClose={closeGroupModal} title={editingGroup ? 'Edit Media Group' : 'Create Media Group'}>
          <div className='space-y-5'>
            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Group Name</label>
              <Input
                value={groupNameInput}
                onChange={(e) => {
                  setGroupNameInput(e.target.value);
                  if (error) setError('');
                }}
                placeholder='Morning Slideshow'
                autoFocus
                error={!!error && !groupNameInput.trim()}
              />
            </div>

            <div>
              <label className='mb-2 block text-sm font-medium text-text-primary dark:text-text-primary'>Description (optional)</label>
              <textarea
                value={groupDescriptionInput}
                onChange={(event) => {
                  setGroupDescriptionInput(event.target.value);
                  if (error) setError('');
                }}
                rows={3}
                className='w-full rounded border border-sand/30 bg-white px-3 py-2 text-sm text-text-primary outline-none focus:border-sea dark:border-sand/40 dark:bg-dark-sand dark:text-text-primary dark:focus:border-accent-blue'
                placeholder='Used by Morning program scene 1'
              />
            </div>

            {error ? <p className='text-sm text-terracotta'>{error}</p> : null}

            <div className='flex justify-end gap-3'>
              <Button variant='secondary' onClick={closeGroupModal} disabled={isSavingGroup}>
                Cancel
              </Button>
              <Button onClick={saveGroup} disabled={isSavingGroup}>
                {isSavingGroup ? 'Saving...' : editingGroup ? 'Update Group' : 'Create Group'}
              </Button>
            </div>
          </div>
        </Modal>
      </div>
    </div>
  );
}
