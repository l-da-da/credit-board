// 额度看板的本地数据服务（独立进程，由计划任务在登录时启动）
// GET  /board   -> 汇总 JSON
// POST /checkin -> 写 force.flag（DSH-CheckinNow 每分钟轮询消费）
// POST /refresh -> 写 refresh.flag（DSH-CreditCollect 每分钟轮询消费）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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

// 服务进程（按需启动）的子进程链被证明不可靠（实测：spawn schtasks 报 ERROR_PATH_NOT_FOUND，
// spawn powershell 后其内部任务注册报拒绝访问），而日历触发创建的任务进程里 schtasks / GUI 都正常。
// 所以本服务不 spawn 任何东西：签到/采集改写 flag 文件（force.flag / refresh.flag），
// 由每分钟轮询的 DSH-CheckinNow / DSH-CreditCollect 在可靠上下文里消费；
// checkinTime 变更由 run-checkin.ps1 每次轮询读 config.json 即时生效，无需重注册任务。

function board() {
  const balance = readJson(path.join(LOG_DIR, 'balance.json')) || {};
  const last = readJson(path.join(LOG_DIR, 'last-result.json')) || {};
  const today = todayLocal();
  const settings = readConfig();
  const expected = (settings && settings.expectedAccounts) || {};
  // 期望账号配置了才参与比对：采集到当前账号则返回布尔，没采集到返回 null（不标红）
  const acctOk = (id, current) => (expected[id]
    ? (current != null && current !== '' ? String(current) === String(expected[id]) : null)
    : undefined);
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
    settings,
    nextRun: nextRun(),
    balanceAt: balance.at || null,
    checkinAt: last.at || null,
    running: {
      checkin: !!running.checkin && Date.now() - running.checkin < 300000,
      refresh: !!running.refresh && Date.now() - running.refresh < 360000,
    },
    apps: [
      {
        id: 'workbuddy',
        name: 'WorkBuddy',
        account: (wbStored && wbStored.account) || null,
        accountOk: acctOk('workbuddy', wbStored && wbStored.account),
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
        account: (ca && ca.account) || null,
        accountOk: acctOk('codearts', ca && ca.account),
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
    // 手动签到：写 force.flag，由每分钟轮询的 DSH-CheckinNow 消费（≤60s 内开始）
    try { fs.writeFileSync(path.join(LOG_DIR, 'force.flag'), '1'); } catch { /* ignore */ }
    running.checkin = Date.now();
    log('checkin requested -> force.flag');
    send(200, { ok: true, started: 'checkin' });
    return;
  }
  if (req.method === 'POST' && url === '/refresh') {
    try { fs.writeFileSync(path.join(LOG_DIR, 'refresh.flag'), '1'); } catch { /* ignore */ }
    running.refresh = Date.now();
    log('refresh requested -> refresh.flag');
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
        if (patch.expectedAccounts && typeof patch.expectedAccounts === 'object' && !Array.isArray(patch.expectedAccounts)) {
          const clean = {};
          for (const [k, v] of Object.entries(patch.expectedAccounts)) {
            if (['workbuddy', 'codearts'].includes(k) && typeof v === 'string' && v.trim()) clean[k] = v.trim();
          }
          next.expectedAccounts = clean;
        }
        const settings = writeConfig(next);
        log(`config updated: ${JSON.stringify(settings)}`);
        send(200, { ok: true, settings, nextRun: nextRun() });
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