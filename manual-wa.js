/**
 * AR WhatsApp Group Message Forwarder — built-in UI engine.
 *
 * Drives WhatsApp Web the way a person does (no WhatsApp internals needed):
 *   - shows the login QR from the page itself
 *   - opens a chat by clicking its row in the chat list (real mouse click)
 *   - types the text into the message box and presses Enter
 *   - watches the open source chat for new incoming text messages
 *
 * The text is typed exactly as given: no prefix, no suffix, no trimming.
 * Media (image / PDF / video / audio / sticker) is never reported.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class ManualWa extends EventEmitter {
  constructor(opts) {
    super();
    this.userData = opts.userData;
    this.onState = opts.onState || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.onMessage = opts.onMessage || (() => {});
    this.browser = null;
    this.page = null;
    this.watchTimer = null;
    this.seen = new Set();
    this.sourceName = null;
    this.busy = false;
  }

  async start() {
    const puppeteer = require('puppeteer');
    const profileDir = path.join(this.userData, 'ui_session');
    fs.mkdirSync(profileDir, { recursive: true });

    this.browser = await puppeteer.launch({
      headless: true,
      userDataDir: profileDir,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,900'
      ]
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || (await this.browser.newPage());
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await this.page.setViewport({ width: 1280, height: 900 });

    this.onState({ status: 'loading' });
    await this.page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    this._loop();
  }

  async _loop() {
    let qrShown = false;
    let ready = false;

    for (let i = 0; i < 4000; i++) {
      if (!this.page) return;
      let snap;
      try {
        snap = await this.page.evaluate(() => ({
          canvas: !!document.querySelector('canvas'),
          loggedIn: !!document.querySelector('#pane-side')
        }));
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (snap.canvas && !snap.loggedIn && !qrShown) {
        qrShown = true;
        const dataUrl = await this._qrDataUrl();
        this.onState({ status: 'qr', qr: dataUrl });
        this.onLog('QR code ready – scan it with WhatsApp on your phone.', 'warn');
      } else if (snap.canvas && !snap.loggedIn && qrShown && i % 12 === 0) {
        const dataUrl = await this._qrDataUrl();
        if (dataUrl) this.onState({ status: 'qr', qr: dataUrl });
      }

      if (snap.loggedIn && !ready) {
        ready = true;
        this.onState({ status: 'ready', info: { pushname: 'WhatsApp Web' } });
        this.onLog('WhatsApp connected (built-in engine).');
        this._startWatching();
      }

      if (!snap.loggedIn && ready) {
        ready = false;
        this.onState({ status: 'loading' });
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async _qrDataUrl() {
    try {
      const canvas = await this.page.$('canvas');
      if (!canvas) return null;
      const box = await canvas.boundingBox();
      if (!box || box.width < 100) return null;
      const buf = await canvas.screenshot({ encoding: 'base64' });
      return 'data:image/png;base64,' + buf;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- helpers
  /** names of chats currently visible in the chat list */
  async _listNames() {
    return this.page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('#pane-side span[title]').forEach((s) => {
        const t = s.getAttribute('title');
        if (t) set.add(t);
      });
      return [...set];
    });
  }

  /** real mouse click on the chat row with this exact name */
  async _clickRow(name) {
    const box = await this.page.evaluate((nm) => {
      const els = [...document.querySelectorAll('#pane-side span[title]')];
      const el = els.find((s) => s.getAttribute('title') === nm);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
    }, name);
    if (!box) return false;
    await this.page.mouse.click(box.x, box.y);
    await new Promise((r) => setTimeout(r, 1800));
    return true;
  }

  /** type into the search box to find a chat that is not visible */
  async _searchAndClick(name) {
    const search = await this.page.evaluate(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => !e.closest('footer'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!search) return false;

    await this.page.mouse.click(search.x, search.y);
    await new Promise((r) => setTimeout(r, 300));
    await this.page.keyboard.down('Control');
    await this.page.keyboard.press('A');
    await this.page.keyboard.up('Control');
    await this.page.keyboard.press('Backspace');
    await this.page.keyboard.type(name, { delay: 25 });
    await new Promise((r) => setTimeout(r, 2000));

    const ok = await this._clickRow(name);
    // clear the search box again
    try {
      const s2 = await this.page.evaluate(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => !e.closest('footer'));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (s2) {
        await this.page.mouse.click(s2.x, s2.y);
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('A');
        await this.page.keyboard.up('Control');
        await this.page.keyboard.press('Backspace');
        await this.page.keyboard.press('Escape');
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
    return this.page.evaluate(() => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2, aria: el.getAttribute('aria-label') };
    });
  }

  // ---------------------------------------------------------------- groups
  async groups() {
    if (!this.page) throw new Error('WhatsApp is not connected yet.');
    const names = await this._listNames();
    return names.map((n) => ({ id: n, name: n })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------------------------------------------------------------- sending
  async sendToGroup(name, text) {
    if (!this.page) throw new Error('WhatsApp is not connected yet.');
    this.busy = true;
    try {
      const opened = await this._openChat(name);
      if (!opened) throw new Error('Chat not found: ' + name);

      const box = await this._messageBox();
      if (!box) throw new Error('Message box not found (chat did not open).');
      if (box.aria && !box.aria.toLowerCase().includes(name.toLowerCase().slice(0, 8))) {
        // a different chat is open – try once more
        const again = await this._openChat(name);
        if (!again) throw new Error('Could not open chat: ' + name);
        await new Promise((r) => setTimeout(r, 1500));
      }

      await this.page.mouse.click(box.x, box.y);
      await new Promise((r) => setTimeout(r, 300));
      // clear the composer completely before typing
      for (let k = 0; k < 2; k++) {
        await this.page.keyboard.down('Control');
        await this.page.keyboard.press('A');
        await this.page.keyboard.up('Control');
        await this.page.keyboard.press('Backspace');
        await new Promise((r) => setTimeout(r, 150));
      }

      // Type line by line: Shift+Enter starts a new line inside the message,
      // a bare Enter would send it. Nothing is added to the text.
      const lines = String(text).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length) await this.page.keyboard.sendCharacter(lines[i]);
        if (i < lines.length - 1) {
          await this.page.keyboard.down('Shift');
          await this.page.keyboard.press('Enter');
          await this.page.keyboard.up('Shift');
          await new Promise((r) => setTimeout(r, 40));
        }
      }
      await new Promise((r) => setTimeout(r, 400));
      const composer = await this.page.evaluate(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
        if (!el) return null;
        const blocks = [];
        for (const c of el.childNodes) {
          if (c.nodeType === 3) { blocks.push(c.nodeValue); continue; }
          if (c.nodeName === 'BR') { blocks.push('\n'); continue; }
          if (c.querySelector && c.querySelector('span, div, br')) { blocks.push(c.innerText || ''); continue; }
          blocks.push(c.textContent || '');
        }
        const pieces = blocks.filter((b) => b !== '').map((b) => b.replace(/\n+$/, ''));
        return pieces.length ? pieces.join('\n') : el.innerText;
      });
      if (composer !== null && composer.replace(/\n+$/, '') !== String(text).replace(/\n+$/, '')) {
        // last resort: set the text directly, then let WhatsApp normalise it
        await this.page.evaluate((t) => {
          const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
          el.focus();
          document.execCommand('selectAll', false, null);
          const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          document.execCommand('insertHTML', false, t.split('\n').map(esc).join('<br>'));
        }, String(text));
        await new Promise((r) => setTimeout(r, 400));
      }

      await this.page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- watching
  setSourceName(name) {
    this.sourceName = name;
    this._startWatching();
  }

  _startWatching() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this._pollSource().catch(() => {}), 1500);
  }

  /** read (without consuming) the newest message of a chat – used by the diagnostics button */
  async lastSourceSnapshot(name) {
    if (!this.page || !name) return null;
    let opened = await this._openChat(name);
    if (!opened) return null;
    await new Promise((r) => setTimeout(r, 2000));
    // make sure the requested chat really is the open one before reading
    for (let i = 0; i < 4; i++) {
      const aria = await this.page.evaluate(() => {
        const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
        return el ? el.getAttribute('aria-label') || '' : '';
      });
      if (aria.toLowerCase().includes(String(name).toLowerCase().slice(0, 10))) break;
      opened = await this._openChat(name);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return this._readLast();
  }

  /** read the newest message in the currently open chat */
  async _readLast() {
    return this.page.evaluate(() => {
      const msgs = [...document.querySelectorAll('[data-id]')].filter((e) => e.querySelector('[data-pre-plain-text]'));
      const el = msgs[msgs.length - 1];
      if (!el) return null;
      const meta = el.querySelector('[data-pre-plain-text]').getAttribute('data-pre-plain-text') || '';
      const own = /\bYou\s*:|আপনি\s*:/.test(meta);
      const media = !!el.querySelector('img[src^="blob:"], video, audio, [data-testid="media-container"], [data-icon="document"], [data-icon="sticker"], [data-icon="image"], [data-icon="video"], [data-icon="audio-play"]');

      const body = el.querySelector('span[data-testid="selectable-text"], span.selectable-text.copyable-text') || el;

      // WhatsApp renders every line as a block element whose text node ends with "\n".
      // Walking the text nodes therefore gives exactly one "\n" per line break —
      // innerText adds extra ones (block spacing), which is what made the gaps.
      const blocks = [];
      for (const c of body.childNodes) {
        if (c.nodeType === 3) { blocks.push(c.nodeValue); continue; }
        if (c.nodeName === 'BR') { blocks.push('\n'); continue; }
        if (c.querySelector && c.querySelector('span, div, br')) { blocks.push(c.innerText || ''); continue; }
        blocks.push(c.textContent || '');
      }
      const pieces = blocks.filter((b) => b !== '').map((b) => b.replace(/\n+$/, ''));
      let text = pieces.length ? pieces.join('\n') : body.innerText || '';

      // drop a leading "You" / "আপনি" and a trailing clock time if they came along
      const lines = text.split('\n');
      if (lines.length && /^(You|আপনি)$/.test(lines[0].trim())) lines.shift();
      if (lines.length && /^\d{1,2}:\d{2}\s*(AM|PM|am|pm)?$/.test(lines[lines.length - 1].trim())) lines.pop();
      text = lines.join('\n');

      return { id: el.getAttribute('data-id'), meta, own, media, text };
    });
  }

  /** open the source chat so its messages are on screen, then read the newest incoming one */
  async _pollSource() {
    if (!this.page || !this.sourceName || this.busy) return;

    let open = await this.page.evaluate((nm) => {
      const el = [...document.querySelectorAll('[contenteditable="true"]')].find((e) => e.closest('footer'));
      const aria = el ? el.getAttribute('aria-label') || '' : '';
      return aria.toLowerCase().includes(nm.toLowerCase().slice(0, 12));
    }, this.sourceName);

    if (!open) {
      open = await this._openChat(this.sourceName);
      if (!open) return;
      await new Promise((r) => setTimeout(r, 1500));
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

  async stop() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    try { if (this.browser) await this.browser.close(); } catch (e) {}
    this.browser = null;
    this.page = null;
  }
}

module.exports = { ManualWa };
