'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const sourceMapSupport = require('source-map-support');
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { buildSourceCoverage } = require('../scripts/build-source-coverage.cjs');
const {
  instrumentSource,
  composeCompilerMap,
} = require('../scripts/source-coverage.cjs');

const filename = '/fixture/source.ts';
const source = `
function Injectable(): ClassDecorator { return () => {}; }
class Dependency {}
@Injectable()
export class Service {
  constructor(readonly dependency: Dependency) {}
  choose(value: boolean) { return value ? 'enabled' : 'disabled'; }
}
`;

function compile(instrumented) {
  const output = ts.transpileModule(instrumented.code, {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      sourceMap: true,
      inlineSources: true,
    },
  });
  assert.equal(output.diagnostics.length, 0);
  return composeCompilerMap(
    { code: output.outputText, map: JSON.parse(output.sourceMapText) },
    instrumented,
    filename,
  );
}

function execute(code) {
  const metadata = [];
  const context = vm.createContext({
    exports: {},
    Reflect: {
      metadata: (...args) => {
        metadata.push(args);
        return () => {};
      },
    },
  });
  new vm.Script(code, { filename }).runInContext(context);
  return { context, metadata };
}

test('native source counters distinguish real branches and retain Nest constructor metadata', () => {
  const instrumented = instrumentSource(source, filename);
  const compiled = compile(instrumented);
  const { context, metadata } = execute(compiled.code);
  const service = new context.exports.Service({});
  assert.equal(service.choose(true), 'enabled');
  const report = context.__coverage__[filename];
  const branches = Object.values(report.b);
  assert.equal(branches.length, 1);
  assert.deepEqual(Array.from(branches[0]), [1, 0]);
  assert.equal(service.choose(false), 'disabled');
  assert.deepEqual(Array.from(branches[0]), [1, 1]);
  assert.equal(metadata[0][0], 'design:paramtypes');
  assert.equal(metadata[0][1][0].name, 'Dependency');
  assert.equal(report.inputSourceMap, undefined);
  assert.equal(Object.values(report.branchMap)[0].line, 7);
  assert.equal(compiled.map.sourcesContent[0], source);
});

test('composed source maps preserve authored throw locations across both transforms', () => {
  const throwing =
    'export function fail() {\n  throw new Error("expected");\n}\n';
  const instrumented = instrumentSource(throwing, filename);
  const compiled = compile(instrumented);
  const { context } = execute(compiled.code);
  let failure;
  try {
    context.exports.fail();
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /expected/);
  const position = failure.stack.match(/source\.ts:(\d+):(\d+)/);
  assert.ok(position);
  const originalPrepareStackTrace = Error.prepareStackTrace;
  sourceMapSupport.install({
    handleUncaughtExceptions: false,
    retrieveSourceMap: (file) =>
      file === filename ? { url: filename, map: compiled.map } : null,
  });
  try {
    const mapped = sourceMapSupport.mapSourcePosition({
      source: filename,
      line: Number(position[1]),
      column: Number(position[2]) - 1,
    });
    assert.equal(mapped.source, filename);
    assert.equal(mapped.line, 2);
    assert.equal(compiled.map.sourcesContent[0], throwing);
  } finally {
    sourceMapSupport.resetRetrieveHandlers();
    Error.prepareStackTrace = originalPrepareStackTrace;
  }
});

test('invalid syntax and missing compiler maps fail instead of returning partial coverage', () => {
  assert.throws(
    () => instrumentSource('export const = ;', filename),
    SyntaxError,
  );
  const instrumented = instrumentSource(source, filename);
  assert.throws(
    () => composeCompilerMap({ code: 'no map' }, instrumented, filename),
    /no source map/,
  );
});

test('type-only modules remain in the native inventory with zero executable counters', () => {
  const instrumented = instrumentSource(
    'export interface Empty { id: string }',
    filename,
  );
  const compiled = compile(instrumented);
  const { context } = execute(compiled.code);
  const report = context.__coverage__[filename];
  assert.equal(report.path, filename);
  assert.equal(Object.keys(report.statementMap).length, 0);
  assert.equal(Object.keys(report.branchMap).length, 0);
});

