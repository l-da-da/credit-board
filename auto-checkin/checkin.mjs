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

// 签到进度（看板读它显示「签到中 · 当前在签哪一家」）
const PROGRESS = path.join(LOG_DIR, 'progress.json');
function progress(patch) {
  try { fs.writeFileSync(PROGRESS, JSON.stringify({ at: new Date().toISOString(), ...patch }), 'utf8'); } catch { }
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

// ---------- WorkBuddy：CDP 调应用自身的签到接口（等同点侧边栏的「立即领取」） ----------
// 注意：它不会「启动即领」。界面里没有固定入口，签到卡片只是底部活动轮播里的一张，
// 所以走 wb.account.checkinStatus() / checkin()，日志只做兜底。
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

  // 首选：通过 CDP 调 WorkBuddy 自己的签到接口（就是面板上「立即领取」背后的同一个调用）。
  // 它的界面上没有固定入口，签到卡片是侧边栏底部轮播里的一张，靠点 DOM 很不稳；
  // wb.account.checkinStatus()/checkin() 才是应用内部用的那份接口。
  const port = 9533;
  const page = await waitFor(async () => {
    const ts = await listTargets(port).catch(() => []);
    return ts.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || ts.find((t) => t.type === 'page');
  }, 30_000, 800);
  if (!page) {
    if (claimedToday()) return { status: 'ok', detail: '今天已签到（日志确认）' };
    return { status: 'fail', detail: 'WorkBuddy 没开调试端口 9533（客户端不是脚本启动的）' };
  }

  const cdp = await connect(page.webSocketDebuggerUrl);
  try {
    await cdp.send('Runtime.enable');
    const ready = await waitFor(
      () => evalJs(cdp, `!!(window.wb && window.wb.account && window.wb.account.checkinStatus)`).catch(() => false),
      60_000, 1000,
    );
    if (!ready) {
      if (claimedToday()) return { status: 'ok', detail: '今天已签到（日志确认）' };
      return { status: 'fail', detail: 'WorkBuddy 界面没加载出来（页面里没有 wb.account）' };
    }

    const readStatus = () => evalJs(cdp, `(async () => {
      try { return await window.wb.account.checkinStatus(); }
      catch (e) { return { error: String((e && e.message) || e) }; }
    })()`).catch(() => null);

    const s1 = await readStatus();
    if (!s1) return { status: 'fail', detail: '读不到 WorkBuddy 签到状态' };
    if (s1.error) return { status: 'fail', detail: `读不到 WorkBuddy 签到状态：${s1.error}` };
    if (s1.active === false) return { status: 'ok', detail: 'WorkBuddy 签到活动当前不活跃，无需签到' };
    if (s1.todayCheckedIn) return { status: 'ok', detail: `今天已签到（连签 ${s1.streakDays ?? '-'} 天）` };

    // 未签：调应用自己的领取接口（已领过时后端回 400，所以下面要再看一次状态）
    const claim = await evalJs(cdp, `(async () => {
      try { return { ok: true, r: await window.wb.account.checkin() }; }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    })()`).catch(() => null);

    const s2 = await waitFor(async () => {
      const s = await readStatus();
      return s && s.todayCheckedIn ? s : null;
    }, 10_000, 800);

    if (s2) {
      const credit = (claim && claim.ok && claim.r && claim.r.credit) || s1.todayCredit || 0;
      return { status: 'ok', detail: `已领取${credit ? ` +${credit} 积分` : ''}，连签 ${s2.streakDays ?? '-'} 天` };
    }
    if (claim && !claim.ok) return { status: 'fail', detail: `领取失败：${claim.error}` };
    return { status: 'fail', detail: '调了签到接口，但状态没变成已签到' };
  } finally {
    cdp.close();
  }
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

  // 刚启动的豆包界面可能还没渲染完，账号弹窗会读空——重试几次再下结论
  let accounts = await listAccounts(cdp);
  for (let i = 0; i < 3 && !(accounts.names && accounts.names.length); i++) {
    await sleep(2500);
    accounts = await listAccounts(cdp);
  }
  const { names, current } = accounts;
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

// ---------- CodeArts：左下角头像 → 活动福利 → 第一项「每日签到领100积分」 ----------
// 新版面板把签到放在「活动福利」的第一项，按钮文字是「每日领取」（不再是「签到」）；
// 领取之后这一项会移进「已完成与已隐藏的活动」，并显示「今日已领」。
async function doCodeArts() {
  const port = 9534;
  const page = await waitFor(async () => {
    const ts = await listTargets(port).catch(() => []);
    return ts.find((t) => t.type === 'page' && !/devtools/.test(t.url));
  }, 45_000, 1000);
  if (!page) return { status: 'fail', detail: 'CodeArts 没开调试端口 9534（客户端不是脚本启动的，或启动太慢）' };

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await applyViewport(cdp, 1440, 900);

  const ready = await waitFor(
    () => evalJs(cdp, `!!document.querySelector('.user-avatar')`).catch(() => false),
    60_000, 1000,
  );
  if (!ready) { cdp.close(); return { status: 'fail', detail: 'CodeArts 界面没加载出来' }; }

  // 面板是否已经开着（签到条目 / 已完成区 / 面板本身，任一存在即算开）
  const panelOpen = () => evalJs(cdp,
    `!!document.querySelector('.welfare-activity-item, .welfare-hidden-section, .welfare-popup-header, .welfare-popup')`)
    .catch(() => false);

  if (!(await panelOpen())) {
    // 左下角头像菜单（可能已经开着，点一下会关掉，所以先判断）
    const menuOpen = () => evalJs(cdp, `!!document.querySelector('.activity-welfare-item')`).catch(() => false);
    if (!(await menuOpen())) {
      const avatar = await evalJs(cdp, `(() => {
        const el = document.querySelector('.user-avatar');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`).catch(() => null);
      if (!avatar) { cdp.close(); return { status: 'fail', detail: '找不到头像按钮' }; }
      await clickAt(cdp, avatar.x, avatar.y);
      await waitFor(menuOpen, 8000, 700);
    }
    const entry = await evalJs(cdp, `(() => {
      const el = document.querySelector('.activity-welfare-item')
        || [...document.querySelectorAll('button,div,span')]
          .find((e) => (e.innerText || '').trim() === '活动福利' && e.getBoundingClientRect().width > 40);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`).catch(() => null);
    if (!entry) { cdp.close(); return { status: 'fail', detail: '没找到「活动福利」入口' }; }
    await clickAt(cdp, entry.x, entry.y);
    const shown = await waitFor(panelOpen, 12_000, 700);
    if (!shown) { cdp.close(); return { status: 'fail', detail: '点了「活动福利」但面板没出来' }; }
  }

  // 「已完成与已隐藏的活动」默认是折叠的：签到后的条目在里面，展开才能读到「今日已领」
  const expandHidden = async () => {
    const st = await evalJs(cdp, `(() => {
      const s = document.querySelector('.welfare-hidden-section');
      return s ? { expanded: s.classList.contains('is-expanded') } : null;
    })()`).catch(() => null);
    if (!st || st.expanded) return;
    const box = await evalJs(cdp, `(() => {
      const el = document.querySelector('.welfare-hidden-section__label') || document.querySelector('.welfare-hidden-section');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`).catch(() => null);
    if (!box) return;
    await clickAt(cdp, box.x, box.y);
    await sleep(900);
  };

  const readState = async () => {
    await expandHidden();
    return evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll('.welfare-activity-item')];
      const item = items.find((e) => /每日签到/.test(e.innerText || '')) || null;
      let btn = null;
      if (item) {
        btn = [...item.querySelectorAll('button')]
          .find((b) => /领取|签到/.test(b.innerText || '') && b.getBoundingClientRect().width > 16) || null;
      }
      const hidden = document.querySelector('.welfare-hidden-section');
      const hiddenText = hidden ? (hidden.innerText || '') : '';
      const signedHidden = /每日签到[\\s\\S]{0,40}今日已领/.test(hiddenText);
      const signedBody = /每日签到[\\s\\S]{0,40}今日已领/.test(document.body.innerText || '');
      const r = btn ? btn.getBoundingClientRect() : null;
      return {
        hasItem: !!item,
        btnText: btn ? (btn.innerText || '').trim() : null,
        btn: r ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null,
        signed: signedHidden || signedBody || (!!item && !btn && /今日已领|已领取/.test(item.innerText || '')),
      };
    })()`).catch(() => null);
  };

  const s1 = await readState();
  if (!s1) { cdp.close(); return { status: 'fail', detail: '读不到活动福利面板内容' }; }
  if (s1.signed) { cdp.close(); return { status: 'ok', detail: '今天已签到（活动福利里显示今日已领）' }; }
  if (!s1.btn) { cdp.close(); return { status: 'fail', detail: '活动福利里没找到「每日领取」按钮' }; }

  await clickAt(cdp, s1.btn.x, s1.btn.y);
  const s2 = await waitFor(async () => {
    const s = await readState();
    return s && s.signed ? s : null;
  }, 12_000, 900);
  cdp.close();
  if (s2) return { status: 'ok', detail: `点了「${s1.btnText}」，已显示今日已领` };
  return { status: 'fail', detail: `点了「${s1.btnText}」但没看到今日已领` };
}
// ---------- 主流程 ----------
const RUNNERS = { workbuddy: doWorkBuddy, doubao: doDoubao, codearts: doCodeArts };
try { fs.writeFileSync(path.join(LOG_DIR, `checkin-${todayLocal()}.log`), '', 'utf8'); } catch { }
const results = [];
for (const key of Object.keys(RUNNERS)) {
  if (only && key !== only) continue;
  const label = CFG[key].name;
  progress({ stage: 'app', app: label });
  log(`===== ${label} 开始 =====`);
  const t0 = Date.now();
  let r;
  try { r = await RUNNERS[key](); } catch (e) { r = { status: 'fail', detail: `异常：${e.message}` }; }
  r.ms = Date.now() - t0;
  results.push({ app: label, ...r });
  log(`${label}: ${r.status} - ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`);
}

log(`===== 完成：${results.map((r) => `${r.app}: ${r.status}`).join(' | ')} =====`);
progress({ stage: 'wrapping' });
fs.writeFileSync(path.join(LOG_DIR, `checkin-${todayLocal()}.log`), logLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(LOG_DIR, 'last-result.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');

function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

process.exit(results.some((r) => r.status === 'fail') ? 2 : 0);