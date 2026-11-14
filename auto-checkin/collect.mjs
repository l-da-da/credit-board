// 采集三家客户端的余额快照 → logs/balance.json
// 前提：应用已由 collect.ps1 以调试端口启动；本脚本只负责读界面。
import fs from 'node:fs';
import path from 'node:path';
import { listTargets, connect, evalJs } from './cdp.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const out = { at: new Date().toISOString(), apps: {} };

async function applyViewport(cdp, w = 1208, h = 777) {
  try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(300); } catch { }
}

async function clickBox(cdp, box) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
}

async function findTarget(port, test, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const ts = await listTargets(port);
      const t = ts.find(test);
      if (t) return t;
    } catch { /* app still starting */ }
    await sleep(1000);
  }
  return null;
}

async function connectWithRetry(target, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { return await connect(target.webSocketDebuggerUrl); } catch { await sleep(1500); }
  }
  return null;
}

async function waitReady(cdp, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const st = await evalJs(cdp, `({ ready: document.readyState, len: (document.body && document.body.innerText || '').length })`, true, 6000);
      if (st && st.ready === 'complete' && st.len > 60) return true;
    } catch { /* not ready */ }
    await sleep(1500);
  }
  return false;
}

// ---------- AutoClaw：点右上角积分，读「总积分」 ----------
async function collectAutoClaw() {
  const port = 9532;
  const page = await findTarget(port, (t) => t.type === 'page' && /zwork\.html/.test(t.url));
  if (!page) return null;
  const cdp = await connectWithRetry(page);
  if (!cdp) return null;
  try { await cdp.send('Runtime.enable'); } catch { }
  await applyViewport(cdp);
  if (!(await waitReady(cdp, 90_000))) { cdp.close(); return null; }

  let data = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    const box = await evalJs(cdp, `(() => {
      const cands = [...document.querySelectorAll('div,span,button')].filter(e => {
        const t = (e.innerText || '').trim();
        const r = e.getBoundingClientRect();
        return /^[\\d\\.]+\\s*万?$/.test(t) && r.y < 80 && r.x > innerWidth - 420 && r.width > 20 && r.height > 10;
      });
      if (!cands.length) return null;
      const el = cands[cands.length - 1];
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`).catch(() => null);
    if (!box) { await sleep(2000); continue; }
    await clickBox(cdp, box);
    await sleep(2000);
    data = await evalJs(cdp, `(() => {
      const t = document.body.innerText || '';
      const total = (t.match(/总积分\\s*\\n?\\s*([\\d\\.]+\\s*万?)/) || [])[1] || null;
      const reward = (t.match(/奖励积分\\s*\\n?\\s*([\\d\\.]+\\s*万?)/) || [])[1] || null;
      return total ? { total, reward } : null;
    })()`).catch(() => null);
    if (!data) await sleep(2000);
  }

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  cdp.close();
  return data;
}

