import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClipboardGuard } from './clipboard-guard.ts';
import type { ClipboardContent, ClipboardGuard, ClipboardImage, GuardClipboard } from './clipboard-guard.ts';

const noImage: ClipboardImage = { isEmpty: () => true };
const screenshot: ClipboardImage = { isEmpty: () => false };

/** Electron's clipboard: write() replaces everything that was there, formats the guard never reads included. */
function fakeClipboard<T extends ClipboardContent>(initial: T): GuardClipboard & { content(): ClipboardContent } {
  let content: ClipboardContent = initial;
  return {
    readText: () => content.text ?? '',
    readHTML: () => content.html ?? '',
    readRTF: () => content.rtf ?? '',
    readImage: () => content.image ?? noImage,
    write: (next) => {
      content = next;
    },
    content: () => content,
  };
}

function guardOver(clipboard: GuardClipboard): ClipboardGuard {
  return createClipboardGuard({
    clipboard,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    restoreDelayMs: 1500,
  });
}

/** Wispr Flow Helper puts the text on the clipboard and answers once it has sent Ctrl+V. */
function pasteThroughHelper(guard: ClipboardGuard, clipboard: GuardClipboard, text: string): Promise<void> {
  return guard.paste(text, async () => {
    clipboard.write({ text });
  });
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('the dictated text stays on the clipboard for the whole delay, then what was copied before comes back', async () => {
  const clipboard = fakeClipboard({ text: 'copied before' });
  const guard = guardOver(clipboard);

  await pasteThroughHelper(guard, clipboard, 'dictated text ');
  mock.timers.tick(1499);
  const duringDelay = clipboard.readText();
  mock.timers.tick(1);

  assert.deepEqual({ duringDelay, after: clipboard.readText() }, { duringDelay: 'dictated text ', after: 'copied before' });
});

for (const [kind, before] of [
  ['a screenshot', { image: screenshot }],
  ['formatted text with its formatting', { text: 'bold', html: '<b>bold</b>', rtf: '{\\rtf1 \\b bold}' }],
] as const) {
  test(`${kind} copied before the paste comes back`, async () => {
    const clipboard = fakeClipboard(before);
    const guard = guardOver(clipboard);

    await pasteThroughHelper(guard, clipboard, 'dictated text ');
    mock.timers.tick(1500);

    assert.deepEqual(clipboard.content(), before);
  });
}

test('after two pastes in a row what was copied before the first one comes back', async () => {
  const clipboard = fakeClipboard({ text: 'copied before' });
  const guard = guardOver(clipboard);

  await pasteThroughHelper(guard, clipboard, 'first dictation ');
  mock.timers.tick(500);
  await pasteThroughHelper(guard, clipboard, 'second dictation ');
  mock.timers.tick(1500);

  assert.equal(clipboard.readText(), 'copied before');
});

test('a paste request the Helper fails still gets the clipboard back, and Wispr still sees the failure', async () => {
  const clipboard = fakeClipboard({ text: 'copied before' });
  const guard = guardOver(clipboard);

  const failure = await guard
    .paste('dictated text ', async () => {
      clipboard.write({ text: 'dictated text ' });
      throw new Error('helper unavailable');
    })
    .then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'not an Error'),
    );
  mock.timers.tick(1500);

  assert.deepEqual({ failure, after: clipboard.readText() }, { failure: 'helper unavailable', after: 'copied before' });
});

/** Wispr Flow Helper copies the selection with Ctrl+C and answers with it. */
function copySelectionThroughHelper(guard: ClipboardGuard, clipboard: GuardClipboard, selectedText: string) {
  return guard.copy(async () => {
    clipboard.write({ text: selectedText });
    return { selectedText };
  });
}

test('the selection the Helper copies is replaced by what was copied before as soon as the Helper answers', async () => {
  const clipboard = fakeClipboard({ text: 'copied before' });
  const guard = guardOver(clipboard);

  await copySelectionThroughHelper(guard, clipboard, 'selected words');

  assert.equal(clipboard.readText(), 'copied before');
});

test('a clipboard the Helper put back itself after a copy stays untouched, formats the guard cannot save included', async () => {
  const before = { text: 'report.pdf', fileList: ['C:/docs/report.pdf'] };
  const clipboard = fakeClipboard(before);
  const guard = guardOver(clipboard);

  await guard.copy(async () => {
    clipboard.write({ text: 'selected words' });
    clipboard.write(before);
    return { selectedText: 'selected words' };
  });

  assert.deepEqual(clipboard.content(), before);
});

test('after a failed copy the next paste brings back the clipboard as it was at that paste', async () => {
  const clipboard = fakeClipboard({ text: 'copied before' });
  const guard = guardOver(clipboard);

  await guard
    .copy(async () => {
      throw new Error('helper unavailable');
    })
    .catch(() => {});
  clipboard.write({ text: 'copied later' });
  await pasteThroughHelper(guard, clipboard, 'dictated text ');
  mock.timers.tick(1500);

  assert.equal(clipboard.readText(), 'copied later');
});

test('something copied during the delay stays on the clipboard', async () => {
  const clipboard = fakeClipboard({ text: 'copied before' });
  const guard = guardOver(clipboard);

  await pasteThroughHelper(guard, clipboard, 'dictated text ');
  clipboard.write({ text: 'copied during the delay' });
  mock.timers.tick(1500);

  assert.equal(clipboard.readText(), 'copied during the delay');
});
