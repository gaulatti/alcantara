import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { PanelColumn } from './PanelColumn';

// gaulatti/alcantara#186: the editor panel column layout.

afterEach(cleanup);

it('stacks its children in a full-height column, with an optional class and style', () => {
  const { rerender } = render(<PanelColumn><p>First field</p></PanelColumn>);
  const column = screen.getByText('First field').parentElement!;
  expect(column.className).toBe('flex h-full min-h-0 flex-col');
  rerender(
    <PanelColumn className='gap-2' style={{ width: 320 }}>
      <p>First field</p>
    </PanelColumn>,
  );
  expect(column.className).toBe('flex h-full min-h-0 flex-col gap-2');
  expect(column).toHaveStyle({ width: '320px' });
});
