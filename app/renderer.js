/* AR WhatsApp Group Message Forwarder - renderer */
const $ = (id) => document.getElementById(id);
const API = window.api;

let groups = [];
let state = { wa: { status: 'stopped' }, settings: null };

/* ---------------------------------------------------------------- helpers */
function setWaBadge(status) {
  const dot = $('waDot');
  const txt = $('waText');
  dot.className = 'dot';
  const map = {
    ready: ['on', 'WhatsApp: connected'],
    qr: ['warn', 'WhatsApp: scan QR code'],
    loading: ['warn', 'WhatsApp: starting…'],
    authenticated: ['warn', 'WhatsApp: logging in…'],
    auth_failure: ['err', 'WhatsApp: login failed'],
    disconnected: ['err', 'WhatsApp: disconnected'],
    error: ['err', 'WhatsApp: error'],
    stopped: ['', 'WhatsApp: not connected']
  };
  const [cls, label] = map[status] || ['', 'WhatsApp: ' + status];
  if (cls) dot.classList.add(cls);
  txt.textContent = label;
  $('btnConnect').disabled = ['loading', 'qr', 'authenticated', 'ready'].includes(status);
  $('btnLogout').disabled = status === 'stopped';
  $('btnReload').disabled = status !== 'ready';
}

function setSchedBadge(active, text) {
  const dot = $('schedDot');
  dot.className = 'dot ' + (active ? 'on' : '');
  $('schedText').textContent = (active ? 'Active now · ' : 'Waiting · ') + (text || '09:50 – 16:28');
}

