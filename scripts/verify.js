'use strict';

// One-shot acceptance verification. Exits non-zero on the first failed
// stage. Stages, in order:
//   A. engine acceptance evidence
//      1) width-2 short pulse with causal chain
//      2) delay-3 NOT gate: reversals at tick 0/1 cancel stale tick-3 flip
//      3) positive-delay feedback chain: oscillation evidence
//   B. code test suite (node --test)
//   C. page build
//   D. HTTP /health smoke test against a freshly started server
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { normalizeConfig, simulate } = require('../src/engine');

const ROOT = path.join(__dirname, '..');
let failures = 0;

function stage(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; }) ;
    child.on('error', (e) => resolve({ code: 999, out, err: err + e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function main() {
  console.log('== A. Engine acceptance evidence ==');

  stage('A1 宽度为 2 的短脉冲，附起止刻度、宽度与因果事件链', () => {
    const cfg = normalizeConfig({
      gates: [
        { id: 'g1', type: 'NOT', delay: 1, inputs: ['in'] },
        { id: 'g2', type: 'NOT', delay: 1, inputs: ['g1'] },
      ],
      edges: [
        { input: 'in', tick: 1, to: 1 },
        { input: 'in', tick: 3, to: 0 },
      ],
      monitored: ['g2'],
    });
    assert.ok(cfg.ok, cfg.errors.map((e) => e.message).join('; '));
    const r = simulate(cfg);
    assert.equal(r.status, 'stable');
    assert.equal(r.pulses.length, 1);
    const p = r.pulses[0];
    assert.equal(p.wire, 'g2');
    assert.equal(p.start, 3);
    assert.equal(p.end, 5);
    assert.equal(p.width, 2);
    const refs = p.causeChain.map((c) => c.ref);
    assert.ok(refs.includes('ext:in@1'), `因果链缺少 ext:in@1: ${refs.join(',')}`);
    assert.ok(refs.includes('ext:in@3'), `因果链缺少 ext:in@3: ${refs.join(',')}`);
  });

  stage('A2 延迟 3 的 NOT 门在第 0、1 刻反转，撤销第 3 刻失效翻转', () => {
    const cfg = normalizeConfig({
      gates: [{ id: 'n', type: 'NOT', delay: 3, inputs: ['in'] }],
      edges: [
        { input: 'in', tick: 0, to: 1 },
        { input: 'in', tick: 1, to: 0 },
      ],
      monitored: ['n'],
    });
    assert.ok(cfg.ok);
    const r = simulate(cfg);
    assert.deepEqual(r.events, [], '失效翻转不得落入轨迹');
    assert.ok(
      r.cancellations.some((c) => c.gate === 'n' && c.wouldBeDue === 3 && c.reason === 'invalidated'),
      '缺少对第 3 刻失效翻转的撤销记录'
    );
    assert.deepEqual(r.final, { n: 1 });
  });

  stage('A3 正延迟反馈链产生可回放的振荡证据（前缀 + 循环）', () => {
    const cfg = normalizeConfig({
      gates: [
        { id: 'a', type: 'NOT', delay: 1, inputs: ['c'] },
        { id: 'b', type: 'NOT', delay: 1, inputs: ['a'] },
        { id: 'c', type: 'NOT', delay: 1, inputs: ['b'] },
      ],
      edges: [],
      monitored: ['a', 'b', 'c'],
    });
    assert.ok(cfg.ok);
    const r = simulate(cfg);
    assert.equal(r.status, 'oscillating');
    assert.ok(r.cycle && r.cycle.period > 0, '缺少循环周期');
    assert.ok(r.cycle.prefix.length >= 1, '缺少振荡前缀');
    assert.ok(r.cycle.loop.length >= 1, '缺少循环帧');
    for (const f of [...r.cycle.prefix, ...r.cycle.loop]) {
      for (const p of f.pending) assert.ok(p.eventId && Number.isInteger(p.inTicks));
    }
  });

  if (failures) { finish(); return; }

  console.log('== B. Code tests ==');
  const tests = await run(process.execPath, ['--test', 'test/']);
  if (tests.code === 0) console.log('  PASS  node --test test/');
  else {
    failures++;
    console.error('  FAIL  node --test test/ (exit %s)', tests.code);
    console.error((tests.out + tests.err).split('\n').slice(-25).map((l) => '        ' + l).join('\n'));
    finish();
    return;
  }

  console.log('== C. Page build ==');
  const build = await run(process.execPath, ['scripts/build.js']);
  if (build.code === 0) console.log('  PASS  %s', build.out.trim());
  else {
    failures++;
    console.error('  FAIL  page build\n        %s', (build.out + build.err).trim());
    finish();
    return;
  }

  console.log('== D. HTTP health smoke test ==');
  const PORT = Number(process.env.PORT || 8080);
  const HOST = process.env.HOST || '127.0.0.1';
  const child = spawn(process.execPath, ['scripts/server.js'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });

  const stopServer = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
  try {
    await waitForPort(HOST, PORT, 5000);
    const body = await httpGet(`http://${HOST}:${PORT}/health`);
    const parsed = JSON.parse(body);
    assert.equal(parsed.status, 'ok');
    const page = await httpGet(`http://${HOST}:${PORT}/`);
    assert.ok(page.includes('冗余离散链路瞬态复核台'), '首页内容异常');
    console.log('  PASS  GET /health -> %s', body.trim());
  } catch (err) {
    failures++;
    console.error('  FAIL  health smoke: %s', err.message);
    if (serverLog.trim()) console.error('        %s', serverLog.trim().split('\n').join('\n        '));
  } finally {
    stopServer();
  }

  finish();
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
  });
}

function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host, port, path: '/health' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server did not open ${host}:${port} within ${timeoutMs}ms`));
        else setTimeout(attempt, 120);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt();
  });
}

function finish() {
  if (failures === 0) {
    console.log('\nVERIFY RESULT: PASS');
    process.exit(0);
  }
  console.error(`\nVERIFY RESULT: FAIL (${failures} stage(s) failed)`);
  process.exit(1);
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(2);
});
