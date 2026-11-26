import { expect, it } from 'vitest';
import { memoryAccessClient } from './accessFixtures';

// gaulatti/alcantara#624: the memory client's refusals and fallbacks that the panel tests do not reach. Names are fictional.

it('refuses a new token while token creation is switched off', async () => {
  const client = memoryAccessClient({ manager: true, unavailable: false });
  await client.setTokenSwitch(false);
  await expect(client.createMyToken({ name: 'Booth tablet' })).rejects.toMatchObject({ status: 409 });
});

it('records a grant to an unknown role with an empty role name', async () => {
  const client = memoryAccessClient({ manager: true, unavailable: false });
  const added = await client.grant({ user_id: 7, role_id: 999_999 } as never);
  expect(added.role_name).toBe('');
});
