import { act, cleanup, configure, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveProgramRow } from '../utils/programRow';
import { ModoItalianoProgramRow } from './ModoItalianoProgramRow';

// The scene renderers load the library lazily. Import it once up front, outside any test's clock, so
// a render below only waits for modules that are already in memory, however slow the runner is.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 15_000 });
beforeAll(async () => {
  await Promise.all([import('@modoitaliano/giorgia/scenes'), import('@modoitaliano/giorgia/scenes/legacy')]);
}, 120_000);

afterEach(cleanup);

const text = (value: string) => ({ mode: 'manual', items: [{ id: 'a', text: value }], activeItemId: 'a' });
const song = { mode: 'manual', items: [{ id: 's', kind: 'preset', artist: 'Giorgia', title: 'La cura per me', coverUrl: '/cover.jpg' }], activeItemId: 's' };

async function renderRow(componentType: string, metadata: Record<string, unknown>, songSequence: unknown = song) {
  const plan = resolveProgramRow(componentType.split(','));
  if (!plan) throw new Error(`no row for ${componentType}`);
  const { container } = render(<ModoItalianoProgramRow plan={plan} metadata={metadata} programId='row-test' songSequence={songSequence} />);
  // The scene renderers load lazily (the library's when the pinned version has them): let them settle.
  if (componentType.includes('giorgia')) {
    await waitFor(() => expect(container.querySelector('.modoitaliano-giorgia-clock-header')).not.toBeNull(), { timeout: 5000 });
  }
  // A shown chyron renders text as soon as its lazy component has loaded: wait for that, not a delay.
  const chyronShown = plan.chyronType !== null && (metadata[plan.chyronType] as { show?: unknown } | undefined)?.show !== false;
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

describe('ModoItalianoProgramRow: legacy', () => {
  const chyron = { 'modoitaliano-chyron': { show: true, textSequence: text('Titular') } };

  it('keeps the legacy geometry and slot sizing', async () => {
    const container = await renderRow('modoitaliano-clock,modoitaliano-chyron', chyron);
    const row = container.querySelector<HTMLElement>('[data-program-row="legacy"]');
    expect(row?.className).toBe('absolute z-[950] flex items-end gap-6');
    expect(row?.style.left).toBe('110px');
    expect(row?.style.right).toBe('110px');
    expect(row?.style.bottom).toBe('110px');
    expect(slot(container, 'chyron')?.className).toBe('flex-1 min-w-0');
    expect(slot(container, 'clock')?.className).toBe('shrink-0');
    expect(slot(container, 'chyron')?.textContent).toContain('TITULAR');
    expect(slot(container, 'clock')?.textContent).toContain('Estás escuchando:');
    expect(container.querySelector('.modoitaliano-giorgia-clock-header')).toBeNull();
    expect(container.querySelector('[data-giorgia-rule]')).toBeNull();
  });

  it('does not mount the legacy chyron while it is hidden', async () => {
    const container = await renderRow('modoitaliano-clock,modoitaliano-chyron', { 'modoitaliano-chyron': { show: false, textSequence: text('Titular') } });
    expect(slot(container, 'chyron')?.childNodes).toHaveLength(0);
  });

  it('applies the clock switches from the legacy clock metadata', async () => {
    const container = await renderRow('modoitaliano-clock,modoitaliano-bracket', { 'modoitaliano-clock': { showWorldClocks: 0, showLogo: 'no' } }, null);
    expect(slot(container, 'clock')?.childNodes).toHaveLength(0);
    const visible = await renderRow('modoitaliano-clock,modoitaliano-bracket', { 'modoitaliano-clock': { showWorldClocks: 1, showLogo: 'yes' } }, null);
    expect(slot(visible, 'clock')?.querySelector('[aria-label="MI"]')).not.toBeNull();
  });
});

describe('ModoItalianoProgramRow: flags it cannot read', () => {
  it('keeps the row when a flag is neither a boolean, a number nor a known word', async () => {
    const container = await renderRow('modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron', {
      'modoitaliano-giorgia-clock': { showWorldClocks: 'maybe' },
      'modoitaliano-giorgia-chyron': { show: true, textSequence: text('Sanremo 2027'), ctaSequence: text('En directo') },
    });
    expect(container.querySelector('[data-program-row="giorgia"]')).not.toBeNull();
  });
});
