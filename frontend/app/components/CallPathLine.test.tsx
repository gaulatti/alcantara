import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { CallPathLine } from './CallPathLine';

afterEach(cleanup);

const text = (participant: Parameters<typeof CallPathLine>[0]['participant']) => render(<CallPathLine participant={participant} />).container.textContent;

it('says how the call reaches the studio, or why it could not', () => {
  expect(text({ connectionState: 'connected', icePath: 'udp' })).toBe('Path: direct UDP');
  expect(text({ connectionState: 'connected', icePath: 'tcp' })).toBe('Path: direct TCP');
  expect(text({ connectionState: 'reconnecting', icePath: 'relay' })).toBe('Path: relayed (TURN)');
  expect(text({ connectionState: 'offline', joinFailure: 'permission_denied' })).toBe('Could not join: camera or microphone blocked');
  expect(text({ connectionState: 'offline', joinFailure: 'ice_failed' })).toBe('Could not join: no media path through their network');
});

it('says nothing before the guest reports, or about a call that is over', () => {
  expect(text({ connectionState: 'connected' })).toBe('');
  expect(text({ connectionState: 'offline', icePath: 'udp', joinFailure: null })).toBe('');
});
