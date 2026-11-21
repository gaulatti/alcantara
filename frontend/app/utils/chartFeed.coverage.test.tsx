import { describe, expect, it } from 'vitest';
import { matchChartEntry } from './chartFeed';

describe('chart entry matching', () => {
  const lookup = { byId: { 'c-1': 'by id' }, byKey: { 'modugno volare': 'by text' } };

  it('prefers the chart id, then the chyron text, and finds nothing for unknown or blank input', () => {
    expect(matchChartEntry(lookup, { id: ' c-1 ', text: 'Modugno — Volare' })).toBe('by id');
    expect(matchChartEntry(lookup, { id: 'missing', text: 'Modugno - Volare!' })).toBe('by text');
    expect(matchChartEntry(lookup, { id: null, text: 'Someone else' })).toBeNull();
    expect(matchChartEntry(lookup, { text: '   ' })).toBeNull();
    expect(matchChartEntry(null, { id: 'c-1' })).toBeNull();
  });
});
