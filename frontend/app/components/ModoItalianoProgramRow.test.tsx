import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProgramRow } from '../utils/programRow';
import { ModoItalianoProgramRow } from './ModoItalianoProgramRow';

afterEach(cleanup);

const text = (value: string) => ({ mode: 'manual', items: [{ id: 'a', text: value }], activeItemId: 'a' });
const song = { mode: 'manual', items: [{ id: 's', kind: 'preset', artist: 'Giorgia', title: 'La cura per me', coverUrl: '/cover.jpg' }], activeItemId: 's' };

function renderRow(componentType: string, metadata: Record<string, unknown>, songSequence: unknown = song) {
  const plan = resolveProgramRow(componentType.split(','));
  if (!plan) throw new Error(`no row for ${componentType}`);
  const { container } = render(<ModoItalianoProgramRow plan={plan} metadata={metadata} programId='row-test' songSequence={songSequence} />);
  return container;
}

const slot = (container: HTMLElement, name: string) => container.querySelector<HTMLElement>(`[data-program-row-slot="${name}"]`);

describe('ModoItalianoProgramRow: Giorgia', () => {
  const layout = 'modoitaliano-giorgia-clock,modoitaliano-giorgia-chyron';
  const metadata = { 'modoitaliano-giorgia-chyron': { show: true, textSequence: text('Sanremo 2027'), ctaSequence: text('En directo') } };

  it('anchors the row to the Giorgia edges with the header outside it', () => {
    const container = renderRow(layout, metadata);
    const row = container.querySelector<HTMLElement>('[data-program-row="giorgia"]');
    expect(row?.style.left).toBe('82px');
    expect(row?.style.right).toBe('82px');
    expect(row?.style.bottom).toBe('70px');
    const header = container.querySelector('.modoitaliano-giorgia-clock-header');
    expect(header).not.toBeNull();
    expect(row?.contains(header)).toBe(false);
    expect(container.querySelectorAll('.modoitaliano-giorgia-clock-header')).toHaveLength(1);
  });

  it('gives the headline half the row and puts the on-air block in the clock slot', () => {
    const container = renderRow(layout, metadata);
    expect(slot(container, 'chyron')?.className).toBe('flex-1 min-w-[50%] empty:hidden');
    expect(slot(container, 'chyron')?.textContent).toContain('SANREMO 2027');
    expect(slot(container, 'clock')?.className).toBe('min-w-0');
    expect(slot(container, 'clock')?.querySelector('.modoitaliano-giorgia-clock-hero')?.textContent).toBe('GIORGIA');
    expect(container.querySelectorAll('.modoitaliano-giorgia-clock-on-air')).toHaveLength(1);
  });

  it('leaves the chyron slot empty when the chyron is hidden', () => {
    const container = renderRow(layout, { 'modoitaliano-giorgia-chyron': { ...metadata['modoitaliano-giorgia-chyron'], show: false } });
    expect(slot(container, 'chyron')?.childNodes).toHaveLength(0);
    expect(slot(container, 'clock')?.querySelector('.modoitaliano-giorgia-clock-on-air')).not.toBeNull();
  });

  it('applies the clock switches from the Giorgia clock metadata', () => {
    const container = renderRow(layout, { ...metadata, 'modoitaliano-giorgia-clock': { showLogo: false, showPlaybackProgress: 'false' } });
    expect(container.querySelector('svg[aria-label="ModoItaliano"]')).toBeNull();
    expect(container.querySelector('.modoitaliano-giorgia-clock-progress')).toBeNull();
  });

  it('never renders legacy components', () => {
    const container = renderRow(layout, metadata);
    expect(container.querySelector('[data-program-row="legacy"]')).toBeNull();
    expect(container.textContent).not.toContain('Estás escuchando:');
  });
});

describe('ModoItalianoProgramRow: legacy', () => {
  const chyron = { 'modoitaliano-chyron': { show: true, textSequence: text('Titular') } };

  it('keeps the legacy geometry and slot sizing', () => {
    const container = renderRow('modoitaliano-clock,modoitaliano-chyron', chyron);
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

  it('does not mount the legacy chyron while it is hidden', () => {
    const container = renderRow('modoitaliano-clock,modoitaliano-chyron', { 'modoitaliano-chyron': { show: false, textSequence: text('Titular') } });
    expect(slot(container, 'chyron')?.childNodes).toHaveLength(0);
  });

  it('shows the disclaimer only while no chyron is showing', () => {
    const layout = 'modoitaliano-clock,modoitaliano-chyron,modoitaliano-disclaimer';
    const disclaimer = { 'modoitaliano-disclaimer': { text: 'Aviso legal', align: 'left', fontSizePx: 24, opacity: 0.5 } };
    const hidden = renderRow(layout, { ...disclaimer, 'modoitaliano-chyron': { show: false, textSequence: text('Titular') } });
    const shown = slot(hidden, 'chyron')?.firstElementChild as HTMLElement;
    expect(shown.textContent).toBe('Aviso legal');
    expect(shown.style.justifyContent).toBe('flex-start');
    expect(shown.style.fontSize).toBe('24px');
    expect(shown.style.opacity).toBe('0.5');

    const withChyron = renderRow(layout, { ...disclaimer, ...chyron });
    expect(slot(withChyron, 'chyron')?.textContent).toContain('TITULAR');
    expect(slot(withChyron, 'chyron')?.textContent).not.toContain('Aviso legal');

    const defaults = renderRow('modoitaliano-clock,modoitaliano-disclaimer', { 'modoitaliano-disclaimer': { text: 'Aviso', align: 'diagonal' } });
    const fallback = slot(defaults, 'chyron')?.firstElementChild as HTMLElement;
    expect(fallback.style.justifyContent).toBe('flex-end');
    expect(fallback.style.fontSize).toBe('20px');
    expect(fallback.style.opacity).toBe('0.82');

    const disabled = renderRow('modoitaliano-clock,modoitaliano-disclaimer', { 'modoitaliano-disclaimer': { text: 'Aviso', show: 'off' } });
    expect(slot(disabled, 'chyron')?.childNodes).toHaveLength(0);
    const blank = renderRow('modoitaliano-clock,modoitaliano-disclaimer', { 'modoitaliano-disclaimer': { text: '   ' } });
    expect(slot(blank, 'chyron')?.childNodes).toHaveLength(0);
  });

  it('applies the clock switches from the legacy clock metadata', () => {
    const container = renderRow('modoitaliano-clock,modoitaliano-bracket', { 'modoitaliano-clock': { showWorldClocks: 0, showLogo: 'no' } }, null);
    expect(slot(container, 'clock')?.childNodes).toHaveLength(0);
    const visible = renderRow('modoitaliano-clock,modoitaliano-bracket', { 'modoitaliano-clock': { showWorldClocks: 1, showLogo: 'yes' } }, null);
    expect(slot(visible, 'clock')?.querySelector('[aria-label="MI"]')).not.toBeNull();
  });
});
