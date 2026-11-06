'use strict';

const { createInstrumenter, defaultOpts } = require('istanbul-lib-instrument');
const remapping = require('@ampproject/remapping');

// Instrument authored TypeScript before TSC adds decorator metadata and helpers.
// The native counters therefore describe source branches, not compiler output.
function instrumentSource(source, filename) {
  const instrumenter = createInstrumenter({
    esModules: true,
    compact: false,
    produceSourceMap: true,
    parserPlugins: [
      ...defaultOpts.parserPlugins,
      'typescript',
      'decorators-legacy',
    ],
  });
  const code = instrumenter.instrumentSync(source, filename);
  return {
    code,
    map: instrumenter.lastSourceMap(),
    coverage: instrumenter.lastFileCoverage(),
  };
}

function composeCompilerMap(output, instrumented, filename) {
  const inline = output.code.match(
    /\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([^\s]+)/,
  );
  const compilerMap =
    output.map ??
    (inline && JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')));
  if (!compilerMap) {
    throw new Error(`TypeScript emitted no source map for ${filename}`);
  }
  return {
    code: output.code.replace(
      /\/\/# sourceMappingURL=data:application\/json[^\n]*/g,
      '',
    ),
    map: remapping(
      [
        typeof compilerMap === 'string' ? JSON.parse(compilerMap) : compilerMap,
        instrumented.map,
      ],
      () => null,
    ),
  };
}

module.exports = { instrumentSource, composeCompilerMap };