// ---------- 豆包：打开「免费用豆包工作」，读累计额度 ----------
async function collectDoubao() {
  const port = 9531;
  const chat = await findTarget(port, (t) => t.type === 'page' && /doubao-chat\/chat/.test(t.url));
  if (!chat) return null;
  const cdp = await connectWithRetry(chat);
  if (!cdp) return null;
  try { await cdp.send('Runtime.enable'); } catch { }
  await applyViewport(cdp);
  if (!(await waitReady(cdp, 90_000))) { cdp.close(); return null; }

  // 打开账号弹窗 → 免费用豆包工作
  const btn = await evalJs(cdp, `(() => {
    const el = [...document.querySelectorAll('button')].find(e => {
      const r = e.getBoundingClientRect();
      return r.y > 690 && r.y < 790 && r.x < 40 && r.width > 180;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`).catch(() => null);
  const alreadyOpen = await evalJs(cdp, `(document.body.innerText||'').includes('添加账号')`).catch(() => false);
  if (!alreadyOpen && btn) { await clickBox(cdp, btn); await sleep(1500); }

  let entry = null;
  for (let i = 0; i < 10 && !entry; i++) {
    entry = await evalJs(cdp, `(() => {
      const el = [...document.querySelectorAll('div,span,button')].find(e => (e.innerText || '').trim() === '免费用豆包工作');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`).catch(() => null);
    if (!entry) await sleep(1000);
  }
  if (!entry) { cdp.close(); return null; }
  await clickBox(cdp, entry);
  await sleep(4000);

  const wv = await findTarget(port, (t) => /agent-explore/.test(t.url), 30_000);
  if (!wv) { cdp.close(); return null; }
  const page = await connectWithRetry(wv);
  if (!page) { cdp.close(); return null; }
  try { await page.send('Runtime.enable'); } catch { }
  await applyViewport(page);
  await waitReady(page, 45_000);

  let text = '';
  for (let i = 0; i < 15; i++) {
    text = await evalJs(page, `(document.body && document.body.innerText) || ''`).catch(() => '');
    if (text && text.includes('累计获得额度')) break;
    await sleep(1000);
  }
  page.close();
  cdp.close();
  if (!text) return null;

  const total = (text.match(/累计获得额度[：:]?\s*\n?\s*([\d,\.]+)\s*点/) || [])[1] || null;
  const next = (text.match(/再积累\s*([\d,\.]+)\s*点/) || [])[1] || null;
  return total ? { total, next } : null;
}

