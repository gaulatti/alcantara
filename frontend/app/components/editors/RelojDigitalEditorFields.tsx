import { useMemo } from 'react';
import { Select } from '@gaulatti/bleecker';
import { normalizeProgramTextSequence, createProgramTextSequence, type ProgramTextSequence } from '../../utils/programSequence';
import { ProgramTextSequenceEditor } from './ProgramTextSequenceEditor';

export function RelojDigitalEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  timezoneOptions
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  timezoneOptions: { value: string; label: string }[];
}) {
  const normalizedText = normalizeProgramTextSequence(props.textSequence, 0, { includeMarquee: false });
  const normalizedCta = normalizeProgramTextSequence(props.ctaSequence, 0, { includeMarquee: false });

  const textSequenceForEditor = useMemo<ProgramTextSequence>(() => normalizedText ?? createProgramTextSequence('manual', { includeMarquee: false }), [normalizedText]);
  const ctaSequenceForEditor = useMemo<ProgramTextSequence>(() => normalizedCta ?? createProgramTextSequence('manual', { includeMarquee: false }), [normalizedCta]);

  const buildSequenceProps = (t: ProgramTextSequence, c: ProgramTextSequence) => ({ ...props, textSequence: t, ctaSequence: c, _timestamp: Date.now() });

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

  const applyProps = (nextProps: unknown) => replaceProps(componentType, nextProps);

  return (
    <div className='space-y-4'>
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Starting Timezone</label>
        <Select value={props.timezone || 'America/New_York'} onChange={v => updateProp(componentType, 'timezone', v)}
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 bg-black/20 text-white' options={timezoneOptions} />
      </div>

      <div className='space-y-2 rounded border border-sand/30 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>Lower Third Title</span>
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>Sequence-only. If no text item is active, the entire lower third strip hides.</p>
          <ProgramTextSequenceEditor sequence={textSequenceForEditor} textLabel='Title' textPlaceholder='Main lower third title'
            onChange={next => applyProps(buildSequenceProps(next, ctaSequenceForEditor))} onTakeSelection={activateTextSequence} />
        </div>
      </div>

      <div className='space-y-2 rounded border border-sand/30 p-3'>
        <span className='text-xs font-semibold uppercase tracking-wide text-text-secondary'>CTA Sequence</span>
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>CTA sequence rotates automatically if configured as playlist.</p>
          <ProgramTextSequenceEditor sequence={ctaSequenceForEditor} textLabel='CTA' textPlaceholder='e.g. YA VIENE, UP NEXT'
            onChange={next => applyProps(buildSequenceProps(textSequenceForEditor, next))} onTakeSelection={activateCtaSequence} />
        </div>
      </div>
    </div>
  );
}
