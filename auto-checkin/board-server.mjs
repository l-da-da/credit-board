// 额度看板的本地数据服务（独立进程，由计划任务在登录时启动）
// GET  /board   -> 汇总 JSON
// POST /checkin -> 跑 run-checkin.ps1
// POST /refresh -> 跑 collect.ps1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LOG_DIR = path.join(ROOT, 'logs');
const PORT = Number(process.env.CREDIT_BOARD_PORT) || 47122;
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG = path.join(LOG_DIR, 'board-server.log');

const log = (msg) => {
  try { fs.appendFileSync(LOG, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}\n`, 'utf8'); } catch { }
};

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
};
const todayLocal = () => new Date().toLocaleDateString('sv-SE');

function workbuddyLog() {
  try {
    const p = path.join(process.env.USERPROFILE, '.workbuddy', 'logs', 'main.log');
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - 300_000);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('fetchCheckinStatus success'));
    if (!lines.length) return null;
    const rec = JSON.parse(lines[lines.length - 1]);
    const payload = Array.isArray(rec.message) ? rec.message[1] : null;
    if (!payload) return null;
    return {
      date: new Date(rec.timestamp).toLocaleDateString('sv-SE'),
      checkedIn: !!payload.today_checked_in,
      streak: payload.streak_days ?? null,
      todayCredit: payload.today_credit ?? null,
    };
  } catch { return null; }
}

const CONFIG = path.join(ROOT, 'config.json');
function readConfig() {
  try { return { keepOpen: false, checkinTime: '09:30', ...(JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {}) }; }
  catch { return { keepOpen: false, checkinTime: '09:30' }; }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function setCheckinTime() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve) => {
    const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install-task.ps1')], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: ROOT, env,
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => { log(`schedule update failed: ${e.message}`); resolve(false); });
    child.on('exit', (code) => {
      log(`schedule re-registered (exit ${code}) ${out.trim().split('\n').slice(0, 3).join(' | ').slice(0, 200)}`);
      resolve(code === 0);
    });
  });
}
function nextRun() {
  const { checkinTime } = readConfig();
  const m = /^(\d{2}):(\d{2})$/.exec(String(checkinTime || '09:30'));
  if (!m) return null;
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), 0, 0);
  // 今天已经跑过（轮询已暂停）→ 下一次是明天
  let ranToday = false;
  try { ranToday = fs.readFileSync(path.join(LOG_DIR, 'last-run.txt'), 'utf8').trim() === now.toLocaleDateString('sv-SE'); } catch { }
  if (ranToday || next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())} ${p(next.getHours())}:${p(next.getMinutes())}`;
}
const running = { checkin: null, refresh: null };

// 直接启动 GUI 应用在“服务进程→powershell”这条链上会被静默拦截，
// 所以这里只调用计划任务，由任务调度器以用户身份运行脚本。
function runTask(taskName) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn('schtasks.exe', ['/run', '/tn', taskName], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env,
  });
  child.stdout.on('data', (d) => log(`[${taskName}] ${d.toString().trim().slice(0, 200)}`));
  child.stderr.on('data', (d) => log(`[${taskName}!] ${d.toString().trim().slice(0, 200)}`));
  child.on('error', (e) => log(`run ${taskName} failed: ${e.message}`));
  child.on('exit', (code) => log(`run ${taskName} exit ${code}`));
  return Date.now();
}