test('actual Node child compilation uses identical source maps and standard native merging', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alcantara-native-coverage-'));
  try {
    mkdirSync(join(directory, 'src'));
    writeFileSync(
      join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'commonjs',
          target: 'es2023',
          sourceMap: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      }),
    );
    const fixture =
      'export function choose(value: boolean) { return value ? "on" : "off"; }\n';
    const authored = join(directory, 'src/service.ts');
    writeFileSync(authored, fixture);
    writeFileSync(
      join(directory, 'src/main.ts'),
      'import {choose} from "./service";\nconsole.log(JSON.stringify([choose(true),choose(false)]));\n',
    );
    writeFileSync(join(directory, 'src/contract.proto'), 'syntax = "proto3";');
    writeFileSync(
      join(directory, 'src/service.spec.ts'),
      'this is deliberately not application source',
    );
    const destination = buildSourceCoverage(directory);
    const native = join(destination, 'child.json');
    const child = spawnSync(
      process.execPath,
      [
        '--require',
        resolve(__dirname, '../scripts/capture-child-coverage.cjs'),
        join(destination, 'src/main.js'),
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ALCANTARA_CHILD_COVERAGE_FILE: native },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), ['on', 'off']);
    assert.equal(
      readFileSync(join(destination, 'src/contract.proto'), 'utf8'),
      'syntax = "proto3";',
    );
    const report = JSON.parse(readFileSync(native, 'utf8'));
    assert.deepEqual(Object.values(report[authored].b), [[1, 1]]);
    const original = instrumentSource(fixture, authored).coverage;
    assert.deepEqual(report[authored].branchMap, original.branchMap);
    assert.deepEqual(report[authored].statementMap, original.statementMap);
    const merged = createCoverageMap({ [authored]: original });
    merged.merge(report);
    assert.equal(merged.getCoverageSummary().branches.pct, 100);
    assert.equal(merged.getCoverageSummary().lines.pct, 100);
    assert.deepEqual(
      merged.fileCoverageFor(authored).toJSON().branchMap,
      original.branchMap,
    );
    const transferred = createCoverageMap(
      structuredClone(JSON.parse(JSON.stringify(merged))),
    );
    assert.equal(transferred.getCoverageSummary().branches.pct, 100);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('jest transformer instruments authored source and defers to ts-jest otherwise', () => {
  const transformer = require('../scripts/jest-source-coverage-transformer.cjs');
  const root = resolve(__dirname, '..');
  const config = {
    cwd: root,
    rootDir: root,
    globals: {},
    extensionsToTreatAsEsm: [],
    transform: [],
    moduleFileExtensions: ['ts', 'js'],
    setupFiles: [],
    testMatch: [],
    testRegex: [],
    fakeTimers: {},
    snapshotSerializers: [],
  };
  const created = transformer.createTransformer(config);
  const source = 'export const pick = (x: boolean) => (x ? 1 : 2);';
  const filename = join(root, 'src/pick.ts');
  const options = (instrument) => ({
    config,
    instrument,
    supportsStaticESM: false,
    configString: '{}',
    cacheFS: new Map(),
    transformerConfig: {},
  });
  assert.equal(created.canInstrument, true);
  assert.match(created.process(source, filename, options(true)).code, /cov_/);
  assert.doesNotMatch(
    created.process(source, filename, options(false)).code,
    /cov_/,
  );
  const key = created.getCacheKey(source, filename, options(true));
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(
    key,
    created.getCacheKey(source + ' ', filename, options(true)),
  );
});

test('child coverage capture refuses to run without an explicit output path', () => {
  const previous = process.env.ALCANTARA_CHILD_COVERAGE_FILE;
  delete process.env.ALCANTARA_CHILD_COVERAGE_FILE;
  try {
    assert.throws(
      () => require('../scripts/capture-child-coverage.cjs'),
      /explicit output path/,
    );
  } finally {
    if (previous !== undefined)
      process.env.ALCANTARA_CHILD_COVERAGE_FILE = previous;
  }
});

test('source coverage runner builds, then runs jest natively, and propagates failures', () => {
  const { run } = require('../scripts/run-source-coverage.cjs');
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push([command, args, options]);
    return { status: 0 };
  };
  let built = 0;
  assert.equal(
    run(['--runInBand'], spawn, () => (built += 1)),
    0,
  );
  assert.equal(built, 1);
  assert.deepEqual(calls[0][1], ['run', 'build']);
  assert.equal(calls[1][1].at(-1), '--runInBand');
  assert.equal(calls[1][2].env.ALCANTARA_NATIVE_COVERAGE, '1');
  assert.equal(
    run(
      [],
      () => ({ status: 3 }),
      () => assert.fail(),
    ),
    3,
  );
  assert.equal(
    run(
      [],
      () => ({ status: null }),
      () => assert.fail(),
    ),
    1,
  );
  let step = 0;
  assert.equal(
    run(
      [],
      () => ({ status: step++ === 0 ? 0 : null }),
      () => {},
    ),
    1,
  );
  assert.throws(
    () =>
      run(
        [],
        () => ({ error: new Error('no pnpm') }),
        () => {},
      ),
    /no pnpm/,
  );
  step = 0;
  assert.throws(
    () =>
      run(
        [],
        () => (step++ === 0 ? { status: 0 } : { error: new Error('jest') }),
        () => {},
      ),
    /jest/,
  );
});
