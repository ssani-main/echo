// Echo for Obsidian — paste a YouTube link, get a note with the transcript and
// a faithful AI digest.
//
// The plugin does no AI and holds no keys. It talks to a running Echo over
// HTTP, which is where the transcript fetching, Whisper, the digest prompt and
// the provider seam already live. That keeps one implementation of the thing
// that matters and makes this file a thin client.
//
// Plain CommonJS, no build step — matching the rest of the repo. Obsidian loads
// main.js directly, so there is no esbuild/rollup stage to keep in sync.

const { Plugin, PluginSettingTab, Setting, Modal, Notice, requestUrl, normalizePath } = require('obsidian');
const { normalizeServer, extractVideoId, buildNote, notePath, fidelityParams } = require('./lib.js');

const DEFAULT_SETTINGS = {
  server: 'http://localhost:8000',
  folder: 'Echo',
  fidelity: 'digest',
  language: 'English',
  includeTranscript: true,
  openAfterCreate: true,
};

/** Ask for a URL, pre-filled from the clipboard when it already holds one. */
class UrlPromptModal extends Modal {
  constructor(app, onSubmit) {
    super(app);
    this.onSubmit = onSubmit;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Read a YouTube video' });

    const input = contentEl.createEl('input', {
      type: 'text',
      cls: 'echo-url-input',
      attr: { placeholder: 'https://www.youtube.com/watch?v=…' },
    });

    // Most of the time the link is already on the clipboard — reading it saves
    // the paste, and it costs nothing when it is not a video URL.
    try {
      const clip = await navigator.clipboard.readText();
      if (extractVideoId(clip)) input.value = clip.trim();
    } catch {
      /* clipboard unavailable or denied — just leave it empty */
    }

    const submit = () => {
      const value = input.value.trim();
      if (!value) return;
      this.close();
      this.onSubmit(value);
    };

    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    new Setting(contentEl).addButton((b) =>
      b.setButtonText('Read it').setCta().onClick(submit));

    input.focus();
    input.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = class EchoPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: 'echo-read-youtube-video',
      name: 'Read a YouTube video',
      callback: () => new UrlPromptModal(this.app, (url) => this.readVideo(url)).open(),
    });

    this.addCommand({
      id: 'echo-read-from-selection',
      name: 'Read the YouTube link in the selection',
      editorCallback: (editor) => {
        const selection = (editor.getSelection() || '').trim();
        const id = extractVideoId(selection);
        if (!id) {
          new Notice('Echo: no YouTube link in the selection.');
          return;
        }
        this.readVideo(selection);
      },
    });

    this.addSettingTab(new EchoSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** POST JSON to Echo. requestUrl, not fetch: it bypasses CORS, which a call to localhost from the app would otherwise trip. */
  async post(path, body) {
    const server = normalizeServer(this.settings.server);
    if (!server) throw new Error('Set a valid Echo server address (http:// or https://) in settings.');

    const res = await requestUrl({
      url: `${server}${path}`,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify(body),
      // Handle non-2xx ourselves so Echo's structured error envelope survives
      // instead of being thrown away as a generic request failure.
      throw: false,
    });

    let json = null;
    try { json = res.json; } catch { /* not JSON */ }

    if (res.status < 200 || res.status >= 300) {
      const err = json && json.error;
      const message = err ? `${err.message}${err.hint ? ` — ${err.hint}` : ''}` : `Echo returned HTTP ${res.status}`;
      throw new Error(message);
    }
    return json;
  }

  async readVideo(url) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      new Notice("Echo: that doesn't look like a YouTube link.");
      return;
    }

    const notice = new Notice('Echo: fetching transcript…', 0);
    try {
      const transcript = await this.post('/api/transcript', { url });
      const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
      if (segments.length === 0) throw new Error('Echo returned an empty transcript.');

      notice.setMessage('Echo: writing the digest… (this can take 10-30s)');
      const text = segments.map((s) => s.text || '').join(' ');
      const { format, length } = fidelityParams(this.settings.fidelity);
      const digest = await this.post('/api/digest', {
        text,
        format,
        length,
        language: this.settings.language || 'English',
        title: transcript.title || '',
        videoId: transcript.videoId,
      });

      const path = normalizePath(notePath(this.settings.folder, transcript.title, transcript.videoId));
      await this.ensureFolder(path);

      const markdown = buildNote({
        title: transcript.title || videoId,
        url: transcript.url || url,
        videoId: transcript.videoId,
        channel: transcript.channel,
        digest: digest.digest,
        segments,
        tags: Array.isArray(digest.suggestedTags) ? digest.suggestedTags : [],
        savedAt: new Date().toISOString(),
      }, { includeTranscript: this.settings.includeTranscript });

      // Re-reading the same video should update its note, not pile up copies —
      // the filename is derived from the video id, same as folder-sync.
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) await this.app.vault.modify(existing, markdown);
      else await this.app.vault.create(path, markdown);

      notice.hide();
      new Notice(`Echo: saved "${transcript.title || videoId}"`);

      if (this.settings.openAfterCreate) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) await this.app.workspace.getLeaf(false).openFile(file);
      }
    } catch (err) {
      notice.hide();
      console.error('[echo] plugin error:', err);
      // Echo's hints are written for humans and are the useful half of the
      // message ("Open Settings → Transcription and download a model"), so they
      // are surfaced rather than swallowed. 12s: these are long sentences.
      new Notice(`Echo: ${err.message}`, 12000);
    }
  }

  /** Create the target folder if the vault does not have it yet. */
  async ensureFolder(path) {
    const dir = path.split('/').slice(0, -1).join('/');
    if (!dir) return;
    if (this.app.vault.getAbstractFileByPath(dir)) return;
    try {
      await this.app.vault.createFolder(dir);
    } catch (err) {
      // Racing with another create, or it appeared between the check and here.
      if (!/exists/i.test(String(err && err.message))) throw err;
    }
  }
};

class EchoSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Echo server')
      .setDesc('Where Echo is running. Start it with `npm start` for the default below, or point this at a hosted instance.')
      .addText((t) => t
        .setPlaceholder('http://localhost:8000')
        .setValue(this.plugin.settings.server)
        .onChange(async (v) => { this.plugin.settings.server = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Check that Obsidian can reach Echo.')
      .addButton((b) => b.setButtonText('Test').onClick(async () => {
        const server = normalizeServer(this.plugin.settings.server);
        if (!server) { new Notice('Echo: that address needs to start with http:// or https://'); return; }
        try {
          const res = await requestUrl({ url: `${server}/api/health`, throw: false });
          if (res.status === 200 && res.json && res.json.status === 'ok') {
            new Notice(`Echo: connected (${res.json.mode} mode)`);
          } else {
            new Notice(`Echo: reached the address but got HTTP ${res.status}`);
          }
        } catch (err) {
          new Notice(`Echo: could not reach ${server} — is it running?`, 8000);
        }
      }));

    new Setting(containerEl)
      .setName('Folder')
      .setDesc('Vault folder for new notes. Created if it does not exist.')
      .addText((t) => t
        .setPlaceholder('Echo')
        .setValue(this.plugin.settings.folder)
        .onChange(async (v) => { this.plugin.settings.folder = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('How much')
      .setDesc('How much of the video to keep — the same dial the Echo app has.')
      .addDropdown((d) => d
        .addOption('bullets', 'Gist — the bottom line and the few points worth knowing')
        .addOption('digest', 'Digest — the real substance, reorganised by idea')
        .addOption('article', 'Everything — the whole thing, minus the noise of speech')
        .setValue(this.plugin.settings.fidelity)
        .onChange(async (v) => { this.plugin.settings.fidelity = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Language')
      .setDesc('Language for the digest, whatever language the video is in.')
      .addText((t) => t
        .setPlaceholder('English')
        .setValue(this.plugin.settings.language)
        .onChange(async (v) => { this.plugin.settings.language = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Include the full transcript')
      .setDesc('Append the raw transcript under the digest. Makes notes long, but makes the vault searchable on anything that was said.')
      .addToggle((t) => t
        .setValue(this.plugin.settings.includeTranscript)
        .onChange(async (v) => { this.plugin.settings.includeTranscript = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Open the note when it is ready')
      .addToggle((t) => t
        .setValue(this.plugin.settings.openAfterCreate)
        .onChange(async (v) => { this.plugin.settings.openAfterCreate = v; await this.plugin.saveSettings(); }));
  }
}