function board() {
  const balance = readJson(path.join(LOG_DIR, 'balance.json')) || {};
  const last = readJson(path.join(LOG_DIR, 'last-result.json')) || {};
  const today = todayLocal();
  const wb = workbuddyLog();
  const wbLog = wb;
  const wbStored = balance.apps && balance.apps.workbuddy;
  const results = Array.isArray(last.results) ? last.results : [];
  const byApp = Object.fromEntries(results.map((r) => [r.app, r]));
  const doubao = byApp['豆包'];
  const ac = balance.apps && balance.apps.autoclaw;
  const ca = balance.apps && balance.apps.codearts;
  const db = balance.apps && balance.apps.doubao;
  const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : null; };
  const dbNow = db ? num(db.total || db.accumulated) : null;
  const dbNext = db ? num(db.next) : null;
  const dbProgress = dbNow != null && dbNext != null ? { now: dbNow, goal: dbNow + dbNext } : null;

  return {
    at: new Date().toISOString(),
    today,
    settings: readConfig(),
    nextRun: nextRun(),
    balanceAt: balance.at || null,
    checkinAt: last.at || null,
    running: {
      checkin: !!running.checkin && Date.now() - running.checkin < 120000,
      refresh: !!running.refresh && Date.now() - running.refresh < 150000,
    },
    apps: [
      {
        id: 'workbuddy',
        name: 'WorkBuddy',
        account: '熬夜长身体',
        balance: wbStored && wbStored.balance ? `${wbStored.balance} 积分` : null,
        balanceNote: wbStored && wbStored.balance
          ? (wbStored.plan ? `套餐 ${wbStored.plan}` : '积分余额')
          : '点「刷新余额」采集',
        signed: wbLog ? wbLog.checkedIn : (wbStored ? wbStored.checkedIn : null),
        signedNote: wbLog && wbLog.date === today ? `连签 ${wbLog.streak ?? '-'} 天 · 今日 +${wbLog.todayCredit ?? '-'}` : '今日日志未更新',
      },
      {
        id: 'doubao',
        name: '豆包',
        balance: db && (db.total || db.accumulated) ? `${db.total || db.accumulated} 点` : null,
        balanceNote: db && (db.total || db.accumulated) ? `总额度${db.next ? ` · 再攒 ${db.next} 点解锁额外奖励` : ''}` : '点「刷新余额」采集',
        signed: doubao ? !String(doubao.status).includes('fail') : null,
        signedNote: doubao ? String(doubao.detail).slice(0, 90) : '今天还没跑过',
        progress: dbProgress,
      },
      {
        id: 'codearts',
        name: 'CodeArts',
        balance: ca && ca.total ? `${ca.total} 积分` : null,
        balanceNote: ca && ca.total ? (ca.used ? `已用 ${ca.used}` : '积分总量') : '点「刷新余额」采集',
        signed: byApp['CodeArts'] ? !String(byApp['CodeArts'].status).includes('fail') : (ca && typeof ca.signedToday === 'boolean' ? ca.signedToday : null),
        signedNote: byApp['CodeArts'] ? String(byApp['CodeArts'].detail).slice(0, 80) : (ca && typeof ca.signedToday === 'boolean' ? (ca.signedToday ? '活动福利：今日已领' : '活动福利：待签到') : '今天还没采集'),
      },
      {
        id: 'autoclaw',
        name: 'AutoClaw',
        balance: ac && ac.total ? ac.total : null,
        balanceNote: ac && ac.total ? '总积分' : '点「刷新余额」采集',
        signed: null,
        signedNote: '不参与自动签到',
      },
    ],
  };
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...cors });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  if (req.method === 'GET' && (url === '/board' || url === '/')) {
    try { send(200, board()); } catch (e) { send(500, { error: String(e && e.message) }); }
    return;
  }
  if (req.method === 'POST' && url === '/checkin') {
    // 手动签到：放一个 force 标记，让任务里的时间闸门放行
    try { fs.writeFileSync(path.join(LOG_DIR, 'force.flag'), '1'); } catch { /* ignore */ }
    running.checkin = runTask('DSH-CheckinNow');
    send(200, { ok: true, started: 'checkin' });
    return;
  }
  if (req.method === 'POST' && url === '/refresh') {
    running.refresh = runTask('DSH-CreditCollect');
    send(200, { ok: true, started: 'refresh' });
    return;
  }
  if (req.method === 'POST' && url === '/config') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const next = {};
        if (typeof patch.keepOpen === 'boolean') next.keepOpen = patch.keepOpen;
        if (typeof patch.checkinTime === 'string' && /^\d{2}:\d{2}$/.test(patch.checkinTime)) next.checkinTime = patch.checkinTime;
        const settings = writeConfig(next);
        Promise.resolve(settings.checkinTime && next.checkinTime ? setCheckinTime() : true).then(() => {
          log(`config updated: ${JSON.stringify(settings)}`);
          send(200, { ok: true, settings, nextRun: nextRun() });
        });
      } catch (e) { send(400, { error: String(e && e.message) }); }
    });
    return;
  }

  send(404, { error: 'not_found' });
});

server.on('error', (e) => {
  log(`server error: ${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});

server.listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${PORT}`));