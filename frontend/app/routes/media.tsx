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
  Pagination,
  Select,
  SectionHeader,
  SortableTableHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  Textarea,
  showAlert
} from '@gaulatti/bleecker';
import type { SortState } from '@gaulatti/bleecker';
import { Pencil, Plus, Trash2, ArrowUp, ArrowDown, Search, X } from 'lucide-react';
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
  const [selectedGroup, setSelectedGroup] = useState<MediaGroup | null>(null);
  const [activeTab, setActiveTab] = useState('library');
  const [isLoading, setIsLoading] = useState(true);

  const [mediaSearch, setMediaSearch] = useState('');
  const [debouncedMediaSearch, setDebouncedMediaSearch] = useState('');
  const [mediaPage, setMediaPage] = useState(1);
  const [mediaTotalPages, setMediaTotalPages] = useState(1);
  const [mediaTotalCount, setMediaTotalCount] = useState(0);

  const [groupSearch, setGroupSearch] = useState('');
  const [debouncedGroupSearch, setDebouncedGroupSearch] = useState('');
  const [groupPage, setGroupPage] = useState(1);
  const [groupTotalPages, setGroupTotalPages] = useState(1);
  const [groupTotalCount, setGroupTotalCount] = useState(0);

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
    const params = new URLSearchParams();
    if (debouncedMediaSearch) params.set('search', debouncedMediaSearch);
    params.set('page', String(mediaPage));
    params.set('limit', '50');
    const qs = params.toString();
    const res = await fetch(apiUrl(`/media${qs ? `?${qs}` : ''}`));
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    const payload = await res.json();
    setMedia(Array.isArray(payload.data) ? payload.data : []);
    setMediaTotalPages(payload.meta?.totalPages ?? 1);
    setMediaTotalCount(payload.meta?.total ?? 0);
  }, [debouncedMediaSearch, mediaPage]);

  const fetchMediaGroups = useCallback(async () => {
    const params = new URLSearchParams();
    if (debouncedGroupSearch) params.set('search', debouncedGroupSearch);
    params.set('page', String(groupPage));
    params.set('limit', '20');
    const qs = params.toString();
    const res = await fetch(apiUrl(`/media-groups${qs ? `?${qs}` : ''}`));
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
    const payload = await res.json();
    setMediaGroups(Array.isArray(payload.data) ? payload.data : []);
    setGroupTotalPages(payload.meta?.totalPages ?? 1);
    setGroupTotalCount(payload.meta?.total ?? 0);
  }, [debouncedGroupSearch, groupPage]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedMediaSearch(mediaSearch), 300);
    return () => clearTimeout(timer);
  }, [mediaSearch]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedGroupSearch(groupSearch), 300);
    return () => clearTimeout(timer);
  }, [groupSearch]);

  useEffect(() => {
    setMediaPage(1);
  }, [debouncedMediaSearch]);

  useEffect(() => {
    setGroupPage(1);
  }, [debouncedGroupSearch]);

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

  const openCreateMediaModal = () => {
    setEditingMedia(null);
    setMediaNameInput('');
    setMediaUrlInput('');
    setSelectedImageFiles([]);
    if (selectedGroup !== null) {
      setGroupAssignMode('existing');
      setGroupAssignExistingId(String(selectedGroup.id));
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
          setError('Name is .');
          return;
        }
        if (!nextUrl) {
          setError('Image URL is .');
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
          setError('Name is  when using direct URL.');
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
          setError('New group name is .');
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
        const groupRes = await fetch(apiUrl(`/media-groups/${assignedGroupId}`));
        if (groupRes.ok) {
          setSelectedGroup(await groupRes.json());
        }
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
      setError('Group name is .');
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
      setSelectedGroup(saved);
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

  const [groupSort, setGroupSort] = useState<SortState>({ field: 'name', order: 'asc' });

  const handleGroupSort = (field: string, order: 'asc' | 'desc') => {
    setGroupSort({ field, order });
  };

  const sortedMediaGroups = useMemo(() => {
    return [...mediaGroups].sort((a, b) => {
      if (groupSort.field === 'name') {
        return groupSort.order === 'asc' ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      }
      return 0;
    });
  }, [mediaGroups, groupSort]);

  return (
    <div className='min-h-screen bg-light-sand p-6 dark:bg-deep-sea md:p-8'>
      <AlertContainer />
      <div className='mx-auto max-w-7xl space-y-6'>
        <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
          <SectionHeader title='Media & Media Groups' description='Create image assets once, then reuse them across slideshow scenes via groups.' />
          <Button variant='secondary' onClick={() => navigate('/')}>
            Back to Control
          </Button>
        </div>

        {isLoading ? (
          <Card>
            <div className='flex flex-col items-center justify-center gap-3 py-12 text-center text-text-secondary dark:text-text-secondary'>
              <LoadingSpinner />
              <p>Loading media library and groups...</p>
            </div>
          </Card>
        ) : (
          <Card className='overflow-hidden p-0'>
            <div className='border-b border-sand/10 dark:border-sand/20'>
              <Tabs
                activeTab={activeTab}
                onChange={setActiveTab}
                tabs={[
                  { id: 'library', label: `Media Library (${sortedMedia.length})` },
                  { id: 'groups', label: `Media Groups (${groupTotalCount})` },
                ]}
              />
            </div>
            <div className='p-6'>
              {activeTab === 'library' ? (
                <div className='space-y-4'>
                  <div className='flex items-center justify-between'>
                    <h2 className='text-xl font-semibold text-text-primary dark:text-text-primary'>Media Library</h2>
                    <div className='flex items-center gap-3'>
                      <Input
                        type='text'
                        value={mediaSearch}
                        onChange={(event) => setMediaSearch(event.target.value)}
                        placeholder='Search by name...'
                        startIcon={<Search size={14} className='text-text-secondary dark:text-text-secondary' />}
                      />
                      <Button size='sm' onClick={openCreateMediaModal}>
                        <Plus size={14} />
                        Add Media
                      </Button>
                    </div>
                  </div>

                  {mediaTotalCount === 0 ? (
                    <Empty
                      title={debouncedMediaSearch ? 'No media match your search' : 'No media yet'}
                      description={debouncedMediaSearch ? 'Try a different search term.' : 'Upload your first image asset.'}
                      action={
                        debouncedMediaSearch ? (
                          <Button variant='secondary' onClick={() => setMediaSearch('')}>
                            Clear Search
                          </Button>
                        ) : (
                          <Button onClick={openCreateMediaModal}>Add Media</Button>
                        )
                      }
                    />
                  ) : (
                    <>
                      <div className='grid gap-4 sm:grid-cols-2 md:grid-cols-3'>
                        {sortedMedia.map((item) => (
                          <article
                            key={item.id}
                            className='group relative overflow-hidden rounded-2xl border border-sand/20 bg-white/80 transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60 '
                          >
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              className='aspect-[4/3] w-full object-cover'
                            />
                            <div className='absolute inset-x-0 bottom-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.8)_20%,rgba(0,0,0,0.7)_40%,rgba(0,0,0,0.3)_60%,transparent_80%)] p-3 pt-14'>
                              <h3 className='truncate text-sm font-semibold text-white drop-shadow-sm'>{item.name}</h3>
                            </div>
                            <div className='absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                              <IconButton
                                onClick={() => openEditMediaModal(item)}
                                className='bg-white/80 text-sea backdrop-blur-sm hover:bg-white dark:bg-dark-sand/80 dark:hover:bg-dark-sand'
                                title={`Edit ${item.name}`}
                                aria-label={`Edit ${item.name}`}
                              >
                                <Pencil size={14} />
                              </IconButton>
                              <IconButton
                                onClick={() => {
                                  void deleteMedia(item);
                                }}
                                className='bg-white/80 text-terracotta backdrop-blur-sm hover:bg-white dark:bg-dark-sand/80 dark:hover:bg-dark-sand'
                                title={`Delete ${item.name}`}
                                aria-label={`Delete ${item.name}`}
                              >
                                <Trash2 size={14} />
                              </IconButton>
                            </div>
                          </article>
                        ))}
                      </div>

                      <Pagination
                        currentPage={mediaPage}
                        totalPages={mediaTotalPages}
                        hasNextPage={mediaPage < mediaTotalPages}
                        hasPrevPage={mediaPage > 1}
                        onPageChange={setMediaPage}
                      />
                    </>
                  )}
                </div>
              ) : (
                <div className='flex gap-6'>
                  <div className='w-1/2 space-y-4'>
                    <div className='flex items-center justify-between'>
                      <h2 className='text-xl font-semibold text-text-primary dark:text-text-primary'>Media Groups</h2>
                      <div className='flex items-center gap-3'>
                        <Input
                          type='text'
                          value={groupSearch}
                          onChange={(event) => setGroupSearch(event.target.value)}
                          placeholder='Search groups...'
                          startIcon={<Search size={14} className='text-text-secondary dark:text-text-secondary' />}
                        />
                        <Button size='sm' onClick={openCreateGroupModal}>
                          <Plus size={14} />
                          Create Group
                        </Button>
                      </div>
                    </div>

                    {groupTotalCount === 0 ? (
                      <Empty
                        title={debouncedGroupSearch ? 'No groups match your search' : 'No groups yet'}
                        description={debouncedGroupSearch ? 'Try a different search term.' : 'Create a media group, then assign images to it.'}
                        action={
                          debouncedGroupSearch ? (
                            <Button variant='secondary' onClick={() => setGroupSearch('')}>
                              Clear Search
                            </Button>
                          ) : (
                            <Button onClick={openCreateGroupModal}>Create Group</Button>
                          )
                        }
                      />
                    ) : (
                      <>
                        <div className='overflow-hidden rounded-xl border border-sand/20 dark:border-sand/40'>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <SortableTableHeader field='name' label='Name' currentSort={groupSort} onSort={handleGroupSort} />
                                <TableHead>Images</TableHead>
                                <TableHead>Description</TableHead>
                                <TableHead />
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {sortedMediaGroups.map((group) => (
                                <TableRow
                                  key={group.id}
                                  className='cursor-pointer'
                                  onClick={() => setSelectedGroup(group)}
                                >
                                  <TableCell className='font-medium text-text-primary dark:text-text-primary'>{group.name}</TableCell>
                                  <TableCell className='text-text-secondary dark:text-text-secondary'>{group.items.length}</TableCell>
                                  <TableCell>
                                    <span className='truncate text-xs text-text-secondary dark:text-text-secondary'>
                                      {group.description || '—'}
                                    </span>
                                  </TableCell>
                                  <TableCell>
                                    <div className='flex items-center justify-end gap-1' onClick={(e) => e.stopPropagation()}>
                                      <IconButton
                                        onClick={() => setSelectedGroup(group)}
                                        className='text-sea '
                                        title={`View ${group.name}`}
                                        aria-label={`View ${group.name}`}
                                      >
                                        <Search size={14} />
                                      </IconButton>
                                      <IconButton
                                        onClick={() => openEditGroupModal(group)}
                                        className='text-sea '
                                        title={`Edit ${group.name}`}
                                        aria-label={`Edit ${group.name}`}
                                      >
                                        <Pencil size={14} />
                                      </IconButton>
                                      <IconButton
                                        onClick={() => {
                                          void deleteGroup(group);
                                        }}
                                        className='text-terracotta'
                                        title={`Delete ${group.name}`}
                                        aria-label={`Delete ${group.name}`}
                                      >
                                        <Trash2 size={14} />
                                      </IconButton>
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                        <Pagination
                          currentPage={groupPage}
                          totalPages={groupTotalPages}
                          hasNextPage={groupPage < groupTotalPages}
                          hasPrevPage={groupPage > 1}
                          onPageChange={setGroupPage}
                        />
                      </>
                    )}
                  </div>

                  <div className='w-1/2 space-y-4'>
                    {selectedGroup ? (
                      <>
                        <div className='flex items-center justify-between'>
                          <div>
                            <h3 className='text-lg font-semibold text-text-primary dark:text-text-primary'>{selectedGroup.name}</h3>
                            {selectedGroup.description ? (
                              <p className='text-sm text-text-secondary dark:text-text-secondary'>{selectedGroup.description}</p>
                            ) : (
                              <p className='text-sm text-text-secondary dark:text-text-secondary'>{selectedGroup.items.length} media items</p>
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

                        {selectedGroup.items.length === 0 ? (
                          <div className='flex flex-col items-center justify-center gap-3 py-12 text-center text-text-secondary dark:text-text-secondary'>
                            <p>No media assigned yet.</p>
                          </div>
                        ) : (
                          <div className='grid gap-4 grid-cols-2'>
                            {selectedGroup.items.map((item, index) => (
                              <article
                                key={item.id}
                                className='group relative overflow-hidden rounded-2xl border border-sand/20 bg-white/80 transition-colors hover:border-sea/40 dark:border-sand/40 dark:bg-dark-sand/60'
                              >
                                <img
                                  src={item.media.imageUrl}
                                  alt={item.media.name}
                                  className='aspect-[4/3] w-full object-cover'
                                />
                                <div className='absolute inset-x-0 bottom-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.9)_0%,rgba(0,0,0,0.8)_20%,rgba(0,0,0,0.7)_40%,rgba(0,0,0,0.3)_60%,transparent_80%)] p-3 pt-14'>
                                  <h3 className='truncate text-sm font-semibold text-white drop-shadow-sm'>{item.media.name}</h3>
                                </div>
                                <div className='absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                                  <IconButton
                                    onClick={() => {
                                      void moveMediaInSelectedGroup(item.mediaId, -1);
                                    }}
                                    disabled={index === 0}
                                    className='bg-white/80 text-sea backdrop-blur-sm hover:bg-white dark:bg-dark-sand/80 dark:hover:bg-dark-sand'
                                    title='Move up'
                                    aria-label='Move up'
                                  >
                                    <ArrowUp size={14} />
                                  </IconButton>
                                  <IconButton
                                    onClick={() => {
                                      void moveMediaInSelectedGroup(item.mediaId, 1);
                                    }}
                                    disabled={index === selectedGroup.items.length - 1}
                                    className='bg-white/80 text-sea backdrop-blur-sm hover:bg-white dark:bg-dark-sand/80 dark:hover:bg-dark-sand'
                                    title='Move down'
                                    aria-label='Move down'
                                  >
                                    <ArrowDown size={14} />
                                  </IconButton>
                                  <IconButton
                                    onClick={() => {
                                      void removeMediaFromSelectedGroup(item.mediaId);
                                    }}
                                    className='bg-white/80 text-terracotta backdrop-blur-sm hover:bg-white dark:bg-dark-sand/80 dark:hover:bg-dark-sand'
                                    title='Remove from group'
                                    aria-label='Remove from group'
                                  >
                                    <X size={14} />
                                  </IconButton>
                                </div>
                              </article>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className='flex flex-col items-center justify-center gap-3 py-16 text-center text-text-secondary dark:text-text-secondary'>
                        <p>Select a group from the table to view its media.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Card>
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
                error={!!error && Boolean(editingMedia) && !mediaNameInput.trim()}
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
                  <FileInput
                    accept='image/*'
                    multiple
                    disabled={isUploadingMediaImage}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      setSelectedImageFiles(files);
                      if (error) setError('');
                    }}
                  />
                  <span className='mt-2 block text-xs text-text-secondary dark:text-text-secondary'>
                    {isUploadingMediaImage ? 'Uploading…' : 'Select one or more images. Multi-upload is supported.'}
                  </span>
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
                  <Select
                    value={groupAssignMode}
                    onChange={(value) => {
                      const nextMode = value as MediaGroupAssignMode;
                      setGroupAssignMode(nextMode);
                      if (nextMode !== 'existing') {
                        setGroupAssignExistingId('');
                      }
                      if (nextMode !== 'new') {
                        setGroupAssignNewName('');
                        setGroupAssignNewDescription('');
                      }
                    }}
                    options={[
                      { value: 'none', label: 'Do not assign' },
                      { value: 'existing', label: 'Assign to existing group' },
                      { value: 'new', label: 'Create a new group and assign' }
                    ]}
                  />

                  {groupAssignMode === 'existing' ? (
                    <Select
                      value={groupAssignExistingId}
                      onChange={(value) => setGroupAssignExistingId(value)}
                      placeholder='Select a group'
                      options={mediaGroups.map((group) => ({
                        value: String(group.id),
                        label: `${group.name} (${group.items.length} images)`
                      }))}
                    />
                  ) : null}

                  {groupAssignMode === 'new' ? (
                    <div className='space-y-2'>
                      <Input
                        value={groupAssignNewName}
                        onChange={(event) => setGroupAssignNewName(event.target.value)}
                        placeholder='New group name'
                      />
                      <Textarea
                        value={groupAssignNewDescription}
                        onChange={(event) => setGroupAssignNewDescription(event.target.value)}
                        rows={2}
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
              <Textarea
                value={groupDescriptionInput}
                onChange={(event) => {
                  setGroupDescriptionInput(event.target.value);
                  if (error) setError('');
                }}
                rows={3}
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
