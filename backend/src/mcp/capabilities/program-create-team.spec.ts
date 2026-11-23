// gaulatti/alcantara#337: a program created through MCP records the deployment's team, the same
// team the HTTP guard resolves for the route.
import { ProgramMcpTools } from './program';

describe('program_create_program records the caller team', () => {
  it('passes the deployment team to createProgram', async () => {
    const createProgram = jest.fn().mockResolvedValue({ programId: 'news' });
    const tools = new ProgramMcpTools(
      { createProgram } as never,
      { inspect: jest.fn() } as never,
      { teamId: 7 } as never,
    );
    const spec = tools.specs().find((candidate) => candidate.name === 'program_create_program');
    expect(spec).toBeDefined();
    await spec!.run({ program_id: 'news' } as never, {} as never);
    expect(createProgram).toHaveBeenCalledTimes(1);
    expect(createProgram.mock.calls[0][3]).toBe(7);
  });
});
