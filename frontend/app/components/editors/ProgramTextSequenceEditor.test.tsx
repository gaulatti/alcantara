import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgramTextSequenceEditor } from './ProgramTextSequenceEditor';
import type { ProgramTextSequence } from '../../utils/programSequence';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function sequence(): ProgramTextSequence {
  return { mode: 'manual', activeItemId: 'first', intervalMs: 1000, loop: true, startedAt: 10000, items: [
    { id: 'first', kind: 'preset', text: 'First headline', useMarquee: false },
    { id: 'second', kind: 'preset', text: 'Second headline', useMarquee: true },
  ] };
}

function editor(initial: ProgramTextSequence = sequence(), props: { depth?: number; includeMarquee?: boolean; onTakeSelection?: (next: ProgramTextSequence) => void | Promise<void> } = {}) {
  const changed = vi.fn();
  function Controlled() {
    const [current, setCurrent] = useState(initial);
    return <ProgramTextSequenceEditor sequence={current} onChange={(next) => { changed(next); setCurrent(next); }} depth={1} textLabel="Headline" textPlaceholder="Write headline" {...props} />;
  }
  return { ...render(<Controlled />), changed };
}

describe('editable text sequences', () => {
  it('edits a single headline and its marquee flag while preserving the other item', () => {
    const { changed } = editor(sequence(), { includeMarquee: true });
    fireEvent.change(screen.getByDisplayValue('First headline'), { target: { value: 'Updated headline' } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ id: 'first', text: 'Updated headline' }), expect.objectContaining({ id: 'second', text: 'Second headline' })],
    }));
    fireEvent.click(screen.getAllByLabelText('Force marquee scrolling')[0]);
    expect(changed.mock.calls.at(-1)![0].items[0]).toMatchObject({ text: 'Updated headline', useMarquee: true });
    expect(screen.getByDisplayValue('Updated headline')).toBeInTheDocument();
  });
  it('removes active items, selects the surviving item, and supports an explicitly empty sequence', () => {
    const { changed } = editor();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(changed.mock.calls.at(-1)![0]).toMatchObject({ activeItemId: 'second', items: [{ id: 'second', text: 'Second headline' }] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ activeItemId: null, items: [] }));
    expect(screen.getByText('This sequence is empty. Add items below.')).toBeInTheDocument();
  });
  it('takes the selected item with the complete updated sequence', async () => {
    const take = vi.fn().mockResolvedValue(undefined);
    const { changed } = editor(sequence(), { onTakeSelection: take });
    fireEvent.click(screen.getAllByRole('button', { name: 'Take' })[1]);
    await waitFor(() => expect(take).toHaveBeenCalledOnce());
    expect(take).toHaveBeenCalledWith(expect.objectContaining({ activeItemId: 'second' }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ activeItemId: 'second' }));
  });
  it('adds a nested sequence and selects it when starting from an empty sequence', () => {
    const { changed } = editor({ mode: 'manual', items: [], activeItemId: null });
    fireEvent.click(screen.getByRole('button', { name: '+ Sequence' }));
    const next = changed.mock.calls.at(-1)![0] as ProgramTextSequence;
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ kind: 'sequence', label: 'Nested Sequence' });
    expect(next.activeItemId).toBe(next.items[0].id);
    expect(next.startedAt).toBeTypeOf('number');
  });
  it('reorders only valid drops and leaves a cancelled or same-position drag unchanged', () => {
    const { changed } = editor();
    const handles = screen.getAllByLabelText('Drag to reorder');
    fireEvent.dragStart(handles[0]);
    fireEvent.dragOver(handles[1]);
    fireEvent.drop(handles[1]);
    expect(changed.mock.calls.at(-1)![0].items.map((item: { id: string }) => item.id)).toEqual(['second', 'first']);
    changed.mockClear();
    const reordered = screen.getAllByLabelText('Drag to reorder');
    fireEvent.dragStart(reordered[0]);
    fireEvent.drop(reordered[0]);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.dragStart(reordered[0]);
    fireEvent.dragEnd(reordered[0]);
    fireEvent.drop(reordered[1]);
    expect(changed).not.toHaveBeenCalled();
  });
  it('does not show marquee controls when the component contract excludes them', () => {
    editor();
    expect(screen.queryByLabelText('Force marquee scrolling')).not.toBeInTheDocument();
  });
});

describe('autoplay and nested editing', () => {
  it('switches autoplay timing, enforces interval bounds, and preserves the current item when returning to manual', () => {
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const { changed } = editor();
    fireEvent.click(screen.getByRole('button', { name: 'Autoplay' }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'autoplay', startedAt: 10000 }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ intervalMs: 500 }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ intervalMs: 4000 }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1000' } });
    fireEvent.click(screen.getByLabelText('Loop'));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ loop: false }));
    act(() => vi.advanceTimersByTime(1250));
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'manual', activeItemId: 'second' }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });
  it('wraps legacy top-level text in an editable nested sequence without losing text or marquee state', () => {
    const legacy: ProgramTextSequence = { mode: 'manual', activeItemId: 'legacy', items: [{ id: 'legacy', kind: 'preset', text: 'Legacy headline', useMarquee: true }] };
    const { changed } = editor(legacy, { depth: 0, includeMarquee: true });
    fireEvent.change(screen.getByDisplayValue('Legacy headline'), { target: { value: 'Updated legacy headline' } });
    const nested = changed.mock.calls.at(-1)![0].items[0];
    expect(nested).toMatchObject({ id: 'legacy', kind: 'sequence', label: 'Legacy headline' });
    expect(nested.sequence.items[0]).toMatchObject({ kind: 'preset', text: 'Updated legacy headline', useMarquee: true });
  });
  it('propagates nested TAKE with the parent sequence and current child selection', async () => {
    const take = vi.fn().mockResolvedValue(undefined);
    const parent: ProgramTextSequence = { mode: 'manual', activeItemId: 'group', items: [{ id: 'group', kind: 'sequence', label: 'Headlines', sequence: sequence() }] };
    const { changed } = editor(parent, { depth: 0, onTakeSelection: take });
    fireEvent.click(screen.getAllByRole('button', { name: 'Take' })[2]);
    await waitFor(() => expect(take).toHaveBeenCalledOnce());
    const next = take.mock.calls[0][0];
    expect(next.items[0]).toMatchObject({ id: 'group', kind: 'sequence', sequence: { activeItemId: 'second' } });
    expect(changed.mock.calls.at(-1)![0].items[0].sequence.activeItemId).toBe('second');
  });
});
