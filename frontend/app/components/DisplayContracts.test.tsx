import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Scoreboard } from './Scoreboard';
import { ModoItalianoDisclaimer } from './ModoItalianoDisclaimer';
import { CronicaChyron } from './CronicaChyron';

afterEach(cleanup);

describe('Scoreboard editorial output', () => {
  it('renders both teams and independently controlled period and clock fields', () => {
    const { rerender } = render(<Scoreboard title='FINAL' homeTeam='Local' awayTeam='Visitor' homeScore={3} awayScore='OT' period='2ND' clock='89:59' status='COMPLETE' />);
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Visitor')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('OT')).toBeInTheDocument();
    expect(screen.getByText('COMPLETE')).toBeInTheDocument();
    rerender(<Scoreboard period='2ND' clock='89:59' showPeriod={false} />);
    expect(screen.queryByText('2ND')).not.toBeInTheDocument();
    expect(screen.getByText('89:59')).toBeInTheDocument();
    rerender(<Scoreboard period='2ND' clock='89:59' showClock={false} />);
    expect(screen.getByText('2ND')).toBeInTheDocument();
    expect(screen.queryByText('89:59')).not.toBeInTheDocument();
  });

  it('supplies the established empty-match presentation without pretending an actual score exists', () => {
    const { container } = render(<Scoreboard />);
    expect(screen.getByText('MATCH')).toBeInTheDocument();
    expect(screen.getByText('HOME')).toBeInTheDocument();
    expect(screen.getByText('AWAY')).toBeInTheDocument();
    expect(container.querySelectorAll('.scoreboard-team-score')).toHaveLength(2);
    expect(screen.getByText('1ST')).toBeInTheDocument();
    expect(screen.getByText('00:00')).toBeInTheDocument();
  });
});

describe('disclaimer safety and placement', () => {
  it('keeps absent, whitespace-only and explicitly hidden editorial text off air', () => {
    const { container, rerender } = render(<ModoItalianoDisclaimer />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ModoItalianoDisclaimer text='  ' />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ModoItalianoDisclaimer text='Editorial notice' show={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['left', { left: '56px', textAlign: 'left' }],
    ['center', { left: '50%', textAlign: 'center', transform: 'translateX(-50%)' }],
    ['right', { right: '56px', textAlign: 'right' }],
  ] as const)('positions a standalone %s disclaimer and bounds display dimensions', (align, expected) => {
    render(<ModoItalianoDisclaimer text='Editorial notice' align={align} bottomPx={-10} fontSizePx={3} opacity={2} />);
    expect(screen.getByText('Editorial notice')).toHaveStyle({ ...expected, bottom: '0px', fontSize: '10px', opacity: '1' });
  });

  it.each([
    ['left', 'flex-start'], ['center', 'center'], ['right', 'flex-end'],
  ] as const)('aligns the inline %s disclaimer inside the shared row without becoming an absolute overlay', (align, justification) => {
    render(<ModoItalianoDisclaimer text='Editorial notice' inline align={align} opacity={-1} />);
    const notice = screen.getByText('Editorial notice');
    expect(notice).toHaveStyle({ justifyContent: justification, opacity: '0', height: '140px' });
    expect(notice.style.position).toBe('');
  });
});

describe('Cronica multiline output', () => {
  it('keeps empty text off air and preserves each editorial line after a scene update', () => {
    const { container, rerender } = render(<CronicaChyron />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CronicaChyron text={'Confirmed line\nSecond line'} />);
    expect(container.querySelectorAll('.cronica-chyron-line')).toHaveLength(2);
    expect(screen.getByText('Confirmed line')).toBeInTheDocument();
    expect(screen.getByText('Second line')).toBeInTheDocument();
  });
});
