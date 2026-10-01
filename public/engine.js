'use strict';

// Inertial-delay event-driven simulator for NOT / AND / OR gate networks.
//
// Time is an integer tick. Internal events carry a unique id. A gate
// re-evaluates whenever one of its inputs changes; if the ideal value
// equals the current output the pending flip is cancelled, and if the
// desired flip changes the old pending event is superseded. Cancelled
// or superseded events never appear in the delivered trajectory.

/** Evaluate a gate's ideal value from its (already resolved) input values. */
function idealValue(type, inputValues) {
  if (type === 'NOT') return inputValues[0] === 1 ? 0 : 1;
  if (type === 'AND') return inputValues.some((v) => v === 0) ? 0 : 1;
  if (type === 'OR') return inputValues.some((v) => 1) ? 1 : 0;
  throw new Error(`unknown gate type: ${type}`);
}

/** Validate and normalize an external review request. */
function normalizeConfig(raw) {
  const errors = [];
  const cfg = {
    gates: [],      // { id, type, delay, inputs: [wire...] }
    edges: [],      // { input, tick, to }
    monitored: [],  // wire names
    gateById: new Map(),
  };

  const rawGates = Array.isArray(raw?.gates) ? raw.gates : [];
  if (rawGates.length > 12) {
    errors.push({ code: 'TOO_MANY_GATES', message: `门数量上限为 12，当前 ${rawGates.length} 个` });
  }

  const seenIds = new Set();
  for (const g of rawGates.slice(0, 12)) {
    const id = String(g?.id ?? '').trim();
    const type = String(g?.type ?? '').toUpperCase();
    const delay = Number(g?.delay);
    if (!id) errors.push({ code: 'EMPTY_GATE_ID', message: '存在缺少唯一标识的门' });
    else if (seenIds.has(id)) errors.push({ code: 'DUPLICATE_GATE_ID', message: `门标识重复：${id}` });
    else seenIds.add(id);
    if (!['NOT', 'AND', 'OR'].includes(type)) {
      errors.push({ code: 'BAD_GATE_TYPE', message: `门 ${id || '?'} 的类型非法（仅允许 NOT/AND/OR）：${g?.type}` });
    }
    if (!Number.isInteger(delay) || delay < 1) {
      errors.push({ code: 'BAD_DELAY', message: `门 ${id || '?'} 的惯性延迟须为正整数，当前：${g?.delay}` });
    }
    const inputs = Array.isArray(g?.inputs)
      ? g.inputs.map((w) => String(w ?? '').trim()).filter((w) => w.length > 0)
      : [];
    if (type === 'NOT' && inputs.length !== 1) {
      errors.push({ code: 'NOT_ARITY', message: `NOT 门 ${id || '?'} 必须且只能有一个输入连线` });
    }
    if (type === 'AND' && inputs.length < 2) {
      errors.push({ code: 'AND_ARITY', message: `AND 门 ${id || '?'} 至少需要两个输入` });
    }
    if (type === 'OR' && inputs.length < 2) {
      errors.push({ code: 'OR_ARITY', message: `OR 门 ${id || '?'} 至少需要两个输入` });
    }
    // Structurally insert gates with any nonnegative integer delay so
    // that zero-delay cycle detection still sees them; delay 0 stays an
    // error and simulation only runs on fully valid configs.
    if (id && ['NOT', 'AND', 'OR'].includes(type) && Number.isInteger(delay) && delay >= 0) {
      const gate = { id, type, delay, inputs };
      cfg.gates.push(gate);
      cfg.gateById.set(id, gate);
    }
  }

  // External inputs = wires feeding gate inputs that no gate drives.
  const externalNames = new Set();
  for (const g of cfg.gates) {
    for (const w of g.inputs) {
      if (!cfg.gateById.has(w)) externalNames.add(w);
    }
  }

  // External edges must not drive a gate-output wire (duplicate drive).
  const rawEdges = Array.isArray(raw?.edges) ? raw.edges : [];
  const seenEdgeKeys = new Set();
  for (const e of rawEdges) {
    const input = String(e?.input ?? '').trim();
    const tick = Number(e?.tick);
    const to = Number(e?.to);
    let fatal = false;
    if (!input) {
      errors.push({ code: 'BAD_EDGE_INPUT', message: '存在缺少输入连线名的边沿' });
      fatal = true;
    } else if (cfg.gateById.has(input)) {
      errors.push({ code: 'DUPLICATE_DRIVER', message: `连线 ${input} 同时被门输出与外部边沿驱动（重复驱动）` });
      fatal = true;
    } else if (!externalNames.has(input)) {
      errors.push({ code: 'DANGLING_WIRE', message: `边沿引用了未被任何门使用的悬空连线：${input}` });
      fatal = true;
    }
    if (!Number.isInteger(tick) || tick < 0) {
      errors.push({ code: 'BAD_EDGE_TICK', message: `边沿 ${input || '?'} 的时刻须为非负整数，当前：${e?.tick}` });
      fatal = true;
    }
    if (to !== 0 && to !== 1) {
      errors.push({ code: 'BAD_EDGE_VALUE', message: `非法边沿：${input || '?'} 在第 ${e?.tick} 刻的目标值须为 0/1，当前：${e?.to}` });
      fatal = true;
    }
    if (!fatal) {
      const key = `${input}@${tick}`;
      if (seenEdgeKeys.has(key)) {
        errors.push({ code: 'DUPLICATE_EDGE', message: `同一输入在同一刻度存在重复边沿：${key}` });
      } else {
        seenEdgeKeys.add(key);
        cfg.edges.push({ input, tick, to });
      }
    }
  }

  // Monitored outputs must resolve to a gate or a declared external wire.
  const monitored = Array.isArray(raw?.monitored)
    ? raw.monitored.map((w) => String(w ?? '').trim()).filter((w) => w.length > 0)
    : [];
  const monSeen = new Set();
  for (const w of monitored) {
    if (monSeen.has(w)) continue;
    monSeen.add(w);
    cfg.monitored.push(w);
    if (!cfg.gateById.has(w) && !externalNames.has(w)) {
      errors.push({ code: 'DANGLING_WIRE', message: `受监控输出连线不存在（悬空）：${w}` });
    }
  }

  // Cycles. All delays must be positive; a cycle containing a
  // zero-delay gate is an illegal combinational hazard. This structural
  // check runs even when other errors exist, so every problem is listed.
  {
    const cyc = findCycle(cfg);
    if (cyc.length && cyc.slice(0, -1).some((id) => cfg.gateById.get(id).delay === 0)) {
      errors.push({ code: 'ZERO_DELAY_CYCLE', message: `环内存在零延迟门：${cyc.join(' → ')}` });
    }
  }

  cfg.externalInputs = [...externalNames].sort();
  cfg.edges.sort((a, b) => (a.tick - b.tick) || a.input.localeCompare(b.input) || a.to - b.to);
  cfg.errors = dedupeErrors(errors);
  cfg.ok = cfg.errors.length === 0;
  return cfg;
}

