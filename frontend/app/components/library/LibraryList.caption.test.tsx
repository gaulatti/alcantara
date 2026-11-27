import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LibraryList } from './LibraryList';

// alcantara#875: every library table printed its own name again under the rows.
it('names the table for assistive technology without repeating the heading on screen', () => {
  render(
    <LibraryList
      caption='Scenes'
      columns={[{ key: 'name', header: 'Name' }]}
      data={[{ id: 1, name: 'Desk' }]}
      getRowKey={(row) => String(row.id)}
      status='ready'
      sort={{ field: 'name', order: 'asc' }}
      onSortChange={() => {}}
      errorTitle='Could not load scenes'
      onRetry={() => {}}
      empty={{ title: 'No scenes', description: 'None yet.', action: null }}
    />
  );
  const table = screen.getByRole('table', { name: 'Scenes' });
  expect(table.className).toContain('[&_caption]:sr-only');
});
