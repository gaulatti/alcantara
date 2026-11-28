import type { ComponentType, ReactNode } from 'react';
import { bleeckerSceneModules } from './bleeckerSceneModules';

/**
 * The program output parts that belong to Bleecker. Each renders the installed library export when there is one and
 * the copy below otherwise. The copies go, with this fallback, once the app depends on a release that has them all.
 */
function fromLibrary<P>(name: string): ComponentType<P> | null {
  for (const module of Object.values(bleeckerSceneModules)) {
    if (module[name]) return module[name] as ComponentType<P>;
  }
  return null;
}

export function LowerThird({ text }: { text?: string }) {
  const Library = fromLibrary<{ text?: string }>('LowerThird');
  if (Library) return <Library text={text} />;
  return (
    <div className='absolute bottom-0 left-0 right-0 h-48 bg-gradient-to-r from-blue-600 to-blue-800 flex items-center px-16'>
      <div className='text-white'>
        <div className='text-5xl font-bold'>{text || 'Lower Third'}</div>
      </div>
    </div>
  );
}

export function FullScreen({ text }: { text?: string }) {
  const Library = fromLibrary<{ text?: string }>('FullScreen');
  if (Library) return <Library text={text} />;
  return (
    <div className='w-full h-full flex items-center justify-center bg-gradient-to-br from-purple-900 to-blue-900'>
      <div className='text-white text-8xl font-bold text-center px-16'>{text || 'Full Screen'}</div>
    </div>
  );
}

export function CornerBug({ text }: { text?: string }) {
  const Library = fromLibrary<{ text?: string }>('CornerBug');
  if (Library) return <Library text={text} />;
  return (
    <div className='absolute top-8 right-8 bg-red-600 text-white px-8 py-4 rounded-lg shadow-2xl'>
      <div className='text-3xl font-bold'>{text || 'LIVE'}</div>
    </div>
  );
}

/** What the output says when it has nothing to draw. `placement` only shapes the local copy. */
export function SceneNotice({ message, placement }: { message: string; placement: 'frame' | 'centre' }): ReactNode {
  const Library = fromLibrary<{ message: string }>('SceneNotice');
  if (Library) return <Library message={message} />;
  if (placement === 'frame') return <div className='w-full h-full flex items-center justify-center text-white text-4xl'>{message}</div>;
  return (
    <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white' }}>{message}</div>
  );
}

/** The black layer over the output. `marker` is the data attribute the page and its checks read the state from. */
export function FadeToBlack({ active, animate, marker }: { active: boolean; animate: boolean; marker: 'data-fade-to-black' | 'data-confidence-fade-to-black' }) {
  const state = { [marker]: active ? 'active' : 'inactive' };
  const Library = fromLibrary<{ active: boolean; animate: boolean }>('FadeToBlack');
  if (Library) {
    return (
      <div {...state}>
        <Library active={active} animate={animate} />
      </div>
    );
  }
  return (
    <div
      className='pointer-events-none absolute inset-0 z-[2000] bg-black'
      {...state}
      style={{ opacity: active ? 1 : 0, transition: animate ? 'opacity 1000ms linear' : 'none' }}
    />
  );
}
