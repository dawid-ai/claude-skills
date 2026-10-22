// Subagent status line: one row per agent-panel task that has CTS moments. Reads context.json only (no sqlite, no server),
// so it costs one file read per refresh. Tasks with no moments are left out, which keeps Claude Code's default row.
import { paths, readJson, findRoot } from './util.mjs';

const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);

/** `input` is the JSON Claude Code sends on stdin: base hook fields, `columns`, `tasks`. Returns the stdout lines. */
export function agentLines(input, root = findRoot(input.cwd || process.cwd())) {
  const ctx = readJson(paths(root).context);
  const agents = (ctx && ctx.agents) || {};
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const width = Number(input.columns) > 20 ? Number(input.columns) : 80;
  const out = [];
  for (const t of tasks) {
    if (!t || !t.id) continue;
    let a = agents[t.id] || agents[String(t.id).replace(/^agent[-:]/, '')];
    if (!a && t.agentType) {
      // Fall back to the agent type only when exactly one agent of that type has moments in this session.
      const same = Object.values(agents).filter((x) => x.type === t.agentType && (!input.session_id || x.sid === input.session_id));
      if (same.length === 1) a = same[0];
    }
    if (!a || !a.n) continue;
    const label = t.name || t.agentType || 'agent';
    const desc = t.description ? ` ${t.description}` : '';
    const tail = ` · CTS ● ${a.n} moment${a.n === 1 ? '' : 's'}${a.last ? `: "${a.last}"` : ''}`;
    out.push(JSON.stringify({ id: t.id, content: cut(label + desc, Math.max(10, width - tail.length)) + cut(tail, width) }));
  }
  return out;
}
