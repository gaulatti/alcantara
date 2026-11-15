import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BRAND_WORDS,
  checkBrandBaselines,
  findRepoRoot,
  isBrandMatch,
  loadBaseline,
  scanTree,
  walkDirectory,
} from './brand-literals';

describe('Brand-literal ratchet invariant', () => {
  const repoRoot = findRepoRoot();

  it('verifies that current repository counts equal baselines at merge time', () => {
    const result = checkBrandBaselines();

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);

    for (const tree of ['backend', 'frontend']) {
      for (const word of BRAND_WORDS) {
        expect(result.counts[tree][word]).toBe(result.baselines[tree][word]);
      }
    }
  });

  it('fails when a file path contains a brand word beyond baseline', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-path-'));
    const treeDir = path.join(baseDir, 'tree');
    const baselineDir = path.join(baseDir, 'baselines');
    const brandedSubdir = path.join(treeDir, 'fifthbell-sub');
    const brandedFile = path.join(brandedSubdir, 'clean-file.ts');
    fs.mkdirSync(brandedSubdir, { recursive: true });
    fs.writeFileSync(brandedFile, 'export const clean = true;\n');

    try {
      const scan = scanTree(treeDir, 'test-tree', ['fifthbell'], []);
      expect(scan.matchesByWord['fifthbell']).toEqual(['fifthbell-sub/clean-file.ts']);

      fs.mkdirSync(path.join(baselineDir, 'test-tree'), { recursive: true });
      fs.writeFileSync(
        path.join(baselineDir, 'test-tree/fifthbell.json'),
        JSON.stringify({ count: 0 }),
      );

      const check = checkBrandBaselines({
        repoRoot,
        baselineDir,
        trees: { 'test-tree': treeDir },
        words: ['fifthbell'],
        logger: jest.fn(),
      });

      expect(check.passed).toBe(false);
      expect(check.failures.length).toBe(1);
      expect(check.failures[0]).toContain('[brand-ratchet] test-tree/fifthbell');
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('fails when a fixture adds fifthbell to a new file', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-add-'));
    const treeDir = path.join(baseDir, 'tree');
    const baselineDir = path.join(baseDir, 'baselines');
    const newFile = path.join(treeDir, 'new-feature.ts');
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(newFile, 'const customer = "fifthbell";\n');

    fs.mkdirSync(path.join(baselineDir, 'test-tree'), { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, 'test-tree/fifthbell.json'),
      JSON.stringify({ count: 0 }),
    );

    try {
      const check = checkBrandBaselines({
        repoRoot,
        baselineDir,
        trees: { 'test-tree': treeDir },
        words: ['fifthbell'],
        logger: jest.fn(),
      });

      expect(check.passed).toBe(false);
      expect(check.failures.length).toBe(1);
      expect(check.failures[0]).toContain(
        '[brand-ratchet] test-tree/fifthbell: expected at most 0 files, found 1 (1 new)',
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('passes and prints a reminder to lower baseline when a branded file is removed', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-lower-'));
    const treeDir = path.join(baseDir, 'tree');
    const baselineDir = path.join(baseDir, 'baselines');
    fs.mkdirSync(treeDir, { recursive: true });

    fs.mkdirSync(path.join(baselineDir, 'test-tree'), { recursive: true });
    fs.writeFileSync(
      path.join(baselineDir, 'test-tree/fifthbell.json'),
      JSON.stringify({ count: 5 }),
    );

    const logger = jest.fn();
    try {
      const check = checkBrandBaselines({
        repoRoot,
        baselineDir,
        trees: { 'test-tree': treeDir },
        words: ['fifthbell'],
        logger,
      });

      expect(check.passed).toBe(true);
      expect(check.failures).toEqual([]);
      expect(check.reminders).toEqual([
        '[brand-ratchet] Reminder: lower baseline for test-tree/fifthbell from 5 to 0',
      ]);
      expect(logger).toHaveBeenCalledWith(
        '[brand-ratchet] Reminder: lower baseline for test-tree/fifthbell from 5 to 0',
      );
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  describe('helper unit coverage', () => {
    it('findRepoRoot falls back when no pnpm-workspace.yaml is found', () => {
      const rootFallback = findRepoRoot('/');
      expect(rootFallback).toBeDefined();
    });

    it('walkDirectory returns empty array for non-existent directory', () => {
      expect(walkDirectory('/non/existent/path')).toEqual([]);
    });

    it('walkDirectory skips excluded folder names', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-walk-'));
      const excluded = path.join(tmpDir, 'invariants');
      const included = path.join(tmpDir, 'sub');
      fs.mkdirSync(excluded, { recursive: true });
      fs.mkdirSync(included, { recursive: true });
      fs.writeFileSync(path.join(excluded, 'file1.ts'), '1');
      fs.writeFileSync(path.join(included, 'file2.ts'), '2');

      try {
        const files = walkDirectory(tmpDir, ['invariants']);
        expect(files).toEqual([path.join(included, 'file2.ts')]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('isBrandMatch checks path and content correctly', () => {
      expect(isBrandMatch('programs/modoitaliano/view.tsx', 'clean code', 'modoitaliano')).toBe(true);
      expect(isBrandMatch('programs/view.tsx', 'const x = "MODOITALIANO";', 'modoitaliano')).toBe(true);
      expect(isBrandMatch('programs/view.tsx', 'clean code', 'modoitaliano')).toBe(false);
    });

    it('scanTree handles unreadable files gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-error-'));
      const testFile = path.join(tmpDir, 'error.ts');
      fs.writeFileSync(testFile, 'dummy');
      fs.chmodSync(testFile, 0o000);

      try {
        const scan = scanTree(tmpDir, 'test-tree', ['modoitaliano']);
        expect(scan.files).toEqual([testFile]);
        expect(scan.matchesByWord['modoitaliano']).toEqual([]);
      } finally {
        fs.chmodSync(testFile, 0o644);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('loadBaseline throws when baseline file is missing', () => {
      expect(() => loadBaseline('/non/existent', 'backend', 'unknown')).toThrow(
        /Missing baseline file at/,
      );
    });

    it('loadBaseline throws when count is missing or not a number', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-bad-'));
      const treeDir = path.join(tmpDir, 'backend');
      fs.mkdirSync(treeDir, { recursive: true });
      fs.writeFileSync(path.join(treeDir, 'bad.json'), JSON.stringify({ count: 'not-a-number' }));

      try {
        expect(() => loadBaseline(tmpDir, 'backend', 'bad')).toThrow(
          /Invalid baseline format at .* missing count/,
        );
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
