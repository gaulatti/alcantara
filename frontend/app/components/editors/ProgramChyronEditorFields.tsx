import { useMemo } from 'react';
import { Input, Switch } from '@gaulatti/bleecker';
import { normalizeProgramTextSequence, createProgramTextSequence, createProgramTextSequenceItem, type ProgramTextSequence } from '../../utils/programSequence';
import { ProgramTextSequenceEditor } from './ProgramTextSequenceEditor';

export function ProgramChyronEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
}) {
  const normalizedText = normalizeProgramTextSequence(props.textSequence, 0, { includeMarquee: true });
  const normalizedCta = normalizeProgramTextSequence(props.ctaSequence);
  const showValue = typeof props.show === 'boolean' ? props.show : typeof props.show === 'string' ? props.show.trim().toLowerCase() !== 'false' : true;
  const legacyMainText = typeof props.text === 'string' ? props.text : '';
  const legacyUseMarquee = Boolean(props.useMarquee);
  const legacyCtaText = typeof props.cta === 'string' ? props.cta : '';

  const seqHasText = (s: ProgramTextSequence): boolean => s.items.some(i => i.kind === 'sequence' ? seqHasText(i.sequence) : Boolean(i.text.trim()));

  const textSequenceForEditor = useMemo<ProgramTextSequence>(() => {
    const base = normalizedText ?? createProgramTextSequence('manual', { includeMarquee: true });
    if (!legacyMainText.trim() && !legacyUseMarquee) return base;
    if (seqHasText(base)) return base;
    const first = base.items[0];
    const fallback = createProgramTextSequenceItem('preset', { includeMarquee: true });
    const seeded = first && first.kind === 'preset'
      ? { ...first, text: legacyMainText, useMarquee: legacyUseMarquee }
      : { ...(fallback.kind === 'preset' ? fallback : createProgramTextSequenceItem('preset', { includeMarquee: true })), text: legacyMainText, useMarquee: legacyUseMarquee };
    return { ...base, items: [seeded], activeItemId: base.activeItemId ?? seeded.id, startedAt: base.startedAt ?? Date.now() };
  }, [normalizedText, legacyMainText, legacyUseMarquee]);

  const ctaSequenceForEditor = useMemo<ProgramTextSequence>(() => {
    const base = normalizedCta ?? createProgramTextSequence('manual');
    if (!legacyCtaText.trim()) return base;
    if (seqHasText(base)) return base;
    const first = base.items[0];
    const fallback = createProgramTextSequenceItem('preset');
    const seeded = first && first.kind === 'preset'
      ? { ...first, text: legacyCtaText }
      : { ...(fallback.kind === 'preset' ? fallback : createProgramTextSequenceItem('preset')), text: legacyCtaText };
    return { ...base, items: [seeded], activeItemId: base.activeItemId ?? seeded.id, startedAt: base.startedAt ?? Date.now() };
  }, [normalizedCta, legacyCtaText]);

  const buildSequenceProps = (t: ProgramTextSequence, c: ProgramTextSequence) => ({ ...props, textSequence: t, ctaSequence: c, text: '', useMarquee: false, cta: '' });

  const applyProps = (nextProps: any) => replaceProps(componentType, nextProps);

  const activateTextSequence = async (next: ProgramTextSequence) => {
    const nextProps = buildSequenceProps(next, ctaSequenceForEditor);
    replaceProps(componentType, nextProps);
    if (commitProps) await commitProps(componentType, nextProps);
  };

  const activateCtaSequence = async (next: ProgramTextSequence) => {
    const nextProps = buildSequenceProps(textSequenceForEditor, next);
    replaceProps(componentType, nextProps);
    if (commitProps) await commitProps(componentType, nextProps);
  };

  return (
    <div className='space-y-4'>
      <p className='text-xs text-text-secondary'>ModoItaliano row rule: if chyron and disclaimer are both enabled, chyron is shown.</p>
      <Switch checked={showValue} onCheckedChange={checked => updateProp(componentType, 'show', checked)} label='Show Chyron' />

      {showValue ? (
        <>
          <div className='space-y-2 rounded border border-sand/30 p-3'>
            <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>Main Chyron</span>
            <div className='space-y-3'>
              <p className='text-xs text-text-secondary'>Sequence-only. If no text item is selected, the chyron is hidden.</p>
              <ProgramTextSequenceEditor sequence={textSequenceForEditor} includeMarquee textLabel='Text' textPlaceholder='Main chyron text'
                onChange={next => applyProps(buildSequenceProps(next, ctaSequenceForEditor))} onTakeSelection={activateTextSequence} />
            </div>
          </div>

          <div className='space-y-2 rounded border border-sand/30 p-3'>
            <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>CTA</span>
            <div className='space-y-3'>
              <p className='text-xs text-text-secondary'>CTA is sequence-only as well.</p>
              <ProgramTextSequenceEditor sequence={ctaSequenceForEditor} textLabel='CTA' textPlaceholder='Call to action (shown above chyron)'
                onChange={next => applyProps(buildSequenceProps(textSequenceForEditor, next))} onTakeSelection={activateCtaSequence} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
