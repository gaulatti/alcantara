import {
  AlertDialog,
  Button,
  Card,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  ErrorState,
  IconButton,
  SkeletonTable,
  StatePill
} from '@gaulatti/bleecker';
import type { ColumnDef, SortState } from '@gaulatti/bleecker';
import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

/**
 * The one list pattern of the library screens (audio clips, transitions, scenes, scene templates):
 * a dense table, one visible primary action per row, the rest in a menu with delete last and
 * confirmed, skeleton rows while loading, an empty state with one primary action and an error
 * state with a retry.
 */
export type LibraryStatus = 'loading' | 'error' | 'ready';

export interface LibraryRowAction {
  label: string;
  onSelect: () => void;
}

export interface LibraryRowActionsProps {
  /** Names the row in accessible labels and in the delete confirmation. */
  name: string;
  /** The one visible action. */
  primary: LibraryRowAction;
  /** Further actions, kept in the menu above delete. */
  more?: LibraryRowAction[];
  /** Delete is always last and always confirmed; if it rejects, the confirmation stays open. */
  onDelete: () => Promise<void> | void;
  deleteTitle: string;
  deleteDescription?: string;
}

export function LibraryRowActions({ name, primary, more = [], onDelete, deleteTitle, deleteDescription }: LibraryRowActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onDelete();
      setConfirming(false);
    } catch {
      // The caller has already told the operator why; the dialog stays open so the delete is not mistaken for done.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className='flex items-center justify-end gap-1'>
      <Button size='sm' variant='secondary' onClick={primary.onSelect} aria-label={`${primary.label} ${name}`}>
        {primary.label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton title={`More actions for ${name}`} aria-label={`More actions for ${name}`}>
            <MoreHorizontal size={16} />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          {more.map((action) => (
            <DropdownMenuItem key={action.label} onSelect={action.onSelect}>
              {action.label}
            </DropdownMenuItem>
          ))}
          {more.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem className='text-terracotta' onSelect={() => setConfirming(true)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        isOpen={confirming}
        title={deleteTitle}
        description={deleteDescription ?? 'This cannot be undone.'}
        confirmLabel='Delete'
        cancelLabel='Cancel'
        variant='destructive'
        confirmLoading={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}

/** Enabled or disabled as a state pill; the state is always in words. */
export function EnabledPill({ enabled }: { enabled: boolean }) {
  return <StatePill tone={enabled ? 'ok' : 'idle'} label={enabled ? 'Enabled' : 'Disabled'} />;
}

/** A 0-1 volume as a whole percentage with tabular numerals. */
export function VolumeCell({ volume }: { volume: number }) {
  return <span className='tabular-nums'>{Math.round(volume * 100)}%</span>;
}

export interface LibraryListProps<T> {
  caption: string;
  columns: ColumnDef<T>[];
  data: T[];
  getRowKey: (row: T) => string;
  status: LibraryStatus;
  onRetry: () => void;
  errorTitle: string;
  empty: { title: string; description: string; action: ReactNode };
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  /** Controls shown above the table, set apart from the header's create action. */
  toolbar?: ReactNode;
}

export function LibraryList<T>({ caption, columns, data, getRowKey, status, onRetry, errorTitle, empty, sort, onSortChange, toolbar }: LibraryListProps<T>) {
  return (
    <Card className='space-y-4'>
      {toolbar}
      {status === 'loading' ? (
        <div role='status' aria-label={`Loading ${caption}`}>
          <SkeletonTable rows={5} columns={Math.max(columns.length, 2)} />
        </div>
      ) : status === 'error' ? (
        <ErrorState title={errorTitle} description='The list could not be loaded.' onRetry={onRetry} retryLabel='Retry' />
      ) : data.length === 0 ? (
        <Empty title={empty.title} description={empty.description} action={empty.action} />
      ) : (
        // The caption names the table for assistive technology; on screen it only repeated the heading (#875).
        <DataTable caption={caption} className='[&_caption]:sr-only' density='dense' columns={columns} data={data} getRowKey={getRowKey} sort={sort} onSortChange={onSortChange} />
      )}
    </Card>
  );
}
