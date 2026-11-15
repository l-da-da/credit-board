---
name: credit-board
description: 在 Windows 上安装「每日自动签到 + 额度看板」：自动给 WorkBuddy、豆包、CodeArts 签到并汇总积分/额度/签到状态到 DeepSeek Harness 侧边栏面板。当用户提到自动签到、积分看板、WorkBuddy/豆包/CodeArts 签到、把额度汇总到 DSH 时使用。
---

# Credit board（自动签到 + 额度看板）

把四个客户端（WorkBuddy、豆包、CodeArts、AutoClaw）的签到和余额汇总到 DeepSeek Harness 的一个面板里，并每天自动签到（AutoClaw 只展示余额，不签到）。

## 适用环境

- Windows 10 / 11
- 已安装并登录：WorkBuddy、豆包、CodeArts（AutoClaw 可选，只展示余额）
- Node.js 22+（脚本用内置 WebSocket）
- DeepSeek Harness（桌面版或 Web 版均可，插件安装在当前 profile）

## 它做什么

1. **自动签到**：按 `config.json` 的 `checkinTime`（默认 09:30，面板可改）触发；任务每 15 分钟轮询一次，脚本判断该不该跑，**当天签完自动暂停轮询**（次日 00:05 恢复）
   - WorkBuddy：点开客户端后**不一定自动领**；脚本通过 CDP 调它自己的接口 `wb.account.checkinStatus()` / `wb.account.checkin()`（等同点侧边栏活动卡片上的「立即领取」）
   - 豆包：最小化启动 → 点账号 → 「免费用豆包工作」→ 每日签到；支持多账号自动切换、签完切回
   - CodeArts：点左下角账号头像 → 活动福利 → 第一项「每日签到领100积分」→「每日领取」；余额读「积分用量 x / y」
2. **额度看板**：DSH 侧边栏底部「💰 额度」浮层，展示
   - WorkBuddy 积分余额 + 套餐 + 今日领取/连签
   - 豆包总额度（含「再攒 X 解锁奖励」进度条）+ 各账号签到结果
   - AutoClaw 总积分
   - 两个按钮：刷新余额、立即签到；顶部有实时进度（已排队 / 正在签到：豆包…），底部显示上次各家结果
3. **可选行为**：签到后关闭客户端（默认）或保留进程（面板里勾选，适合让豆包常驻、下次直接点）

## 安装步骤

1. 在本目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

默认装到 `%LOCALAPPDATA%\credit-board`，可用 `-Target` 指定目录。

2. 把插件加进 DSH：`设置 → Plugins → Add plugin` → 选择 `<安装目录>\plugin`
   或在会话里让 agent 执行 `plugin_manager install_bundle`，`target` 填该目录。

3. 刷新 DSH 页面（F5），侧边栏底部出现「💰 额度」。

## 验证

```powershell
schtasks /query /tn DSH-CreditBoard         # 看板服务是否在跑
Invoke-WebRequest http://127.0.0.1:47122/board   # 看板数据（JSON）
powershell -File <安装目录>\auto-checkin\run-checkin.ps1 -Force   # 手动签到一次
powershell -File <安装目录>\auto-checkin\collect.ps1             # 手动采集余额
```

日志在 `<安装目录>\logs\`：`runner.log`（签到）、`collect.log`（余额采集）、`board-server.log`（服务）。

## 排错

| 现象 | 处理 |
| --- | --- |
| 面板提示「本地服务未连接」 | 在 auto-checkin 目录跑 `powershell -File install-board.ps1`（会清残留 node 再重启）；不要只用 `schtasks /end + /run`（/end 杀不掉孙子 node，会占 47122 端口）。看 `board-server.log` |
| 面板「刷新余额 / 立即签到」没反应 | 「立即签到」只写 `force.flag`，由 `DSH-CheckinNow` 消费（长轮询，1.5 秒看一次，正常 2 秒内开始）；「刷新余额」写 `refresh.flag`，由每分钟的 `DSH-CreditCollect` 消费。先看面板顶部的进度文字和 `logs\runner.log` / `collect.log` |
| 签到报「没开调试端口 9533/9534」 | 客户端是手动打开的、没带 `--remote-debugging-port`；`run-checkin.ps1` 会自动重启一次，若仍失败就手动关掉该客户端再重跑 |
| 豆包签到超时 | 确认豆包已登录；客户端首次启动慢，稍后重跑一次 |
| 余额显示「点刷新余额采集」 | 点一下刷新，等 2–3 分钟（会最小化启动各客户端读一次） |
| 任务没有按点跑 | 电脑当时关机；登录后 3 分钟会补跑 |
| 端口冲突 | 改 `board-server.mjs` 的 PORT 与插件 `cordis.patch.yml` 的 port（两处要一致） |

## 限制（要如实告知用户）

- 客户端额度是**封闭**的：只能通过 UI 操作，没有 API；WorkBuddy/豆包/CodeArts/AutoClaw 的积分无法转成通用 API key。
- 签到必须启动客户端（最小化、不抢焦点，跑完可关可留）。
- 电脑关机当天无法签到；账号退出登录后需重新登录。
- 自动化操作客户端界面属于个人使用场景，可能受各家服务条款约束，请自行评估风险；本项目不读取、不保存密码。
- 只关闭「脚本自己启动的」客户端；用户手动开着、只是为了拿到调试端口被重启的那次，签到完会保持打开。