/**
 * AR WhatsApp Group Message Forwarder — WhatsApp engine
 * ----------------------------------------------------
 * Two engines are tried in order:
 *   1) whatsapp-web.js (fast, event based)
 *   2) built-in UI engine (works when WhatsApp changes its internal modules)
 *
 * In BOTH engines the text is sent exactly as received:
 *   no prefix, no suffix, no trimming, no reformatting.
 *   Emoji, digits and line breaks stay identical.
 * Only plain text is forwarded; images, PDFs, videos, audio and stickers
 * are dropped before they ever reach the forwarder.
 */

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class WaEngine extends EventEmitter {
  constructor(opts) {
    super();
    this.userData = opts.userData;
    this.sessionDir = path.join(opts.userData, 'wwebjs_auth');
    this.client = null;
    this.engine = null;
    this.state = 'stopped';
    this.info = null;
    this.qr = null;
    this.manual = null; // manual UI-mode client
  }

  status() {
    return { status: this.state, info: this.info, qr: this.qr, engine: this.engine };
  }

  _set(state, extra = {}) {
    this.state = state;
    this.emit('state', { ...this.status(), ...extra });
  }

  async start() {
    if (['loading', 'qr', 'authenticated', 'ready'].includes(this.state)) return this.status();
    this._set('loading');
    fs.mkdirSync(this.sessionDir, { recursive: true });

    // ---- engine 1: built-in window engine (works on every PC) ----------
    // WhatsApp Web runs in the app's own window: no Chrome, no ChromeDriver,
    // no npm, nothing to install on the computer.
    try {
      await this._startBuiltIn();
      return this.status();
    } catch (e) {
      this.emit('log', { msg: 'Built-in WhatsApp window failed: ' + e.message, level: 'err' });
    }

    // ---- engine 2: whatsapp-web.js (fallback) --------------------------
    try {
      const ok = await this._startWweb();
      if (ok) return this.status();
    } catch (e) {
      this.emit('log', { msg: 'Standard engine failed: ' + e.message, level: 'warn' });
    }

    // ---- engine 3: puppeteer UI engine (last resort) -------------------
    try {
      await this._startManual();
    } catch (e) {
      this._set('error');
      this.emit('log', { msg: 'Could not start WhatsApp: ' + e.message, level: 'err' });
    }
    return this.status();
  }

  // =========================================================================
  // Engine 1 — whatsapp-web.js
  // =========================================================================
  async _startWweb() {
    let Client, LocalAuth, QRCode;
    try {
      const wweb = require('whatsapp-web.js');
      Client = wweb.Client;
      LocalAuth = wweb.LocalAuth;
      QRCode = require('qrcode');
    } catch (e) {
      return false;
    }

    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: this.sessionDir }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows'
        ]
      },
      takeoverOnConflict: false,
      deviceName: 'AR WhatsApp Forwarder'
    });

    this.client = client;
    this.engine = 'wweb';

    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (!settled) { settled = true; resolve(val); }
      };

      client.on('qr', async (qr) => {
        try { this.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 }); } catch (e) { this.qr = null; }
        this._set('qr');
        done(true);
      });

      client.on('authenticated', () => { this._set('authenticated'); done(true); });

      client.on('auth_failure', (m) => {
        this.emit('log', { msg: 'Login failed: ' + String(m || ''), level: 'err' });
        this._set('auth_failure');
        done(false);
      });

      client.on('loading_screen', (percent, message) => {
        this.emit('loading', { percent, message });
      });

      client.on('ready', async () => {
        try {
          this.info = { pushname: client.info.pushname, number: client.info.wid.user };
        } catch (e) { this.info = null; }
        this._set('ready');
        this.emit('log', { msg: 'WhatsApp connected (standard engine).' });
        done(true);
      });

      client.on('disconnected', (reason) => {
        this._set('disconnected');
        this.emit('log', { msg: 'WhatsApp disconnected: ' + reason, level: 'err' });
      });

      client.on('message', (msg) => this.emit('message', this._fromWweb(msg)));

      client.initialize().catch((e) => {
        this.emit('log', { msg: 'Standard engine could not start: ' + e.message, level: 'warn' });
        this._set('loading');
        done(false);
      });

      // give up on engine 1 after 45 s of silence and switch to engine 2
      setTimeout(() => {
        if (!settled) {
          this.emit('log', { msg: 'Standard engine did not respond — switching to the built-in engine.', level: 'warn' });
          try { client.destroy(); } catch (e) {}
          this.client = null;
          done(false);
        }
      }, 45000);
    });
  }

  _fromWweb(msg) {
    return {
      id: msg.id && msg.id._serialized ? msg.id._serialized : `${msg.timestamp}:${msg.from}`,
      from: msg.from,
      body: msg.body,
      type: msg.type,
      hasMedia: !!msg.hasMedia,
      fromMe: !!msg.fromMe
    };
  }

  // =========================================================================
  // Engine 2 — built-in UI engine (no WhatsApp internals needed)
  // =========================================================================
  async _startBuiltIn() {
    const { ManualWa } = require('./manual-wa-app');
    this.engine = 'builtin';
    this.manual = new ManualWa({
      userData: this.userData,
      onState: (s) => {
        if (s.status) this.state = s.status;
        if (s.qr !== undefined) this.qr = s.qr;
        if (s.info !== undefined) this.info = s.info;
        this.emit('state', this.status());
      },
      onLog: (msg, level) => this.emit('log', { msg, level }),
      onMessage: (m) => this.emit('message', m)
    });
    await this.manual.start();
  }

  async _startManual() {
    const { ManualWa } = require('./manual-wa');
    this.engine = 'ui';
    this.manual = new ManualWa({
      userData: this.userData,
      onState: (s) => {
        if (s.status) this.state = s.status;
        if (s.qr !== undefined) this.qr = s.qr;
        if (s.info !== undefined) this.info = s.info;
        this.emit('state', this.status());
      },
      onLog: (msg, level) => this.emit('log', { msg, level }),
      onMessage: (m) => this.emit('message', m)
    });
    await this.manual.start();
  }

  // =========================================================================
  // Shared API
  // =========================================================================
  async groups() {
    if ((this.engine === 'ui' || this.engine === 'builtin') && this.manual) return this.manual.groups();
    if (!this.client) throw new Error('WhatsApp is not connected yet.');
    const chats = await this.client.getChats();
    return chats
      .filter((c) => c.isGroup)
      .map((c) => ({ id: c.id._serialized, name: c.name || c.id._serialized }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async sendToGroup(id, text) {
    if ((this.engine === 'ui' || this.engine === 'builtin') && this.manual) return this.manual.sendToGroup(id, text);
    if (!this.client) throw new Error('WhatsApp is not connected yet.');
    const chat = await this.client.getChatById(id);
    await chat.sendMessage(text);   // text passed through untouched
    return true;
  }

  async stop() {
    try { if (this.manual) await this.manual.stop(); } catch (e) {}
    try { if (this.client) await this.client.destroy(); } catch (e) {}
    this.manual = null;
    this.client = null;
    this.qr = null;
    this.info = null;
    this._set('stopped');
  }
}

module.exports = { WaEngine };
