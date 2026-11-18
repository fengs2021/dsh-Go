import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifest } from '../../ohos/plugins/installer.mjs';

// npm rewrites `bin` before publishing a packument: a bare string becomes an object
// keyed by the package name, and a leading `./` is dropped. The tarball keeps exactly
// what the publisher wrote, so yaml@2.9.1 reads `{"yaml":"bin.mjs"}` from the registry
// and `"./bin.mjs"` from the archive. Refusing that pair blocks every package with a bin.
test('a registry-normalised bin matches the archive it points at', () => {
  checkManifest({ name: 'yaml', version: '2.9.1', bin: { yaml: 'bin.mjs' } },
    { name: 'yaml', version: '2.9.1', bin: './bin.mjs' });
  checkManifest({ name: 'yaml', version: '2.9.1', bin: { yaml: 'bin.mjs' } },
    { name: 'yaml', version: '2.9.1', bin: { yaml: './bin.mjs' } });
  checkManifest({ name: 'cli', version: '1.0.0', bin: 'cli.js' },
    { name: 'cli', version: '1.0.0', bin: { cli: './cli.js' } });
  checkManifest({ name: '@scope/cli', version: '1.0.0', bin: { cli: './one.js', extra: './two.js' } },
    { name: '@scope/cli', version: '1.0.0', bin: { extra: 'two.js', cli: 'one.js' } });
  checkManifest({ name: 'none', version: '1.0.0' }, { name: 'none', version: '1.0.0' });
});

test('a different bin target, an extra entry or another drifted field still refuses', () => {
  assert.throws(() => checkManifest({ name: 'cli', version: '1.0.0', bin: { tool: 'cli.js' } },
    { name: 'cli', version: '1.0.0', bin: { tool: './other.js' } }), /cli: archive manifest differs from locked bin/);
  assert.throws(() => checkManifest({ name: 'cli', version: '1.0.0', bin: { tool: 'cli.js' } },
    { name: 'cli', version: '1.0.0', bin: { tool: './cli.js', extra: './extra.js' } }), /differs from locked bin/);
  assert.throws(() => checkManifest({ name: 'cli', version: '1.0.0', bin: { tool: 'cli.js' } },
    { name: 'cli', version: '1.0.0' }), /differs from locked bin/);
  assert.throws(() => checkManifest({ name: 'cli', version: '1.0.0', dependencies: { hidden: '1' } },
    { name: 'cli', version: '1.0.0', dependencies: { hidden: '2' } }), /differs from locked dependencies/);
});
