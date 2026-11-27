import { act, cleanup, configure, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeSceneComponentTypes, normalizeSceneMetadata, resolveProgramRow } from '../utils/programRow';
import { ModoItalianoProgramRow } from './ModoItalianoProgramRow';

// The scene renderers load the library lazily. Import it once up front, outside any test's clock, so
// a render below only waits for modules that are already in memory, however slow the runner is.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });
beforeAll(async () => {
  await import('@modoitaliano/giorgia/scenes');
}, 120_000);

afterEach(cleanup);

const text = (value: string) => ({ mode: 'manual', items: [{ id: 'a', text: value }], activeItemId: 'a' });
const song = { mode: 'manual', items: [{ id: 's', kind: 'preset', artist: 'Giorgia', title: 'La cura per me', coverUrl: '/cover.jpg' }], activeItemId: 's' };

async function renderRow(componentType: string, metadata: Record<string, unknown>, songSequence: unknown = song) {
  // As the program route does: retired ids and their stored props reach the Giorgia renderers.
  const stored = componentType.split(',');
  const plan = resolveProgramRow(normalizeSceneComponentTypes(stored));
  if (!plan) throw new Error(`no row for ${componentType}`);
  const sceneMetadata = normalizeSceneMetadata(metadata, stored);
  const { container } = render(<ModoItalianoProgramRow plan={plan} metadata={sceneMetadata} programId='row-test' songSequence={songSequence} />);
  // The scene renderers load lazily: let them settle.
  await waitFor(() => expect(container.querySelector('.modoitaliano-giorgia-clock-header')).not.toBeNull(), { timeout: 5000 });
  // A shown chyron renders text as soon as its lazy component has loaded: wait for that, not a delay.
  const chyron = sceneMetadata[plan.chyronType] as { show?: unknown; textSequence?: unknown } | undefined;
  const chyronShown = chyron?.show !== false && chyron?.textSequence !== undefined;
  if (chyronShown) {
    await waitFor(() => expect(container.querySelector('[data-program-row-slot="chyron"]')?.childNodes.length).toBeGreaterThan(0));
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return container;
}

const slot = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-program-row-slot="${name}"]`);

describe('ModoItalianoProgramRow: Giorgia', () => {
  const layout = 'modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron';
  const metadata = { 'modoitaliano-giorgia-chyron': { show: true, textSequence: text('Sanremo 2027'), ctaSequence: text('En directo') } };

  it('anchors the row to the Giorgia edges with the header outside it', async () => {
    const container = await renderRow(layout, metadata);
    const row = container.querySelector<HTMLElement>('[data-program-row="giorgia"]');
    expect(row?.style.left).toBe('82px');
    expect(row?.style.right).toBe('82px');
    expect(row?.style.bottom).toBe('70px');
    const header = container.querySelector('.modoitaliano-giorgia-clock-header');
    expect(header).not.toBeNull();
    expect(row?.contains(header)).toBe(false);
    expect(container.querySelectorAll('.modoitaliano-giorgia-clock-header')).toHaveLength(1);
  });

  it('gives the headline half the row and puts the on-air block in the clock slot', async () => {
    const container = await renderRow(layout, metadata);
    expect(slot(container, 'chyron')?.className).toBe('flex-1 min-w-[50%] empty:hidden');
    expect(slot(container, 'chyron')?.textContent).toContain('SANREMO 2027');
    expect(slot(container, 'clock')?.className).toBe('min-w-0');
    expect(slot(container, 'clock')?.querySelector('.modoitaliano-giorgia-clock-hero')?.textContent).toBe('GIORGIA');
    expect(container.querySelectorAll('.modoitaliano-giorgia-clock-on-air')).toHaveLength(1);
  });

  it('leaves the chyron slot empty when the chyron is hidden', async () => {
    const container = await renderRow(layout, { 'modoitaliano-giorgia-chyron': { ...metadata['modoitaliano-giorgia-chyron'], show: false } });
    expect(slot(container, 'chyron')?.childNodes).toHaveLength(0);
    expect(slot(container, 'clock')?.querySelector('.modoitaliano-giorgia-clock-on-air')).not.toBeNull();
  });

  it('applies the clock switches from the Giorgia clock metadata', async () => {
    const container = await renderRow(layout, { ...metadata, 'modoitaliano-giorgia-clock': { showLogo: false, showPlaybackProgress: 'false' } });
    expect(container.querySelector('svg[aria-label="ModoItaliano"]')).toBeNull();
    expect(container.querySelector('.modoitaliano-giorgia-clock-progress')).toBeNull();
  });

  it('by default sets type on the soft grade, with shadows', async () => {
    const container = await renderRow(layout, metadata);
    for (const grade of container.querySelectorAll<HTMLElement>('[data-giorgia-grade]')) expect(grade.style.background).toContain('linear-gradient');
    expect(container.querySelector<HTMLElement>('.modoitaliano-giorgia-chyron-headline')?.style.textShadow).not.toBe('none');
    expect(container.querySelector<HTMLElement>('.modoitaliano-giorgia-clock-header')?.style.background).toBe('');
  });

  it.each([['modoitaliano-giorgia-clock'], ['modoitaliano-giorgia-chyron']])(
    'key-safe set on %s puts the whole pair on solid navy with nothing soft over the key colour',
    async (flagged) => {
      const container = await renderRow(layout, { ...metadata, [flagged]: { ...(metadata as Record<string, object>)[flagged], keySafe: true } });
      const everything = [...container.querySelectorAll<HTMLElement | SVGElement>('*')];

      // No gradient, shadow, glow or blur anywhere: each is partly transparent over the key colour.
      for (const element of everything) {
        expect(element.style.background).not.toContain('gradient');
        expect(['', 'none']).toContain(element.style.textShadow);
        expect(element.style.boxShadow).toBe('');
        expect(element.style.filter).toBe('');
      }
      // Every piece of type has its shadow switched off, not just left unset.
      for (const selector of ['.modoitaliano-giorgia-chyron-headline', '.modoitaliano-giorgia-clock-hero']) {
        expect(container.querySelector<HTMLElement>(selector)?.style.textShadow).toBe('none');
      }

      // The bands are opaque navy with a hard top edge, and cut rather than fade.
      const grades = [...container.querySelectorAll<HTMLElement>('[data-giorgia-grade]')];
      expect(grades).toHaveLength(2);
      for (const grade of grades) {
        expect(grade.style.background).toBe('rgb(7, 13, 43)');
        expect(grade.style.top).toBe('-44px');
        expect(grade.style.transition).toBe('none');
      }

      // The header sits on its own plate, flush with the top-left corner, with the mark where it always is.
      const header = container.querySelector<HTMLElement>('.modoitaliano-giorgia-clock-header');
      expect(header?.style.background).toBe('rgb(7, 13, 43)');
      expect(header?.style.padding).toBe('68px 44px 44px 82px');
      expect(header?.style.margin).toBe('-68px 0px 0px -82px');
    }
  );

  it('never renders legacy components', async () => {
    const container = await renderRow(layout, metadata);
    expect(container.querySelector('[data-program-row="legacy"]')).toBeNull();
    expect(container.textContent).not.toContain('Estás escuchando:');
  });
});

describe('ModoItalianoProgramRow: settings as the scenes store them', () => {
  it('reads numbers and words as switches, keeps the default for a word it does not know, and starts from defaults without chyron settings', async () => {
    const container = await renderRow('modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron', {
      'modoitaliano-giorgia-clock': { showLogo: 0, showPlaybackProgress: 'true', keySafe: 'maybe' }
    });
    expect(container.querySelector('svg[aria-label="ModoItaliano"]')).toBeNull();
    // keySafe stays off for an unknown word: the grade keeps its gradient.
    for (const grade of container.querySelectorAll<HTMLElement>('[data-giorgia-grade]')) expect(grade.style.background).toContain('linear-gradient');
    expect(container.querySelector('[data-program-row="giorgia"]')).not.toBeNull();
  });
});

describe('ModoItalianoProgramRow: a scene stored with the retired chyron and clock ids', () => {
  const layout = 'cronica-background,modoitaliano-chyron,cronica-chyron,modoitaliano-clock';

  it('draws the Giorgia row with the props stored under the retired keys, and no warnings', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const container = await renderRow(layout, {
        'modoitaliano-chyron': { show: true, textSequence: text('Titular'), ctaSequence: text('En directo') },
        'modoitaliano-clock': { showLogo: false, showPlaybackProgress: false }
      });
      expect(container.querySelector('[data-program-row="giorgia"]')).not.toBeNull();
      expect(slot(container, 'chyron')?.textContent).toContain('TITULAR');
      expect(container.querySelector('svg[aria-label="ModoItaliano"]')).toBeNull();
      expect(container.querySelector('.modoitaliano-giorgia-clock-progress')).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  it('honours a hidden retired chyron', async () => {
    const container = await renderRow(layout, { 'modoitaliano-chyron': { show: false, textSequence: text('Titular') } });
    expect(slot(container, 'chyron')?.childNodes).toHaveLength(0);
    expect(slot(container, 'clock')?.querySelector('.modoitaliano-giorgia-clock-on-air')).not.toBeNull();
  });
});
