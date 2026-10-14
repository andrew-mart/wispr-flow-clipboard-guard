# wispr-flow-clipboard-guard

A patch for [Wispr Flow](https://wisprflow.ai) on Windows: dictation sometimes pastes **what was on the clipboard
before** instead of the words just dictated. This patch makes the paste reliable while still giving you your
clipboard back afterwards.

Unofficial; not affiliated with or endorsed by Wispr. It edits the app's files on your machine — read
[What it changes](#what-it-changes) and [Undo](#undo) first.

## The symptom

You dictate, stop, and the text box receives your previous clipboard — an earlier copied line, or a screenshot
attached as an image. It happens now and then, mostly in a browser tab that is busy (a page rendering a long,
streaming answer), and practically never in fast native apps.

## Why it happens

Wispr Flow pastes through its native `Wispr Flow Helper.exe`:

1. it puts the dictated text on the clipboard with *delayed rendering* — the data is produced only when someone
   asks for it;
2. it presses Ctrl+V in the target app;
3. it treats **the first request for that data, from any process**, as "the paste happened" and restores the
   previous clipboard a moment later.

Any program that reads the clipboard on every change answers step 3 before the target does. ESET Security's
Safe Banking & Browsing (`eOppFrame.exe`) reads it about 15 ms after each change, and it does so even when the
feature is paused. Formats such as `ExcludeClipboardContentFromMonitorProcessing` do not stop it. A fast target
still reads the text in time. A browser whose page is busy handles Ctrl+V later, after the Helper has already
put the old clipboard back.

The Helper has a server-side feature flag, `disable-clipboard-restore`, that turns step 3 off, but there is no
setting for it in the app.

## What it changes

The patch edits one file, `.webpack/main/index.js`, inside `resources/app.asar` of the newest installed version
(`%LOCALAPPDATA%\WisprFlow\app-X.Y.Z`):

- every feature-flag update sent to the Helper carries `disable-clipboard-restore` enabled, so the Helper no
  longer restores the clipboard on the first read;
- the Helper's `PasteText` request is wrapped: the clipboard is captured before the paste and put back
  **1.5 s after the Helper answers** — unless something else has been copied in the meantime;
- the Helper's `GetSelectedTextViaCopy` request (used by Polish) is wrapped the same way, restoring right after
  the answer.

What is captured and restored: plain text, HTML, RTF and images. A copied list of files is not restored, because
Electron's clipboard API cannot write it back.

Before writing, the patcher checks two things. It refuses if Electron's embedded asar integrity validation fuse
is on, since the app would then refuse the edited archive. It also refuses if the Helper requests above do not
each occur exactly once, which means the build has changed and the patch needs updating. The edits are anchored on
the Helper request names, not on minified identifiers; the update from 1.6.1102 to 1.6.1147 did not break them.

Tested on Wispr Flow 1.6.1102 and 1.6.1147.

## Use

Requires Windows and Node.js 22.6 or newer. Running the patch needs no `npm install`.

```
git clone https://github.com/andrew-mart/wispr-flow-clipboard-guard
cd wispr-flow-clipboard-guard
npm run apply -- --restart
```

`--restart` stops Wispr Flow if it is running from the version being patched, since `app.asar` is locked while it
runs, and starts it again afterwards. Without it the patcher refuses to touch a running version.

**Run it again after every Wispr Flow update.** Squirrel installs each update into a new `app-X.Y.Z` folder with an
unpatched `app.asar`. Running it on an already patched version does nothing.

## Undo

The original archive is kept next to the patched one. Quit Wispr Flow, then:

```
cd %LOCALAPPDATA%\WisprFlow\app-X.Y.Z\resources
copy /Y app.asar.before-clipboard-guard app.asar
```

Updating Wispr Flow also undoes the patch, because the new version comes with its own `app.asar`.

## Develop

```
npm install
npm test
npm run typecheck
```

- `src/clipboard-guard.ts` is the code injected into Wispr Flow. Its source is taken with `toString()`, so it must
  not refer to anything outside itself.
- `src/patch-main-bundle.ts` holds the edits to `index.js`.
- `src/asar.ts` reads and replaces a file inside an asar archive.
- `src/apply.ts` is the command-line entry point.

## License

MIT. Wispr Flow is a product of Wispr AI; this project ships none of its code apart from three call expressions
used as test fixtures.
