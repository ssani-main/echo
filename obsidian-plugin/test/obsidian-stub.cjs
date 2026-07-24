// Minimal stand-in for Obsidian's plugin API, enough to load and drive main.js
// outside the app. Only what main.js actually touches is implemented — this is
// a test fixture, not a reimplementation of Obsidian.
//
// The vault is a real Map with real path semantics, so note creation, the
// update-instead-of-duplicate path, and folder creation are genuinely
// exercised rather than mocked away.

const http = require('node:http');

class Notice {
  constructor(message) { this.message = message; Notice.log.push(message); }
  setMessage(message) { this.message = message; Notice.log.push(message); }
  hide() { this.hidden = true; }
}
Notice.log = [];

/** Chainable no-op that records what a settings tab declared. */
class Setting {
  constructor(containerEl) { this.containerEl = containerEl; Setting.built.push(this); }
  setName(n) { this.name = n; return this; }
  setDesc(d) { this.desc = d; return this; }
  addText(fn) { fn(textLike()); return this; }
  addButton(fn) { fn(buttonLike()); return this; }
  addToggle(fn) { fn(toggleLike()); return this; }
  addDropdown(fn) { fn(dropdownLike()); return this; }
}
Setting.built = [];

const textLike = () => {
  const o = {};
  o.setPlaceholder = () => o; o.setValue = () => o; o.onChange = () => o;
  return o;
};
const buttonLike = () => {
  const o = {};
  o.setButtonText = () => o; o.setCta = () => o; o.onClick = (fn) => { o.click = fn; return o; };
  return o;
};
const toggleLike = () => {
  const o = {};
  o.setValue = () => o; o.onChange = () => o;
  return o;
};
const dropdownLike = () => {
  const o = {};
  o.addOption = () => o; o.setValue = () => o; o.onChange = () => o;
  return o;
};

class Plugin {
  constructor(app) {
    this.app = app;
    this.commands = [];
    this._data = {};
  }
  addCommand(cmd) { this.commands.push(cmd); }
  addSettingTab() { /* not exercised here */ }
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; }
}

class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {} }; }
}

class Modal {
  constructor(app) { this.app = app; this.contentEl = { empty() {} }; }
  open() {}
  close() {}
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

/** Obsidian's CORS-free HTTP helper, backed by node:http here. */
function requestUrl(options) {
  const opts = typeof options === 'string' ? { url: options } : options;
  const url = new URL(opts.url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || 'GET',
      headers: opts.contentType ? { 'Content-Type': opts.contentType } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        const result = { status: res.statusCode, text, json };
        if (opts.throw !== false && (res.statusCode < 200 || res.statusCode >= 300)) {
          reject(new Error(`Request failed, status ${res.statusCode}`));
          return;
        }
        resolve(result);
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** A vault that actually stores files, so path logic is really tested. */
function makeApp() {
  const files = new Map();   // path -> { path, contents }
  const folders = new Set();

  const vault = {
    files,
    folders,
    getAbstractFileByPath(path) {
      if (files.has(path)) return files.get(path);
      if (folders.has(path)) return { path, isFolder: true };
      return null;
    },
    async create(path, contents) {
      if (files.has(path)) throw new Error('File already exists');
      const file = { path, contents };
      files.set(path, file);
      return file;
    },
    async modify(file, contents) {
      file.contents = contents;
      files.set(file.path, file);
    },
    async createFolder(path) {
      if (folders.has(path)) throw new Error('Folder already exists');
      folders.add(path);
    },
  };

  const opened = [];
  const workspace = {
    opened,
    getLeaf() { return { async openFile(file) { opened.push(file.path); } }; },
  };

  return { vault, workspace };
}

module.exports = {
  Plugin, PluginSettingTab, Setting, Modal, Notice, requestUrl, normalizePath,
  __test: { makeApp },
};
