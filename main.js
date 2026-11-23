/**
 * AR WhatsApp Group Message Forwarder
 * -----------------------------------
 * Source group -> one or many target groups.
 * The text is sent EXACTLY as received: no prefix, no suffix, no trimming,
 * no reformatting. Emoji, digits and line breaks stay identical.
 * Images / PDFs / videos / audio / stickers are never forwarded.
 *
 * Schedule: every day, 09:50 -> 16:28 (start inclusive, end exclusive).
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const LOG_FILE = () => path.join(app.getPath('userData'), 'activity.log');

const DEFAULT_SETTINGS = {
  sourceGroup: null,      // { id, name }
  targetGroups: [],       // [{ id, name }]
  schedule: { start: '09:50', end: '16:28' },
  dailyLimit: 0,          // 0 = unlimited
  perGroupDelay: 3,       // seconds between two target groups
  forwardHistory: [],
  stats: { forwarded: 0, failed: 0, skipped: 0, lastAt: null }
};

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      schedule: { ...DEFAULT_SETTINGS.schedule, ...(parsed.schedule || {}) },
      stats: { ...DEFAULT_SETTINGS.stats, ...(parsed.stats || {}) }
    };
  } catch (e) {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.log('Could not save settings: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let mainWindow = null;

function sendToUi(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function log(msg, level = 'info') {
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE(), line + '\n', 'utf8'); } catch (e) { /* ignore */ }
  sendToUi('log', { msg, level, at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
function hhmmToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function isWithinSchedule(d = new Date()) {
  const start = hhmmToMinutes(settings.schedule.start);
  const end = hhmmToMinutes(settings.schedule.end);
  if (start === null || end === null || start === end) return false;
  const n = d.getHours() * 60 + d.getMinutes();
  if (start < end) return n >= start && n < end;
  return n >= start || n < end;
}

function scheduleText() {
  return `${settings.schedule.start} – ${settings.schedule.end}`;
}

// ---------------------------------------------------------------------------
// WhatsApp engine
// ---------------------------------------------------------------------------
const { WaEngine } = require('./wa-engine');
let engine = null;

function getEngine() {
  if (engine) return engine;
  engine = new WaEngine({ userData: app.getPath('userData') });
  engine.on('state', (s) => {
    sendToUi('wa-state', s);
    if (s.status === 'ready') {
      // give the built-in engine the source group name for watching
      if (engine.manual && settings.sourceGroup) engine.manual.setSourceName(settings.sourceGroup.name);
      refreshGroupNames().catch(() => {});
    }
  });
  engine.on('loading', (l) => sendToUi('loading', l));
  engine.on('log', (l) => log(l.msg, l.level));
  engine.on('message', (msg) => {
    handleIncoming(msg).catch((e) => log('Forward error: ' + e.message, 'err'));
  });
  return engine;
}

async function getGroups() {
  const e = getEngine();
  return e.groups();
}

async function refreshGroupNames() {
  const e = getEngine();
  if (!e || e.state !== 'ready') return;
  try {
    const groups = await e.groups();
    const byId = new Map(groups.map((g) => [g.id, g.name]));
    if (settings.sourceGroup && byId.has(settings.sourceGroup.id)) {
      settings.sourceGroup.name = byId.get(settings.sourceGroup.id);
    }
    settings.targetGroups = settings.targetGroups.map((t) =>
      byId.has(t.id) ? { id: t.id, name: byId.get(t.id) } : t
    );
    saveSettings();
    sendToUi('settings', publicSettings());
  } catch (err) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------
const seenMessageIds = new Set();
let sending = false;
let dayCounter = { day: new Date().toISOString().slice(0, 10), count: 0 };

async function forwardToTargets(body, targets) {
  const e = getEngine();
  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    try {
      await e.sendToGroup(t.id, body);      // body passed through untouched
      results.push({ id: t.id, name: t.name, ok: true });
      log(`Sent to "${t.name}" (${body.length} chars).`);
    } catch (err) {
      results.push({ id: t.id, name: t.name, ok: false, error: err.message });
      log(`Failed for "${t.name}": ${err.message}`, 'err');
    }
    if (i < targets.length - 1) {
      const d = Math.max(0, Number(settings.perGroupDelay) || 0) * 1000;
      if (d > 0) await new Promise((r) => setTimeout(r, d));
    }
  }
  return results;
}

async function handleIncoming(msg) {
  if (msg.type !== 'chat') return;      // images, PDFs, video, audio, stickers blocked
  if (msg.hasMedia) return;
  if (msg.fromMe) return;
  if (!settings.sourceGroup) return;
  if (msg.from !== settings.sourceGroup.id && msg.from !== settings.sourceGroup.name) return;

  const id = msg.id || `${msg.from}:${msg.body}`;
  if (seenMessageIds.has(id)) return;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 5000) seenMessageIds.delete(seenMessageIds.values().next().value);

  if (!isWithinSchedule()) {
    settings.stats.skipped++;
    saveSettings();
    sendToUi('stats', settings.stats);
    log(`Outside schedule (${scheduleText()}) – not forwarded.`, 'warn');
    return;
  }

  if (!settings.targetGroups.length) {
    log('No target group selected – not forwarded.', 'warn');
    return;
  }

  const dk = new Date().toISOString().slice(0, 10);
  if (dayCounter.day !== dk) dayCounter = { day: dk, count: 0 };
  const limit = Number(settings.dailyLimit) || 0;
  if (limit > 0 && dayCounter.count >= limit) {
    settings.stats.skipped++;
    saveSettings();
    sendToUi('stats', settings.stats);
    log(`Daily limit (${limit}) reached – not forwarded.`, 'warn');
    return;
  }

  if (sending) {
    log('Previous forward still in progress – message skipped.', 'warn');
    return;
  }
  sending = true;

  const body = msg.body;                 // original text, untouched
  log(`New message in source group (${body.length} chars). Forwarding…`);
  sendToUi('incoming', { text: body, at: new Date().toISOString() });

  const results = await forwardToTargets(body, settings.targetGroups.slice());

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;

  dayCounter.count++;
  settings.stats.forwarded += ok;
  settings.stats.failed += failed;
  settings.stats.lastAt = new Date().toISOString();

  settings.forwardHistory.unshift({
    at: new Date().toISOString(),
    source: settings.sourceGroup.name,
    targets: results,
    text: body,
    ok,
    failed
  });
  if (settings.forwardHistory.length > 200) settings.forwardHistory.length = 200;
  saveSettings();

  sendToUi('stats', settings.stats);
  sendToUi('history', settings.forwardHistory.slice(0, 50));
  log(`Forwarded to ${ok}/${results.length} group(s)${failed ? `, ${failed} failed` : ''}.`);
  sending = false;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function publicSettings() {
  return {
    sourceGroup: settings.sourceGroup,
    targetGroups: settings.targetGroups,
    schedule: settings.schedule,
    dailyLimit: settings.dailyLimit,
    perGroupDelay: settings.perGroupDelay,
    stats: settings.stats,
    history: settings.forwardHistory.slice(0, 50),
    active: isWithinSchedule(),
    scheduleText: scheduleText(),
    userData: app.getPath('userData')
  };
}

ipcMain.handle('wa:start', async () => {
  const e = getEngine();
  await e.start();
  return e.status();
});
ipcMain.handle('wa:stop', async () => {
  const e = getEngine();
  await e.stop();
  return e.status();
});
ipcMain.handle('wa:state', async () => (engine ? engine.status() : { status: 'stopped', info: null, qr: null }));
ipcMain.handle('wa:groups', async () => getGroups());

ipcMain.handle('settings:get', async () => publicSettings());
ipcMain.handle('settings:save', async (_e, patch) => {
  if (patch.schedule) {
    if (hhmmToMinutes(patch.schedule.start) === null || hhmmToMinutes(patch.schedule.end) === null) {
      throw new Error('Time must be in HH:MM (24-hour) format.');
    }
    settings.schedule = { start: patch.schedule.start, end: patch.schedule.end };
  }
  if (patch.sourceGroup !== undefined) {
    settings.sourceGroup = patch.sourceGroup;
    if (engine && engine.manual) engine.manual.setSourceName(patch.sourceGroup ? patch.sourceGroup.name : null);
  }
  if (patch.targetGroups !== undefined) settings.targetGroups = patch.targetGroups;
  if (patch.dailyLimit !== undefined) settings.dailyLimit = Math.max(0, Number(patch.dailyLimit) || 0);
  if (patch.perGroupDelay !== undefined) settings.perGroupDelay = Math.max(0, Number(patch.perGroupDelay) || 0);
  saveSettings();
  sendToUi('settings', publicSettings());
  log('Settings saved.');
  return publicSettings();
});

ipcMain.handle('history:clear', async () => {
  settings.forwardHistory = [];
  saveSettings();
  sendToUi('history', []);
  return true;
});

ipcMain.handle('stats:reset', async () => {
  settings.stats = { forwarded: 0, failed: 0, skipped: 0, lastAt: null };
  saveSettings();
  sendToUi('stats', settings.stats);
  return settings.stats;
});

ipcMain.handle('test:send', async (_e, text) => {
  const e = getEngine();
  if (e.state !== 'ready') throw new Error('WhatsApp is not connected yet.');
  if (!settings.targetGroups.length) throw new Error('Select at least one target group first.');
  return forwardToTargets(String(text ?? ''), settings.targetGroups.slice());
});

ipcMain.handle('open:log', async () => {
  const f = LOG_FILE();
  if (fs.existsSync(f)) shell.showItemInFolder(f);
  else dialog.showMessageBox({ message: 'No activity log yet.' });
  return true;
});

ipcMain.handle('open:folder', async () => { shell.openPath(app.getPath('userData')); return true; });

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  os: `${os.type()} ${os.release()} (${os.arch()})`,
  schedule: scheduleText(),
  active: isWithinSchedule(),
  logFile: LOG_FILE()
}));