function logLine(msg, level) {
  const box = $('log');
  const d = document.createElement('div');
  d.className = 'l-' + (level || 'info');
  d.textContent = msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------------------------------------------------------- groups */
function renderGroups() {
  const st = state.settings || {};
  const srcIds = new Set((st.sourceGroups || []).map((g) => g.id));
  const tgtIds = new Set((st.targetGroups || []).map((g) => g.id));

  const srcBox = $('sourceList');
  const tgtBox = $('targetList');

  if (!groups.length) {
    srcBox.innerHTML = '<div class="item" style="color:var(--muted)">No groups found. Join the groups on WhatsApp first.</div>';
    tgtBox.innerHTML = '<div class="item" style="color:var(--muted)">No groups found. Join the groups on WhatsApp first.</div>';
    $('sourceCount').textContent = '0 selected';
    $('targetCount').textContent = '0 selected';
    return;
  }

  const row = (g, checked, tag) => `
    <label class="item">
      <input type="checkbox" data-id="${esc(g.id)}" ${checked ? 'checked' : ''}>
      <span class="nm">${esc(g.name)}</span>
      ${tag || ''}
    </label>`;

  srcBox.innerHTML = groups.map((g) => {
    const alsoTarget = tgtIds.has(g.id) ? '<span class="tag">target</span>' : '';
    return row(g, srcIds.has(g.id), alsoTarget);
  }).join('');

  tgtBox.innerHTML = groups.map((g) => {
    const alsoSource = srcIds.has(g.id) ? '<span class="tag">source</span>' : '';
    return row(g, tgtIds.has(g.id), alsoSource);
  }).join('');

  srcBox.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', updateCounts));
  tgtBox.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', updateCounts));
  updateCounts();
}

function updateCounts() {
  const s = $('sourceList').querySelectorAll('input[type=checkbox]:checked').length;
  const t = $('targetList').querySelectorAll('input[type=checkbox]:checked').length;
  $('sourceCount').textContent = s + ' selected';
  $('targetCount').textContent = t + ' selected';
}

function updateTargetCount() { updateCounts(); }

/* ------------------------------------------------------- scheduled messages */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function repeatLabel(c) {
  if (c.repeat === 'once') return 'once';
  if (c.repeat === 'daily') return 'every day';
  if (c.repeat === 'weekdays') return 'Mon–Fri';
  if (c.repeat === 'weekly') return 'every ' + (c.weekdays || []).map((d) => DAY_NAMES[d]).join(', ');
  if (c.repeat === 'monthly') return 'monthly on day ' + (c.startDate ? Number(c.startDate.slice(8, 10)) : 1);
  if (c.repeat === 'every') return 'every ' + c.everyMinutes + ' min';
  return c.repeat;
}

function campState(c) {
  if (!c.enabled) return { text: 'STOPPED', cls: 'badge-stop' };
  if (!String(c.text || '').trim()) return { text: 'NO TEXT', cls: 'badge-stop' };
  if (!(c.targetGroups || []).length) return { text: 'NO GROUPS', cls: 'badge-stop' };
  return { text: 'RUNNING', cls: 'badge-run' };
}

function renderCampaigns() {
  const list = $('campaignList');
  const camps = (state.settings && state.settings.campaigns) || [];
  if (!camps.length) {
    list.innerHTML = '<div class="hint">No scheduled message yet. Press <b>+ Add scheduled message</b>.</div>';
    return;
  }

  list.innerHTML = camps.map((c, idx) => {
    const st = campState(c);
    const groupOpts = groups.map((g) => `
      <label class="item">
        <input type="checkbox" data-camp="${idx}" data-gid="${esc(g.id)}" ${(c.targetGroups || []).some((t) => t.id === g.id) ? 'checked' : ''}>
        <span class="nm">${esc(g.name)}</span>
      </label>`).join('') || '<div class="item" style="color:var(--muted)">— connect WhatsApp first —</div>';

    return `<div class="camp" data-idx="${idx}">
      <div class="camphead">
        <span class="${st.cls}">${st.text}</span>
        <input class="cname" data-camp="${idx}" data-field="name" value="${esc(c.name || '')}" placeholder="Name (e.g. Morning offer)">
        <button class="btn-ghost del" data-act="del" data-idx="${idx}">Delete</button>
      </div>

      <div class="mini">1 · Recipient groups — tick one or more</div>
      <div class="list" data-groups="${idx}">${groupOpts}</div>

      <div class="mini" style="margin-top:10px">2 · Message to send — sent exactly as typed</div>
      <textarea data-camp="${idx}" data-field="text" placeholder="Type the message that will be sent to every ticked group…">${esc(c.text || '')}</textarea>

      <div class="mini" style="margin-top:10px">3 · Repeat</div>
      <div class="row2">
        <select data-camp="${idx}" data-field="repeat">
          <option value="once" ${c.repeat === 'once' ? 'selected' : ''}>Once</option>
          <option value="daily" ${c.repeat === 'daily' ? 'selected' : ''}>Every day</option>
          <option value="weekdays" ${c.repeat === 'weekdays' ? 'selected' : ''}>Monday to Friday</option>
          <option value="weekly" ${c.repeat === 'weekly' ? 'selected' : ''}>Selected days of the week</option>
          <option value="monthly" ${c.repeat === 'monthly' ? 'selected' : ''}>Once a month</option>
          <option value="every" ${c.repeat === 'every' ? 'selected' : ''}>Every N minutes</option>
        </select>
        <input type="number" min="1" max="1440" data-camp="${idx}" data-field="everyMinutes" value="${c.everyMinutes || 60}" title="minutes" ${c.repeat === 'every' ? '' : 'disabled'}>
      </div>
      <div class="days">
        ${DAY_NAMES.map((d, i) => `<label><input type="checkbox" data-camp="${idx}" data-day="${i}" ${(c.weekdays || []).includes(i) ? 'checked' : ''}>${d}</label>`).join('')}
      </div>

      <div class="mini" style="margin-top:10px">4 · Time and dates</div>
      <div class="row2">
        <input type="time" data-camp="${idx}" data-field="time0" value="${esc(c.times[0] || '10:00')}" title="time">
        <input type="date" data-camp="${idx}" data-field="startDate" value="${esc(c.startDate || '')}" title="from date">
        <input type="date" data-camp="${idx}" data-field="endDate" value="${esc(c.endDate || '')}" title="until date">
      </div>

      <div class="mini" style="margin-top:8px">Status: <b>${st.text}</b> · ${esc(repeatLabel(c))} at ${esc((c.times || []).join(', '))}
        ${c.stats && c.stats.lastAt ? ' · last sent ' + new Date(c.stats.lastAt).toLocaleString() : ' · never sent yet'}
        ${c.stats && c.stats.lastError ? ' · <span class="fail">' + esc(c.stats.lastError) + '</span>' : ''}</div>

      <div class="statrow" style="margin-top:8px">
        <button class="btn-primary" data-act="start" data-idx="${idx}">▶ Start</button>
        <button class="btn-ghost" data-act="stop" data-idx="${idx}">■ Stop</button>
        <button class="btn-ghost" data-act="now" data-idx="${idx}">Send now</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-field]').forEach((el) => {
    const ev = el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'date' || el.type === 'time' ? 'change' : 'input';
    el.addEventListener(ev, () => campEdit(el));
  });
  list.querySelectorAll('[data-day]').forEach((el) => el.addEventListener('change', () => campEdit(el)));
  list.querySelectorAll('[data-gid]').forEach((el) => el.addEventListener('change', () => campEdit(el)));
  list.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => campAction(btn)));
}

let campSaveTimer = null;
function campEdit(el) {
  const idx = Number(el.dataset.camp);
  const c = state.settings.campaigns[idx];
  if (!c) return;

  if (el.dataset.field === 'name') c.name = el.value;
  else if (el.dataset.field === 'text') c.text = el.value;
  else if (el.dataset.field === 'repeat') { c.repeat = el.value; }
  else if (el.dataset.field === 'everyMinutes') c.everyMinutes = Number(el.value) || 60;
  else if (el.dataset.field === 'time0') c.times = [el.value];
  else if (el.dataset.field === 'startDate') c.startDate = el.value;
  else if (el.dataset.field === 'endDate') c.endDate = el.value;
  else if (el.dataset.day !== undefined) {
    const d = Number(el.dataset.day);
    const set = new Set(c.weekdays || []);
    if (el.checked) set.add(d); else set.delete(d);
    c.weekdays = [...set].sort();
  } else if (el.dataset.gid !== undefined) {
    const box = el.closest('.camp');
    const ids = [...box.querySelectorAll('[data-gid]')].filter((x) => x.checked).map((x) => x.dataset.gid);
    c.targetGroups = ids.map((id) => groups.find((g) => g.id === id)).filter(Boolean);
  }

  clearTimeout(campSaveTimer);
  campSaveTimer = setTimeout(saveCampaigns, 700);
}

async function saveCampaigns() {
  try {
    state.settings = await API.saveSettings({ campaigns: state.settings.campaigns });
    renderCampaigns();
  } catch (e) { logLine(e.message, 'err'); }
}

async function campAction(btn) {
  const idx = Number(btn.dataset.idx);
  const c = state.settings.campaigns[idx];
  if (!c) return;
  try {
    if (btn.dataset.act === 'del') {
      state.settings.campaigns.splice(idx, 1);
      await saveCampaigns();
      logLine('Scheduled message deleted.');
      return;
    }
    if (btn.dataset.act === 'start' || btn.dataset.act === 'stop') {
      state.settings = await API.setCampaign(c.id, btn.dataset.act === 'start');
      renderCampaigns();
      logLine(btn.dataset.act === 'start' ? 'Scheduled message STARTED.' : 'Scheduled message STOPPED.', btn.dataset.act === 'start' ? 'info' : 'warn');
      return;
    }
    if (btn.dataset.act === 'now') {
      btn.disabled = true;
      btn.textContent = 'Sending…';
      const r = await API.sendCampaignNow(c.id);
      state.settings = await API.getSettings();
      renderCampaigns();
      logLine(`Sent now to ${r.ok}/${r.results.length} group(s).`, r.failed ? 'warn' : 'info');
    }
  } catch (e) {
    logLine(e.message, 'err');
    btn.disabled = false;
  }
}

function addCampaign() {
  const c = {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: 'Message ' + ((state.settings.campaigns || []).length + 1),
    text: '',
    targetGroups: [],
    enabled: false,
    startDate: '', endDate: '',
    times: ['10:00'],
    repeat: 'daily',
    weekdays: [1, 2, 3, 4, 5],
    everyMinutes: 60,
    lastRunKey: '',
    stats: { sent: 0, failed: 0, lastAt: null, lastError: null }
  };
  state.settings.campaigns = [...(state.settings.campaigns || []), c];
  renderCampaigns();
  saveCampaigns();
  logLine('Scheduled message added. Choose the groups, write the text, then press Start.');
}

/* ---------------------------------------------------------------- stats / history */
function renderStats(stats) {
  if (!stats) return;
  $('stFwd').textContent = stats.forwarded || 0;
  $('stFail').textContent = stats.failed || 0;
  $('stSkip').textContent = stats.skipped || 0;
  $('stLast').textContent = stats.lastAt
    ? new Date(stats.lastAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';
}

function renderHistory(hist) {
  const box = $('hist');
  if (!hist || !hist.length) {
    box.innerHTML = '<div class="hint">Nothing forwarded yet.</div>';
    return;
  }
  box.innerHTML = hist.map((h) => {
    const names = (h.targets || []).map((t) =>
      `<span class="${t.ok ? 'ok' : 'fail'}">${t.ok ? '✓' : '✗'} ${esc(t.name)}</span>`).join(' · ');
    return `<div class="hitem">
      <div class="t">${new Date(h.at).toLocaleString()} — from <b>${esc(h.source || '')}</b> — ${h.ok} ok${h.failed ? `, <span class="fail">${h.failed} failed</span>` : ''}</div>
      <div class="txt">${esc(h.text || '')}</div>
      <div class="t" style="margin-top:4px">${names}</div>
    </div>`;
  }).join('');
}

/* ---------------------------------------------------------------- init */
async function init() {
  state.settings = await API.getSettings();
  applySettings(state.settings);

  const st = await API.waState();
  state.wa = st;
  setWaBadge(st.status);
  if (st.qr) showQr(st.qr);
  if (st.status === 'ready') loadGroups();

  $('btnConnect').onclick = async () => {
    try {
      setWaBadge('loading');
      logLine('Starting WhatsApp…');
      const s = await API.startWhatsApp();
      setWaBadge(s.status);
    } catch (e) {
      logLine(e.message, 'err');
      setWaBadge('error');
    }
  };

  $('btnLogout').onclick = async () => {
    await API.stopWhatsApp();
    setWaBadge('stopped');
    logLine('WhatsApp stopped. The saved login stays on this PC.', 'warn');
  };

  $('btnReload').onclick = loadGroups;

  $('btnAddCampaign').onclick = addCampaign;

  $('btnSaveGroups').onclick = async () => {
    const srcIds = [...$('sourceList').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.dataset.id);
    const tgtIds = [...$('targetList').querySelectorAll('input[type=checkbox]:checked')].map((c) => c.dataset.id);
    const sourceGroups = srcIds.map((id) => groups.find((g) => g.id === id)).filter(Boolean);
    const targetGroups = tgtIds.map((id) => groups.find((g) => g.id === id)).filter(Boolean);
    state.settings = await API.saveSettings({ sourceGroups, targetGroups });
    logLine(`Groups saved: ${sourceGroups.length} source group(s) -> ${targetGroups.length} target group(s).`);
  };

  $('btnRecheck').onclick = async () => {
    $('btnRecheck').disabled = true;
    $('btnRecheck').textContent = 'Checking...';
    const r = await API.debugCheck();
    $('btnRecheck').disabled = false;
    $('btnRecheck').textContent = 'Check now (why not forwarding?)';
    alert(r);
  };

  $('btnSaveSchedule').onclick = async () => {
    try {
      const patch = {
        schedule: { start: $('startTime').value, end: $('endTime').value },
        perGroupDelay: Number($('delay').value),
        dailyLimit: Number($('dailyLimit').value)
      };
      state.settings = await API.saveSettings(patch);
      applySettings(state.settings);
      logLine(`Schedule saved: ${patch.schedule.start} – ${patch.schedule.end}.`);
    } catch (e) {
      logLine(e.message, 'err');
    }
  };

  $('btnResetStats').onclick = async () => {
    renderStats(await API.resetStats());
    logLine('Counters reset.');
  };
  $('btnClearHist').onclick = async () => {
    await API.clearHistory();
    renderHistory([]);
  };
  $('btnLogFile').onclick = () => API.openLog();

  $('btnTest').onclick = async () => {
    const text = $('testText').value;
    if (!text) { $('testMsg').textContent = 'Type something first.'; return; }
    $('testMsg').textContent = 'Sending…';
    try {
      const res = await API.testSend(text);
      const ok = res.filter((r) => r.ok).length;
      $('testMsg').textContent = `Sent to ${ok}/${res.length} group(s).`;
    } catch (e) {
      $('testMsg').textContent = e.message;
    }
  };

  /* events from main */
  API.on('wa-state', (s) => {
    state.wa = s;
    setWaBadge(s.status);
    if (s.qr) showQr(s.qr);
    if (s.engine) logLine('Engine: ' + (s.engine === 'ui' ? 'built-in' : 'standard'));
    if (s.status === 'ready') {
      const who = s.info ? ` as ${s.info.pushname} (+${s.info.number})` : '';
      $('waStatusLine').innerHTML = `Connected${esc(who)}. Choose your groups below.`;
      $('qrBox').innerHTML = '<div class="ph" style="color:#15803d;font-weight:700">✓ Connected</div>';
      loadGroups();
    }
    if (s.status === 'qr') {
      $('waStatusLine').innerHTML = 'Scan this QR code: WhatsApp → <b>Linked devices</b> → <b>Link a device</b>.';
    }
    if (s.status === 'error' && s.error) {
      $('waStatusLine').innerHTML = 'Error: ' + esc(s.error);
    }
    if (s.status === 'stopped') {
      $('qrBox').innerHTML = '<div class="ph">QR code will appear here</div>';
    }
  });

  API.on('loading', (l) => {
    $('waStatusLine').textContent = `Loading WhatsApp… ${l.percent || 0}% ${l.message || ''}`;
  });
  API.on('log', (l) => logLine(l.msg, l.level));
  API.on('stats', renderStats);
  API.on('history', renderHistory);
  API.on('tick', (t) => setSchedBadge(t.active, state.settings?.scheduleText));
  API.on('settings', (s) => { state.settings = s; applySettings(s); });
  API.on('incoming', (m) => logLine('New source message: ' + m.text.slice(0, 120), 'info'));

  const info = await API.appInfo();
  logLine(`AR WhatsApp Group Message Forwarder v${info.version} ready on ${info.os}. Schedule ${info.schedule}.`);
}

function showQr(dataUrl) {
  $('qrBox').innerHTML = `<img src="${dataUrl}" alt="WhatsApp QR code">`;
}

function applySettings(s) {
  if (!s) return;
  $('startTime').value = s.schedule.start;
  $('endTime').value = s.schedule.end;
  $('delay').value = s.perGroupDelay ?? 3;
  $('dailyLimit').value = s.dailyLimit ?? 0;
  setSchedBadge(s.active, s.scheduleText);
  renderStats(s.stats);
  renderHistory(s.history);
  if (groups.length) renderGroups();
  renderCampaigns();
}

async function loadGroups() {
  try {
    groups = await API.groups();
    renderGroups();
    renderCampaigns();
    logLine(`Loaded ${groups.length} group(s).`);
  } catch (e) {
    logLine(e.message, 'err');
  }
}

/* ------------------------------------------------------------- about */
(async function setupAbout() {
  try {
    const info = await API.appInfo();
    const v = document.getElementById('aboutVersion');
    if (v && info && info.version) v.textContent = info.version;
  } catch (e) {}
  const y = document.getElementById('aboutYear');
  if (y) y.textContent = String(new Date().getFullYear());
})();

init();

/* ---------------------------------------------------------------- zoom */
(function setupZoom() {
  const base = Math.min(1, 1150 / Math.max(1, window.innerWidth));
  const step = 0.05;
  const apply = (z) => {
    const v = Math.min(1.3, Math.max(0.55, Math.round(z * 100) / 100));
    document.body.style.zoom = v;
    current = v;
    const el = document.getElementById('zoomLabel');
    if (el) el.textContent = Math.round(v * 100) + '%';
    try { localStorage.setItem('arzoom', String(v)); } catch (e) {}
  };
  let z = base;
  try { const saved = localStorage.getItem('arzoom'); z = saved ? Number(saved) : base; } catch (e) { z = base; }
  if (!z) z = base;
  let current = z;
  apply(z);
  const btnIn = document.getElementById('zoomIn');
  const btnOut = document.getElementById('zoomOut');
  const btnReset = document.getElementById('zoomReset');
  if (btnIn) btnIn.onclick = () => apply(current + step);
  if (btnOut) btnOut.onclick = () => apply(current - step);
  if (btnReset) btnReset.onclick = () => apply(1);
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); apply(current + step); }
    if (e.key === '-') { e.preventDefault(); apply(current - step); }
    if (e.key === '0') { e.preventDefault(); apply(1); }
  });
})();
