import * as fs from 'fs';
import * as path from 'path';

export const BRAND_WORDS = [
  'modoitaliano',
  'fifthbell',
  'earone',
  'toni',
  'giorgia',
  'reloj',
  'sanremo',
  'cronica',
] as const;

export type BrandWord = (typeof BRAND_WORDS)[number];

export const DEFAULT_TREE_DIRS: Record<string, string> = {
  backend: 'backend/src',
  frontend: 'frontend/app',
};

export interface TreeScanResult {
  tree: string;
  files: string[];
  matchesByWord: Record<string, string[]>;
}

export interface BaselineCheckResult {
  passed: boolean;
  failures: string[];
  reminders: string[];
  counts: Record<string, Record<string, number>>;
  baselines: Record<string, Record<string, number>>;
}

export function findRepoRoot(startDir: string = __dirname): string {
  let curr = path.resolve(startDir);
  while (curr !== path.dirname(curr)) {
    if (fs.existsSync(path.join(curr, 'pnpm-workspace.yaml'))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  return path.resolve(startDir, '../../..');
}

// Lists every file under `dir`. `excludeNames` names entries directly under `dir` only (the tree root), so the
// ratchet's own `invariants` folder is skipped but a nested folder or file of the same name is still scanned.
export function walkDirectory(
  dir: string,
  excludeNames: string[] = ['invariants'],
): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (excludeNames.includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirectory(fullPath, []));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

export function isBrandMatch(
  relativePath: string,
  content: string,
  word: string,
): boolean {
  const lowerWord = word.toLowerCase();
  if (relativePath.toLowerCase().includes(lowerWord)) {
    return true;
  }
  return content.toLowerCase().includes(lowerWord);
}

// Test files are named *.test.* or *.spec.* (Vitest frontend, Jest backend).
export function isTestFile(relativePath: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

export function scanTree(
  treeDir: string,
  treeName: string,
  words: readonly string[] = BRAND_WORDS,
  excludeNames: string[] = ['invariants'],
): TreeScanResult {
  const allFiles = walkDirectory(treeDir, excludeNames);
  const matchesByWord: Record<string, string[]> = {};
  for (const word of words) {
    matchesByWord[word] = [];
  }

  for (const filePath of allFiles) {
    const rel = path.relative(treeDir, filePath);
    // A test names the branded component it covers, so it adds no product coupling of its own: only
    // runtime sources count toward the ratchet.
    if (isTestFile(rel)) continue;
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      // Unreadable file treated as empty content
    }
    for (const word of words) {
      if (isBrandMatch(rel, content, word)) {
        matchesByWord[word].push(rel);
      }
    }
  }

  return {
    tree: treeName,
    files: allFiles,
    matchesByWord,
  };
}

export function loadBaseline(
  baselineBaseDir: string,
  tree: string,
  word: string,
): number {
  const baselinePath = path.join(baselineBaseDir, tree, `${word}.json`);
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Missing baseline file at ${baselinePath}`);
  }
  const raw = fs.readFileSync(baselinePath, 'utf8');
  const parsed = JSON.parse(raw) as { count?: unknown };
  if (typeof parsed.count !== 'number') {
    throw new Error(
      `Invalid baseline format at ${baselinePath}: missing count`,
    );
  }
  return parsed.count;
}

export function checkBrandBaselines(options?: {
  repoRoot?: string;
  baselineDir?: string;
  trees?: Record<string, string>;
  words?: readonly string[];
  logger?: (msg: string) => void;
}): BaselineCheckResult {
  const repoRoot = options?.repoRoot ?? findRepoRoot();
  const baselineDir =
    options?.baselineDir ?? path.join(repoRoot, 'scripts/brand-baselines');
  const treeMap = options?.trees ?? {
    backend: path.join(repoRoot, DEFAULT_TREE_DIRS.backend),
    frontend: path.join(repoRoot, DEFAULT_TREE_DIRS.frontend),
  };
  const words = options?.words ?? BRAND_WORDS;
  const logger = options?.logger ?? console.log;

  const failures: string[] = [];
  const reminders: string[] = [];
  const counts: Record<string, Record<string, number>> = {};
  const baselines: Record<string, Record<string, number>> = {};

  for (const [treeName, treePath] of Object.entries(treeMap)) {
    counts[treeName] = {};
    baselines[treeName] = {};
    const scan = scanTree(treePath, treeName, words);

    for (const word of words) {
      const baseline = loadBaseline(baselineDir, treeName, word);
      baselines[treeName][word] = baseline;
      const actualFiles = scan.matchesByWord[word];
      const actual = actualFiles.length;
      counts[treeName][word] = actual;

      if (actual > baseline) {
        failures.push(
          `[brand-ratchet] ${treeName}/${word}: expected at most ${baseline} files, found ${actual} (${actual - baseline} new):\n  ${actualFiles.join('\n  ')}`,
        );
      } else if (actual < baseline) {
        const reminder = `[brand-ratchet] Reminder: lower baseline for ${treeName}/${word} from ${baseline} to ${actual}`;
        reminders.push(reminder);
        logger(reminder);
      }
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    reminders,
    counts,
    baselines,
  };
}