ipcMain.handle('debug:check', async () => {
  const e = getEngine();
  const lines = [];
  lines.push('WhatsApp: ' + e.state + (e.engine ? ' (engine: ' + e.engine + ')' : ''));
  if (e.state !== 'ready') {
    lines.push('-> WhatsApp is not connected. Press Connect WhatsApp and link the device.');
    return lines.join('\n');
  }
  lines.push('Schedule: ' + scheduleText() + '  |  now: ' +
    new Date().toTimeString().slice(0, 5) + '  |  inside: ' + (isWithinSchedule() ? 'YES' : 'NO'));
  if (!settings.sourceGroup) lines.push('-> No source group selected. Pick it in step 2 and press Save groups.');
  if (!settings.targetGroups.length) lines.push('-> No target group selected. Tick it in step 2 and press Save groups.');
  const limit = Number(settings.dailyLimit) || 0;
  lines.push('Daily: ' + dayCounter.count + ' of ' + (limit || 'unlimited') + ' used today.');
  try {
    const groups = await e.groups();
    const names = groups.map((g) => g.name);
    lines.push('Visible chats: ' + names.slice(0, 12).join(' | '));
    if (settings.sourceGroup) {
      const hit = names.some((n) => n.toLowerCase() === settings.sourceGroup.name.toLowerCase());
      lines.push('Source "' + settings.sourceGroup.name + '" found in the list: ' + (hit ? 'YES' : 'NO (scroll the list / open that chat once)'));
    }
    for (const t of settings.targetGroups) {
      const hit = names.some((n) => n.toLowerCase() === t.name.toLowerCase());
      lines.push('Target "' + t.name + '" found in the list: ' + (hit ? 'YES' : 'NO'));
    }
  } catch (err) {
    lines.push('Could not read the chat list: ' + err.message);
  }
  try {
    const last = await e.lastSourceSnapshot(settings.sourceGroup ? settings.sourceGroup.name : null);
    lines.push('Last message seen in source: ' + (last ? JSON.stringify(String(last.text || '').slice(0, 60)) + (last.own ? '  [own]' : '  [incoming]') + (last.media ? '  [media]' : '') : 'none'));
  } catch (err) {
    lines.push('Could not read the source chat: ' + err.message);
  }
  return lines.join('\n');
});

