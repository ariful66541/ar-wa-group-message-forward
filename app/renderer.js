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
}

async function loadGroups() {
  try {
    groups = await API.groups();
    renderGroups();
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