function dedupeErrors(errors) {
  const seen = new Set();
  const out = [];
  for (const e of errors) {
    const key = `${e.code}:${e.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(e); }
  }
  return out;
}

/** Return node ids on a directed cycle (id repeated at end), or [] if acyclic. */
function findCycle(cfg) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(cfg.gates.map((g) => [g.id, WHITE]));
  const stack = [];
  let found = null;

  const dfs = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    const g = cfg.gateById.get(id);
    for (const w of g.inputs) {
      if (!cfg.gateById.has(w)) continue;
      const c = color.get(w);
      if (c === GRAY) {
        found = [...stack.slice(stack.indexOf(w)), w];
        return true;
      }
      if (c === WHITE && dfs(w)) return true;
    }
    stack.pop();
    color.set(id, BLACK);
    return false;
  };

  for (const g of cfg.gates) {
    if (color.get(g.id) === WHITE && dfs(g.id)) return found;
  }
  return [];
}

/** Tarjan SCC; return the list of SCCs whose members lie on a cycle (size>1 or self-loop). */
function cyclicSccs(cfg) {
  let nextIndex = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const out = [];

  const strongConnect = (v) => {
    index.set(v, nextIndex); low.set(v, nextIndex); nextIndex++;
    stack.push(v); onStack.add(v);
    const g = cfg.gateById.get(v);
    for (const w of g.inputs) {
      if (!cfg.gateById.has(w)) continue;
      if (!index.has(w)) { strongConnect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) { low.set(v, Math.min(low.get(v), index.get(w))); }
    }
    if (low.get(v) === index.get(v)) {
      const scc = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); scc.push(w); } while (w !== v);
      if (scc.length > 1 || g.inputs.includes(v)) out.push(scc);
    }
  };
  for (const g of cfg.gates) if (!index.has(g.id)) strongConnect(g.id);
  return out;
}

/** Set of gate ids that participate in any cyclic SCC. */
function findCyclicGates(cfg) {
  const set = new Set();
  for (const scc of cyclicSccs(cfg)) for (const id of scc) set.add(id);
  return set;
}

/**
 * Simulate the network.
 *
 * Same-tick processing order (stable):
 *   1. external edges (sorted by input name)
 *   2. internal events that become due (sorted by event id)
 *   3. every gate whose inputs changed is re-evaluated once (sorted by id)
 * then time jumps to the next edge or next due event.
 *
 * After the external edge window ends, oscillation is declared once a
 * (gate values + relative pending events) signature repeats.
 */
function simulate(cfg) {
  const SHORT_PULSE_WIDTH = 2;
  const external = new Map(cfg.externalInputs.map((n) => [n, 0]));

  // Normalized initial state at tick 0. Acyclic gates relax from the
  // all-zero seed (externals held at 0) to their fixed point. Gates
  // belonging to a feedback ring (cyclic SCC) seed at 0 and receive
  // initialization events at tick 0 toward their ideal value, so ring
  // dynamics (including fixed-point-free odd inverter rings) emerge
  // through the ordinary event mechanism.
  const cyclicGates = findCyclicGates(cfg);
  const value = new Map(cfg.gates.map((g) => [g.id, 0]));
  for (let pass = 0; pass < cfg.gates.length; pass++) {
    for (const g of cfg.gates) {
      const inputs = g.inputs.map((w) => (cfg.gateById.has(w) ? value.get(w) : 0));
      value.set(g.id, idealValue(g.type, inputs));
    }
  }
  // Cyclic SCCs that failed to reach a fixed point are reset to the
  // all-zero power-up seed, e.g. an odd inverter ring. Their first
  // inertial flips are injected together at tick 0 below.
  const seedSccs = [];
  for (const scc of cyclicSccs(cfg)) {
    const disagree = scc.filter((id) => {
      const g = cfg.gateById.get(id);
      const inputs = g.inputs.map((w) => (cfg.gateById.has(w) ? value.get(w) : 0));
      return idealValue(g.type, inputs) !== value.get(id);
    });
    if (!disagree.length) continue;
    for (const id of scc) value.set(id, 0);
    seedSccs.push(scc);
  }
  const initial = snapshotValues(cfg, value);

  const traces = new Map();
  for (const g of cfg.gates) traces.set(g.id, [{ tick: 0, value: value.get(g.id) }]);
  const extTraces = new Map(cfg.externalInputs.map((n) => [n, [{ tick: 0, value: 0 }]]));

  const events = [];           // delivered internal events
  const cancellations = [];    // { gate, tick, wouldBeDue, to, reason }
  let seq = 0;
  const newId = () => `evt-${++seq}`;
  const pending = new Map();   // gate -> { id, to, due, cause }

  const recordExt = (e) => {
    const tr = extTraces.get(e.input);
    if (tr[tr.length - 1].value !== e.to) tr.push({ tick: e.tick, value: e.to });
  };

  const reconsider = (gateId, tick, causes) => {
    const g = cfg.gateById.get(gateId);
    const inputs = g.inputs.map((w) => (cfg.gateById.has(w) ? value.get(w) : (external.get(w) ?? 0)));
    const want = idealValue(g.type, inputs);
    const cur = value.get(gateId);
    const p = pending.get(gateId);
    if (want === cur) {
      if (p) {
        cancellations.push({ gate: gateId, tick, wouldBeDue: p.due, to: p.to, reason: 'invalidated', eventId: p.id });
        pending.delete(gateId);
      }
      return;
    }
    if (p && p.to === want) return; // identical flip already in flight
    if (p) {
      cancellations.push({ gate: gateId, tick, wouldBeDue: p.due, to: p.to, reason: 'superseded', eventId: p.id });
      pending.delete(gateId);
    }
    pending.set(gateId, { id: newId(), to: want, due: tick + g.delay, cause: [...causes] });
  };

  const edgeByTick = new Map();
  for (const e of cfg.edges) {
    if (!edgeByTick.has(e.tick)) edgeByTick.set(e.tick, []);
    edgeByTick.get(e.tick).push(e);
  }
  const edgeEnd = cfg.edges.reduce((m, e) => Math.max(m, e.tick), 0);

  const signature = (tick) => {
    const gates = [...value.entries()].sort().map(([id, v]) => `${id}=${v}`).join(',');
    const minDue = pending.size ? Math.min(...[...pending.values()].map((e) => e.due)) : tick;
    const evs = [...pending.entries()]
      .map(([id, e]) => `${id}:${e.to}@${e.due - minDue}`)
      .sort()
      .join(';');
    return `${gates}|${evs}`;
  };

  let tick = 0;
  let status = 'stable';

  // Inject the power-up flips of fixed-point-free rings together at tick 0:
  // every ring gate whose ideal value disagrees with its zero seed.
  for (const scc of seedSccs) {
    for (const id of [...scc].sort()) {
      const g = cfg.gateById.get(id);
      const inputs = g.inputs.map((w) => (cfg.gateById.has(w) ? value.get(w) : 0));
      const want = idealValue(g.type, inputs);
      if (want !== 0) pending.set(id, { id: newId(), to: want, due: 0, cause: ['init'] });
    }
  }

  const frames = [{ tick, gates: snapshotValues(cfg, value), pending: snapshotPending(pending, tick) }];
  const sigSeen = new Map();
  let cycle = null;

  for (let guard = 0; guard < 100000; guard++) {
    const touched = new Set();
    const triggerRefs = [];

    // 1. external edges at this tick (stable name order)
    for (const e of [...(edgeByTick.get(tick) || [])].sort((a, b) => a.input.localeCompare(b.input))) {
      if (external.get(e.input) === e.to) continue;
      external.set(e.input, e.to);
      recordExt(e);
      triggerRefs.push(`ext:${e.input}@${e.tick}`);
      for (const g of cfg.gates) if (g.inputs.includes(e.input)) touched.add(g.id);
    }

    // 2. due internal events (stable event-id order)
    const landing = [...pending.entries()]
      .filter(([, ev]) => ev.due === tick)
      .sort((a, b) => a[1].id.localeCompare(b[1].id));
    for (const [gateId, ev] of landing) {
      pending.delete(gateId);
      triggerRefs.push(ev.id);
      if (value.get(gateId) === ev.to) continue; // defensive: stale flip
      value.set(gateId, ev.to);
      events.push({ id: ev.id, tick, gate: gateId, to: ev.to, cause: [...ev.cause] });
      const tr = traces.get(gateId);
      if (tr[tr.length - 1].value !== ev.to) tr.push({ tick, value: ev.to });
      for (const g of cfg.gates) if (g.inputs.includes(gateId)) touched.add(g.id);
    }

    // 3. re-evaluate each affected gate exactly once (stable id order)
    for (const gateId of [...touched].sort()) {
      reconsider(gateId, tick, triggerRefs);
    }

    frames.push({ tick, gates: snapshotValues(cfg, value), pending: snapshotPending(pending, tick) });

    // 4. oscillation detection only after the external edge window ended
    if (tick >= edgeEnd && pending.size > 0) {
      const sig = signature(tick);
      if (sigSeen.has(sig)) {
        status = 'oscillating';
        const firstTick = sigSeen.get(sig);
        cycle = {
          firstTick,
          repeatedTick: tick,
          period: tick - firstTick,
          prefix: frames.filter((f) => f.tick <= firstTick),
          loop: frames.filter((f) => f.tick > firstTick && f.tick <= tick),
        };
        break;
      }
      sigSeen.set(sig, tick);
    }

    // 5. advance to next interesting tick
    let next = null;
    if (pending.size) next = Math.min(...[...pending.values()].map((e) => e.due));
    for (const t of edgeByTick.keys()) {
      if (t > tick) next = next === null ? t : Math.min(next, t);
    }
    if (next === null) break;
    if (next <= tick) throw new Error(`scheduler stalled at tick ${tick}`);
    tick = next;
  }

  // Deterministic integer-delay dynamics over finite state must either
  // drain or repeat a signature; if the safety bound is ever reached,
  // never misreport the network as stable.
  if (status === 'stable' && pending.size > 0) {
    status = 'oscillating';
    cycle = cycle || {
      firstTick: null, repeatedTick: null, period: null,
      prefix: frames, loop: [],
      note: '达到仿真安全步数上限仍有待发事件，按未静稳处理',
    };
  }

  const result = {
    status,
    edgeEnd,
    horizon: tick,
    initial,
    final: snapshotValues(cfg, value),
    events,
    cancellations,
    traces: Object.fromEntries([...traces.entries()].sort()),
    externalTraces: Object.fromEntries([...extTraces.entries()].sort()),
    cycle,
    pulses: findPulses(cfg, traces, extTraces, events),
  };
  result.pulses.forEach((p) => { p.causeChain = buildCauseChain(p, events, cfg); });
  return result;
}

function snapshotValues(cfg, value) {
  return Object.fromEntries(cfg.gates.map((g) => [g.id, value.get(g.id)]).sort());
}

function snapshotPending(pending, tick) {
  const minDue = pending.size ? Math.min(...[...pending.values()].map((e) => e.due)) : tick;
  return [...pending.entries()]
    .map(([gate, e]) => ({ eventId: e.id, gate, to: e.to, inTicks: e.due - minDue, dueAt: e.due }))
    .sort((a, b) => a.gate.localeCompare(b.gate));
}

/** Short (<= width 2) pulses on monitored wires, from trace segments. */
function findPulses(cfg, traces, extTraces) {
  const pulses = [];
  for (const wire of cfg.monitored) {
    const tr = traces.get(wire) || extTraces.get(wire);
    if (!tr) continue;
    for (let i = 0; i + 1 < tr.length; i++) {
      const a = tr[i], b = tr[i + 1];
      const width = b.tick - a.tick;
      if (width >= 1 && width <= 2) {
        pulses.push({ wire, pulseLevel: a.value, start: a.tick, end: b.tick, width });
      }
    }
  }
  pulses.sort((a, b) => a.start - b.start || a.wire.localeCompare(b.wire));
  return pulses;
}

/**
 * Recursive causal chain for a pulse: the delivered events (or external
 * edges) at its start and end, expanded through event `cause` references
 * back to the originating external edges.
 */
function buildCauseChain(pulse, events, cfg) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const chain = [];
  const visited = new Set();

  const roots = events.filter((e) => e.gate === pulse.wire && (e.tick === pulse.start || e.tick === pulse.end));
  if (!roots.length) {
    for (const e of cfg.edges) {
      if (e.input === pulse.wire && (e.tick === pulse.start || e.tick === pulse.end)) {
        chain.push({ ref: `ext:${e.input}@${e.tick}`, tick: e.tick, gate: e.input, to: e.to, causedBy: [] });
      }
    }
    return chain;
  }

  const walk = (ev, depth) => {
    const key = `${ev.id}@${depth}`;
    if (visited.has(key) || depth > 12) return;
    visited.add(key);
    chain.push({ ref: ev.id, tick: ev.tick, gate: ev.gate, to: ev.to, causedBy: [...ev.cause] });
    for (const ref of ev.cause) {
      if (ref.startsWith('ext:')) {
        const [, rest] = ref.split('ext:');
        const at = rest.lastIndexOf('@');
        chain.push({ ref, tick: Number(rest.slice(at + 1)), gate: rest.slice(0, at), external: true, causedBy: [] });
      } else {
        const parent = byId.get(ref);
        if (parent) walk(parent, depth + 1);
      }
    }
  };
  for (const r of roots) walk(r, 0);

  // de-duplicate while preserving order
  const seen = new Set();
  return chain.filter((c) => (seen.has(c.ref) ? false : (seen.add(c.ref), true)));
}

/** Deterministic canonical signature of a validated config. */
function canonicalConfig(cfg) {
  if (!cfg.ok) return null;
  return JSON.stringify({
    gates: cfg.gates
      .map((g) => ({ id: g.id, type: g.type, delay: g.delay, inputs: [...g.inputs] }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...cfg.edges]
      .map((e) => ({ ...e }))
      .sort((a, b) => (a.tick - b.tick) || a.input.localeCompare(b.input) || a.to - b.to),
    monitored: [...cfg.monitored].sort(),
  });
}

const EngineApi = { normalizeConfig, simulate, canonicalConfig, idealValue };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EngineApi;
} else if (typeof globalThis !== 'undefined') {
  globalThis.DiscreteEngine = EngineApi;
}
