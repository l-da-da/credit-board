// 每日自动签到：WorkBuddy / 豆包
// 由 run-checkin.ps1 调用：应用已经以「最小化、不抢焦点」方式在后台启动，这里只做签到动作。
// 豆包支持多账号：自动切到每个账号签到，最后切回你原来的账号。
// 不修改应用文件、不读取密码、不向任何第三方上传数据。
//
// 用法: runtime\node.exe checkin.mjs [--only=workbuddy|doubao]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listTargets, connect, evalJs } from './cdp.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LOG_DIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const HOME = process.env.USERPROFILE;
const CFG = {
  workbuddy: { name: 'WorkBuddy', proc: 'WorkBuddy', log: path.join(HOME, '.workbuddy', 'logs', 'main.log') },
  doubao: { name: '豆包', proc: 'Doubao', port: 9531 },
  codearts: { name: 'CodeArts', proc: 'CodeArts', port: 9534 },
};

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logLines = [];
function log(...parts) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${parts.join(' ')}`;
  logLines.push(line);
  console.log(line);
  // 立刻落盘，方便卡住时排查
  try { fs.appendFileSync(path.join(LOG_DIR, `checkin-${todayLocal()}.log`), line + '\n', 'utf8'); } catch { }
}

// 本次由脚本启动的应用（run-checkin.ps1 写入）
let launched = {};
try {
  const raw = fs.readFileSync(path.join(LOG_DIR, 'launch.json'), 'utf8').replace(/^\uFEFF/, '');
  launched = JSON.parse(raw) || {};
} catch { launched = {}; }

function tasklist(name) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const m = out.match(/"([^"]+\.exe)","(\d+)"/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

async function waitFor(fn, timeoutMs, intervalMs = 700) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(intervalMs);
  }
  return null;
}

async function cdpReady(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// ---------- 豆包页面操作基础 ----------
// 窗口是最小化的，必须先把视口固定成正常尺寸，否则元素坐标是负的、点不到
async function applyViewport(cdp, w = 1208, h = 777) {
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
  } catch { /* ignore */ }
}

async function clickAt(cdp, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
}
async function clickText(cdp, texts) {
  const box = await evalJs(cdp, `(() => {
    const wanted = ${JSON.stringify(texts)};
    const cands = [];
    for (const el of document.querySelectorAll('button,a,[role=button],div,span,li')) {
      const t = (el.innerText || '').trim();
      if (!wanted.includes(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t, a: r.width * r.height });
    }
    cands.sort((a, b) => a.a - b.a);
    return cands[0] || null;
  })()`);
  if (!box) return null;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  return box;
}

async function pressEsc(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

// 连上豆包主页面（chat）
async function connectChat(port, timeout = 60_000) {
  const chat = await waitFor(async () => {
    const ts = await listTargets(port);
    return ts.find((t) => t.type === 'page' && /doubao-chat\/chat/.test(t.url));
  }, timeout, 1000);
  if (!chat) return null;
  const cdp = await connect(chat.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await applyViewport(cdp);
  // 等界面真正可用（左下角账号按钮出现）再操作
  for (let i = 0; i < 40; i++) {
    const ok = await evalJs(cdp, `(() => [...document.querySelectorAll('button')].some(e => {
      const r = e.getBoundingClientRect();
      return r.y > 690 && r.y < 790 && r.x < 40 && r.width > 180;
    }))()`).catch(() => false);
    if (ok) break;
    await sleep(1500);
  }
  return cdp;
}

// 左下角账号按钮（不同账号文字不同：可能是「昵称」或「昵称\n免费体验」）
async function accountButtonBox(cdp) {
  return evalJs(cdp, `(() => {
    const el = [...document.querySelectorAll('button')].find(e => {
      const r = e.getBoundingClientRect();
      return r.y > 690 && r.y < 790 && r.x < 40 && r.width > 180 && r.height > 38 && r.height < 60;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (el.innerText || '').trim() };
  })()`);
}

// 当前账号名
async function currentAccountName(cdp) {
  const b = await accountButtonBox(cdp);
  return b && b.text ? b.text.split('\n')[0] : null;
}

async function popoverOpen(cdp) {
  return evalJs(cdp, `(document.body.innerText||'').includes('添加账号')`);
}

async function openAccountPopover(cdp) {
  if (await popoverOpen(cdp)) return true;
  for (let i = 0; i < 3; i++) {
    await pressEsc(cdp);
    await sleep(300);
    if (await clickText(cdp, ['关闭', '我知道了', '知道了'])) await sleep(400);
    const btn = await accountButtonBox(cdp);
    if (!btn) { await sleep(800); continue; }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: btn.x, y: btn.y, button: type === 'mouseMoved' ? 'none' : 'left',
        clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
      });
    }
    await sleep(1200);
    if (await popoverOpen(cdp)) return true;
  }
  return false;
}

async function listAccounts(cdp) {
  const ok = await openAccountPopover(cdp);
  if (!ok) return { names: [], current: await currentAccountName(cdp) };
  const names = await evalJs(cdp, `(() => {
    const skip = new Set(['添加账号', '退出登录', '设置', '外观设置', '检查更新', '帮助与更多', '免费用豆包工作', '近 7 天额度消耗']);
    // 找「最小」的包含账号区的容器，避免把整个页面当作容器
    const roots = [...document.querySelectorAll('div')].filter(d => {
      const t = d.innerText || '';
      return t.includes('添加账号') && t.includes('退出登录');
    });
    if (!roots.length) return [];
    roots.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const root = roots[0];
    const out = [];
    for (const el of root.querySelectorAll('div,button,li')) {
      // 账号行可能是昵称，或昵称 + 免费体验徽标，取第一行
      const raw = (el.innerText || '').trim();
      if (!raw) continue;
      const name = raw.split(String.fromCharCode(10))[0].trim();
      if (!name || name.length > 20 || skip.has(name)) continue;
      if (/免费体验|额度消耗|^\d+%$|升级|订阅/.test(name)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 24 || r.height > 50 || r.width < 100) continue;
      if (!out.includes(name)) out.push(name);
    }
    return out;
  })()`);
  const current = await currentAccountName(cdp);
  await pressEsc(cdp);
  return { names, current };
}

// 只在账号弹窗内部按文字点击（避免误点侧边栏同名的文字）
async function clickInPopover(cdp, text) {
  const box = await evalJs(cdp, `(() => {
    const roots = [...document.querySelectorAll('div')].filter(d => {
      const t = d.innerText || '';
      return t.includes('添加账号') && t.includes('退出登录');
    });
    if (!roots.length) return null;
    roots.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const root = roots[0];
    const cands = [];
    for (const el of root.querySelectorAll('div,button,li,span')) {
      if ((el.innerText || '').trim() !== ${JSON.stringify(text)}) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      cands.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), a: r.width * r.height });
    }
    cands.sort((a, b) => a.a - b.a);
    return cands[0] || null;
  })()`);
  if (!box) return null;
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  return box;
}

// 切换到指定账号：点击后页面会整页刷新，旧连接作废，需要重新连
async function switchAccount(port, fromCdp, name) {
  const opened = await openAccountPopover(fromCdp);
  if (!opened) return null;
  const box = await clickInPopover(fromCdp, name);
  if (!box) { log(`豆包：账号列表里没找到「${name}」`); return null; }
  log(`豆包：切换到账号「${name}」…`);

  // 等页面重载并稳定，再重新连接
  const end = Date.now() + 45_000;
  let lastErr = '';
  while (Date.now() < end) {
    await sleep(2000);
    try {
      const ts = await listTargets(port);
      const chat = ts.find((t) => t.type === 'page' && /doubao-chat\/chat/.test(t.url));
      if (!chat) continue;
      const cdp = await connect(chat.webSocketDebuggerUrl);
      await cdp.send('Runtime.enable');
      const st = await evalJs(cdp, `({ ready: document.readyState, len: (document.body?.innerText||'').length })`, true, 8000);
      if (st.ready === 'complete' && st.len > 50) {
        await applyViewport(cdp);
        await sleep(1200);
        const cur = await currentAccountName(cdp);
        if (!cur || cur === name) return cdp;
        cdp.close();
      } else {
        cdp.close();
      }
    } catch (e) { lastErr = e.message; }
  }
  log(`豆包：切换账号超时 ${lastErr}`);
  return null;
}

// 签到弹窗（「今日签到领 200 额度 / 立即签到」）
async function signByPopup(cdp) {
  const has = await evalJs(cdp, `(document.body.innerText||'').includes('立即签到')`);
  if (!has) return null;
  const box = await clickText(cdp, ['立即签到']);
  if (!box) return null;
  await sleep(2500);
  const txt = await evalJs(cdp, `(document.body.innerText||'')`);
  const ok = /签到成功|已签到|明天再来/.test(txt);
  return { status: ok ? 'ok' : 'fail', detail: ok ? '点「立即签到」成功' : '点了「立即签到」但没看到成功提示' };
}

// 兜底：走「免费用豆包工作」里的「每日签到」卡片
async function signByTaskPanel(cdp, port) {
  let wv = (await listTargets(port)).find((t) => /agent-explore/.test(t.url));
  if (!wv) {
    for (let i = 0; i < 5 && !wv; i++) {
      await pressEsc(cdp);
      await sleep(300);
      if (await clickText(cdp, ['关闭', '我知道了', '知道了'])) await sleep(400);
      if (!(await openAccountPopover(cdp))) continue;
      if (!(await clickText(cdp, ['免费用豆包工作']))) continue;
      wv = await waitFor(async () => (await listTargets(port)).find((t) => /agent-explore/.test(t.url)), 20_000, 1000);
    }
    if (!wv) return { status: 'fail', detail: '没能打开「免费用豆包工作」入口' };
  }

  const page = await connect(wv.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await applyViewport(page);

  const cardState = () => evalJs(page, `(() => {
    const card = document.querySelector('[data-reward-code="daily_signin"]');
    if (!card) return { found: false };
    const btn = card.querySelector('button,[role=button]');
    const done = !!card.querySelector('.rewarded-nPpEuG, svg');
    return { found: true, done,
      btn: btn ? (() => { const r = btn.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })() : null };
  })()`);

  const first = await waitFor(async () => {
    const s = await cardState();
    return s && s.found ? s : null;
  }, 40_000, 1200);
  if (!first) { page.close(); return { status: 'fail', detail: '没找到「每日签到」卡片' }; }
  if (first.done) { page.close(); return { status: 'ok', detail: '今天已签到（页面显示已完成）' }; }
  if (!first.btn) { page.close(); return { status: 'fail', detail: '签到卡片没有可点的按钮' }; }

  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, x: first.btn.x, y: first.btn.y, button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? 1 : 0,
    });
  }
  await sleep(2500);
  const after = await cardState();
  page.close();
  return after.done
    ? { status: 'ok', detail: '点「每日签到」成功' }
    : { status: 'fail', detail: '点了签到但页面没变化' };
}

// ---------- WorkBuddy：启动即自动领取 ----------
async function doWorkBuddy() {
  const c = CFG.workbuddy;
  const today = new Date().toLocaleDateString('sv-SE');
  const claimedToday = () => {
    try {
      const fd = fs.openSync(c.log, 'r');
      const size = fs.fstatSync(fd).size;
      const from = Math.max(0, size - 400_000);
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('[Checkin]'));
      return lines.some((l) => {
        const m = l.match(/"timestamp":"([^"]+)"/);
        if (!m) return false;
        if (new Date(m[1]).toLocaleDateString('sv-SE') !== today) return false;
        return /claimDailyCheckin success/.test(l) || /"today_checked_in":true/.test(l);
      });
    } catch { return false; }
  };

  if (claimedToday()) return { status: 'ok', detail: '今天已自动领取（日志确认）' };
  if (!tasklist(c.proc)) return { status: 'skipped', detail: '客户端没在运行，本次跳过' };

  const ok = await waitFor(() => claimedToday(), 150_000, 3000);
  if (!ok) return { status: 'fail', detail: '客户端已启动，但 150 秒内没等到今日领取记录' };
  return { status: 'ok', detail: '已启动客户端并自动领取今日积分' };
}

// ---------- 豆包：多账号逐个签到 ----------
async function doDoubao() {
  const c = CFG.doubao;
  if (!launched.doubao && tasklist(c.proc) && !(await cdpReady(c.port))) {
    return { status: 'skipped', detail: '豆包已在运行（没有调试端口），本次跳过' };
  }
  const ready = await waitFor(() => cdpReady(c.port), 90_000, 1200);
  if (!ready) return { status: 'fail', detail: '豆包没能启动（或调试端口没起来）' };

  let cdp = await connectChat(c.port);
  if (!cdp) return { status: 'fail', detail: '没找到豆包主页面（可能未登录）' };

  const { names, current } = await listAccounts(cdp);
  // 解析异常（比如把整页文字当成账号）时，保守起见只签当前账号
  const sane = names.length > 0 && names.length <= 5 && names.every((n) => n.length <= 20 && !n.includes('\n'));
  if (!sane) {
    log(`豆包：账号列表解析异常（${names.length} 项），只签当前账号`);
    const r = await signCurrent(cdp, c.port);
    cdp.close();
    return r;
  }
  log(`豆包：账号列表 [${names.join(', ')}]，当前「${current || '?'}」`);

  const deadline = Date.now() + 8 * 60_000; // 多账号整体最多 8 分钟
  const per = [];
  let cur = current;
  for (const name of names) {
    if (Date.now() > deadline) { per.push(`${name}: skipped(超时)`); continue; }
    try {
      if (name !== cur) {
        const next = await switchAccount(c.port, cdp, name); // 用当前连接点菜单
        cdp.close();
        if (!next) { per.push(`${name}: fail(切换失败)`); continue; }
        cdp = next;
        cur = name;
        await sleep(1000);
      }
      const r = await signCurrent(cdp, c.port);
      per.push(`${name}: ${r.status} - ${r.detail}`);
      log(`豆包 ${name}: ${r.status} - ${r.detail}`);
    } catch (e) {
      per.push(`${name}: fail(${e.message.slice(0, 40)})`);
    }
  }

  // 切回原来的账号
  if (cur && current && cur !== current) {
    const back = await switchAccount(c.port, cdp, current);
    cdp.close();
    if (back) { log(`豆包：已切回「${current}」`); back.close(); }
  } else {
    cdp.close();
  }

  const failed = per.filter((p) => p.includes(': fail'));
  return {
    status: failed.length ? 'fail' : 'ok',
    detail: per.join('；'),
  };
}

// 对当前登录的豆包账号签到：优先点弹窗，不行再走任务面板
async function signCurrent(cdp, port) {
  const popup = await signByPopup(cdp);
  if (popup && popup.status === 'ok') return popup;
  return signByTaskPanel(cdp, port);
}

// ---------- CodeArts：头像 → 活动福利 → 每日签到 ----------
async function doCodeArts() {
  const port = 9534;
  const page = await waitFor(async () => {
    const ts = await listTargets(port).catch(() => []);
    return ts.find((t) => t.type === 'page' && !/devtools/.test(t.url));
  }, 90_000, 1500);
  if (!page) return { status: 'fail', detail: 'CodeArts 没能启动' };

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await applyViewport(cdp, 1440, 900);

  const ready = await waitFor(
    () => evalJs(cdp, `document.querySelectorAll('.user-avatar').length > 0`).catch(() => false),
    60_000, 1500,
  );
  if (!ready) { cdp.close(); return { status: 'fail', detail: 'CodeArts 界面没加载出来' }; }

  const avatar = await evalJs(cdp, `(() => {
    const el = document.querySelector('.user-avatar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`).catch(() => null);
  if (!avatar) { cdp.close(); return { status: 'fail', detail: '找不到头像按钮' }; }

  // 打开账号菜单（可能已经开着，点一下会关掉，所以先看文本）
  const menuOpen = () => evalJs(cdp, `(document.body.innerText||'').includes('活动福利')`).catch(() => false);
  if (!(await menuOpen())) {
    await clickAt(cdp, avatar.x, avatar.y);
    await waitFor(menuOpen, 8000, 800);
  }

  let opened = null;
  for (let i = 0; i < 4 && !opened; i++) {
    opened = await clickText(cdp, ['活动福利']);
    if (!opened) { await sleep(1200); await clickAt(cdp, avatar.x, avatar.y); await sleep(1200); }
  }
  if (!opened) { cdp.close(); return { status: 'fail', detail: '没找到「活动福利」入口' }; }
  // 等活动福利面板出现（推荐码 / 学生认证是它的固定条目）
  await waitFor(
    () => evalJs(cdp, `(document.body.innerText||'').includes('推荐码上有礼')`).catch(() => false),
    10_000, 800,
  );
  await sleep(800);

  // 展开「已完成与已隐藏的活动」，签到条目可能收在里面
  for (let i = 0; i < 5; i++) {
    const seen = await evalJs(cdp, `(document.body.innerText||'').includes('每日签到')`).catch(() => false);
    if (seen) break;
    const header = await evalJs(cdp, `(() => {
      const el = [...document.querySelectorAll('div,span')].find(e => (e.innerText || '').trim().startsWith('已完成与已隐藏的活动'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`).catch(() => null);
    if (!header) break;
    await clickAt(cdp, header.x, header.y);
    await sleep(1200);
  }

  const state = () => evalJs(cdp, `(() => {
    const t = document.body.innerText || '';
    const done = /每日签到领\\d+积分\\s*\\n?\\s*今日已领/.test(t);
    const has = t.includes('每日签到');
    return { has, done };
  })()`).catch(() => ({ has: false, done: false }));

  const s1 = await state();
  if (s1.done) { cdp.close(); return { status: 'ok', detail: '今天已签到（活动福利里显示今日已领）' }; }

  // 没签：找「签到」按钮
  const btn = await evalJs(cdp, `(() => {
    const cands = [...document.querySelectorAll('button,[role=button],div,span')].filter(e => {
      const s = (e.innerText || '').trim();
      return /^(签到|立即签到|去签到|领取)$/.test(s);
    });
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: el.innerText.trim() };
    }
    return null;
  })()`).catch(() => null);
  if (!btn) { cdp.close(); return { status: 'fail', detail: '活动福利里没找到签到按钮' }; }

  await clickAt(cdp, btn.x, btn.y);
  await sleep(2500);
  const s2 = await state();
  cdp.close();
  if (s2.done) return { status: 'ok', detail: `点了「${btn.t}」，已显示今日已领` };
  return { status: 'fail', detail: `点了「${btn.t}」但没看到今日已领` };
}
// ---------- 主流程 ----------
const RUNNERS = { workbuddy: doWorkBuddy, doubao: doDoubao, codearts: doCodeArts };
try { fs.writeFileSync(path.join(LOG_DIR, `checkin-${todayLocal()}.log`), '', 'utf8'); } catch { }
const results = [];
for (const key of Object.keys(RUNNERS)) {
  if (only && key !== only) continue;
  const label = CFG[key].name;
  log(`===== ${label} 开始 =====`);
  const t0 = Date.now();
  let r;
  try { r = await RUNNERS[key](); } catch (e) { r = { status: 'fail', detail: `异常：${e.message}` }; }
  r.ms = Date.now() - t0;
  results.push({ app: label, ...r });
  log(`${label}: ${r.status} - ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
}

log(`===== 完成：${results.map((r) => `${r.app}: ${r.status}`).join(' | ')} =====`);
fs.writeFileSync(path.join(LOG_DIR, `checkin-${todayLocal()}.log`), logLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(LOG_DIR, 'last-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

process.exit(results.some((r) => r.status === 'fail') ? 2 : 0);