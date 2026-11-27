import { useEffect, useRef, useState } from 'react';
import { Field, Checkbox, Button, Input } from '@gaulatti/bleecker';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import {
  countSequenceLeafItems,
  createToniChyronSequenceItem,
  getToniChyronContentMode,
  getToniChyronSequenceSelectedItemId,
  normalizeToniChyronSequence,
  type ToniChyronSequence,
  type ToniChyronSequenceItem
} from '../../utils/toniChyronSequence';

export function ToniChyronSequenceEditor({
  sequence,
  onChange,
  onTakeSelection,
  depth = 0
}: {
  sequence: ToniChyronSequence;
  onChange: (nextSequence: ToniChyronSequence) => void;
  onTakeSelection?: (nextSequence: ToniChyronSequence) => Promise<void> | void;
  depth?: number;
}) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const isNested = depth > 0;
  const effectiveActiveItemId = getToniChyronSequenceSelectedItemId(sequence, nowMs);

  useEffect(() => {
    if (sequence.mode !== 'autoplay') return;
    const timer = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(timer);
  }, [sequence.mode, sequence.startedAt, sequence.intervalMs, sequence.loop, sequence.items.length]);

  const applySequence = (nextSequence: ToniChyronSequence) => {
    onChange({
      ...nextSequence,
      activeItemId: nextSequence.activeItemId && nextSequence.items.some(item => item.id === nextSequence.activeItemId)
        ? nextSequence.activeItemId : (nextSequence.items[0]?.id ?? null)
    });
  };

  const updateItem = (index: number, nextItem: ToniChyronSequenceItem) => {
    applySequence({ ...sequence, items: sequence.items.map((item, i) => i === index ? nextItem : item) });
  };

  // Only called for top-level chyron items (see the items map below).
  const toSequenceItem = (item: Extract<ToniChyronSequenceItem, { kind: 'preset' }>): ToniChyronSequenceItem => {
    // A new sequence item is always a sequence, and a new sequence always seeds one preset leaf.
    const nextItem = createToniChyronSequenceItem('sequence') as Extract<ToniChyronSequenceItem, { kind: 'sequence' }>;
    const nestedFirstItem = nextItem.sequence.items[0] as Extract<ToniChyronSequenceItem, { kind: 'preset' }>;
    // Carry every field of the saved chyron (text, marquee and chart values),
    // keeping the new leaf's own id (gaulatti/alcantara#197).
    const nextLeaf = { ...nestedFirstItem, ...item, id: nestedFirstItem.id };
    return { ...nextItem, id: item.id, label: item.text.trim() || 'Sequence', sequence: { ...nextItem.sequence, items: [nextLeaf], activeItemId: nextLeaf.id } };
  };

  const addItem = () => {
    const nextItem = createToniChyronSequenceItem('sequence');
    applySequence({ ...sequence, items: [...sequence.items, nextItem], activeItemId: sequence.activeItemId ?? nextItem.id, startedAt: Date.now() });
  };

  const removeItem = (index: number) => {
    // Called only from the items map, so index always names an existing item.
    const removed = sequence.items[index];
    const nextItems = sequence.items.filter((_, i) => i !== index);
    applySequence({ ...sequence, items: nextItems, activeItemId: sequence.activeItemId === removed.id ? (nextItems[0]?.id ?? null) : sequence.activeItemId, startedAt: Date.now() });
  };

  const activateItem = async (itemId: string) => {
    const nextSequence = { ...sequence, activeItemId: itemId, startedAt: Date.now() };
    applySequence(nextSequence);
    if (onTakeSelection) await onTakeSelection(nextSequence);
  };

  const reorderItems = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= sequence.items.length || toIndex >= sequence.items.length) return;
    const nextItems = [...sequence.items];
    const [moved] = nextItems.splice(fromIndex, 1);
    nextItems.splice(toIndex, 0, moved);
    applySequence({ ...sequence, items: nextItems });
  };

  return (
    <div className={`space-y-3 rounded border ${isNested ? 'border-sand/30 bg-dark-sand/70' : 'border-sand/40 bg-dark-sand/60'} p-3`}>
      <div className='flex flex-wrap items-center gap-2'>
        {isNested && <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>Nested sequence</span>}
        <Button type='button' onClick={() => applySequence({ ...sequence, mode: 'manual', activeItemId: sequence.mode === 'autoplay' ? (effectiveActiveItemId ?? sequence.activeItemId) : sequence.activeItemId, startedAt: Date.now() })}
          className={`px-2.5 py-1 rounded text-xs font-medium border ${sequence.mode === 'manual' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-sand/10'}`}>Manual</Button>
        <Button type='button' onClick={() => applySequence({ ...sequence, mode: 'autoplay', startedAt: Date.now() })}
          className={`px-2.5 py-1 rounded text-xs font-medium border ${sequence.mode === 'autoplay' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-sand/10'}`}>Autoplay</Button>
        {sequence.mode === 'autoplay' && (
          <>
            <label className='text-xs text-text-secondary'>Interval (ms)</label>
            <Input type='number' min={500} step={500} value={sequence.intervalMs ?? 4000}
              onChange={e => applySequence({ ...sequence, intervalMs: Math.max(500, Number(e.target.value) || 4000), startedAt: Date.now() })}
              className='w-28 px-2 py-1 text-xs border rounded focus:ring-2 focus:ring-sea/50' />
            <label className='flex items-center gap-1 text-xs text-text-secondary'>
              <Checkbox checked={sequence.loop !== false} onChange={e => applySequence({ ...sequence, loop: e.target.checked })} />
              Loop
            </label>
          </>
        )}
      </div>

      {sequence.items.length === 0 && <p className='text-xs text-text-secondary'>This sequence is empty. Add items below.</p>}

      <div className='space-y-3'>
        {sequence.items.map((item, index) => {
          const displayItem = depth === 0 && item.kind === 'preset' ? toSequenceItem(item) : item;
          const isActive = displayItem.id === effectiveActiveItemId;
          return (
            <div key={displayItem.id} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (draggingIndex !== null) reorderItems(draggingIndex, index); setDraggingIndex(null); }}
              className={`rounded border p-3 ${isActive ? 'border-sea/40 bg-sea/10' : 'border-sand/30 bg-dark-sand/80'}`}>
              <div className='flex flex-wrap items-center gap-2'>
                <span draggable onDragStart={() => setDraggingIndex(index)} onDragEnd={() => setDraggingIndex(null)}
                  className='cursor-grab select-none rounded border border-dashed border-sand/40 p-2 text-text-secondary' title='Drag to reorder' aria-label='Drag to reorder'>
                  <GripVertical size={14} strokeWidth={2} />
                </span>
                <div className='min-w-0 flex-1 text-xs font-medium uppercase tracking-wide text-text-secondary'>
                  {displayItem.kind === 'sequence' ? 'Nested Sequence' : 'Sequence Item'}
                </div>
                <Button type='button' onClick={() => reorderItems(index, index - 1)} disabled={index === 0}
                  aria-label={`Move item ${index + 1} up`} className='px-2 py-2 text-xs rounded border border-sand/40 text-text-primary disabled:opacity-30'><ChevronUp size={14} /></Button>
                <Button type='button' onClick={() => reorderItems(index, index + 1)} disabled={index === sequence.items.length - 1}
                  aria-label={`Move item ${index + 1} down`} className='px-2 py-2 text-xs rounded border border-sand/40 text-text-primary disabled:opacity-30'><ChevronDown size={14} /></Button>
                <Button type='button' onClick={() => { void activateItem(displayItem.id); }}
                  className='px-3 py-2 text-xs font-semibold rounded bg-sea text-white hover:bg-sea/90'>Take</Button>
                <Button type='button' onClick={() => removeItem(index)}
                  className='px-3 py-2 text-xs font-semibold rounded border border-terracotta/35 text-terracotta hover:bg-terracotta/10'>Remove</Button>
              </div>

              {displayItem.kind === 'preset' ? (
                <div className='mt-3 space-y-2'>
                  <Field label='Text'>
                    <Input type='text' value={displayItem.text} onChange={e => updateItem(index, { ...displayItem, text: e.target.value })}
                      placeholder='Chyron message' />
                  </Field>
                  <label className='flex items-center gap-2 text-sm text-text-primary'>
                    <Checkbox checked={Boolean(displayItem.useMarquee)} onChange={e => updateItem(index, { ...displayItem, useMarquee: e.target.checked })} />
                    Force marquee scrolling
                  </label>
                </div>
              ) : (
                <div className='mt-3'>
                  <ToniChyronSequenceEditor
                    sequence={displayItem.sequence} depth={depth + 1}
                    onChange={nextNested => updateItem(index, { ...displayItem, sequence: nextNested })}
                    onTakeSelection={async nextNested => {
                      const nextSeq = { ...sequence, items: sequence.items.map((e, i) => i === index ? { ...displayItem, sequence: nextNested } : e) };
                      applySequence(nextSeq);
                      if (onTakeSelection) await onTakeSelection(nextSeq);
                    }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className='flex flex-wrap gap-2'>
        <Button type='button' onClick={addItem} className='px-3 py-2 text-xs font-semibold rounded border border-sand/40 text-text-primary hover:bg-sand/10'>+ Sequence</Button>
      </div>
    </div>
  );
}
