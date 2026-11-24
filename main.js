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
  sourceGroups: [],       // [{ id, name }] — every one of them is read from
  targetGroups: [],       // [{ id, name }] — every one of them receives
  campaigns: [],          // scheduled messages (see DEFAULT_CAMPAIGN)
  autoSchedule: { enabled: false },
  schedule: { start: '09:50', end: '16:28' },
  dailyLimit: 0,          // 0 = unlimited
  perGroupDelay: 3,       // seconds between two target groups
  forwardHistory: [],
  stats: { forwarded: 0, failed: 0, skipped: 0, lastAt: null }
};

let settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

/** the first source group (kept for older code paths) */
function firstSource() {
  return (settings.sourceGroups && settings.sourceGroups[0]) || null;
}

// A scheduled message: pick the groups, write the text, choose the rhythm.
function blankCampaign() {
  return {
    id: '',
    name: '',
    text: '',
    targetGroups: [],                 // [{ id, name }] — recipients
    enabled: false,
    startDate: '',                    // YYYY-MM-DD, empty = today
    endDate: '',                      // YYYY-MM-DD, empty = no end
    times: ['10:00'],                 // HH:MM, one or more
    repeat: 'daily',                  // once | daily | weekdays | weekly | monthly | every
    weekdays: [1, 2, 3, 4, 5],        // 0 = Sunday
    everyMinutes: 60,                 // for repeat = every
    lastRunKey: '',                   // guards against sending twice in one minute
    stats: { sent: 0, failed: 0, lastAt: null, lastError: null }
  };
}

function normaliseCampaign(c) {
  const base = blankCampaign();
  const out = { ...base, ...(c || {}) };
  out.targetGroups = Array.isArray(out.targetGroups) ? out.targetGroups.filter((g) => g && g.name) : [];
  out.times = (Array.isArray(out.times) ? out.times : [out.times || '10:00'])
    .map((t) => String(t || '').trim())
    .filter((t) => hhmmToMinutes(t) !== null);
  if (!out.times.length) out.times = ['10:00'];
  out.weekdays = (Array.isArray(out.weekdays) ? out.weekdays : base.weekdays)
    .map(Number).filter((d) => d >= 0 && d <= 6);
  out.everyMinutes = Math.min(1440, Math.max(1, Number(out.everyMinutes) || 60));
  out.repeat = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'every'].includes(out.repeat) ? out.repeat : 'daily';
  out.stats = { ...base.stats, ...(out.stats || {}) };
  return out;
}

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    settings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      schedule: { ...DEFAULT_SETTINGS.schedule, ...(parsed.schedule || {}) },
      stats: { ...DEFAULT_SETTINGS.stats, ...(parsed.stats || {}) }
    };
    // older versions saved one source group – turn it into the list
    if ((!settings.sourceGroups || !settings.sourceGroups.length) && parsed.sourceGroup) {
      settings.sourceGroups = [parsed.sourceGroup];
    }
    if (!Array.isArray(settings.sourceGroups)) settings.sourceGroups = [];
    if (!Array.isArray(settings.targetGroups)) settings.targetGroups = [];
    settings.campaigns = Array.isArray(settings.campaigns) ? settings.campaigns.map(normaliseCampaign) : [];
    settings.autoSchedule = { enabled: false, ...(settings.autoSchedule || {}) };
    delete settings.sourceGroup;
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
// Scheduled messages (pick groups + write the text + choose the rhythm)
// ---------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

/** does this campaign want to send at this exact minute? */
function campaignDueAt(c, d = new Date()) {
  if (!c.enabled) return false;
  if (!c.text || !String(c.text).trim()) return false;
  if (!c.targetGroups.length) return false;

  const today = ymd(d);
  if (c.startDate && today < c.startDate) return false;
  if (c.endDate && today > c.endDate) return false;

  if (c.repeat === 'weekly') {
    const day = d.getDay();
    if (!c.weekdays.includes(day)) return false;
  }
  if (c.repeat === 'weekdays') {
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
  }
  if (c.repeat === 'monthly') {
    // the same day of the month as the start date
    if (c.startDate) {
      const sd = Number(c.startDate.slice(8, 10));
      if (sd && d.getDate() !== sd) return false;
    }
  }
  if (c.repeat === 'once') {
    if (c.startDate && today !== c.startDate) return false;
  }

  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  if (c.repeat === 'every') {
    const start = hhmmToMinutes(c.times[0] || '00:00');
    const end = hhmmToMinutes(settings.schedule.end);
    const nowMin = d.getHours() * 60 + d.getMinutes();
    if (nowMin < start) return false;
    if (end !== null && settings.schedule.end !== settings.schedule.start && nowMin >= end) return false;
    return (nowMin - start) % c.everyMinutes === 0;
  }

  return c.times.includes(hhmm);
}

let schedulerTimer = null;
let schedulerBusy = false;

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => runScheduler().catch(() => {}), 20000);
  runScheduler().catch(() => {});
}

