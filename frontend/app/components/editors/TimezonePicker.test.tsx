import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComponentPropsFields } from './ComponentPropsFields';
import { withTimezoneOption } from '../../utils/timezones';

// The timezone pickers list the zones the browser's Intl reports. Chromium and
// Node spell Buenos Aires "America/Buenos_Aires" and Kolkata "Asia/Calcutta",
// so the editors' Buenos Aires default and a zone saved under another name
// matched no option, and the picker showed its "Select…" placeholder. The
// saved or default value must stay selectable, and must not be rewritten.

// Radix positioning runs continuously in jsdom; keep Bleecker's string
// callback contract with a native select.
vi.mock('@gaulatti/bleecker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaulatti/bleecker')>();
  return {
    ...actual,
    Select: ({ options, onChange, value, ...rest }: any) => (
      <select {...rest} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    ),
  };
});

afterEach(cleanup);

function picker(componentType: string, props: Record<string, unknown>) {
  const updateProp = vi.fn();
  render(
    <ComponentPropsFields
      componentType={componentType}
      props={props}
      updateProp={updateProp}
      replaceProps={vi.fn()}
      songCatalog={[]}
      mediaGroups={[]}
      isLoadingMediaGroups={false}
      mediaLabels={[]}
      isLoadingMediaLabels={false}
    />,
  );
  return updateProp;
}

function zoneSelect() {
  return screen
    .getAllByRole('combobox')
    .find((select) => within(select).queryAllByRole('option', { name: /\(GMT/ }).length > 0) as HTMLSelectElement;
}

it('keeps the Buenos Aires default selected in every picker that defaults to it', () => {
  expect(Intl.supportedValuesOf('timeZone')).not.toContain('America/Argentina/Buenos_Aires');
  for (const type of ['clock-widget', 'reloj-clock', 'broadcast-layout']) {
    const updateProp = picker(type, {});
    const zone = zoneSelect();
    expect(zone).toHaveValue('America/Argentina/Buenos_Aires');
    expect(within(zone).getByRole('option', { name: /^Buenos Aires \(GMT/, selected: true })).toBeInTheDocument();
    expect(updateProp).not.toHaveBeenCalled();
    cleanup();
  }
});

it('keeps a saved zone the browser lists under another name, without rewriting it', () => {
  for (const [type, prop] of [
    ['clock-widget', 'timezone'],
    ['reloj-loop-clock', 'timezone'],
    ['broadcast-layout', 'clockTimezone'],
    ['reloj-digital-loop-clock', 'timezone'],
  ]) {
    const updateProp = picker(type, { [prop]: 'Asia/Kolkata' });
    const zone = zoneSelect();
    expect(zone).toHaveValue('Asia/Kolkata');
    expect(within(zone).getAllByRole('option').filter((option) => (option as HTMLOptionElement).value === 'Asia/Kolkata')).toHaveLength(1);
    expect(updateProp).not.toHaveBeenCalled();
    cleanup();
  }
});

it('does not add a listed zone twice', () => {
  picker('clock-widget', { timezone: 'Europe/Rome' });
  const zone = zoneSelect();
  expect(zone).toHaveValue('Europe/Rome');
  const listed = Intl.supportedValuesOf('timeZone').length;
  expect(within(zone).getAllByRole('option')).toHaveLength(listed);
});

it('adds nothing for an empty value', () => {
  const options = [{ value: 'Europe/Rome', label: 'Rome (GMT+1)' }];
  expect(withTimezoneOption(options, '')).toBe(options);
});