// ---------- CodeArts：头像 → 用量统计里的「积分用量 x / y」 ----------
async function collectCodeArts() {
  const port = 9534;
  const page = await findTarget(port, (t) => t.type === 'page' && !/devtools/.test(t.url));
  if (!page) return null;
  const cdp = await connectWithRetry(page);
  if (!cdp) return null;
  try { await cdp.send('Runtime.enable'); } catch { }
  await applyViewport(cdp, 1440, 900);
  for (let i = 0; i < 40; i++) {
    const ok = await evalJs(cdp, `document.querySelectorAll('.user-avatar').length > 0`).catch(() => false);
    if (ok) break;
    await sleep(1500);
  }
  const avatar = await evalJs(cdp, `(() => {
    const el = document.querySelector('.user-avatar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`).catch(() => null);
  if (!avatar) { cdp.close(); return null; }

  let data = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    await clickBox(cdp, avatar);
    await sleep(2000);
    data = await evalJs(cdp, `(() => {
      const t = document.body.innerText || '';
      const m = t.match(/积分用量\\s*\\n?\\s*([\\d,\\.]+)\\s*\\/\\s*([\\d,\\.]+)/);
      const signed = /每日签到领\\d+积分\\s*\\n?\\s*今日已领/.test(t);
      let account = (t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/) || [])[0] || null;
      if (!account) {
        // 锚定菜单：从「退出」向上找第一个同时包含「积分用量」的容器（头像菜单根部），取首行
        const leaf = [...document.querySelectorAll('*')].filter((e) => !e.childElementCount && /退出/.test(e.innerText || '')).pop();
        if (leaf) {
          for (let p = leaf.parentElement; p; p = p.parentElement) {
            if (/积分用量/.test(p.innerText || '')) {
              const first = (p.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || '';
              if (first && first.length <= 30 && !/积分|用量|签到|退出|检查|更新|设置|活动|个人|账户|账号/.test(first)) account = first;
              break;
            }
          }
        }
      }
      if (!account) {
        const lines = t.split('\\n').map((s) => s.trim()).filter(Boolean);
        const idx = lines.findIndex((s) => s.includes('退出'));
        if (idx > 0) {
          const cand = lines[idx - 1];
          if (cand && cand.length <= 30 && !/积分|签到|用量|设置|活动|退出|检查|更新|帮助|版本|关于/.test(cand)) account = cand;
        }
      }
      return m ? { used: m[1], total: m[2], signedToday: signed, account } : (account ? { account } : null);
    })()`).catch(() => null);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  cdp.close();
  return data;
}
// ---------- WorkBuddy：点头像读「积分余额」 ----------
async function collectWorkBuddyPanel() {
  const port = 9533;
  const page = await findTarget(port, (t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) return null;
  const cdp = await connectWithRetry(page);
  if (!cdp) return null;
  try { await cdp.send('Runtime.enable'); } catch { }
  await applyViewport(cdp, 1280, 800);
  for (let i = 0; i < 40; i++) {
    const ok = await evalJs(cdp, `document.querySelectorAll('.user-menu-trigger').length > 0`).catch(() => false);
    if (ok) break;
    await sleep(1500);
  }
  const btn = await evalJs(cdp, `(() => {
    const el = document.querySelector('.user-menu-trigger');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`).catch(() => null);

  let data = null;
  for (let attempt = 0; attempt < 3 && !data && btn; attempt++) {
    await clickBox(cdp, btn);
    await sleep(2000);
    data = await evalJs(cdp, `(() => {
      const t = document.body.innerText || '';
      const m = t.match(/积分余额\\s*\\n?\\s*([\\d,\\.]+)/);
      const plan = (t.match(/套餐\\s*\\n?\\s*([^\\n]{1,12})/) || [])[1] || null;
      let account = null;
      const trig = document.querySelector('.user-menu-trigger');
      const trigText = trig ? (trig.innerText || '').trim() : '';
      if (trigText && trigText.length <= 20 && !/积分|套餐|余额/.test(trigText)) account = trigText;
      if (!account) {
        const leaf = [...document.querySelectorAll('*')].filter((e) => !e.childElementCount && /积分余额/.test(e.innerText || '')).pop();
        if (leaf) {
          let root = leaf;
          for (let i = 0; i < 8 && root.parentElement; i++) {
            const p = root.parentElement;
            if (/套餐/.test(p.innerText || '')) root = p; else break;
          }
          const first = (root.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)[0] || '';
          if (first && first.length <= 20 && !/积分|套餐|余额|workbuddy/i.test(first)) account = first;
        }
      }
      return m ? { balance: m[1], plan, account } : null;
    })()`).catch(() => null);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }).catch(() => {});
  cdp.close();
  return data;
}
// ---------- WorkBuddy：从日志读今日签到信息（余额客户端内才有） ----------
function collectWorkBuddy() {
  try {
    const p = path.join(process.env.USERPROFILE, '.workbuddy', 'logs', 'main.log');
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - 400_000);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('fetchCheckinStatus success'));
    if (!lines.length) return null;
    const rec = JSON.parse(lines[lines.length - 1]);
    const obj = Array.isArray(rec.message) ? rec.message[1] : null;
    if (!obj) return null;
    return { checkedIn: !!obj.today_checked_in, streak: obj.streak_days ?? null, todayCredit: obj.today_credit ?? null };
  } catch { return null; }
}

// 采集失败时保留上一次的读数，避免看板空白
let prev = {};
try { prev = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'balance.json'), 'utf8')).apps || {}; } catch { prev = {}; }

const wbLog = collectWorkBuddy();
let wbPanel = null;
try { wbPanel = await collectWorkBuddyPanel(); } catch { wbPanel = null; }
out.apps.workbuddy = { ...(prev.workbuddy || {}), ...(wbLog || {}), ...(wbPanel || {}) };
try { out.apps.autoclaw = (await collectAutoClaw()) || prev.autoclaw || null; } catch { out.apps.autoclaw = prev.autoclaw || null; }
try { out.apps.doubao = (await collectDoubao()) || prev.doubao || null; } catch { out.apps.doubao = prev.doubao || null; }
try { out.apps.codearts = (await collectCodeArts()) || prev.codearts || null; } catch { out.apps.codearts = prev.codearts || null; }
out.stale = !out.apps.autoclaw || !out.apps.doubao;

fs.writeFileSync(path.join(LOG_DIR, 'balance.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));