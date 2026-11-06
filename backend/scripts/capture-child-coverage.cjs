'use strict';

const { writeFileSync } = require('node:fs');
const destination = process.env.ALCANTARA_CHILD_COVERAGE_FILE;
if (!destination)
  throw new Error('Native child coverage requires an explicit output path');
function flush() {
  if (
    !globalThis.__coverage__ ||
    !Object.keys(globalThis.__coverage__).length
  ) {
    throw new Error('Native child execution produced no Istanbul coverage');
  }
  writeFileSync(destination, JSON.stringify(globalThis.__coverage__));
}
process.once('exit', flush);
process.once('SIGTERM', () => {
  flush();
  // Restore the native termination behavior after the synchronous native dump.
  process.kill(process.pid, 'SIGTERM');
});
