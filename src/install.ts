// What the patcher decides from a Wispr Flow installation (%LOCALAPPDATA%\WisprFlow, kept by Squirrel):
// which app-X.Y.Z folder runs next, and whether Electron would refuse an edited app.asar.

const appDirName = /^app-(\d+)\.(\d+)\.(\d+)$/;

/** Zero-padded parts compare as text the way the versions compare as numbers. */
function versionKey(name: string): string | undefined {
  const parts = appDirName.exec(name);
  return parts === null ? undefined : parts.slice(1).map((part) => part.padStart(10, '0')).join('.');
}

/** Squirrel starts the highest version: 1.6.1102 is newer than 1.6.957, though it sorts before it as text. */
export function newestAppDir(names: readonly string[]): string | undefined {
  return names
    .flatMap((name) => {
      const key = versionKey(name);
      return key === undefined ? [] : [{ name, key }];
    })
    .sort((a, b) => a.key.localeCompare(b.key))
    .at(-1)?.name;
}

const fuseSentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
/** Position of EnableEmbeddedAsarIntegrityValidation in fuse wire version 1. */
const asarIntegrityFuseIndex = 4;

export function asarIntegrityFuse(exe: Buffer): 'on' | 'off' | 'unknown' {
  const sentinelAt = exe.indexOf(fuseSentinel);
  if (sentinelAt < 0) return 'unknown';
  const fuse = exe[sentinelAt + fuseSentinel.length + 2 + asarIntegrityFuseIndex];
  if (fuse === '1'.charCodeAt(0)) return 'on';
  if (fuse === '0'.charCodeAt(0)) return 'off';
  return 'unknown';
}
