import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep } from '../src/lib/redact.mjs';
import { scrubSecrets } from '../src/lib/secrets.mjs';

// 50 planted items. All fake, built to match real formats without being real credentials.
const rep = (c, n) => c.repeat(n);
const SECRETS = [
  'AKIA' + rep('Q7', 8), 'ghp_' + rep('aB3', 12), 'github_pat_' + rep('x9Y', 15), 'glpat-' + rep('z8', 12),
  'xoxb-' + '1234567890-' + rep('abc', 6), 'https://hooks.slack.com/services/T000/B000/' + rep('Xy', 12),
  'sk_live_' + rep('a1B2', 6), 'sk-ant-api03-' + rep('Zz9', 14), 'sk-' + rep('Ab1', 14), 'AIza' + rep('Sy3', 11) + 'ab',
  'ya29.' + rep('Gq7', 10), 'npm_' + rep('Kk4', 13), 'pypi-' + rep('Aq5', 14), 'SG.' + rep('aB1', 8) + '.' + rep('cD2', 8),
  'AC' + 'a1b2c3d4'.repeat(4), 'key-' + 'f0e1d2c3'.repeat(4),
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'Bearer ' + rep('tok', 12),
  'postgres://admin:hunter2pw@db.internal:5432/app', 'mongodb://root:s3cretpass@10.0.0.5:27017/x', 'redis://default:r3disPass@cache.corp:6379',
  'Server=tcp:db.example;Database=x;User Id=sa;Password=Sup3rS3cret;',
  'api_key=' + rep('k', 20), 'SECRET_TOKEN: ' + rep('t9', 10), 'password = "correct horse battery"', 'DB_PASSWD=' + rep('p4', 8),
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\n-----END RSA PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----',
];
const IDENTIFIERS = [
  'maria.lopez@acmecorp.com', 'ops@internal-bank.io', 'https://jira.acmecorp.internal/browse/PAY-12', 'http://localhost:8080/admin',
  'http://192.168.1.20/api', 'https://staging.clientco.com/dashboard', '10.20.30.40', 'build-01.corp', 'C:\\Users\\dawid\\clients\\acme\\billing\\src\\pay.ts',
  '/home/dawid/clients/acme/billing/pay.ts', '/Users/sam/work/zeta/secrets/prod.env', 'src/clients/acme/ledger.ts', '../vendor/acme-sdk/index.js',
];
const NAMES = ['Acme Corp', 'Zeta Bank', 'Project Nightingale', 'Orion Retail'];

test('50 planted secrets, identifiers and names: zero leaks', () => {
  const all = [...SECRETS, ...IDENTIFIERS, ...NAMES];
  assert.ok(all.length >= 45);
  const extra = ['DEPLOY_KEY=' + rep('dK', 12), 'x-token: ' + rep('hh', 10), 'client_secret="' + rep('cs', 12) + '"'];
  const text = [...all, ...extra].map((s, i) => `line ${i}: ${s}`).join('\n');
  const { text: out, report } = redact(text, { deny: NAMES });
  const needles = [
    ...SECRETS.map((s) => s.replace(/^(Bearer |api_key=|SECRET_TOKEN: |password = ")/, '').replace(/["']/g, '')).map((s) => (s.includes('\n') ? s.split('\n')[1] : s)),
    'maria.lopez', 'acmecorp', 'clientco', 'dawid', 'hunter2pw', 'Sup3rS3cret', 's3cretpass', 'r3disPass', '/clients/acme', 'billing/pay', 'secrets/prod', 'acme-sdk', 'ledger.ts',
    '192.168.1.20', '10.20.30.40', 'build-01', ...NAMES, rep('dK', 12), rep('cs', 12),
  ];
  for (const n of needles) assert.ok(!out.includes(n), `leaked: ${n}\n--- output ---\n${out}`);
  assert.ok(report.length >= 40, 'report should list every masked item, got ' + report.length);
  assert.ok(report.every((r) => r.rule && r.preview));
  for (const r of report) assert.ok(r.preview.length <= 3, 'report previews must not echo the secret');
});

test('allow-list keeps what the user whitelists, masks the rest', () => {
  const { text } = redact('see src/engine.mjs and src/secret/plan.mjs for Acme', { allow: ['src/engine.mjs'], deny: ['Acme'] });
  assert.match(text, /src\/engine\.mjs/);
  assert.doesNotMatch(text, /secret\/plan|Acme/);
});

test('ordinary prose, commit hashes, ULIDs and bare filenames survive', () => {
  const s = 'Four failures in limiter.test.js, fixed in 3 min. commit 0123456789abcdef0123456789abcdef01234567 event 01JABCDEFGHJKMNPQRSTVWXYZ0.';
  assert.equal(redact(s).text, s);
});

test('capture-time scrub removes secrets but leaves normal text', () => {
  assert.equal(scrubSecrets('run with api_key=abcdef123456 now'), 'run with api_key=[redacted] now');
  assert.equal(scrubSecrets('plain sentence'), 'plain sentence');
});

test('redactDeep walks nested JSON and reports', () => {
  const { value, report } = redactDeep({ a: ['mail me at x@y.org'], b: { c: 'token=abcdefghijk' } });
  assert.equal(value.a[0], 'mail me at [email]');
  assert.equal(value.b.c, 'token=[redacted]');
  assert.equal(report.length, 2);
});

test('Windows paths in every form found in real logs are masked; times and ratios are not', () => {
  const cases = [
    ['read F:/88_CODE/app/.claude/skills/x/SKILL.md now', 'read [path] now'],
    ['"installPath": "C:\\\\Users\\\\someone\\\\.claude\\\\plugins\\\\cache"', '"installPath": "[path]"'],
    ['use forward slashes (`C:/Users/...`).', 'use forward slashes (`[path]`).'],
    ['C:\\Users\\someone\\AppData\\x.txt', '[path]'],
    ['Exit code: 1 at 10:30, then 11:45; ratio 3:1', 'Exit code: 1 at 10:30, then 11:45; ratio 3:1'],
  ];
  for (const [input, want] of cases) assert.equal(redact(input).text, want, input);
});

test('a multi-word project name is masked with any separator, or none', () => {
  const names = ['nightOwl 512'];
  for (const s of ['nightOwl 512', 'nightowl-512', 'NIGHTOWL_512', 'nightowl/512', 'nightowl|512', 'nightOwl512']) assert.equal(redact(`grep for ${s} first`, { names }).text, 'grep for [repo] first', s);
  assert.equal(redact('nightowl of 512 cells', { names }).text, 'nightowl of 512 cells', 'the words apart are not the name');
});
