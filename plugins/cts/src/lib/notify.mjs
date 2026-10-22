// Notifications for drafts made in 'notify' mode. Each draft is announced once: a draft.notify event records it, so a
// server restart or a reindex never repeats it. Desktop notifications use what the OS ships (no dependencies).
import { spawn } from 'node:child_process';
import { writeHumanEvent } from './log.mjs';

const WIN_TOAST = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode($env:CTS_N_TITLE)) > $null; $x.Item(1).AppendChild($t.CreateTextNode($env:CTS_N_BODY)) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;

/** Fire-and-forget OS notification. Title and body travel as arguments or env vars, never inside a script string. */
export function desktopNotify(title, body, { platform = process.platform, run = spawn } = {}) {
  if (process.env.CTS_NO_NOTIFY) return false;
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  let cmd;
  if (platform === 'win32') cmd = ['powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_TOAST], { ...opts, env: { ...process.env, CTS_N_TITLE: title, CTS_N_BODY: body } }];
  else if (platform === 'darwin') cmd = ['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], opts];
  else cmd = ['notify-send', ['--app-name=CTS', title, body], opts];
  try { const c = run(...cmd); if (c && c.on) c.on('error', () => {}); if (c && c.unref) c.unref(); return true; } catch { return false; }
}

/** Announce every pending 'notify'-mode draft not announced yet. Returns the draft ids announced. */
export function notifyDrafts(pr, { url = null, send = desktopNotify, now = Date.now() } = {}) {
  const cfg = pr.cfg.notify || {};
  const due = pr.engine.drafts.list({ status: 'pending' }, now).filter((x) => x.notify && !x.notified);
  if (!due.length) return [];
  const via = [cfg.desktop !== false && 'desktop', cfg.terminal !== false && 'terminal'].filter(Boolean);
  for (const x of due) writeHumanEvent(pr.root, 'draft.notify', { draft: x.id, via }, { sid: x.sid, actor: 'cts' });
  pr.sync();
  if (via.includes('desktop')) {
    const title = due.length === 1 ? `CTS drafted a ${due[0].channel} post` : `CTS drafted ${due.length} posts`;
    const body = (due.length === 1 ? (due[0].title || due[0].text.split('\n')[0]).slice(0, 120) : 'They are waiting in the review queue.') + (url ? `\n${url}#/drafts` : '');
    send(title, body);
  }
  return due.map((x) => x.id);
}
