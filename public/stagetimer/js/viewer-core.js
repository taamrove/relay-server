// Shared rendering for the stage-timer HDMI views.
//
// Loaded by both /viewer.html (L-frame with chroma key for PIP-into-talent)
// and /viewer-pip.html (fullscreen view that is itself PIP'd into a mixer).
// The two pages keep the same DOM IDs so this single file can drive both;
// chroma-specific code is guarded so it no-ops when those elements aren't
// in the page.

const $ = id => document.getElementById(id);
let last = null;
// Relay viewers: window.clockOffset = venue epoch - local epoch (set by output.html), so timers match the venue machine. 0 locally.
const nowMs = () => Date.now() + (window.clockOffset || 0);
function applyState(s) { last = s; renderLayout(); }

function fmt(ms, showSeconds) {
  const sign = ms < 0 ? '-' : '';
  const total = Math.max(0, Math.ceil(Math.abs(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');
  if (h > 0) return `${sign}${h}:${pad(m)}:${pad(s)}`;
  if (showSeconds !== false) return `${sign}${pad(m)}:${pad(s)}`;
  return `${sign}${m}m`;
}

// Project a possibly-running timer's remaining time forward to wall-clock
// time T. Clamp at 0 when requested (for QLab cues — we never want a
// negative readout if QLab is a beat behind on its runningCues update).
function projectRemaining(running, startedAt, durationMs, remainingMs, atMs, clampAtZero) {
  let v = (running && startedAt != null)
    ? durationMs - (atMs - startedAt)
    : remainingMs;
  if (clampAtZero && v < 0) v = 0;
  return v;
}

// Fill the PIP-setup info card inside the chroma rectangle. Recomputed
// on render and on window resize so dimensions stay accurate. No-op on
// pages that don't have a chroma rectangle (the fullscreen PIP view).
//
// ATEM DVE coordinates (Mini/Mini Pro/Extreme/Constellation/4M):
//   - size: 0.000–1.000 of program width
//   - position X: -16.00 (left edge) .. +16.00 (right edge) of program
//   - position Y: -9.00 (bottom edge) .. +9.00 (top edge) of program
//     (Y is inverted relative to pixel coords — positive Y = up.)
function updatePipInfo() {
  const card = $('pipInfo');
  const chromaEl = $('chroma');
  if (!card || !chromaEl) return;
  const W = window.innerWidth, H = window.innerHeight;
  const r = chromaEl.getBoundingClientRect();
  const pw = Math.round(r.width), ph = Math.round(r.height);
  const px = Math.round(r.left),  py = Math.round(r.top);
  const pct = (n, d) => (n / d * 100).toFixed(1) + '%';
  const sign = n => (n >= 0 ? '+' : '') + n.toFixed(2);

  const cx = r.left + r.width / 2 - W / 2;
  const cy = r.top + r.height / 2 - H / 2;
  const atemSize = (r.width / W).toFixed(3);
  const atemX = sign(cx / (W / 2) * 16);
  const atemY = sign(-cy / (H / 2) * 9);

  const k = s => `<span class="pipKey">${s}</span>`;
  card.innerHTML =
    '<div class="pipTitle">PIP setup</div>' +
    k('HDMI    ') + `${W} × ${H}\n` +
    k('size    ') + `${pw} × ${ph} px  (${pct(pw, W)} × ${pct(ph, H)})\n` +
    k('top-left') + ` ${px}, ${py} px  (${pct(px, W)}, ${pct(py, H)})\n` +
    '<div class="pipHr"></div>' +
    '<div class="pipTitle">ATEM DVE</div>' +
    k('size    ') + `${atemSize}\n` +
    k('pos X   ') + `${atemX}\n` +
    k('pos Y   ') + `${atemY}`;
}
window.addEventListener('resize', updatePipInfo);

// --- Layout render: anything that's not a per-second digit. Runs on every
// WS event. Safe to do many times a second.
function renderLayout() {
  if (!last) return;
  const s = last;
  // output.html hook: swaps layouts / applies per-window toggles; false = DOM not ready yet
  if (window.outputHook && window.outputHook(s) === false) return;

  // Chroma-key area colour. Only present on the L-frame viewer; the
  // fullscreen PIP view has no chroma rectangle so we skip this entirely.
  const chromaEl = $('chroma');
  if (chromaEl) {
    const keyOn = s.display.chromaKey !== false;
    chromaEl.style.background = keyOn ? s.display.keyColor : 'var(--frame-bg)';
    chromaEl.classList.toggle('no-key', !keyOn);
    const pipInfoEl = $('pipInfo');
    if (pipInfoEl) {
      const showPip = keyOn && s.display.showPipInfo !== false;
      pipInfoEl.style.display = showPip ? '' : 'none';
      if (showPip) updatePipInfo();
    }
  }

  // Clock visibility. We support both showClock (new) and showClockBottom
  // (the old name, when only the bottom one existed) for backwards compat
  // with older saved state.
  const showClock = s.display.showClock !== false && s.display.showClockBottom !== false;
  const clockEl = $('clockBottom');
  if (clockEl) clockEl.classList.toggle('hidden', !showClock);

  // QLab sidebar visibility — only meaningful on layouts that have a
  // separate QLab container; in the PIP view QLab lives in the top strip
  // and the leftFrame ID is reused for that strip, so we don't toggle it.
  const lf = $('leftFrame');
  if (lf && lf.dataset.role !== 'top-strip') {
    lf.classList.toggle('hidden',
      !(s.qlab && s.qlab.enabled && s.display.showQlabCue !== false));
  }

  // Main timer header — also pull the speaker from the matching running
  // order item if there is one, so the subtitle under the title reads
  // like a presentation slide.
  const t = s.timers.find(x => x.id === s.activeTimerId);
  const ro = s.runningOrder || {};
  const items = ro.items || [];
  const idx = ro.currentIndex | 0;
  const cur = items[idx];
  if (t) {
    $('mainTimerName').textContent = (t.name || 'TIMER').toUpperCase();
    $('mainTimerDuration').textContent = '/ ' + fmt(t.durationMs, true);

    // Speaker subtitle — show only if the current running-order item has
    // one AND the active timer's name matches the item's title (so we
    // don't display a stale speaker after the user manually overrides
    // the timer name).
    const spk = $('mainTimerSpeaker');
    if (cur && cur.speaker && cur.name === t.name) {
      spk.textContent = cur.speaker;
      spk.classList.add('shown');
    } else {
      spk.textContent = '';
      spk.classList.remove('shown');
    }

    // Warning state classes (digit text is written only by the heartbeat).
    const block = $('mainTimerBlock');
    block.classList.remove('warn-yellow', 'warn-red', 'overrun');
    if (t.overrun) block.classList.add('overrun');
    else if (t.remainingMs / 1000 <= t.warnRedSec) block.classList.add('warn-red');
    else if (t.remainingMs / 1000 <= t.warnYellowSec) block.classList.add('warn-yellow');
  }

  // Side timers (non-active). Reconcile in place so newly-added rows get
  // an entry animation; removed rows just disappear. We don't wipe the
  // whole list on every change, otherwise every reorder would re-trigger
  // the pop-up animation on unchanged rows.
  const sideWrap = $('sideTimersWrap');
  const others = s.timers.filter(x =>
    x.id !== s.activeTimerId && (x.running || x.overrun)
  );
  const wantedIds = new Set(others.map(x => x.id));
  for (const node of [...sideWrap.querySelectorAll('.sideTimer')]) {
    if (!wantedIds.has(node.dataset.id)) node.remove();
  }
  for (const x of others) {
    let node = sideWrap.querySelector(`.sideTimer[data-id="${x.id}"]`);
    if (!node) {
      node = document.createElement('div');
      node.className = 'sideTimer appearing';
      node.dataset.id = x.id;
      const pr = document.createElement('div'); pr.className = 'stProgress';
      const n  = document.createElement('div'); n.className = 'stName'; n.textContent = x.name;
      const tm = document.createElement('div'); tm.className = 'stTime'; tm.textContent = '—';
      node.appendChild(pr); node.appendChild(n); node.appendChild(tm);
      sideWrap.appendChild(node);
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('appearing')));
    } else {
      const nm = node.querySelector('.stName');
      if (nm.textContent !== x.name) nm.textContent = x.name;
    }
  }
  for (const node of sideWrap.querySelectorAll('.sideTimer')) {
    const x = s.timers.find(y => y.id === node.dataset.id);
    if (!x) continue;
    node.classList.remove('warn-yellow', 'warn-red', 'overrun', 'paused');
    if (x.overrun) node.classList.add('overrun');
    else if (x.remainingMs / 1000 <= x.warnRedSec) node.classList.add('warn-red');
    else if (x.remainingMs / 1000 <= x.warnYellowSec) node.classList.add('warn-yellow');
    if (!x.running) node.classList.add('paused');
  }
  const tsec = $('timersSection');
  if (tsec) tsec.classList.toggle('hidden', others.length === 0);

  // Message overlay
  const m = $('message');
  if (m) {
    if (s.message && s.message.visible && s.message.text) {
      const changed = m.textContent !== s.message.text || !m.classList.contains('show');
      m.textContent = s.message.text;
      m.style.color = s.message.color || '#fff';
      m.classList.add('show');
      if (changed) fitMessage(m);
      m.classList.toggle('flash', !!s.message.flash);
    } else {
      m.classList.remove('show', 'flash');
    }
  }
}

// Shrink a long message until it fits its box (the CSS size suits short
// ones like "STAND BY"; a sentence would otherwise be clipped off-screen).
function fitMessage(m) {
  m.style.fontSize = '';
  let px = parseFloat(getComputedStyle(m).fontSize);
  for (let i = 0; i < 30 && px > 12 && m.scrollHeight > m.clientHeight + 1; i++) {
    px *= 0.9; m.style.fontSize = px + 'px';
  }
}
window.addEventListener('resize', () => { const m = $('message'); if (m && m.classList.contains('show')) fitMessage(m); });

// --- 1-Hz heartbeat: sole writer of every visible digit on screen, aligned
// to wall-clock seconds. This is why all readouts flip in unison.
let pulseDownTimer = null;
function heartbeat() {
  scheduleNextHeartbeat();
  paintDigits();
}
// Also called once by output.html after it swaps layouts (still the only digit writer).
function paintDigits() {
  if (!last) return;
  const s = last;
  const now = nowMs();

  // Main timer digits + progress bars
  const t = s.timers.find(x => x.id === s.activeTimerId);
  if (t) {
    const rem = projectRemaining(t.running, t.startedAt, t.durationMs, t.remainingMs, now);
    const ms = t.overrun ? -t.overrunMs : rem;
    $('mainTimerDigits').textContent = fmt(ms, s.display.showSeconds !== false);

    if (pulseDownTimer) { clearTimeout(pulseDownTimer); pulseDownTimer = null; }
    if (t.overrun) {
      $('mainTimerDigits').style.opacity = '1';
      pulseDownTimer = setTimeout(() => { $('mainTimerDigits').style.opacity = '0.4'; }, 500);
    } else {
      $('mainTimerDigits').style.opacity = '1';
    }
  }

  // Side timers (non-active), same heartbeat → same wall-second flip.
  for (const node of $('sideTimersWrap').querySelectorAll('.sideTimer')) {
    const x = s.timers.find(y => y.id === node.dataset.id);
    if (!x) continue;
    const rem = projectRemaining(x.running, x.startedAt, x.durationMs, x.remainingMs, now);
    const ms = x.overrun ? -x.overrunMs : rem;
    node.querySelector('.stTime').textContent = fmt(ms, true);
  }

  // QLab — Running cues (full list).
  const runWrap = $('qlabRunning');
  if (runWrap) {
    const running = (s.qlab && Array.isArray(s.qlab.runningCues)) ? s.qlab.runningCues : [];
    const wantIds = new Set(running.map(c => c.uniqueId));
    for (const node of [...runWrap.querySelectorAll('.cueRow')]) {
      if (!wantIds.has(node.dataset.uid)) node.remove();
    }
    if (running.length === 0) {
      if (!runWrap.querySelector('.cueRow.empty')) {
        runWrap.innerHTML = '';
        const row = document.createElement('div');
        row.className = 'cueRow empty';
        row.innerHTML =
          '<div class="cueProgress"></div>' +
          '<div class="cueName">nothing playing</div>' +
          '<div class="cueTime"></div>';
        runWrap.appendChild(row);
      }
    } else {
      const placeholder = runWrap.querySelector('.cueRow.empty');
      if (placeholder) placeholder.remove();
      for (const c of running) {
        let row = runWrap.querySelector(`.cueRow[data-uid="${c.uniqueId}"]`);
        if (!row) {
          row = document.createElement('div');
          row.className = 'cueRow appearing';
          row.dataset.uid = c.uniqueId;
          row.innerHTML =
            '<div class="cueProgress"></div>' +
            '<div class="cueName">—</div>' +
            '<div class="cueTime">' +
              '<span class="cueTimeValue"></span>' +
              '<span class="loopBadge hidden"></span>' +
            '</div>';
          runWrap.appendChild(row);
          requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('appearing')));
        }
        const rem = projectRemaining(true, c.startedAt, c.durationMs, c.remainingMs, now, true);
        const label = c.cueNumber ? `Q${c.cueNumber} · ${c.name || ''}` : (c.name || 'cue');
        row.querySelector('.cueName').textContent = label;
        row.querySelector('.cueTimeValue').textContent = `${fmt(rem, true)} / ${fmt(c.durationMs, true)}`;
        row.classList.toggle('done', rem <= 0 && c.durationMs > 0);

        const badge = row.querySelector('.loopBadge');
        if (c.looping) {
          badge.classList.remove('hidden');
          badge.textContent = (c.loopsRemaining != null && c.loopsRemaining > 0)
            ? `↻ ${c.loopsRemaining}`
            : '↻';
        } else {
          badge.classList.add('hidden');
        }
      }
    }
  }

  // QLab — Next-on-GO (playhead)
  const next = s.qlab && s.qlab.nextCue;
  const nextRow = $('qlabNext');
  if (nextRow) {
    if (next && (next.name || next.cueNumber)) {
      const label = next.cueNumber ? `Q${next.cueNumber} · ${next.name || ''}` : next.name;
      nextRow.querySelector('.cueName').textContent = label;
      nextRow.querySelector('.cueTime').textContent = next.durationMs > 0 ? fmt(next.durationMs, true) : '';
      nextRow.classList.remove('empty');
    } else {
      nextRow.querySelector('.cueName').textContent = '—';
      nextRow.querySelector('.cueTime').textContent = '';
      nextRow.classList.add('empty');
    }
  }

  // Wall clock — anchored to the wall-second tick along with every other
  // digit on the page.
  const cbv = $('clockBottomValue');
  if (cbv) {
    const d = new Date(now);
    const pad = n => String(n).padStart(2, '0');
    let h = d.getHours();
    const ampm = s.display.show24h ? '' : (h >= 12 ? ' PM' : ' AM');
    if (!s.display.show24h) { h = h % 12; if (h === 0) h = 12; }
    cbv.textContent = `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ampm}`;
  }
}

