/**
 * AR WA GROUP MESSAGE FORWARD — built-in WhatsApp engine (app window).
 *
 * This is the engine that makes the software work on EVERY Windows 10/11 PC
 * without installing anything: no Chrome, no ChromeDriver, no Puppeteer, no
 * npm. WhatsApp Web runs inside a window of this app, and the app drives that
 * window with real mouse clicks and real keystrokes, the way a person does.
 *
 *   - shows the login QR from the page itself
 *   - opens a chat by clicking its row in the chat list (real mouse click)
 *   - types the text into the message box and presses Enter
 *   - watches the open source chat for new incoming text messages
 *
 * The text is typed exactly as given: no prefix, no suffix, no trimming.
 * Media (image / PDF / video / audio / sticker) is never reported.
 */

const path = require('path');
const fs = require('fs');

class ManualWa {
  constructor(opts) {
    this.userData = opts.userData;
    this.onState = opts.onState || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.onMessage = opts.onMessage || (() => {});

    this.win = null;              // the app's own window showing WhatsApp Web
    this.sourceName = null;
    this.watchTimer = null;
    this.seen = new Set();
    this.busy = false;
    this.qrShown = false;
    this.ready = false;
    this.stopped = false;
    this.lastQrAt = 0;
  }

  // ------------------------------------------------------------- lifecycle
  async start() {
    const { BrowserWindow, session } = require('electron');
    this.stopped = false;

    // WhatsApp's login is kept in the app's own folder
    const partition = 'persist:whatsapp-builtin';
    const waSession = session.fromPartition(partition);
    waSession.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    this.win = new BrowserWindow({
      width: 1180,
      height: 860,
      title: 'WhatsApp — AR WA GROUP MESSAGE FORWARD',
      backgroundColor: '#0b1220',
      autoHideMenuBar: true,
      show: true,
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    this.win.setMenuBarVisibility(false);

    this.win.on('closed', () => {
      this.win = null;
      if (!this.stopped) {
        this.ready = false;
        this.onState({ status: 'stopped' });
      }
    });

    this.onState({ status: 'loading' });
    try {
      await this.win.loadURL('https://web.whatsapp.com/');
    } catch (e) {
      this.onLog('Could not load WhatsApp Web: ' + e.message, 'err');
    }

    this._loop();
    return true;
  }

  /** the WhatsApp page, or null when the window is gone */
  _wc() {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  async _js(code) {
    const wc = this._wc();
    if (!wc) return null;
    try {
      return await wc.executeJavaScript(code, true);
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- QR / state
  async _loop() {
    for (let i = 0; i < 20000 && !this.stopped; i++) {
      const snap = await this._js(`(() => ({
        canvas: !!document.querySelector('canvas'),
        loggedIn: !!document.querySelector('#pane-side')
      }))()`);

      if (snap) {
        if (snap.canvas && !snap.loggedIn) {
          const now = Date.now();
          if (!this.qrShown || now - this.lastQrAt > 12000) {
            const dataUrl = await this._qrDataUrl();
            if (dataUrl) {
              this.qrShown = true;
              this.lastQrAt = now;
              this.onState({ status: 'qr', qr: dataUrl });
              if (!this.ready) this.onLog('QR code ready – scan it with WhatsApp on your phone.', 'warn');
            }
          }
        }

        if (snap.loggedIn && !this.ready) {
          this.ready = true;
          this.qrShown = false;
          this.onState({ status: 'ready', info: { pushname: 'WhatsApp (built-in)' } });
          this.onLog('WhatsApp connected (built-in engine).');
          this._startWatching();
        }

        if (!snap.loggedIn && this.ready) {
          this.ready = false;
          this.onState({ status: 'loading' });
        }
      }

      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  async _qrDataUrl() {
    const wc = this._wc();
    if (!wc) return null;
    try {
      const shot = await wc.capturePage();
      const full = shot.toPNG();
      const box = await this._js(`(() => {
        const c = document.querySelector('canvas');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        if (r.width < 80) return null;
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      if (!box) return 'data:image/png;base64,' + full.toString('base64');

      const cropped = await this._cropPng(full, box);
      return 'data:image/png;base64,' + (cropped || full).toString('base64');
    } catch (e) {
      return null;
    }
  }

  /** crop the QR out of the page screenshot with the page's own canvas */
  async _cropPng(pngBuffer, box) {
    const wc = this._wc();
    if (!wc) return null;
    try {
      const b64 = pngBuffer.toString('base64');
      const out = await wc.executeJavaScript(`(async () => {
        const img = new Image();
        img.src = 'data:image/png;base64,${b64}';
        await img.decode();
        const scale = img.width / window.innerWidth;
        const c = document.createElement('canvas');
        c.width = ${box.w}; c.height = ${box.h};
        const ctx = c.getContext('2d');
        ctx.drawImage(img, ${box.x} * scale, ${box.y} * scale, ${box.w} * scale, ${box.h} * scale, 0, 0, ${box.w}, ${box.h});
        return c.toDataURL('image/png').split(',')[1];
      })()`, true);
      return out ? Buffer.from(out, 'base64') : null;
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- helpers
  /** names of the chats visible in the chat list */
  async groups() {
    const names = await this._js(`(() => {
      const set = new Set();
      document.querySelectorAll('#pane-side span[title]').forEach((s) => {
        const t = s.getAttribute('title');
        if (t) set.add(t);
      });
      return [...set];
    })()`);
    return (names || []).map((n) => ({ id: n, name: n })).sort((a, b) => a.name.localeCompare(b.name));
  }

  _clickAt(x, y) {
    const wc = this._wc();
    if (!wc) return;
    wc.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  }

  _key(keyCode, modifiers = []) {
    const wc = this._wc();
    if (!wc) return;
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  /** real mouse click on the chat row with this exact name */
  async _clickRow(name) {
    const box = await this._js(`(() => {
      const nm = ${JSON.stringify(String(name))};
      const els = [...document.querySelectorAll('#pane-side span[title]')];
      const el = els.find((s) => s.getAttribute('title') === nm);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
    })()`);
    if (!box) return false;
    this._clickAt(box.x, box.y);
    await new Promise((r) => setTimeout(r, 1600));
    return true;
  }

  /** type into the search box to find a chat that is not visible */
  async _searchAndClick(name) {
    if (!this._wc()) return false;
    const search = await this._js(`(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => !e.closest('footer'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!search) return false;

    this._clickAt(search.x, search.y);
    await new Promise((r) => setTimeout(r, 250));
    this._key('A', ['control']);
    this._key('Backspace');
    const wc = this._wc();
    if (wc) wc.insertText(String(name));
    await new Promise((r) => setTimeout(r, 1900));

    const ok = await this._clickRow(name);

    try {
      const s2 = await this._js(`(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => !e.closest('footer'));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (s2) {
        this._clickAt(s2.x, s2.y);
        this._key('A', ['control']);
        this._key('Backspace');
        this._key('Escape');
      }
    } catch (e) { /* ignore */ }
    return ok;
  }

  async _openChat(name) {
    if (await this._clickRow(name)) return true;
    return this._searchAndClick(name);
  }

  /** the message box of the currently open chat */
  async _messageBox() {
    return this._js(`(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2, aria: el.getAttribute('aria-label') };
    })()`);
  }

  // ------------------------------------------------------------- sending
  async sendToGroup(name, text) {
    if (!this._wc()) throw new Error('WhatsApp is not open. Press Connect WhatsApp first.');
    this.busy = true;
    try {
      const opened = await this._openChat(name);
      if (!opened) throw new Error('Chat not found: ' + name);

      const box = await this._messageBox();
      if (!box) throw new Error('Message box not found (chat did not open).');
      if (box.aria && !box.aria.toLowerCase().includes(String(name).toLowerCase().slice(0, 8))) {
        const again = await this._openChat(name);
        if (!again) throw new Error('Could not open chat: ' + name);
        await new Promise((r) => setTimeout(r, 1400));
      }

      this._clickAt(box.x, box.y);
      await new Promise((r) => setTimeout(r, 250));
      // clear the message box completely before typing
      for (let k = 0; k < 2; k++) {
        this._key('A', ['control']);
        this._key('Backspace');
        await new Promise((r) => setTimeout(r, 120));
      }

      // Type line by line: Shift+Enter starts a new line inside the message,
      // a bare Enter would send it. Nothing is added to the text.
      const wc = this._wc();
      const lines = String(text).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length && wc) wc.insertText(lines[i]);
        if (i < lines.length - 1) {
          this._key('Enter', ['shift']);
          await new Promise((r) => setTimeout(r, 35));
        }
      }
      await new Promise((r) => setTimeout(r, 250));

      // the message box must not be empty before Enter is pressed
      const typed = await this._js(`(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
        return el ? el.innerText : null;
      })()`);
      if (typed !== null && typed.replace(/\u00a0/g, ' ').trim() === '') {
        throw new Error('The message box stayed empty – message not sent.');
      }

      this._key('Enter');
      await new Promise((r) => setTimeout(r, 700));
      return true;
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------- watching
  setSourceName(name) {
    const changed = this.sourceName !== (name || null);
    this.sourceName = name || null;
    if (changed && this.ready) this.onLog('Source group: ' + (this.sourceName || '(none selected)'));
  }

  _startWatching() {
    if (!this.watchingLogged) { this.watchingLogged = true; this.onLog('Watching the source group for new messages.'); }
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this._pollSource().catch(() => {}), 1500);
  }

  /** read the newest message in the currently open chat */
  async _readLast() {
    return this._js(`(() => {
      const msgs = [...document.querySelectorAll('[data-id]')].filter((e) => e.querySelector('[data-pre-plain-text]'));
      const el = msgs[msgs.length - 1];
      if (!el) return null;
      const meta = el.querySelector('[data-pre-plain-text]').getAttribute('data-pre-plain-text') || '';
      const own = /\\bYou\\s*:|আপনি\\s*:/.test(meta);
      const media = !!el.querySelector('img[src^="blob:"], video, audio, [data-testid="media-container"], [data-icon="document"], [data-icon="sticker"], [data-icon="image"], [data-icon="video"], [data-icon="audio-play"]');

      const body = el.querySelector('span[data-testid="selectable-text"], span.selectable-text.copyable-text') || el;

      // WhatsApp renders every line as a block element whose text node ends with "\\n".
      // Walking the nodes gives exactly one "\\n" per line break; innerText adds extra
      // ones (block spacing), which is what makes the gaps.
      const blocks = [];
      for (const c of body.childNodes) {
        if (c.nodeType === 3) { blocks.push(c.nodeValue); continue; }
        if (c.nodeName === 'BR') { blocks.push('\\n'); continue; }
        if (c.querySelector && c.querySelector('span, div, br')) { blocks.push(c.innerText || ''); continue; }
        blocks.push(c.textContent || '');
      }
      const pieces = blocks.filter((b) => b !== '').map((b) => b.replace(/\\n+$/, ''));
      let text = pieces.length ? pieces.join('\\n') : body.innerText || '';

      // drop a leading "You" / "আপনি" and a trailing clock time if they came along
      const lines = text.split('\\n');
      if (lines.length && /^(You|আপনি)$/.test(lines[0].trim())) lines.shift();
      if (lines.length && /^\\d{1,2}:\\d{2}\\s*(AM|PM|am|pm)?$/.test(lines[lines.length - 1].trim())) lines.pop();
      text = lines.join('\\n');

      return { id: el.getAttribute('data-id'), meta, own, media, text };
    })()`);
  }

  /** open the source chat so its messages are on screen, then read the newest incoming one */
  async _pollSource() {
    if (!this._wc() || !this.sourceName || this.busy) return;

    const open = await this._js(`(() => {
      const nm = ${JSON.stringify(String(this.sourceName || ''))};
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
      const aria = el ? el.getAttribute('aria-label') || '' : '';
      return aria.toLowerCase().includes(nm.toLowerCase().slice(0, 12));
    })()`);

    if (!open) {
      const ok = await this._openChat(this.sourceName);
      if (!ok) return;
      await new Promise((r) => setTimeout(r, 1400));
    }

    const snap = await this._readLast();
    if (!snap || !snap.text) return;
    if (snap.own) return;                       // our own message – never forward
    if (snap.media) return;                     // pictures / PDFs / video / audio – never forward
    if (snap.id && this.seen.has(snap.id)) return;
    if (snap.id) this.seen.add(snap.id);

    this.onMessage({
      id: snap.id,
      from: this.sourceName,
      body: snap.text,
      type: 'chat',
      hasMedia: false,
      fromMe: false
    });
  }

  /** bring the WhatsApp window to the front */
  focus() {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.focus();
    }
  }

  async stop() {
    this.stopped = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.ready = false;
    try {
      if (this.win && !this.win.isDestroyed()) this.win.destroy();
    } catch (e) { /* ignore */ }
    this.win = null;
  }
}

module.exports = { ManualWa };
