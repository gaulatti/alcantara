import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchableSelect } from './SearchableSelect';

// gaulatti/alcantara#186: a select whose options a search box narrows.

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

const options = [
  { value: 'rome', label: 'Roma' },
  { value: 'milan', label: 'Milano' },
  { value: 'naples', label: 'Napoli' },
];

const shown = () =>
  within(screen.getByRole('combobox'))
    .getAllByRole('option')
    .map((option) => option.textContent);

it('narrows the options by a case-insensitive search and keeps the selection visible', () => {
  const onChange = vi.fn();
  render(<SearchableSelect value='rome' onChange={onChange} options={options} className='w-40' />);
  expect(shown()).toEqual(['Roma', 'Milano', 'Napoli']);
  expect(screen.getByRole('combobox')).toHaveClass('w-40');
  const search = screen.getByRole('searchbox', { name: 'Search…' });
  fireEvent.change(search, { target: { value: '  MIL ' } });
  // The selected city stays listed so the select still shows it.
  expect(shown()).toEqual(['Roma', 'Milano']);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'milan' } });
  expect(onChange).toHaveBeenCalledWith('milan');
  fireEvent.change(search, { target: { value: 'ro' } });
  expect(shown()).toEqual(['Roma']);
});

it('says when nothing matches, with its own search label', () => {
  render(
    <SearchableSelect value='' onChange={vi.fn()} options={options} searchPlaceholder='Find a city' />,
  );
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a city' }), {
    target: { value: 'torino' },
  });
  expect(shown()).toEqual(['No matches found']);
});
