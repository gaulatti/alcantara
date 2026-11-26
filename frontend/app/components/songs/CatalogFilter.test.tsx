import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogFilter } from './CatalogFilter';

// gaulatti/alcantara#624: the catalog filter's options with and without a count. Fictional labels only.

afterEach(cleanup);

it('shows a count beside an option that has one, and only the label for one that does not', () => {
  const onChange = vi.fn();
  render(
    <CatalogFilter
      label="Catalog state"
      value="all"
      onChange={onChange}
      options={[
        { value: 'all', label: 'All', count: 12 },
        { value: 'enabled', label: 'Enabled' },
      ]}
    />,
  );
  const group = screen.getByRole('group', { name: 'Catalog state' });
  expect(within(group).getByRole('button', { name: /All\s*12/ })).toHaveAttribute('aria-pressed', 'true');
  const enabled = within(group).getByRole('button', { name: 'Enabled' });
  expect(enabled).toHaveAttribute('aria-pressed', 'false');
  expect(enabled.querySelector('span')).toBeNull();
  fireEvent.click(enabled);
  expect(onChange).toHaveBeenCalledWith('enabled');
});
