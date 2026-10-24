import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComponentPropsFields, ZIndexField } from './ComponentPropsFields';
import { FIFTHBELL_AVAILABLE_WEATHER_CITIES } from '../../utils/broadcast';

afterEach(cleanup);
function editor(componentType: string, props: Record<string, unknown> = {}) {
  const updateProp = vi.fn();
  const replaceProps = vi.fn();
  const result = render(<ComponentPropsFields componentType={componentType} props={props}
    updateProp={updateProp} replaceProps={replaceProps} songCatalog={[]} mediaGroups={[]}
    isLoadingMediaGroups={false} mediaLabels={[]} isLoadingMediaLabels={false} />);
  return { ...result, updateProp, replaceProps };
}

describe('scene component properties', () => {
  it.each([
    ['ticker', 'Hashtag', 'hashtag', '#News'],
    ['ticker', 'URL', 'url', 'news.example'],
    ['chyron', 'Text', 'text', 'Confirmed story'],
    ['header', 'Title', 'title', 'Special edition'],
    ['header', 'Date', 'date', 'Editorial date'],
    ['video-stream', 'Source URL', 'sourceUrl', 'https://video.example/live.m3u8'],
    ['video-stream', 'Poster URL (optional)', 'posterUrl', 'https://images.example/poster.jpg'],
    ['scoreboard', 'Home Team', 'homeTeam', 'Home city'],
    ['scoreboard', 'Away Team', 'awayTeam', 'Away city'],
    ['scoreboard', 'Home Score', 'homeScore', '3'],
    ['scoreboard', 'Away Score', 'awayScore', '1'],
    ['scoreboard', 'Period', 'period', '2ND'],
    ['scoreboard', 'Clock', 'clock', '12:34'],
    ['scoreboard', 'Status', 'status', 'FINAL'],
    ['broadcast-layout', 'Header Title', 'headerTitle', 'Late bulletin'],
    ['earone', 'Label', 'label', 'CHART'],
    ['earone', 'Rank', 'rank', '5'],
    ['earone', 'Spins Today', 'spins', '20'],
  ])('keeps %s %s edits bound to their actual persisted property', (componentType, label, property, value) => {
    const { updateProp } = editor(componentType);
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(updateProp).toHaveBeenCalledExactlyOnceWith(componentType, property, value);
  });

  it.each([
    [false, false], [0, false], ['false', false], [' OFF ', false], ['', false],
    [true, true], [1, true], [' yes ', true], ['on', true], [undefined, true], ['unknown', true],
  ])('reflects persisted autoplay value %s without coercing every nonempty string to true', (persisted, checked) => {
    const { updateProp } = editor('video-stream', { autoPlay: persisted });
    const checkbox = screen.getByRole('checkbox', { name: 'Autoplay' });
    if (checked) expect(checkbox).toBeChecked(); else expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(updateProp).toHaveBeenCalledExactlyOnceWith('video-stream', 'autoPlay', !checked);
  });

  it('normalizes the stream-wall limit and commits at most four complete URLs on blur', () => {
    const { updateProp } = editor('stream-wall', { urls: ['https://old.example/', 4], maxStreams: 3 });
    const maximum = screen.getByLabelText('Max Streams (1-4)');
    fireEvent.change(maximum, { target: { value: '9' } });
    expect(updateProp).toHaveBeenLastCalledWith('stream-wall', 'maxStreams', 4);
    fireEvent.change(maximum, { target: { value: '-1' } });
    expect(updateProp).toHaveBeenLastCalledWith('stream-wall', 'maxStreams', 1);
    const urls = screen.getByPlaceholderText('https://vdo.ninja/?view=...');
    expect(urls).toHaveValue('https://old.example/');
    fireEvent.change(urls, { target: { value: ' https://one.example/ ,\nhttps://two.example/\nhttps://three.example/,https://four.example/,https://five.example/ ' } });
    fireEvent.blur(urls);
    expect(updateProp).toHaveBeenLastCalledWith('stream-wall', 'urls', [
      'https://one.example/', 'https://two.example/', 'https://three.example/', 'https://four.example/',
    ]);
  });

  it('preserves independent scoreboard period and clock visibility controls', () => {
    const { updateProp } = editor('scoreboard', { showPeriod: 'false', showClock: true });
    expect(screen.getByRole('checkbox', { name: 'Show Period' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Period' }));
    expect(updateProp).toHaveBeenLastCalledWith('scoreboard', 'showPeriod', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Clock' }));
    expect(updateProp).toHaveBeenLastCalledWith('scoreboard', 'showClock', false);
  });

  it('exposes the broadcast chyron text only for an explicitly visible chyron', () => {
    const { updateProp } = editor('broadcast-layout', { showChyron: true, chyronText: 'Current caption' });
    fireEvent.change(screen.getByPlaceholderText('Optional lower chyron text'), { target: { value: 'Corrected caption' } });
    expect(updateProp).toHaveBeenLastCalledWith('broadcast-layout', 'chyronText', 'Corrected caption');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Chyron' }));
    expect(updateProp).toHaveBeenLastCalledWith('broadcast-layout', 'showChyron', false);
  });

  it('retains newline-delimited editorial text for the Cronica renderer', () => {
    const { updateProp } = editor('cronica-chyron', { text: 'First line' });
    fireEvent.change(screen.getByPlaceholderText('Enter chyron text...'), { target: { value: 'First line\nSecond line' } });
    expect(updateProp).toHaveBeenCalledExactlyOnceWith('cronica-chyron', 'text', 'First line\nSecond line');
  });

  it('allows weather-city removal without retaining malformed non-string selections', () => {
    const first = FIFTHBELL_AVAILABLE_WEATHER_CITIES[0];
    const second = FIFTHBELL_AVAILABLE_WEATHER_CITIES[1];
    const { updateProp } = editor('fifthbell-content', { weatherCities: [first, 7] });
    fireEvent.click(screen.getByRole('checkbox', { name: first }));
    expect(updateProp).toHaveBeenLastCalledWith('fifthbell-content', 'weatherCities', []);
    fireEvent.click(screen.getByRole('checkbox', { name: second }));
    expect(updateProp).toHaveBeenLastCalledWith('fifthbell-content', 'weatherCities', [first, second]);
    expect(screen.queryByRole('checkbox', { name: 'Show Bottom Marquee' })).not.toBeInTheDocument();
  });

  it('keeps marquee-only editing independent of content feed controls', () => {
    const { updateProp } = editor('fifthbell-marquee', { showMarquee: false });
    expect(screen.queryByRole('checkbox', { name: 'Show Articles' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show Bottom Marquee' }));
    expect(updateProp).toHaveBeenLastCalledWith('fifthbell-marquee', 'showMarquee', true);
  });

  it.each(['live-indicator', 'logo-widget', 'toni-logo', 'cronica-background', 'corner-bug'])(
    'does not fabricate mutable fields for fixed %s presentation', (componentType) => {
      const { updateProp } = editor(componentType);
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.getByText(/No configurable|no configurable/)).toBeInTheDocument();
      expect(updateProp).not.toHaveBeenCalled();
    },
  );

  it('reports an unknown component instead of displaying controls for an unrelated renderer', () => {
    editor('unknown-renderer');
    expect(screen.getByText('No editor available for “unknown-renderer”.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('represents a malformed persisted layer index safely and writes a numeric operator edit', () => {
    const updateProp = vi.fn();
    render(<ZIndexField componentType='header' props={{ zIndex: NaN }} updateProp={updateProp} />);
    const layer = screen.getByRole('spinbutton');
    expect(layer).toHaveValue(0);
    fireEvent.change(layer, { target: { value: '5' } });
    expect(updateProp).toHaveBeenCalledExactlyOnceWith('header', 'zIndex', 5);
  });
});
