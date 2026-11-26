import { expect, it } from 'vitest';
import { groupByTier } from './mcpConnect';

// gaulatti/alcantara#624: capabilities in the same tier are listed alphabetically by title. Fictional titles.

it('lists the capabilities of one tier alphabetically by title', () => {
  const groups = groupByTier([
    { id: 'b', title: 'Zebra schedule', tier: 'R' } as never,
    { id: 'a', title: 'Amber clips', tier: 'R' } as never,
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].items.map((item) => (item as { title: string }).title)).toEqual(['Amber clips', 'Zebra schedule']);
});
