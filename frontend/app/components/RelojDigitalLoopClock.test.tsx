import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import RelojDigitalLoopClock from './RelojDigitalLoopClock';

afterEach(cleanup);

const text = (value: string) => ({ mode: 'manual', items: [{ id: 'a', kind: 'preset', text: value }], activeItemId: 'a' });

describe('RelojDigitalLoopClock', () => {
  it('shows the countdown at its full duration with the MI mark outside the clock block', () => {
    const { container } = render(<RelojDigitalLoopClock mode='countdown' countdownDuration={310} programId='reloj-test' allowProgramActivation={false} />);
    expect(container.querySelector('#clock')?.textContent).toBe('00:05:10');
    expect(container.querySelector('#ms')?.textContent).toBe('00');
    // Idle, the label is empty; it reads COUNTDOWN only while running.
    expect(container.querySelector('#city-name')?.textContent).toBe('');
    const mark = container.querySelector('#reloj-mark svg[aria-label="ModoItaliano"]');
    expect(mark).not.toBeNull();
    expect(container.querySelector('#clock-block')?.contains(mark)).toBe(false);
    expect(container.querySelector('#logo-above')).toBeNull();
  });

  it('renders the lower third only when there is text, without the old separator', () => {
    const empty = render(<RelojDigitalLoopClock mode='countdown' />);
    expect(empty.container.querySelector('#lower-third')).toBeNull();
    empty.unmount();

    const { container } = render(<RelojDigitalLoopClock mode='countdown' textSequence={text('Modoitaliano podcast')} ctaSequence={text('En minutos')} />);
    expect(container.querySelector('#cta')?.textContent).toBe('En minutos');
    expect(container.querySelector('#show-title')).not.toBeNull();
    expect(container.querySelector('#pipe')).toBeNull();
  });
});
