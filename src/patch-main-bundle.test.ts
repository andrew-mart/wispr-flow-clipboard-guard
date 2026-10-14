import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { patchMainBundle } from './patch-main-bundle.ts';

// The three Helper calls exactly as Wispr Flow 1.6.1102 writes them in .webpack/main/index.js, in a stand-in for the
// module around them: `y` sends a request and waits for the answer, `ce` sends one without waiting.
const bundle1_6_1102 =
  'const ae=(e,t,n={})=>{const c={pasteId:"p1",text:e};return null!=t&&(c.htmlText=t),' +
  'y("PasteText",()=>{},void 0,{payload:c,propagateError:!0}).catch(e=>{}),"p1"},' +
  'ee=e=>y("GetSelectedTextViaCopy",e=>e.SelectedTextViaCopy?.payload,{afterText:"",beforeText:"",contents:"",selectedText:""},{payload:{copyMode:e}}),' +
  'he=e=>{const t={};for(const n in e)t[n]=e[n];ce("UpdateFeatureFlags",{featureFlags:t})};' +
  'register({ae,ee,he});';

type HelperCall = { readonly action: string; readonly payload: unknown };

type StandInFunctions = {
  ae(text: string, html: string | null): string;
  ee(copyMode: string | undefined): Promise<{ readonly selectedText: string }>;
  he(flags: Readonly<Record<string, unknown>>): void;
};

/** The Helper puts the pasted text, or the selection it copies, on the clipboard. */
function textOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('text' in payload)) return undefined;
  return typeof payload.text === 'string' ? payload.text : undefined;
}

/** Runs the patched stand-in with a Helper that records what it is sent and a text-only clipboard. */
function runPatched(source: string, { clipboardText = '' } = {}) {
  const outcome = patchMainBundle(source);
  if (outcome.kind !== 'patched') throw new Error(`expected the bundle to be patched, got ${outcome.kind}`);
  const sent: HelperCall[] = [];
  let text = clipboardText;
  const clipboard = {
    readText: () => text,
    readHTML: () => '',
    readRTF: () => '',
    readImage: () => ({ isEmpty: () => true }),
    write: (content: { readonly text?: string }) => {
      text = content.text ?? '';
    },
  };
  const requireElectron = (name: string) => (name === 'electron' ? { clipboard } : undefined);
  const request = (action: string, _answer: unknown, fallback: unknown, options: { readonly payload: unknown }) => {
    sent.push({ action, payload: options.payload });
    const pasted = textOf(options.payload);
    if (action === 'PasteText' && pasted !== undefined) text = pasted;
    if (action !== 'GetSelectedTextViaCopy') return Promise.resolve(fallback);
    text = 'selected words';
    return Promise.resolve({ afterText: '', beforeText: '', contents: '', selectedText: 'selected words' });
  };
  const fireAndForget = (action: string, payload: unknown) => {
    sent.push({ action, payload });
  };
  let functions: StandInFunctions | undefined;
  const register = (registered: StandInFunctions) => {
    functions = registered;
  };
  new Function('require', 'y', 'ce', 'register', outcome.source)(requireElectron, request, fireAndForget, register);
  if (functions === undefined) throw new Error('the stand-in registered nothing');
  return { sent, functions, clipboardText: () => text };
}

/** Lets the Helper's answers and what waits on them run; timers stay mocked. */
const answersArrive = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('the Helper is told to leave the clipboard alone whatever the server says', () => {
  const { sent, functions } = runPatched(bundle1_6_1102);

  functions.he({ 'disable-clipboard-restore': { enabled: false }, 'shift-insert': { enabled: true } });

  assert.deepEqual(sent, [
    {
      action: 'UpdateFeatureFlags',
      payload: { featureFlags: { 'disable-clipboard-restore': { enabled: true }, 'shift-insert': { enabled: true } } },
    },
  ]);
});

test('a paste the bundle sends gets the clipboard from before back after the delay', async () => {
  const { functions, clipboardText } = runPatched(bundle1_6_1102, { clipboardText: 'copied before' });

  functions.ae('dictated text ', null);
  await answersArrive();
  mock.timers.tick(1500);

  assert.equal(clipboardText(), 'copied before');
});

test('a selection the bundle has the Helper copy is replaced by the clipboard from before', async () => {
  const { functions, clipboardText } = runPatched(bundle1_6_1102, { clipboardText: 'copied before' });

  await functions.ee(undefined);

  assert.equal(clipboardText(), 'copied before');
});

test('a bundle patched once is left as it is', () => {
  const first = patchMainBundle(bundle1_6_1102);
  if (first.kind !== 'patched') throw new Error(`expected the first patch to apply, got ${first.kind}`);

  assert.deepEqual(patchMainBundle(first.source), { kind: 'already-patched' });
});

for (const [change, source, expected] of [
  ['without the paste call', bundle1_6_1102.replace('"PasteText"', '"PasteTextV2"'), { request: 'PasteText', matches: 0 }],
  [
    'with the flags call twice',
    bundle1_6_1102.replace('register(', 'ce("UpdateFeatureFlags",{featureFlags:t});register('),
    { request: 'UpdateFeatureFlags', matches: 2 },
  ],
] as const) {
  test(`a build ${change} is not patched, and the outcome names the request`, () => {
    assert.deepEqual(patchMainBundle(source), { kind: 'request-not-found-once', ...expected });
  });
}
