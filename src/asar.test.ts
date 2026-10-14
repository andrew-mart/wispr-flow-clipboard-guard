import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as asar from '@electron/asar';
import { readAsarFile, replaceAsarFile } from './asar.ts';

// Laid out like Wispr's app.asar: files before and after the bundle, and a native addon kept outside, in .unpacked.
const files = {
  'a.txt': 'before the bundle',
  '.webpack/main/index.js': 'original bundle',
  'z.txt': 'after the bundle',
  'native/addon.node': 'native addon',
} as const;

async function packFixture(changed: Partial<Record<keyof typeof files, string>> = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'asar-test-'));
  for (const [path, content] of Object.entries({ ...files, ...changed })) {
    mkdirSync(dirname(join(root, 'app', path)), { recursive: true });
    writeFileSync(join(root, 'app', path), content);
  }
  const archivePath = join(root, 'app.asar');
  await asar.createPackageWithOptions(join(root, 'app'), archivePath, { unpack: '*.node', dot: true });
  return archivePath;
}

/** Swaps the archive on disk for `archive`; its .unpacked folder stays next to it. */
function overwrite(archivePath: string, archive: Buffer) {
  writeFileSync(archivePath, archive);
  asar.uncache(archivePath);
}

/** @electron/asar looks paths up by the platform's separator. */
function readEach(archivePath: string) {
  return Object.fromEntries(
    Object.keys(files).map((path) => [path, asar.extractFile(archivePath, join(...path.split('/'))).toString()]),
  );
}

test('the replaced file reads as its new content and every other file as before, the unpacked addon included', async () => {
  const archivePath = await packFixture();

  const outcome = replaceAsarFile(readFileSync(archivePath), '.webpack/main/index.js', Buffer.from('patched bundle, longer'));
  if (outcome.kind !== 'replaced') throw new Error(`expected the file to be replaced, got ${outcome.kind}`);
  overwrite(archivePath, outcome.archive);

  assert.deepEqual(readEach(archivePath), {
    'a.txt': 'before the bundle',
    '.webpack/main/index.js': 'patched bundle, longer',
    'z.txt': 'after the bundle',
    'native/addon.node': 'native addon',
  });
});

/** The header entry @electron/asar writes for a file. */
function entryOf(archivePath: string, path: string) {
  return asar.statFile(archivePath, join(...path.split('/')));
}

test('the replaced file has the integrity @electron/asar gives that content', async () => {
  const archivePath = await packFixture();
  const repackedPath = await packFixture({ '.webpack/main/index.js': 'patched bundle, longer' });

  const outcome = replaceAsarFile(readFileSync(archivePath), '.webpack/main/index.js', Buffer.from('patched bundle, longer'));
  if (outcome.kind !== 'replaced') throw new Error(`expected the file to be replaced, got ${outcome.kind}`);
  overwrite(archivePath, outcome.archive);

  assert.deepEqual(entryOf(archivePath, '.webpack/main/index.js'), entryOf(repackedPath, '.webpack/main/index.js'));
});

test('an archive without the file is not changed, and the outcome names the path', async () => {
  const archivePath = await packFixture();

  assert.deepEqual(replaceAsarFile(readFileSync(archivePath), '.webpack/main/missing.js', Buffer.from('x')), {
    kind: 'file-not-found',
    path: '.webpack/main/missing.js',
  });
});

test('a file stored in the archive reads as its content, an unpacked or missing one as nothing', async () => {
  const archive = readFileSync(await packFixture());

  const read = (path: string) => readAsarFile(archive, path)?.toString();

  assert.deepEqual(
    { stored: read('z.txt'), unpacked: read('native/addon.node'), missing: read('missing.txt') },
    { stored: 'after the bundle', unpacked: undefined, missing: undefined },
  );
});
