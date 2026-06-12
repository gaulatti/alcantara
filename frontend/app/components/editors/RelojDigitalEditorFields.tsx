import { useMemo, useState } from 'react';
import { Input, Select } from '@gaulatti/bleecker';
import { normalizeProgramTextSequence, createProgramTextSequence, type ProgramTextSequence } from '../../utils/programSequence';
import { ProgramTextSequenceEditor } from './ProgramTextSequenceEditor';
import { SCENE_TRANSITIONS } from '../../utils/sceneTransitions';
import type { Scene } from '../../models/broadcast';

export function RelojDigitalEditorFields({
  componentType,
  props,
  updateProp,
  replaceProps,
  commitProps,
  timezoneOptions,
  scenes,
  programId
}: {
  componentType: string;
  props: any;
  updateProp: (componentType: string, propName: string, value: any) => void;
  replaceProps: (componentType: string, nextProps: any) => void;
  commitProps?: (componentType: string, nextProps: any) => Promise<void> | void;
  timezoneOptions: { value: string; label: string }[];
  scenes?: Scene[];
  programId?: string;
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

  const isCountdown = props.mode === 'countdown';

  const durationSec = typeof props.countdownDuration === 'number' ? props.countdownDuration : 300;
  const durationHours = Math.floor(durationSec / 3600);
  const durationMinutes = Math.floor((durationSec % 3600) / 60);
  const durationSeconds = durationSec % 60;

  const setDuration = (h: number, m: number, s: number) => {
    const total = h * 3600 + m * 60 + s;
    updateProp(componentType, 'countdownDuration', Math.max(0, total));
  };

  const toggleCountdown = async () => {
    const nextCmd = (typeof props.countdownCommand === 'number' ? props.countdownCommand : 0) + 1;
    const nextProps = { ...props, countdownCommand: nextCmd };
    replaceProps(componentType, nextProps);
    if (commitProps) {
      try {
        await commitProps(componentType, nextProps);
      } catch (err) {
        console.error('[Countdown] toggle error:', err);
      }
    }
    setLocallyRunning((prev) => !prev);
  };

  const [locallyRunning, setLocallyRunning] = useState(false);
  const isRunning = locallyRunning;

  const sceneOptions = useMemo(() => {
    if (!scenes) return [];
    return scenes.map((s) => ({ value: String(s.id), label: s.name }));
  }, [scenes]);

  const transitionOptions = useMemo(() => {
    return SCENE_TRANSITIONS.map((t) => ({ value: t.id, label: t.name }));
  }, []);

  return (
    <div className='space-y-4'>
      <div>
        <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Mode</label>
        <Select value={props.mode || 'clock'} onChange={v => updateProp(componentType, 'mode', v)}
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 bg-black/20 text-white'
          options={[{ value: 'clock', label: 'Clock' }, { value: 'countdown', label: 'Countdown' }]} />
      </div>

      {!isCountdown && (
        <div>
          <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Starting Timezone</label>
          <Select value={props.timezone || 'America/New_York'} onChange={v => updateProp(componentType, 'timezone', v)}
            className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 bg-black/20 text-white' options={timezoneOptions} />
        </div>
      )}

      {isCountdown && (
        <>
          <div>
            <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Duration</label>
            <div className='flex gap-2 items-center'>
              <div className='flex-1'>
                <label className='block text-[10px] text-text-secondary mb-0.5'>HH</label>
                <Input type='number' min={0} max={99} value={durationHours}
                  onChange={e => setDuration(parseInt(e.target.value) || 0, durationMinutes, durationSeconds)}
                  className='w-full px-2 py-1.5 text-sm border rounded bg-black/20 text-white text-center' />
              </div>
              <span className='text-lg text-text-secondary mt-5'>:</span>
              <div className='flex-1'>
                <label className='block text-[10px] text-text-secondary mb-0.5'>MM</label>
                <Input type='number' min={0} max={59} value={durationMinutes}
                  onChange={e => setDuration(durationHours, parseInt(e.target.value) || 0, durationSeconds)}
                  className='w-full px-2 py-1.5 text-sm border rounded bg-black/20 text-white text-center' />
              </div>
              <span className='text-lg text-text-secondary mt-5'>:</span>
              <div className='flex-1'>
                <label className='block text-[10px] text-text-secondary mb-0.5'>SS</label>
                <Input type='number' min={0} max={59} value={durationSeconds}
                  onChange={e => setDuration(durationHours, durationMinutes, parseInt(e.target.value) || 0)}
                  className='w-full px-2 py-1.5 text-sm border rounded bg-black/20 text-white text-center' />
              </div>
            </div>
          </div>

          <div>
            <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Target Scene</label>
            <Select value={props.countdownTargetSceneId ?? ''}
              onChange={v => updateProp(componentType, 'countdownTargetSceneId', v === '' ? null : Number(v))}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 bg-black/20 text-white'
              options={[{ value: '', label: '— Select scene —' }, ...sceneOptions]} />
          </div>

          <div>
            <label className='block text-xs font-semibold uppercase tracking-wide text-text-secondary mb-1'>Transition</label>
            <Select value={props.countdownTransitionId || 'cut'}
              onChange={v => updateProp(componentType, 'countdownTransitionId', v)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50 bg-black/20 text-white'
              options={transitionOptions} />
          </div>

          <div className='pt-2'>
            {isRunning ? (
              <button onClick={toggleCountdown}
                className='w-full px-4 py-2 text-sm font-semibold uppercase tracking-wide rounded bg-terracotta/80 hover:bg-terracotta text-white transition-colors'>
                Stop Countdown
              </button>
            ) : (
              <button onClick={toggleCountdown}
                disabled={!props.countdownTargetSceneId}
                className='w-full px-4 py-2 text-sm font-semibold uppercase tracking-wide rounded bg-sea/80 hover:bg-sea text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed'>
                Start Countdown
              </button>
            )}
          </div>
        </>
      )}

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
