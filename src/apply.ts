// Patches the Wispr Flow version Squirrel starts next. Run after every Wispr update:
//   node --experimental-strip-types src/apply.ts [--restart]
// --restart stops Wispr Flow when it runs from that version (app.asar is locked while it runs) and starts it again.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readAsarFile, replaceAsarFile } from './asar.ts';
import { asarIntegrityFuse, newestAppDir } from './install.ts';
import { patchMainBundle } from './patch-main-bundle.ts';

const bundlePath = '.webpack/main/index.js';

type Options = { readonly root: string; readonly restart: boolean };

function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined) throw new Error('LOCALAPPDATA is not set: cannot find the Wispr Flow installation');
  return { root: join(localAppData, 'WisprFlow'), restart: argv.includes('--restart') };
}

type WisprProcess = { readonly id: number; readonly path: string };

/** A row of Get-Process output; Path is null for processes it may not open. */
type ProcessRow = { readonly Id: number; readonly Path: string };

function isProcessRow(value: unknown): value is ProcessRow {
  return typeof value === 'object' && value !== null && 'Id' in value && 'Path' in value
    && typeof value.Id === 'number' && typeof value.Path === 'string';
}

/** Wispr Flow's own processes and its Helper. */
function wisprProcesses(): WisprProcess[] {
  const json = execFileSync('powershell', [
    '-NoProfile', '-Command',
    "@(Get-Process -Name 'Wispr Flow','Wispr Flow Helper' -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress",
  ], { encoding: 'utf8' }).trim();
  if (json === '') return [];
  const parsed: unknown = JSON.parse(json);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.flatMap((item: unknown) => (isProcessRow(item) ? [{ id: item.Id, path: item.Path }] : []));
}

function stop(processes: readonly WisprProcess[]) {
  for (const { id } of processes) execFileSync('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore' });
}

function writeAtomically(path: string, content: Buffer) {
  const temporary = `${path}.clipboard-guard-tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function main(): number {
  const { root, restart } = parseOptions(process.argv.slice(2), process.env);
  const dir = newestAppDir(readdirSync(root));
  if (dir === undefined) return fail(`no app-X.Y.Z folder in ${root}`);
  const appDir = join(root, dir);

  const fuse = asarIntegrityFuse(readFileSync(join(appDir, 'Wispr Flow.exe')));
  if (fuse !== 'off') return fail(`${dir}: ASAR integrity fuse is ${fuse}; Electron would refuse an edited app.asar`);

  const asarPath = join(appDir, 'resources', 'app.asar');
  const archive = readFileSync(asarPath);
  const bundle = readAsarFile(archive, bundlePath);
  if (bundle === undefined) return fail(`${dir}: ${bundlePath} is not in app.asar`);

  const outcome = patchMainBundle(bundle.toString('utf8'));
  switch (outcome.kind) {
    case 'already-patched':
      console.log(`${dir}: already patched`);
      return 0;
    case 'request-not-found-once':
      return fail(`${dir}: the Helper request ${outcome.request} occurs ${outcome.matches} times, not once; the patch needs updating`);
    case 'patched':
      break;
    default: {
      const unexpected: never = outcome;
      return fail(`unexpected patch outcome ${JSON.stringify(unexpected)}`);
    }
  }
  const replaced = replaceAsarFile(archive, bundlePath, Buffer.from(outcome.source, 'utf8'));
  if (replaced.kind === 'file-not-found') return fail(`${dir}: ${replaced.path} vanished from app.asar`);

  const running = wisprProcesses().filter(({ path }) => resolve(path).startsWith(resolve(appDir) + sep));
  if (running.length > 0 && !restart) return fail(`${dir}: Wispr Flow is running from it; close it or pass --restart`);
  stop(running);

  const backup = `${asarPath}.before-clipboard-guard`;
  if (!existsSync(backup)) copyFileSync(asarPath, backup);
  writeAtomically(asarPath, replaced.archive);
  console.log(`${dir}: patched (original kept as ${backup})`);

  if (running.length > 0) spawn(join(root, 'Wispr Flow.exe'), [], { detached: true, stdio: 'ignore' }).unref();
  return 0;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

process.exitCode = main();
