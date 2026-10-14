import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asarIntegrityFuse, newestAppDir } from './install.ts';

for (const [names, expected] of [
  [['app-1.6.957', 'app-1.6.1102', 'app-1.6.1074', 'packages', 'Update.exe'], 'app-1.6.1102'],
  [['packages', 'Update.exe'], undefined],
] as const) {
  test(`the version Squirrel starts next among ${names.join(', ')} is ${expected}`, () => {
    assert.equal(newestAppDir(names), expected);
  });
}

/** Electron's fuse wire: a sentinel, the wire version, the fuse count, then one '0'/'1' per fuse. */
function exeWithFuses(fuses: string): Buffer {
  return Buffer.concat([
    Buffer.from('MZ...code...'),
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, fuses.length]),
    Buffer.from(fuses),
    Buffer.from('...more code'),
  ]);
}

for (const [exe, expected] of [
  [exeWithFuses('000000011'), 'off'],
  [exeWithFuses('000010011'), 'on'],
  [Buffer.from('MZ...no fuse wire...'), 'unknown'],
] as const) {
  test(`an executable whose ASAR integrity fuse reads ${expected} is reported so`, () => {
    assert.equal(asarIntegrityFuse(exe), expected);
  });
}
