# Echo for Obsidian

Paste a YouTube link, get a note: the transcript plus a faithful AI digest,
filed in your vault.

The plugin does **no AI and holds no keys**. It talks to a running Echo over
HTTP, which is where transcript fetching, Whisper, the digest prompt and the
provider seam already live. That keeps one implementation of the part that
matters and makes this a thin client.

## Install (manual, until it is in the community list)

Copy `manifest.json`, `main.js` and `styles.css` into:

```
<your vault>/.obsidian/plugins/echo-reader/
```

Then **Settings → Community plugins → Reload**, and enable **Echo**.

Start Echo separately (`npm start` in the repo), then check
**Settings → Echo → Test connection**.

## Use

Two commands, both from the palette:

- **Echo: Read a YouTube video** — prompts for a URL, pre-filled from the
  clipboard if it already holds a video link.
- **Echo: Read the YouTube link in the selection** — for a link already in a note.

The note lands in the configured folder as `<slug>-<videoId>.md`, with
frontmatter (`title`, `url`, `videoId`, `channel`, `tags`, `summary`, `savedAt`),
the digest, and optionally the full transcript.

## Settings

| setting | what it does |
|---|---|
| Echo server | where Echo runs. `http://localhost:8000` by default |
| Folder | vault folder for new notes; created if missing |
| How much | Gist / Digest / Everything — the same fidelity dial the app has |
| Language | digest language, whatever language the video is in |
| Include the full transcript | longer notes, but the vault becomes searchable on anything said |
| Open the note when ready | jump straight to it |

## Design notes

**It matches `/api/vault/sync`.** Note filename, frontmatter keys and section
order mirror the server's `markdown.js`, so a vault fed by both the plugin and
folder-sync gets one consistent format — and one file per video, not two. A test
asserts that parity, and it has already earned its place: it caught a real bug in
the server's summary extraction.

**`requestUrl`, not `fetch`.** Obsidian's helper bypasses CORS, which a call from
the app to `localhost` would otherwise trip.

**Echo's error hints are surfaced verbatim.** They are written for humans and are
the useful half of the message ("Open Settings → Transcription and download a
model"), so a failure gives you the next step rather than a dead end.

**No build step.** Plain CommonJS `main.js`, matching the rest of the repo —
nothing to compile, nothing to keep in sync with a bundler config.

## Testing

`tests/obsidian-plugin.test.js` (in the main suite, `npm test`) loads the real
`main.js` with `require('obsidian')` redirected to a stub, points it at a
stand-in Echo, and runs the actual command path: note contents, folder creation,
re-read-updates-in-place, the fidelity mapping, and the failure paths.

⚠️ What that does **not** cover: whether Obsidian's real API behaves like the
stub, and anything visual. **This plugin has never been run inside Obsidian.**
Before publishing it anywhere, install it in a vault and read a real video.