function scheduleNextHeartbeat() {
  const delay = 1000 - (Date.now() % 1000) + 20;
  setTimeout(heartbeat, delay);
}
scheduleNextHeartbeat();
updatePipInfo();

// --- Smooth-paint loop: 60 fps, updates ONLY the progress bar widths.
function smoothPaint() {
  requestAnimationFrame(smoothPaint);
  if (!last || !$('mainTimerProgress')) return;   // layout fragment not swapped in yet
  const s = last;
  const now = nowMs();

  const t = s.timers.find(x => x.id === s.activeTimerId);
  if (t) {
    const rem = projectRemaining(t.running, t.startedAt, t.durationMs, t.remainingMs, now);
    const dur = Math.max(1, t.durationMs);
    const pct = Math.max(0, Math.min(100, ((dur - Math.max(0, rem)) / dur) * 100));
    $('mainTimerProgress').style.width = pct.toFixed(3) + '%';
  }

  for (const node of document.querySelectorAll('#sideTimersWrap .sideTimer')) {
    const x = s.timers.find(y => y.id === node.dataset.id);
    if (!x) continue;
    const rem = projectRemaining(x.running, x.startedAt, x.durationMs, x.remainingMs, now);
    const dur = Math.max(1, x.durationMs);
    const pct = Math.max(0, Math.min(100, ((dur - Math.max(0, rem)) / dur) * 100));
    const fill = node.querySelector('.stProgress');
    if (fill) fill.style.width = pct.toFixed(3) + '%';
  }

  // QLab running cue bars. For looping cues we want the bar to also loop —
  // grow from 0 to 100 % within each cycle. Use modulo on the live elapsed.
  const running = (s.qlab && Array.isArray(s.qlab.runningCues)) ? s.qlab.runningCues : [];
  for (const c of running) {
    const row = document.querySelector(`#qlabRunning .cueRow[data-uid="${c.uniqueId}"]`);
    if (!row || !c.durationMs) continue;
    const elapsedTotal = (c.startedAt != null) ? (now - c.startedAt) : 0;
    const elapsedInCycle = ((elapsedTotal % c.durationMs) + c.durationMs) % c.durationMs;
    const pct = (elapsedInCycle / c.durationMs) * 100;
    const fill = row.querySelector('.cueProgress');
    if (fill) fill.style.width = pct.toFixed(3) + '%';
  }
}
requestAnimationFrame(smoothPaint);

function connect() {
  if (window.NO_LOCAL_WS) return;   // relay mode: output.html owns the connection
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { window.viewerWs = ws; if (window.outputOnOpen) window.outputOnOpen(ws); const off = $('offline'); if (off) off.style.display = 'none'; document.body.classList.add('connected'); };
  ws.onclose = () => { const off = $('offline'); if (off) off.style.display = 'block'; document.body.classList.remove('connected'); setTimeout(connect, 1000); };
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'tick' || d.type === 'state') applyState(d.state);
    else if (window.outputOnMessage) window.outputOnMessage(d);   // acks etc.
  };
}
connect();

document.addEventListener('click', e => {
  if (document.body.dataset.layout === 'remote' || (e.target.closest && e.target.closest('#unlock'))) return;   // phone page / edit panel: no fullscreen
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
});
