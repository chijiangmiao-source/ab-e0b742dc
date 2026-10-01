'use strict';
/* global DiscreteEngine */

const { normalizeConfig, simulate, canonicalConfig } = DiscreteEngine;

const GATE_TYPES = ['NOT', 'AND', 'OR'];
const STORAGE_DRAFT = 'discrete-review:draft';
const STORAGE_SIGS = 'discrete-review:signatures';

const $ = (sel) => document.querySelector(sel);

const els = {
  gateBody: document.querySelector('#gate-table tbody'),
  edgeBody: document.querySelector('#edge-table tbody'),
  monitored: $('#monitored'),
  hint: $('#form-hint'),
  resultCard: $('#result-card'),
  errorPanel: $('#error-panel'),
  errorList: $('#error-list'),
  conclusion: $('#conclusion-panel'),
  statusBadge: $('#status-badge'),
  dupBadge: $('#dup-badge'),
  canonical: $('#canonical-view'),
  summary: $('#summary'),
  finalBody: document.querySelector('#final-table tbody'),
  pulseList: $('#pulse-list'),
  cancelBody: document.querySelector('#cancel-table tbody'),
  oscPanel: $('#osc-panel'),
  oscMeta: $('#osc-meta'),
  frameBody: document.querySelector('#frame-table tbody'),
  eventBody: document.querySelector('#event-table tbody'),
};

