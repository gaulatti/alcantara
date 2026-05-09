import { Button, Input } from '@gaulatti/bleecker';
import {
  normalizeToniChyronSequence,
  getToniChyronContentMode,
  createToniChyronSequence,
  type ToniChyronSequence,
} from '../../utils/toniChyronSequence';
import { ToniChyronSequenceEditor } from './ToniChyronSequenceEditor';

export function ToniChyronEditorFields({
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
  const normalizedSequence = normalizeToniChyronSequence(props.sequence);
  const contentMode = getToniChyronContentMode(props.contentMode, normalizedSequence);
  const socialHandlesValue = Array.isArray(props.socialHandles)
    ? props.socialHandles.map((e: unknown) => (typeof e === 'string' ? e.trim() : '')).filter((e: string) => e.length > 0)
    : ['@modoitaliano.oficial', '@fifth.bell', '@hnmages'];

  const applyProps = (nextProps: any) => replaceProps(componentType, nextProps);

  const activateSequence = async (nextSequence: ToniChyronSequence) => {
    const nextProps = { ...props, contentMode: 'sequence', sequence: nextSequence };
    replaceProps(componentType, nextProps);
    if (commitProps) await commitProps(componentType, nextProps);
  };

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap gap-2'>
        <Button type='button' onClick={() => applyProps({ ...props, contentMode: 'text' })}
          className={`px-3 py-1.5 rounded text-sm font-medium border ${contentMode === 'text' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-dark-sand/60'}`}>
          Direct Text
        </Button>
        <Button type='button' onClick={() => applyProps({ ...props, contentMode: 'sequence', sequence: normalizedSequence ?? createToniChyronSequence('manual') })}
          className={`px-3 py-1.5 rounded text-sm font-medium border ${contentMode === 'sequence' ? 'bg-sea text-white border-sea' : 'bg-dark-sand/80 text-text-primary border-sand/40 hover:bg-dark-sand/60'}`}>
          Sequence
        </Button>
      </div>

      {contentMode === 'sequence' ? (
        <div className='space-y-3'>
          <p className='text-xs text-text-secondary'>Sequence mode lets you preload multiple chyron values and take them live with one tap.</p>
          <ToniChyronSequenceEditor
            sequence={normalizedSequence ?? createToniChyronSequence('manual')}
            onChange={nextSequence => applyProps({ ...props, contentMode: 'sequence', sequence: nextSequence })}
            onTakeSelection={activateSequence}
          />
          <details className='rounded border border-dashed border-sand/40 px-3 py-2'>
            <summary className='cursor-pointer text-xs font-medium text-text-secondary'>Fallback direct text</summary>
            <div className='space-y-2 pt-3'>
              <div>
                <label className='block text-xs text-text-secondary mb-1'>Fallback Text</label>
                <Input type='text' value={props.text || ''} onChange={e => updateProp(componentType, 'text', e.target.value)}
                  className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50' placeholder='Used only if the sequence is empty' />
              </div>
              <label className='flex items-center gap-2 text-sm text-text-primary'>
                <Input type='checkbox' checked={Boolean(props.useMarquee)} onChange={e => updateProp(componentType, 'useMarquee', e.target.checked)} className='h-4 w-4' />
                Fallback marquee
              </label>
            </div>
          </details>
        </div>
      ) : (
        <div className='space-y-2'>
          <div>
            <label className='block text-xs text-text-secondary mb-1'>Text</label>
            <Input type='text' value={props.text || ''} onChange={e => updateProp(componentType, 'text', e.target.value)}
              className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50' placeholder='Chyron message' />
          </div>
          <label className='flex items-center gap-2 text-sm text-text-primary'>
            <Input type='checkbox' checked={Boolean(props.useMarquee)} onChange={e => updateProp(componentType, 'useMarquee', e.target.checked)} className='h-4 w-4' />
            Force marquee scrolling
          </label>
        </div>
      )}

      <div className='space-y-1'>
        <label className='block text-xs text-text-secondary'>Social Handles (comma-separated)</label>
        <Input type='text' value={socialHandlesValue.join(', ')}
          onChange={e => updateProp(componentType, 'socialHandles', e.target.value.split(',').map(e => e.trim()).filter(e => e.length > 0))}
          className='w-full px-3 py-2 text-sm border rounded focus:ring-2 focus:ring-sea/50' placeholder='@modoitaliano.oficial, @fifth.bell, @hnmages' />
        <p className='text-xs text-text-secondary'>Set an empty value to hide social handles.</p>
      </div>
    </div>
  );
}
