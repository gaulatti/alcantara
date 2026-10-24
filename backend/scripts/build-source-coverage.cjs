'use strict';

const {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} = require('node:fs');
const { dirname, extname, join, relative, resolve } = require('node:path');
const ts = require('typescript');
const {
  instrumentSource,
  composeCompilerMap,
} = require('./source-coverage.cjs');

function buildSourceCoverage(backend = resolve(__dirname, '..')) {
  const source = join(backend, 'src');
  const destination = join(backend, '.coverage-dist');
  const config = ts.readConfigFile(
    join(backend, 'tsconfig.json'),
    ts.sys.readFile,
  );
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, backend);
  if (parsed.errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => backend,
        getNewLine: () => '\n',
      }),
    );
  rmSync(destination, { recursive: true, force: true });
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const input = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(input);
        continue;
      }
      if (/\.(?:spec|test)\.[cm]?[jt]s$|\.d\.ts$/.test(input)) continue;
      const output = join(
        destination,
        'src',
        relative(source, input).replace(/\.ts$/, '.js'),
      );
      mkdirSync(dirname(output), { recursive: true });
      if (!['.ts', '.js'].includes(extname(input))) {
        copyFileSync(input, output);
        continue;
      }
      const instrumented = instrumentSource(readFileSync(input, 'utf8'), input);
      const compiled = ts.transpileModule(instrumented.code, {
        fileName: input,
        compilerOptions: {
          ...parsed.options,
          sourceMap: true,
          inlineSourceMap: false,
          inlineSources: true,
        },
        reportDiagnostics: true,
      });
      if (compiled.diagnostics?.length)
        throw new Error(`Native coverage compilation failed: ${input}`);
      const mapped = composeCompilerMap(
        {
          code: compiled.outputText,
          map: compiled.sourceMapText && JSON.parse(compiled.sourceMapText),
        },
        instrumented,
        input,
      );
      writeFileSync(output, mapped.code);
      writeFileSync(`${output}.map`, JSON.stringify(mapped.map));
    }
  }
  visit(source);
  return destination;
}

if (require.main === module) buildSourceCoverage();
module.exports = { buildSourceCoverage };