async function runScheduler() {
  if (schedulerBusy) return;
  const now = new Date();
  const due = settings.campaigns.filter((c) => campaignDueAt(c, now));
  if (!due.length) return;

  schedulerBusy = true;
  try {
    for (const c of due) {
      const key = ymd(now) + ' ' + `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      if (c.lastRunKey === key) continue;
      c.lastRunKey = key;

      const e = getEngine();
      if (!e || e.state !== 'ready') {
        c.stats.lastError = 'WhatsApp is not connected';
        log(`Scheduled "${c.name || 'message'}" skipped: WhatsApp is not connected.`, 'warn');
        saveSettings();
        continue;
      }

      const results = await forwardToTargets(String(c.text), c.targetGroups.slice());
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      c.stats.sent += ok;
      c.stats.failed += failed;
      c.stats.lastAt = new Date().toISOString();
      c.stats.lastError = failed ? `${failed} group(s) failed` : null;
      if (c.repeat === 'once') c.enabled = false;      // a one-time message is done

      settings.forwardHistory.unshift({
        at: c.stats.lastAt,
        source: '⏰ ' + (c.name || 'scheduled message'),
        targets: results,
        text: String(c.text),
        ok,
        failed
      });
      if (settings.forwardHistory.length > 200) settings.forwardHistory.length = 200;

      saveSettings();
      sendToUi('settings', publicSettings());
      sendToUi('history', settings.forwardHistory.slice(0, 50));
      log(`Scheduled "${c.name || 'message'}" sent to ${ok}/${results.length} group(s)${failed ? `, ${failed} failed` : ''}.`, failed ? 'warn' : 'info');
    }
  } finally {
    schedulerBusy = false;
  }
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
      if (engine.manual) engine.manual.setSourceName(settings.sourceGroups.map((g) => g.name));
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
    settings.sourceGroups = settings.sourceGroups.map((g) =>
      byId.has(g.id) ? { id: g.id, name: byId.get(g.id) } : g
    );
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
  const srcs = settings.sourceGroups || [];
  if (!srcs.length) return;
  const fromSource = srcs.some((g) => msg.from === g.id || msg.from === g.name);
  if (!fromSource) return;

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
    source: msg.from,
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
    sourceGroups: settings.sourceGroups,
    targetGroups: settings.targetGroups,
    campaigns: settings.campaigns,
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
ipcMain.handle('campaign:set', async (_e, id, enabled) => {
  const c = settings.campaigns.find((x) => x.id === id);
  if (!c) throw new Error('That scheduled message no longer exists.');
  if (enabled) {
    if (!String(c.text || '').trim()) throw new Error('Write the message text first.');
    if (!c.targetGroups.length) throw new Error('Choose at least one recipient group first.');
    c.enabled = true;
    c.lastRunKey = '';                       // it may send again from the next slot
    log(`Scheduled "${c.name || 'message'}" STARTED.`);
  } else {
    c.enabled = false;
    log(`Scheduled "${c.name || 'message'}" STOPPED.`, 'warn');
  }
  saveSettings();
  sendToUi('settings', publicSettings());
  return publicSettings();
});

ipcMain.handle('campaign:sendNow', async (_e, id) => {
  const c = settings.campaigns.find((x) => x.id === id);
  if (!c) throw new Error('That scheduled message no longer exists.');
  if (!String(c.text || '').trim()) throw new Error('Write the message text first.');
  if (!c.targetGroups.length) throw new Error('Choose at least one recipient group first.');
  const e = getEngine();
  if (!e || e.state !== 'ready') throw new Error('Connect WhatsApp first.');
  const results = await forwardToTargets(String(c.text), c.targetGroups.slice());
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  c.stats.sent += ok;
  c.stats.failed += failed;
  c.stats.lastAt = new Date().toISOString();
  c.stats.lastError = failed ? `${failed} group(s) failed` : null;
  settings.forwardHistory.unshift({
    at: c.stats.lastAt, source: '⏰ ' + (c.name || 'scheduled message'),
    targets: results, text: String(c.text), ok, failed
  });
  if (settings.forwardHistory.length > 200) settings.forwardHistory.length = 200;
  saveSettings();
  sendToUi('settings', publicSettings());
  sendToUi('history', settings.forwardHistory.slice(0, 50));
  log(`Scheduled "${c.name || 'message'}" sent now to ${ok}/${results.length} group(s).`, failed ? 'warn' : 'info');
  return { ok, failed, results };
});

ipcMain.handle('settings:save', async (_e, patch) => {
  if (patch.schedule) {
    if (hhmmToMinutes(patch.schedule.start) === null || hhmmToMinutes(patch.schedule.end) === null) {
      throw new Error('Time must be in HH:MM (24-hour) format.');
    }
    settings.schedule = { start: patch.schedule.start, end: patch.schedule.end };
  }
  if (patch.sourceGroups !== undefined) {
    settings.sourceGroups = Array.isArray(patch.sourceGroups) ? patch.sourceGroups : [];
  } else if (patch.sourceGroup !== undefined) {
    // older screen: a single source group
    settings.sourceGroups = patch.sourceGroup ? [patch.sourceGroup] : [];
  }
  if (engine && engine.manual) engine.manual.setSourceName(settings.sourceGroups.map((g) => g.name));
  if (patch.targetGroups !== undefined) settings.targetGroups = patch.targetGroups;
  if (patch.campaigns !== undefined) {
    settings.campaigns = (Array.isArray(patch.campaigns) ? patch.campaigns : []).map(normaliseCampaign);
  }
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
  if (!settings.sourceGroups.length) lines.push('-> No source group selected. Tick them in step 2 and press Save groups.');
  if (!settings.targetGroups.length) lines.push('-> No target group selected. Tick it in step 2 and press Save groups.');
  const limit = Number(settings.dailyLimit) || 0;
  lines.push('Daily: ' + dayCounter.count + ' of ' + (limit || 'unlimited') + ' used today.');
  try {
    const groups = await e.groups();
    const names = groups.map((g) => g.name);
    lines.push('Visible chats: ' + names.slice(0, 12).join(' | '));
    for (const g of settings.sourceGroups) {
      const hit = names.some((n) => n.toLowerCase() === g.name.toLowerCase());
      lines.push('Source "' + g.name + '" found in the list: ' + (hit ? 'YES' : 'NO (scroll the list / open that chat once)'));
    }
    for (const t of settings.targetGroups) {
      const hit = names.some((n) => n.toLowerCase() === t.name.toLowerCase());
      lines.push('Target "' + t.name + '" found in the list: ' + (hit ? 'YES' : 'NO'));
    }
  } catch (err) {
    lines.push('Could not read the chat list: ' + err.message);
  }
  try {
    const last = await e.lastSourceSnapshot(firstSource() ? firstSource().name : null);
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

// The password is NOT written in the source. It is read from
//   %APPDATA%\AR WhatsApp Forwarder\password.txt
// (created by the owner; the file stays on the owner's PC).
// If that file does not exist, the built-in password is used.
const DEFAULT_PASSWORD = '66542';
function appPassword() {
  try {
    const f = path.join(app.getPath('userData'), 'password.txt');
    const v = fs.readFileSync(f, 'utf8').trim();
    if (v) return v;
  } catch (e) { /* no file – use the built-in one */ }
  return DEFAULT_PASSWORD;
}
const UNLOCK_FILE = () => path.join(app.getPath('userData'), 'unlocked.json');
// The password is asked EVERY time the software is opened. Nothing is remembered
// between runs; the unlock only lasts for this one run of the app.
const UNLOCK_HOURS = 0;
let unlockedThisRun = false;
let swappingWindow = false;

function samePassword(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function rememberUnlock() {
  // do not write anything: every new start must ask for the password again
  try { fs.unlinkSync(UNLOCK_FILE()); } catch (e) {}
}

function unlockedRecently() {
  // only this run counts; a saved unlock from an earlier start is ignored
  return unlockedThisRun === true;
}

function forgetUnlock() {
  unlockedThisRun = false;
  try { fs.unlinkSync(UNLOCK_FILE()); } catch (e) {}
}

let lockTries = 0;

ipcMain.handle('lock:submit', async (event, password) => {
  await new Promise((r) => setTimeout(r, 350));           // slow down guessing
  if (!samePassword(password, appPassword())) {
    lockTries++;
    try { logLine('Wrong password (' + lockTries + ') on the lock screen.', 'warn'); } catch (e) {}
    return { ok: false, tries: lockTries };
  }
  lockTries = 0;
  unlockedThisRun = true;
  rememberUnlock();
  try { logLine('App unlocked with password.'); } catch (e) {}
  return { ok: true, tries: 0 };
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow() {
  if (unlockedRecently()) {
    unlockedThisRun = true;
    showAppWindow();
  } else {
    showLockWindow();
  }
}

/** the real app window */
function showAppWindow() {
  swappingWindow = true;
  if (mainWindow) { try { mainWindow.destroy(); } catch (e) {} mainWindow = null; }
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.ico'),
    width: 1150,
    height: 800,
    minWidth: 1024,
    minHeight: 700,
    title: 'AR WA GROUP MESSAGE FORWARD — Smart WhatsApp Message Forwarding Software',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow.once('ready-to-show', () => { swappingWindow = false; });
  // keep the layout at 100% zoom, whatever the last zoom level was
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(1);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showLockWindow() {
  swappingWindow = true;
  if (mainWindow) { try { mainWindow.destroy(); } catch (e) {} mainWindow = null; }
  mainWindow = new BrowserWindow({
    icon: path.join(__dirname, 'build', 'icon.ico'),
    width: 420,
    height: 480,
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
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'app', 'lock.html'));
  mainWindow.once('ready-to-show', () => { swappingWindow = false; });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function openAppPage() {
  showAppWindow();
}

ipcMain.handle('lock:open', async () => { openAppPage(); return true; });

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  try { fs.unlinkSync(UNLOCK_FILE()); } catch (e) {}   // old versions saved an unlock - ignore it
  loadSettings();
  startScheduler();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  // the lock window and the app window are swapped while running;
  // if every window is really gone, stop WhatsApp and exit
  if (swappingWindow) return;
  try { if (engine) await engine.stop(); } catch (e) {}
  app.quit();
});
