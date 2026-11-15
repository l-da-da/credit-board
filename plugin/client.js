// Client half: a sidebar button plus a floating board panel.
window.__ModuleLoader__.load({
  id: '@local/credit-board',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = 'http://127.0.0.1:47122';

    // ---- shared open state ----
    let open = false;
    const listeners = new Set();
    const setOpen = (v) => { open = v; for (const fn of listeners) fn(); };
    function useOpen() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const fn = () => force((n) => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      }, []);
      return open;
    }

    const S = {
      button: {
        display: 'flex', alignItems: 'center', gap: 6, width: '100%',
        padding: '6px 8px', borderRadius: 8, background: 'transparent',
        border: '1px solid transparent', color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit', fontSize: 13, cursor: 'pointer', textAlign: 'left',
      },
      panel: {
        position: 'fixed', top: 56, right: 16, width: 360, zIndex: 1000, pointerEvents: 'auto',
        background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 14,
        boxShadow: '0 18px 48px rgba(0,0,0,.28)', padding: 14, fontSize: 13,
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
      title: { fontSize: 14, fontWeight: 600 },
      close: {
        border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 4,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
        padding: '10px 12px', marginBottom: 8, background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
      name: { fontWeight: 600 },
      balance: { fontSize: 18, fontWeight: 700, letterSpacing: '.2px' },
      note: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginTop: 4 },
      badge: (ok) => ({
        fontSize: 11, padding: '1px 7px', borderRadius: 99,
        color: ok === null ? 'var(--dsw-alias-label-secondary)' : '#fff',
        background: ok === null ? 'var(--dsw-alias-state-idle-primary)'
          : ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
      }),
      foot: { display: 'flex', gap: 8, marginTop: 10 },
      action: (primary) => ({
        flex: 1, padding: '7px 10px', borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 12.5,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-brand-primary)' : 'transparent',
        color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
      }),
      updated: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, marginTop: 8, textAlign: 'right' },
      live: {
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, padding: '6px 8px',
        borderRadius: 8, fontSize: 12, background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
      },
      dot: { width: 7, height: 7, borderRadius: 99, background: 'var(--dsw-alias-brand-primary)' },
      bar: { height: 6, borderRadius: 3, background: 'var(--dsw-alias-bg-layer-2)', marginTop: 10, overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: 3, background: 'var(--dsw-alias-brand-primary)', transition: 'width .3s ease' },
      barLabel: { display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginTop: 4 },
    };

    function FooterButton(props) {
      const isOpen = useOpen();
      const wide = !props || props.wide !== false;
      return h('button', {
        style: { ...S.button, background: isOpen ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' },
        title: '额度看板 / 今日签到',
        onClick: () => setOpen(!open),
      }, h('span', { style: { fontSize: 14 } }, '💰'), wide ? h('span', null, '额度') : null);
    }

    function Panel() {
      const isOpen = useOpen();
      const [data, setData] = React.useState(null);
      const [err, setErr] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [timeDraft, setTimeDraft] = React.useState('09:30');

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(`${API}/board`, { cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          setData(await r.json());
          setErr(null);
        } catch (e) {
          setErr(String(e.message || e));
        }
      }, []);

      const running = !!(data && data.checkin && data.checkin.running);
      const refreshing = !!(data && data.running && data.running.refresh);

      React.useEffect(() => {
        if (!isOpen) return;
        load();
        // 签到/采集进行中（或刚点过按钮）时快速刷新，让「已排队 / 正在签哪家」看得见
        const fast = running || refreshing || busy === 'checkin' || busy === 'refresh';
        const t = setInterval(load, fast ? 3000 : 15000);
        return () => clearInterval(t);
      }, [isOpen, load, running, refreshing, busy]);

      React.useEffect(() => {
        if (data && data.settings && data.settings.checkinTime) setTimeDraft(data.settings.checkinTime);
      }, [data && data.settings && data.settings.checkinTime]);

      const saveTime = async (value) => {
        if (!/^\d{2}:\d{2}$/.test(value)) return;
        setBusy('time');
        try {
          await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ checkinTime: value }),
          });
        } catch { /* ignore */ }
        setTimeout(() => { setBusy(''); load(); }, 1500);
      };

      const act = async (which) => {
        setBusy(which);
        try { await fetch(`${API}/${which}`, { method: 'POST' }); } catch (e) { setErr(String(e.message || e)); }
        await load();   // 立刻读回「已排队 / 进行中」，而不是等 2.5s 后无声复位
        setTimeout(() => setBusy(''), which === 'checkin' ? 6000 : 1500);
      };

      if (!isOpen) return null;

      const c = (data && data.checkin) || null;
      const stageText = !c ? ''
        : c.stage === 'queued' ? '已排队，等自动任务启动（最多 1 分钟）'
          : c.stage === 'launching' ? '正在启动客户端…'
            : c.stage === 'app' ? `正在签到：${c.app || ''}`
              : c.stage === 'wrapping' ? '正在收尾…' : '';
      const since = c && c.at ? Math.max(0, Math.round((Date.now() - Date.parse(c.at)) / 1000)) : 0;
      const markOf = (s) => (s === 'ok' ? '✓' : s === 'fail' ? '✗' : '跳过');

      return h('div', { style: S.panel, role: 'dialog', 'aria-label': '额度看板' },
        h('div', { style: S.head },
          h('div', { style: S.title }, '额度看板'),
          h('button', { style: S.close, onClick: () => setOpen(false), title: '关闭' }, '×'),
        ),
        err ? h('div', { style: { ...S.note, color: 'var(--dsw-alias-state-error-primary)' } }, `本地服务未连接：${err}`) : null,
        running || refreshing ? h('div', { style: S.live },
          h('span', { style: S.dot }),
          running ? `${stageText}${since > 1 ? ` · 已 ${since}s` : ''}` : '正在采集余额（启动客户端，约 1-2 分钟）…',
        ) : null,
        c && c.stalled ? h('div', { style: { ...S.note, color: 'var(--dsw-alias-state-warn-primary)' } },
          '已排队 2 分钟还没开始：检查计划任务 DSH-CheckinNow 是否启用') : null,
        !data && !err ? h('div', { style: S.note }, '加载中…') : null,
        data ? data.apps.map((app) => h('div', { key: app.id, style: S.card },
          h('div', { style: S.row },
            h('div', null,
              h('div', { style: S.name }, app.name),
              app.account ? h('div', {
                style: { ...S.note, marginTop: 0, ...(app.accountOk === false ? { color: 'var(--dsw-alias-state-error-primary)', fontWeight: 600 } : {}) },
                title: app.accountOk === false ? '当前登录账号与期望账号不一致（期望值配置在 auto-checkin/config.json 的 expectedAccounts）' : undefined,
              }, app.accountOk === false ? `⚠ ${app.account} · 与期望账号不符` : app.account) : null,
            ),
            h('div', { style: S.balance }, app.balance || '—'),
          ),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('span', { style: S.badge(app.signed) }, app.signed === null ? '不签到' : app.signed ? '今日已签' : '今日未签'),
            h('span', { style: { ...S.note, marginTop: 0 } }, app.signedNote || ''),
          ),
          app.balanceNote ? h('div', { style: S.note }, app.balanceNote) : null,
          app.progress ? h('div', null,
            h('div', { style: S.bar },
              h('div', {
                style: { ...S.barFill, width: `${Math.max(2, Math.min(100, (app.progress.now / app.progress.goal) * 100))}%` },
              }),
            ),
            h('div', { style: S.barLabel },
              h('span', null, `${app.progress.now}`),
              h('span', null, `${app.progress.goal}`),
            ),
          ) : null,
        )) : null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12 } },
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '每天自动签到'),
          h('input', {
            type: 'time',
            value: timeDraft,
            onChange: (e) => setTimeDraft(e.target.value),
            style: {
              background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
              border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: '3px 6px', font: 'inherit',
            },
          }),
          h('button', {
            style: { ...S.action(false), flex: '0 0 auto', padding: '4px 10px' },
            disabled: !!busy,
            onClick: () => saveTime(timeDraft),
          }, busy === 'time' ? '保存中…' : '保存'),
        ),
        data && data.nextRun ? h('div', { style: { ...S.note, marginTop: 6 } }, `下次运行：${data.nextRun}`) : null,
        h('label', {
          style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
          title: '勾选后签到结束不关闭客户端（豆包会带调试端口常驻，方便下次直接签）',
        },
          h('input', {
            type: 'checkbox',
            checked: !!(data && data.settings && data.settings.keepOpen),
            onChange: async (e) => {
              const keepOpen = e.target.checked;
              try {
                await fetch(`${API}/config`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ keepOpen }),
                });
              } catch { /* ignore */ }
              load();
            },
          }),
          '签到后保留客户端',
        ),
        h('div', { style: S.foot },
          h('button', { style: S.action(false), disabled: !!busy || refreshing, onClick: () => act('refresh') },
            busy === 'refresh' || refreshing ? '采集中…' : '刷新余额'),
          h('button', { style: { ...S.action(true), opacity: running ? 0.65 : 1 }, disabled: !!busy || running, onClick: () => act('checkin') },
            (busy === 'checkin' || running) ? '签到中…' : '立即签到'),
        ),
        data && data.lastResults && data.lastResults.length ? h('div', { style: S.note },
          `上次签到 ${data.checkinAt ? new Date(data.checkinAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}：` +
          data.lastResults.map((r) => `${r.app} ${markOf(r.status)}`).join(' · '),
        ) : null,
        data ? h('div', { style: S.updated },
          `余额 ${data.balanceAt ? new Date(data.balanceAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}` +
          ` · 签到 ${data.checkinAt ? new Date(data.checkinAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'credit-board', order: 5,
        }, FooterButton));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'credit-board-panel', order: 100,
        }, Panel));
      },
    };
  },
});