setInterval(() => {
  sendToUi('tick', { now: new Date().toISOString(), active: isWithinSchedule() });
}, 20000);

// ---------------------------------------------------------------------------
// Password gate – the app page is not loaded until the password is correct
// ---------------------------------------------------------------------------
const crypto = require('crypto');

const APP_PASSWORD = '66542';
const UNLOCK_FILE = () => path.join(app.getPath('userData'), 'unlocked.json');
const UNLOCK_HOURS = 12;
let unlockedThisRun = false;

function samePassword(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function rememberUnlock() {
  try { fs.writeFileSync(UNLOCK_FILE(), JSON.stringify({ at: Date.now() }), 'utf8'); } catch (e) {}
}

function unlockedRecently() {
  if (unlockedThisRun) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(UNLOCK_FILE(), 'utf8'));
    const age = Date.now() - Number(raw.at || 0);
    return age >= 0 && age < UNLOCK_HOURS * 3600 * 1000;
  } catch (e) { return false; }
}

function forgetUnlock() {
  unlockedThisRun = false;
  try { fs.unlinkSync(UNLOCK_FILE()); } catch (e) {}
}

let lockTries = 0;

ipcMain.handle('lock:submit', async (event, password) => {
  await new Promise((r) => setTimeout(r, 350));           // slow down guessing
  if (!samePassword(password, APP_PASSWORD)) {
    lockTries++;
    try { logLine('Wrong password entered on the lock screen.', 'warn'); } catch (e) {}
    return false;
  }
  lockTries = 0;
  unlockedThisRun = true;
  rememberUnlock();
  try { logLine('App unlocked with password.'); } catch (e) {}
  return true;
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.ico'),
    width: 1150,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'AR WhatsApp Group Message Forwarder',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (unlockedRecently()) {
    unlockedThisRun = true;
    mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  } else {
    loadLockPage();
  }
  // keep the layout at 100% zoom, whatever the last zoom level was
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function loadLockPage() {
  const bounds = mainWindow ? mainWindow.getBounds() : null;
  if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
  const opts = {
    icon: path.join(__dirname, 'build', 'icon.ico'),
    width: 420,
    height: 470,
    resizable: false,
    maximizable: false,
    title: 'AR WA GROUP MESSAGE FORWARD — Locked',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'lock-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };
  if (bounds) { opts.width = Math.min(420, bounds.width); opts.height = Math.min(470, bounds.height); }
  mainWindow = new BrowserWindow(opts);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'app', 'lock.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openAppPage() {
  const bounds = mainWindow ? mainWindow.getBounds() : null;
  if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
  createWindow();
  if (bounds && mainWindow) {
    mainWindow.setSize(1150, 800);
    mainWindow.center();
  }
}

ipcMain.handle('lock:open', async () => { openAppPage(); return true; });

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  try { if (engine) await engine.stop(); } catch (e) {}
  app.quit();
});
