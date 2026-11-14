'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const tsJest = require('ts-jest').default;
const {
  instrumentSource,
  composeCompilerMap,
} = require('./source-coverage.cjs');

module.exports = {
  createTransformer(config) {
    const compiler = tsJest.createTransformer(config);
    const implementation = [
      readFileSync(__filename),
      readFileSync(require.resolve('./source-coverage.cjs')),
      require.resolve('istanbul-lib-instrument'),
      require.resolve('@ampproject/remapping'),
    ].join('\n');
    return {
      canInstrument: true,
      getCacheKey(source, filename, options) {
        return createHash('sha256')
          .update(implementation)
          .update(compiler.getCacheKey(source, filename, options))
          .digest('hex');
      },
      process(source, filename, options) {
        if (!options.instrument) {
          return compiler.process(source, filename, options);
        }
        const instrumented = instrumentSource(source, filename);
        const output = compiler.process(instrumented.code, filename, {
          ...options,
          instrument: false,
        });
        return composeCompilerMap(output, instrumented, filename);
      },
    };
  },
};
