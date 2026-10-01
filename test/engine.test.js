'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeConfig, simulate, canonicalConfig } = require('../src/engine');

// Width-2 short pulse: in rises @1, falls @3; two delay-1 NOT gates act
// as a buffer; g2 output is high from tick 3 to tick 5 (width 2).
function pulseConfig() {
  return normalizeConfig({
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
}

test('width-2 short pulse is reported with causal event chain', () => {
  const cfg = pulseConfig();
  assert.ok(cfg.ok, cfg.errors.map((e) => e.message).join('; '));
  const r = simulate(cfg);
  assert.equal(r.status, 'stable');
  assert.equal(r.pulses.length, 1);
  const p = r.pulses[0];
  assert.equal(p.wire, 'g2');
  assert.equal(p.start, 3);
  assert.equal(p.end, 5);
  assert.equal(p.width, 2);
  // chain reaches back to both external edges through internal events
  const refs = p.causeChain.map((c) => c.ref);
  assert.ok(refs.includes('ext:in@1'), JSON.stringify(refs));
  assert.ok(refs.includes('ext:in@3'), JSON.stringify(refs));
});

test('NOT gate delay 3: reversals at ticks 0 and 1 cancel the stale tick-3 flip', () => {
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
  assert.deepEqual(r.events, [], 'no flip may be delivered');
  assert.ok(r.cancellations.some((c) => c.gate === 'n' && c.wouldBeDue === 3 && c.reason === 'invalidated'),
    JSON.stringify(r.cancellations));
  assert.deepEqual(r.final, { n: 1 });
  assert.equal(r.pulses.length, 0);
});

test('positive-delay feedback chain yields replayable oscillation evidence', () => {
  // An odd inverter ring has no fixed point: three delay-1 NOT gates.
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
  assert.ok(r.cycle, 'cycle evidence must be present');
  assert.ok(r.cycle.period > 0);
  assert.ok(r.cycle.prefix.length >= 1);
  assert.ok(r.cycle.loop.length >= 1);
  // frames carry stable gate values and event identifiers
  for (const f of [...r.cycle.prefix, ...r.cycle.loop]) {
    assert.ok(Number.isInteger(f.tick));
    assert.deepEqual(Object.keys(f.gates).sort(), ['a', 'b', 'c']);
    assert.ok(Array.isArray(f.pending));
  }
});

test('same-tick events are processed in stable order and leave consistent traces', () => {
  const cfg = normalizeConfig({
    gates: [
      { id: 'a', type: 'NOT', delay: 2, inputs: ['in'] },
      { id: 'b', type: 'NOT', delay: 2, inputs: ['in'] },
      { id: 'c', type: 'AND', delay: 1, inputs: ['a', 'b'] },
    ],
    edges: [{ input: 'in', tick: 0, to: 1 }],
    monitored: ['c'],
  });
  assert.ok(cfg.ok);
  const r = simulate(cfg);
  assert.equal(r.status, 'stable');
  // a,b fall @2 -> c (AND) falls @3 exactly once
  const cFalls = r.events.filter((e) => e.gate === 'c' && e.to === 0);
  assert.equal(cFalls.length, 1);
  assert.equal(cFalls[0].tick, 3);
});

test('dangling wire, duplicate drive, illegal edge and zero-delay cycle each error', () => {
  const cfg = normalizeConfig({
    gates: [
      { id: 'x', type: 'AND', delay: 1, inputs: ['ghost'] },
      { id: 'a', type: 'NOT', delay: 0, inputs: ['b'] },
      { id: 'b', type: 'NOT', delay: 1, inputs: ['a'] },
    ],
    edges: [
      { input: 'b', tick: 0, to: 1 },      // duplicate drive of gate output
      { input: 'ghost', tick: -1, to: 1 }, // bad tick
      { input: 'ghost', tick: 2, to: 5 },  // bad value
    ],
    monitored: ['missing'],
  });
  const codes = new Set(cfg.errors.map((e) => e.code));
  assert.ok(codes.has('DANGLING_WIRE'));
  assert.ok(codes.has('DUPLICATE_DRIVER'));
  assert.ok(codes.has('BAD_EDGE_TICK'));
  assert.ok(codes.has('BAD_EDGE_VALUE'));
  assert.ok(codes.has('ZERO_DELAY_CYCLE'));
  assert.equal(cfg.ok, false);
});

test('more than twelve gates and duplicate gate ids are rejected', () => {
  const gates = [];
  for (let i = 0; i < 13; i++) gates.push({ id: `g${i}`, type: 'NOT', delay: 1, inputs: [i === 0 ? 'in' : `g${i - 1}`] });
  gates[5].id = 'g4';
  const cfg = normalizeConfig({ gates, edges: [], monitored: [] });
  const codes = new Set(cfg.errors.map((e) => e.code));
  assert.ok(codes.has('TOO_MANY_GATES'));
  assert.ok(codes.has('DUPLICATE_GATE_ID'));
});

test('canonical signature identifies duplicate configurations', () => {
  const a = pulseConfig();
  const b = pulseConfig();
  // same semantics, edges given in different order
  b.edges.reverse();
  assert.equal(canonicalConfig(a), canonicalConfig(normalizeConfig({
    gates: [
      { id: 'g2', type: 'NOT', delay: 1, inputs: ['g1'] },
      { id: 'g1', type: 'NOT', delay: 1, inputs: ['in'] },
    ],
    edges: [
      { input: 'in', tick: 3, to: 0 },
      { input: 'in', tick: 1, to: 1 },
    ],
    monitored: ['g2'],
  })));
});

test('AND inertial glitch narrower than delay is filtered (no transient output)', () => {
  const cfg = normalizeConfig({
    gates: [{ id: 'o', type: 'AND', delay: 4, inputs: ['p', 'q'] }],
    edges: [
      { input: 'p', tick: 0, to: 1 },
      { input: 'q', tick: 0, to: 1 },
      { input: 'q', tick: 1, to: 0 },
      { input: 'q', tick: 2, to: 1 },
    ],
    monitored: ['o'],
  });
  assert.ok(cfg.ok);
  const r = simulate(cfg);
  assert.equal(r.status, 'stable');
  assert.equal(r.events.length, 1); // only the final rise
  // inertial delay restarts at tick 2 when both inputs are finally 1
  assert.equal(r.events[0].tick, 6);
});
