// Screenshots every dashboard view in both themes (visual smoke check). usage: node scripts/shots.mjs <port> <outdir>
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const { chromium } = createRequire(execSync('npm root -g').toString().trim() + '/')('playwright');
const [port, out] = [process.argv[2], process.argv[3] || '/tmp/shots'];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const errs = [];
for (const scheme of ['light', 'dark']) {
  for (const [name, w, h] of [['desktop', 1440, 900], ['phone', 390, 800]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errs.push(`${scheme}/${name}: ${e.message}`));
    pg.on('console', (m) => { if (m.type() === 'error') errs.push(`${scheme}/${name} console: ${m.text()}`); });
    for (const v of ['live', 'story', 'threads', 'sessions', 'drafts']) {
      await pg.goto(`http://localhost:${port}/#/${v}`);
      await pg.waitForTimeout(700);
      await pg.screenshot({ path: `${out}/${v}-${name}-${scheme}.png` });
    }
    await ctx.close();
  }
}
await b.close();
console.log(errs.length ? errs.join('\n') : 'no console errors');
