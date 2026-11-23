'use strict';

const { writeFileSync } = require('node:fs');

function install(
  destination,
  target = process,
  coverage = () => globalThis.__coverage__,
) {
  if (!destination)
    throw new Error('Native child coverage requires an explicit output path');
  function flush() {
    const counters = coverage();
    if (!counters || !Object.keys(counters).length) {
      throw new Error('Native child execution produced no Istanbul coverage');
    }
    writeFileSync(destination, JSON.stringify(counters));
  }
  target.once('exit', flush);
  target.once('SIGTERM', () => {
    flush();
    // Restore the native termination behavior after the synchronous native dump.
    target.kill(target.pid, 'SIGTERM');
  });
  return flush;
}

module.exports = { install };

install(process.env.ALCANTARA_CHILD_COVERAGE_FILE);
