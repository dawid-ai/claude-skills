// Builds well-formed events by hand: used by the test fixtures and by the demo session.
import { ulid, SCHEMA } from './util.mjs';
import { testInfo, gitOp } from './parse.mjs';

export class Sim {
  constructor({ sid = 's1', start = Date.now() - 4 * 3600e3, cwd = '/work/app', demo = false } = {}) {
    this.sid = sid; this.t = start; this.cwd = cwd; this.demo = demo; this.n = 0; this.tool = 0; this.pid = 0; this.events = [];
  }
  adv(min = 0.2) { this.t += min * 60000; return this; }
  ev(kind, d = {}, o = {}) {
    this.n++;
    const rnd = Buffer.alloc(10); rnd.writeUInt32BE(this.n, 6);
    const e = {
      v: SCHEMA, id: ulid(Math.round(this.t), rnd), sid: o.sid || this.sid, ts: new Date(Math.round(this.t)).toISOString(), hook: o.hook || kind, kind,
      actor: o.actor || 'main', prompt_id: o.prompt_id ?? (this.pid ? this.sid + ':p' + this.pid : null), cwd: this.cwd, d: this.demo ? { ...d, demo: true } : d,
    };
    if (o.agent) e.agent_type = o.agent;
    if (o.tp) e.tp = o.tp;
    this.events.push(e);
    return e;
  }
  start(source = 'startup', model = 'claude-sonnet-5-5') { return this.ev('session.start', { source, model }); }
  prompt(text) { this.pid++; return this.ev('prompt', { text }, { actor: 'human' }); }
  pre(tool, input = {}, o = {}) { this.tool++; const id = 'tu' + this.tool; this.ev('tool.pre', { tool, tool_use_id: id, input }, o); return id; }
  post(tool, input = {}, { ok = true, out = '', id, extra = {}, ...o } = {}) {
    id = id || 'tu' + (++this.tool);
    return this.ev(ok ? 'tool.post' : 'tool.fail', { tool, tool_use_id: id, ok, input, out, ...extra }, o);
  }
  /** pre + post pair with a duration in minutes */
  call(tool, input, { dur = 0.1, ...rest } = {}) { const id = this.pre(tool, input, rest); this.adv(dur); return this.post(tool, input, { id, ...rest }); }
  bash(command, { ok = true, out = '', git, ...o } = {}) {
    const extra = {};
    const t = testInfo(command, out, ok);
    if (t) extra.test = t;
    const g = gitOp(command);
    if (g) extra.git = { op: g.op, args: g.args, ...(git || {}) };
    return this.call('Bash', { command }, { ok, out, extra, ...o });
  }
  stop(text, o = {}) { return this.ev('turn.end', { last: text }, o); }
  subStart(id, type, name) { return this.ev('subagent.start', { agent_type: type, name: name || null }, { actor: 'agent:' + id, agent: type }); }
  subStop(id, type, text) { return this.ev('subagent.stop', { last: text }, { actor: 'agent:' + id, agent: type }); }
}
export const JEST_RED = (f) => `FAIL src/limiter.test.js\n  ● limiter › refills tokens\n    expected 5 received 4\nTests: ${f} failed, 3 passed, ${f + 3} total`;
export const JEST_GREEN = 'Tests: 6 passed, 6 total';
