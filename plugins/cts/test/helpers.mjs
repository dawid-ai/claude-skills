import { Engine } from '../src/lib/engine.mjs';
import { Sim, JEST_RED, JEST_GREEN } from '../src/lib/sim.mjs';
export { Sim, JEST_RED, JEST_GREEN };
export function run(fn, cfg) {
  const sim = new Sim({ start: Date.parse('2026-10-20T09:00:00Z') });
  const eng = new Engine(cfg);
  fn(sim);
  for (const e of sim.events) eng.push(e);
  return { sim, eng, kinds: eng.listMoments().map((m) => m.kind), moments: eng.listMoments() };
}
