import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CornerBug, FadeToBlack, FullScreen, LowerThird, SceneNotice } from './sceneParts';

// Each part has two paths: the installed Bleecker's export, and the local copy used until it ships.
const library = vi.hoisted(() => ({}) as Record<string, Record<string, unknown>>);
vi.mock('./bleeckerSceneModules', () => ({ bleeckerSceneModules: library }));

afterEach(() => {
  cleanup();
  for (const key of Object.keys(library)) delete library[key];
});

const ship = () => {
  library.release = {
    LowerThird: (props: { text?: string }) => <p>library lower third {props.text}</p>,
    FullScreen: (props: { text?: string }) => <p>library full screen {props.text}</p>,
    CornerBug: (props: { text?: string }) => <p>library corner bug {props.text}</p>,
    SceneNotice: (props: { message: string }) => <p>library notice {props.message}</p>,
    FadeToBlack: (props: { active: boolean; animate: boolean }) => <p>library fade {String(props.active)} {String(props.animate)}</p>,
  };
};

const all = (
  <>
    <LowerThird text='Fictional name' />
    <FullScreen text='Fictional title' />
    <CornerBug text='Fictional bug' />
    <SceneNotice message='No Active Scene' placement='frame' />
    <SceneNotice message='Unknown component: made-up' placement='centre' />
    <FadeToBlack marker='data-fade-to-black' active animate={false} />
  </>
);

it('draws the local copies while the installed Bleecker has none of the parts', () => {
  const { container } = render(all);
  for (const text of ['Fictional name', 'Fictional title', 'Fictional bug', 'No Active Scene', 'Unknown component: made-up']) {
    expect(screen.getByText(text)).toBeInTheDocument();
  }
  expect(screen.queryByText(/^library /)).toBeNull();
  const fade = container.querySelector<HTMLElement>('[data-fade-to-black]')!;
  expect(fade).toHaveAttribute('data-fade-to-black', 'active');
  expect(fade.style.opacity).toBe('1');
  expect(fade.style.transition).toBe('none');
});

it('keeps the local defaults', () => {
  const { container } = render(
    <>
      <LowerThird />
      <FullScreen />
      <CornerBug />
      <FadeToBlack marker='data-confidence-fade-to-black' active={false} animate />
    </>,
  );
  for (const text of ['Lower Third', 'Full Screen', 'LIVE']) expect(screen.getByText(text)).toBeInTheDocument();
  const fade = container.querySelector<HTMLElement>('[data-confidence-fade-to-black]')!;
  expect(fade).toHaveAttribute('data-confidence-fade-to-black', 'inactive');
  expect(fade.style.opacity).toBe('0');
  expect(fade.style.transition).toBe('opacity 1000ms linear');
});

it('draws the library parts once the installed Bleecker has them, keeping the fade marker', () => {
  ship();
  const { container } = render(all);
  for (const text of [
    'library lower third Fictional name',
    'library full screen Fictional title',
    'library corner bug Fictional bug',
    'library notice No Active Scene',
    'library notice Unknown component: made-up',
    'library fade true false',
  ]) {
    expect(screen.getByText(text)).toBeInTheDocument();
  }
  expect(container.querySelector('[data-fade-to-black]')).toHaveAttribute('data-fade-to-black', 'active');
});
