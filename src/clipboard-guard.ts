// Keeps the user's clipboard across a Wispr Flow paste. Wispr Flow Helper restores the clipboard as soon as anybody
// reads it — ESET's eOppFrame does within ~15 ms — so a slow target (Brave with a busy page) pastes the old content.
// The Helper's restore is turned off by the patch; this guard restores instead, a fixed delay after the paste.
// The factory's source is injected into Wispr's main bundle via toString(): it must not refer to anything outside it.

export type ClipboardImage = { isEmpty(): boolean };

export type ClipboardContent = {
  readonly text?: string;
  readonly html?: string;
  readonly rtf?: string;
  readonly image?: ClipboardImage;
};

/** The part of Electron's `clipboard` the guard uses. */
export type GuardClipboard = {
  readText(): string;
  readHTML(): string;
  readRTF(): string;
  readImage(): ClipboardImage;
  write(content: ClipboardContent): void;
};

type TimerHandle = ReturnType<typeof setTimeout>;

export type ClipboardGuardDeps = {
  readonly clipboard: GuardClipboard;
  readonly setTimer: (run: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer: (handle: TimerHandle) => void;
  /** How long Wispr's text stays on the clipboard after the Helper has sent the paste keystroke. */
  readonly restoreDelayMs: number;
};

export type ClipboardGuard = {
  /**
   * Wraps the Helper's PasteText request: the clipboard from before comes back `restoreDelayMs` after the Helper
   * answers, unless something other than `text` is on the clipboard by then. Returns the request itself.
   */
  paste<T>(text: string, send: () => Promise<T>): Promise<T>;
  /**
   * Wraps the Helper's GetSelectedTextViaCopy request: once the Helper answers, the clipboard from before replaces
   * the copied selection. Returns the request itself.
   */
  copy<T extends { readonly selectedText: string }>(send: () => Promise<T>): Promise<T>;
};

export function createClipboardGuard(deps: ClipboardGuardDeps): ClipboardGuard {
  const { clipboard } = deps;
  // A restore is pending from capture() until it runs: a paste in between must not capture Wispr's own text.
  let saved: ClipboardContent | undefined;
  let timer: TimerHandle | undefined;

  // Electron reads an absent format as '' or an empty image; only the formats present are written back.
  const read = (): ClipboardContent => {
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    const rtf = clipboard.readRTF();
    const image = clipboard.readImage();
    return {
      ...(text === '' ? {} : { text }),
      ...(html === '' ? {} : { html }),
      ...(rtf === '' ? {} : { rtf }),
      ...(image.isEmpty() ? {} : { image }),
    };
  };

  // Wispr's text gone means someone copied something since: theirs stays.
  const restoreIfStillHolds = (wisprText: string) => {
    const content = saved;
    saved = undefined;
    timer = undefined;
    if (content === undefined) return;
    if (clipboard.readText() !== wisprText) return;
    clipboard.write(content);
  };

  const capture = () => {
    if (saved === undefined) saved = read();
  };

  const scheduleRestore = (pastedText: string) => {
    if (timer !== undefined) deps.clearTimer(timer);
    timer = deps.setTimer(() => restoreIfStillHolds(pastedText), deps.restoreDelayMs);
  };

  return {
    paste(text, send) {
      capture();
      const request = send();
      const restoreLater = () => scheduleRestore(text);
      // a failed request still may have put the text on the clipboard; its rejection is the caller's to handle
      void request.then(restoreLater, restoreLater);
      return request;
    },
    copy(send) {
      capture();
      const request = send();
      const forget = () => {
        saved = undefined;
      };
      void request.then((answer) => restoreIfStillHolds(answer.selectedText), forget);
      return request;
    },
  };
}
