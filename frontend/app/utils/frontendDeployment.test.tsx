import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('frontend deployment cache contract', () => {
  const workflow = readFileSync(resolve(process.cwd(), '../.github/workflows/frontend-deploy.yml'), 'utf8');

  it('keeps hashed assets immutable but forces the SPA shell to revalidate', () => {
    expect(workflow).toContain('--cache-control "public,max-age=31536000,immutable"');
    expect(workflow).toContain('--cache-control "no-cache,no-store,must-revalidate"');
  });

  it('invalidates every cached SPA route after deployment', () => {
    expect(workflow).toContain('--paths "/*"');
    expect(workflow).not.toContain('--paths "/index.html"');
  });
});
