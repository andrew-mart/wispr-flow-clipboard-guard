// Edits Wispr Flow's main-process bundle (.webpack/main/index.js inside app.asar): the Helper stops restoring the
// clipboard itself, and the clipboard guard restores it around the Helper's paste and copy requests instead.
// Anchors are the Helper's request names: minified identifiers change from one Wispr build to the next.
import { createClipboardGuard } from './clipboard-guard.ts';

export type PatchOutcome =
  | { readonly kind: 'patched'; readonly source: string }
  | { readonly kind: 'already-patched' }
  /** A Wispr build that sends this Helper request differently: patching it blind could break dictation. */
  | { readonly kind: 'request-not-found-once'; readonly request: string; readonly matches: number };

const marker = '/*wispr-clipboard-guard*/';

/**
 * Long enough for Brave on a loaded machine to read the clipboard; Wispr's text is on it for that long. 1.5 s was not:
 * Brave pasted the clipboard from before.
 */
const restoreDelayMs = 8000;

// Created on the first paste, when Electron is up; the bundle is a CommonJS script, so `require` is in scope.
const guardDefinition =
  `${marker}var __wisprClipboardGuard=(()=>{let guard;return()=>guard??=` +
  `(${createClipboardGuard.toString()})` +
  `({clipboard:require("electron").clipboard,setTimer:setTimeout,clearTimer:clearTimeout,restoreDelayMs:${restoreDelayMs}})})();`;

type Edit = {
  readonly request: string;
  /** Global, to count the calls; the patch goes ahead only when there is exactly one. */
  readonly call: RegExp;
  readonly rewrite: (call: string, ...identifiers: string[]) => string;
};

const edits: readonly Edit[] = [
  {
    request: 'UpdateFeatureFlags',
    call: /(\w+)\("UpdateFeatureFlags",\{featureFlags:(\w+)\}\)/g,
    rewrite: (_call, send, flags) =>
      `(${flags}["disable-clipboard-restore"]={enabled:!0},${send}("UpdateFeatureFlags",{featureFlags:${flags}}))`,
  },
  {
    request: 'PasteText',
    call: /\w+\("PasteText",\(\)=>\{\},void 0,\{payload:(\w+),propagateError:!0\}\)/g,
    rewrite: (call, payload) => `__wisprClipboardGuard().paste(${payload}.text,()=>${call})`,
  },
  {
    // The answer's fallback when the Helper says nothing has selectedText "" too, so the guard always gets a string.
    request: 'GetSelectedTextViaCopy',
    call: /\w+\("GetSelectedTextViaCopy",[^;]*?\{payload:\{copyMode:\w+\}\}\)/g,
    rewrite: (call) => `__wisprClipboardGuard().copy(()=>${call})`,
  },
];

/** replace() passes the capture groups, then the match offset and the whole string: the groups are the strings. */
function identifiersIn(groups: readonly unknown[]): string[] {
  return groups.filter((group): group is string => typeof group === 'string').slice(0, -1);
}

export function patchMainBundle(source: string): PatchOutcome {
  if (source.includes(marker)) return { kind: 'already-patched' };
  for (const { request, call } of edits) {
    const matches = [...source.matchAll(call)].length;
    if (matches !== 1) return { kind: 'request-not-found-once', request, matches };
  }
  const patched = edits.reduce(
    (edited, { call, rewrite }) => edited.replace(call, (found: string, ...groups: unknown[]) => rewrite(found, ...identifiersIn(groups))),
    source,
  );
  return { kind: 'patched', source: guardDefinition + patched };
}
