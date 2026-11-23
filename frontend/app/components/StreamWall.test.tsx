import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StreamWall } from './StreamWall';

// gaulatti/alcantara#184: the stream wall shows each valid stream once.

afterEach(cleanup);

it('shows each valid http(s) stream once, up to the limit, under its title', () => {
  render(
    <StreamWall
      maxStreams={2}
      urls={[
        ' https://vdo.example.test/?view=a ',
        'https://vdo.example.test/?view=a',
        '',
        'not a url',
        'ftp://files.example.test/stream',
        'http://vdo.example.test/?view=b',
        'https://vdo.example.test/?view=c',
      ]}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Stream Wall' })).toBeInTheDocument();
  expect(screen.getByText('2/2 streams')).toBeInTheDocument();
  const frames = [screen.getByTitle('Stream 1'), screen.getByTitle('Stream 2')];
  expect(frames.map((frame) => frame.getAttribute('src'))).toEqual([
    'https://vdo.example.test/?view=a',
    'http://vdo.example.test/?view=b',
  ]);
  expect(frames[0]).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(screen.queryByTitle('Stream 3')).toBeNull();
});

it('explains how to add streams when none are valid, with the default limit', () => {
  render(<StreamWall urls={['javascript:alert(1)']} title='Guests' />);
  expect(screen.getByRole('heading', { name: 'Guests' })).toBeInTheDocument();
  expect(screen.getByText('0/4 streams')).toBeInTheDocument();
  expect(screen.getByText(/No valid stream URLs provided/)).toHaveTextContent(
    '(repeat up to 4)',
  );
});

it('hides the header for a blank title and shows a suspended wall without its streams', () => {
  render(<StreamWall urls={['https://vdo.example.test/?view=a']} title='  ' suspended />);
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByText('Stream wall suspended')).toBeInTheDocument();
  expect(screen.queryByTitle('Stream 1')).toBeNull();
});