function gateRow(g = {}) {
  const tr = document.createElement('tr');
  tr.className = 'gate-row';
  tr.innerHTML = `
    <td><input class="g-id" value="${escapeAttr(g.id || '')}" placeholder="如 g1" /></td>
    <td>
      <select class="g-type">
        ${GATE_TYPES.map((t) => `<option value="${t}" ${g.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </td>
    <td><input class="g-delay" type="number" min="1" step="1" value="${escapeAttr(g.delay ?? '')}" placeholder="正整数" /></td>
    <td><input class="g-inputs" value="${escapeAttr((g.inputs || []).join(', '))}" placeholder="逗号分隔，如 in, g1" /></td>
    <td><button type="button" class="btn small danger g-del">删</button></td>`;
  tr.querySelector('.g-del').addEventListener('click', () => tr.remove());
  return tr;
}

function edgeRow(e = {}) {
  const tr = document.createElement('tr');
  tr.className = 'edge-row';
  tr.innerHTML = `
    <td><input class="e-input" value="${escapeAttr(e.input || '')}" placeholder="外部连线名" /></td>
    <td><input class="e-tick" type="number" min="0" step="1" value="${escapeAttr(e.tick ?? '')}" /></td>
    <td><input class="e-to" type="number" min="0" max="1" step="1" value="${escapeAttr(e.to ?? '')}" /></td>
    <td><button type="button" class="btn small danger e-del">删</button></td>`;
  tr.querySelector('.e-del').addEventListener('click', () => tr.remove());
  return tr;
}

function escapeAttr(s) {
  return String(s).replace(/[&"]/g, (c) => ({ '&': '&amp;', '"': '&quot;' }[c]));
}

function splitWires(s) {
  return String(s || '').split(/[,，\s]+/).map((w) => w.trim()).filter(Boolean);
}

function collectConfig() {
  const gates = [...document.querySelectorAll('.gate-row')].map((tr) => ({
    id: tr.querySelector('.g-id').value,
    type: tr.querySelector('.g-type').value,
    delay: tr.querySelector('.g-delay').value,
    inputs: splitWires(tr.querySelector('.g-inputs').value),
  }));
  const edges = [...document.querySelectorAll('.edge-row')].map((tr) => ({
    input: tr.querySelector('.e-input').value,
    tick: tr.querySelector('.e-tick').value,
    to: tr.querySelector('.e-to').value,
  }));
  return { gates, edges, monitored: splitWires(els.monitored.value) };
}

function saveDraft() {
  try { localStorage.setItem(STORAGE_DRAFT, JSON.stringify(collectConfig())); } catch { /* ignore */ }
}

function loadDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(STORAGE_DRAFT) || 'null'); } catch { d = null; }
  return d;
}

function renderDraft(d) {
  els.gateBody.innerHTML = '';
  els.edgeBody.innerHTML = '';
  (d?.gates || []).forEach((g) => els.gateBody.appendChild(gateRow(g)));
  (d?.edges || []).forEach((e) => els.edgeBody.appendChild(edgeRow(e)));
  els.monitored.value = (d?.monitored || []).join(', ');
  if (!els.gateBody.children.length) els.gateBody.appendChild(gateRow());
  if (!els.edgeBody.children.length) els.edgeBody.appendChild(edgeRow());
}

function clearAll() {
  els.gateBody.innerHTML = '';
  els.edgeBody.innerHTML = '';
  els.monitored.value = '';
  els.hint.textContent = '草稿已清空，旧结论已清除。';
  els.gateBody.appendChild(gateRow());
  els.edgeBody.appendChild(edgeRow());
  els.resultCard.hidden = true;
  try { localStorage.removeItem(STORAGE_DRAFT); } catch { /* ignore */ }
}

const EXAMPLE = {
  gates: [
    { id: 'g1', type: 'NOT', delay: 1, inputs: ['in'] },
    { id: 'g2', type: 'NOT', delay: 1, inputs: ['g1'] },
  ],
  edges: [
    { input: 'in', tick: 1, to: 1 },
    { input: 'in', tick: 3, to: 0 },
  ],
  monitored: ['g2'],
};

function rememberSignature(sig) {
  let sigs = [];
  try { sigs = JSON.parse(localStorage.getItem(STORAGE_SIGS) || '[]'); } catch { sigs = []; }
  const idx = sigs.indexOf(sig);
  if (idx >= 0) return { duplicate: true, index: idx + 1, total: sigs.length };
  sigs.push(sig);
  try { localStorage.setItem(STORAGE_SIGS, JSON.stringify(sigs)); } catch { /* ignore */ }
  return { duplicate: false, index: sigs.length, total: sigs.length };
}

function valSpan(v) {
  return `<span class="val${v}">${v}</span>`;
}

function renderErrors(errors) {
  els.resultCard.hidden = false;
  els.errorPanel.hidden = false;
  els.conclusion.hidden = true;
  els.statusBadge.className = 'badge error';
  els.statusBadge.textContent = '校验失败';
  els.errorList.innerHTML = errors
    .map((e) => `<li><code>${e.code}</code> — ${e.message}</li>`)
    .join('');
}

let lastFrames = [];
let replayTimer = null;
let replayIndex = 0;

function renderConclusion(cfg, result, sigInfo) {
  els.resultCard.hidden = false;
  els.errorPanel.hidden = true;
  els.conclusion.hidden = false;

  const osc = result.status === 'oscillating';
  els.statusBadge.className = `badge ${osc ? 'osc' : 'stable'}`;
  els.statusBadge.textContent = osc ? '持续振荡（边沿窗口后未静稳）' : '静稳（事件队列排空）';

  els.dupBadge.classList.remove('hidden');
  if (sigInfo.duplicate) {
    els.dupBadge.textContent = `重复配置：与历史第 #${sigInfo.index} 次复核签名一致`;
  } else {
    els.dupBadge.textContent = `新配置（历史第 #${sigInfo.index} 个唯一签名）`;
  }

  els.canonical.textContent = JSON.stringify(JSON.parse(canonicalConfig(cfg)), null, 2);

  els.summary.innerHTML = `
    <p>外部边沿窗口：<b>0 … ${result.edgeEnd}</b> 刻；仿真推进至第 <b>${result.horizon}</b> 刻。</p>
    <p>已交付内部事件 <b>${result.events.length}</b> 个；被撤销 / 取代的待发事件 <b>${result.cancellations.length}</b> 个。</p>
    <p>短脉冲 <b>${result.pulses.length}</b> 个。</p>`;

  els.finalBody.innerHTML = cfg.gates.map((g) => `
    <tr>
      <td>${g.id}</td><td>${g.type}</td><td>${g.delay}</td>
      <td>${valSpan(result.initial[g.id] ?? 0)}</td>
      <td>${valSpan(result.final[g.id] ?? 0)}</td>
    </tr>`).join('');

  // pulses
  if (!result.pulses.length) {
    els.pulseList.innerHTML = '<p class="hint">受监控输出上未发现宽度 ≤ 2 刻度的短脉冲。</p>';
  } else {
    els.pulseList.innerHTML = result.pulses.map((p) => `
      <div class="pulse-card">
        <header>
          <span>输出 <code>${p.wire}</code> 的 ${p.pulseLevel === 1 ? '高' : '低'} 脉冲</span>
          <span>起 ${p.start} → 止 ${p.end}（宽度 ${p.width} 刻）</span>
        </header>
        <div class="meta">宽度 ${p.width} ≤ 2，属可能遗漏的瞬态短脉冲。</div>
        <div class="meta">因果事件链：</div>
        <ol class="chain">
          ${p.causeChain.map((c) => `<li class="${c.external ? 'ext' : ''}">
            <code>${c.ref}</code>：第 ${c.tick} 刻，<code>${c.gate}</code> → ${c.to}
            ${c.external ? '（外部边沿，根因）' : ''}
          </li>`).join('')}
        </ol>
      </div>`).join('');
  }

  // cancellations
  els.cancelBody.innerHTML = result.cancellations.length
    ? result.cancellations.map((c) => `
      <tr>
        <td>${c.tick}</td><td>${c.gate}</td><td><code>${c.eventId}</code></td>
        <td>${c.wouldBeDue}</td><td>${valSpan(c.to)}</td>
        <td>${c.reason === 'invalidated' ? '失效撤销（目标值已等于当前值）' : '被新待发事件取代'}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="hint">无撤销事件。</td></tr>';

  // delivered events
  els.eventBody.innerHTML = result.events.length
    ? result.events.map((ev) => `
      <tr>
        <td>${ev.tick}</td><td><code>${ev.id}</code></td><td>${ev.gate}</td>
        <td>${valSpan(ev.to)}</td>
        <td>${ev.cause.map((c) => `<code>${c}</code>`).join(' ')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="hint">无内部翻转事件。</td></tr>';

  // oscillation replay
  if (osc && result.cycle) {
    const cy = result.cycle;
    els.oscPanel.hidden = false;
    els.oscMeta.textContent =
      `签名首次出现于第 ${cy.firstTick} 刻，第 ${cy.repeatedTick} 刻重现；循环周期 ${cy.period} 刻。` +
      `每帧列出该刻稳定门值与相对待发事件（事件标识:目标值@相对最早待发刻的偏移），可逐帧回放。`;
    lastFrames = [
      ...cy.prefix.map((f) => ({ ...f, seg: '前缀' })),
      ...cy.loop.map((f) => ({ ...f, seg: '循环' })),
    ];
    replayIndex = 0;
    renderFrames(-1);
  } else {
    els.oscPanel.hidden = true;
    lastFrames = [];
    stopReplay();
  }
}

function renderFrames(activeIdx) {
  els.frameBody.innerHTML = lastFrames.map((f, i) => `
    <tr class="${f.seg === '循环' ? 'loop-row' : 'prefix-row'} ${i === activeIdx ? 'active-row' : ''}">
      <td>${f.seg}${f.seg === '循环' ? ` #${i - lastFrames.findIndex((x) => x.seg === '循环')}` : ''}</td>
      <td>${f.tick}</td>
      <td class="gates-cell">${Object.entries(f.gates).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
      <td class="pending-cell">${f.pending.length
        ? f.pending.map((p) => `${p.eventId}:${p.gate}→${p.to}@${p.inTicks}`).join('  ')
        : '∅'}</td>
    </tr>`).join('');
  $('#replay-pos').textContent = lastFrames.length
    ? `帧 ${activeIdx + 1} / ${lastFrames.length}（第 ${lastFrames[Math.max(0, activeIdx)]?.tick ?? '-'} 刻）`
    : '';
}

function stopReplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
}

function stepReplay() {
  if (!lastFrames.length) return;
  replayIndex = Math.min(replayIndex, lastFrames.length - 1);
  renderFrames(replayIndex);
  replayIndex++;
  if (replayIndex >= lastFrames.length) {
    replayIndex = lastFrames.findIndex((f) => f.seg === '循环');
    if (replayIndex < 0) replayIndex = 0;
  }
}

function submit() {
  stopReplay();
  els.hint.textContent = '';
  saveDraft();
  const raw = collectConfig();
  const cfg = normalizeConfig(raw);
  if (!cfg.ok) {
    renderErrors(cfg.errors);
    els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  let result;
  try {
    result = simulate(cfg);
  } catch (err) {
    renderErrors([{ code: 'SIM_FAULT', message: `仿真器内部故障：${err.message}` }]);
    return;
  }
  const sig = canonicalConfig(cfg);
  const sigInfo = rememberSignature(sig);
  renderConclusion(cfg, result, sigInfo);
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---- wiring ----
document.addEventListener('DOMContentLoaded', () => {
  $('#btn-add-gate').addEventListener('click', () => els.gateBody.appendChild(gateRow()));
  $('#btn-add-edge').addEventListener('click', () => els.edgeBody.appendChild(edgeRow()));
  $('#btn-clear').addEventListener('click', clearAll);
  $('#btn-submit').addEventListener('click', submit);
  $('#btn-example').addEventListener('click', () => {
    renderDraft(EXAMPLE);
    els.hint.textContent = '已载入宽度 2 短脉冲示例，可直接提交复核。';
    saveDraft();
  });
  $('#btn-replay').addEventListener('click', () => {
    stopReplay();
    replayTimer = setInterval(stepReplay, 900);
  });
  $('#btn-step').addEventListener('click', () => { stopReplay(); stepReplay(); });
  $('#btn-reset-replay').addEventListener('click', () => {
    stopReplay();
    replayIndex = 0;
    renderFrames(-1);
  });

  const draft = loadDraft();
  renderDraft(draft);
});
