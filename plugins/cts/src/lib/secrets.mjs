// High-confidence secret patterns. Used at capture time (so secrets never enter the log)
// and again by the full redactor at the publishing boundary.
export const SECRET_RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['aws-access-key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{16,}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g],
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['google-oauth', /\bya29\.[0-9A-Za-z_-]{20,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ['pypi-token', /\bpypi-[A-Za-z0-9_-]{30,}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
  ['twilio-key', /\b(?:SK|AC)[0-9a-f]{32}\b/g],
  ['mailgun-key', /\bkey-[0-9a-f]{32}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['bearer-token', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  ['basic-auth-url', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gi],
  ['connection-string', /\b(?:Server|Data Source|Host)=[^;\n]+;[^\n]*?(?:Password|Pwd)=[^;\n]+/gi],
  ['kv-secret', /\b([A-Za-z0-9_.-]*(?:api[_-]?key|[_-]key|secret|token|passw(?:or)?d|pwd|auth|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi],
];

/** Replace secrets with [redacted]. Returns {text, hits:[{rule,len}]}. */
export function scrubWithHits(text) {
  const hits = [];
  if (!text || typeof text !== 'string') return { text, hits };
  let out = text;
  for (const [rule, re] of SECRET_RULES) {
    re.lastIndex = 0;
    if (rule === 'kv-secret') {
      out = out.replace(re, (m, k, sep, v) => {
        const q = /^["']/.test(v) ? v[0] : '';
        if (/^\[redacted/.test(q ? v.slice(1) : v)) return m;
        hits.push({ rule, len: v.length });
        return k + sep + q + '[redacted]' + q;
      });
    } else {
      out = out.replace(re, (m) => { hits.push({ rule, len: m.length }); return '[redacted]'; });
    }
  }
  return { text: out, hits };
}
export function scrubSecrets(text) { return scrubWithHits(text).text; }
