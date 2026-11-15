# 每日自动签到 + 额度看板（WorkBuddy / 豆包 / CodeArts / AStudio / AutoClaw）

两件事：

1. **自动签到**：按你设定的时间每天自动签到（默认 09:30，面板里可改），窗口最小化、不抢焦点。
2. **额度看板**：在 DSH 侧边栏底部点「💰 额度」，看各家的签到状态与余额，并能一键签到 / 刷新余额。

## 看板在哪

DSH 侧边栏最下面、Settings 旁边多了一个 **💰 额度** 按钮，点开是浮层面板：

| 应用 | 余额 | 签到状态 |
| --- | --- | --- |
| WorkBuddy | 积分余额（点头像读） | 今日是否已领、连签天数、今日领取额 |
| 豆包 | 总额度（页面上的「累计获得额度」，如 `2600 点`） | 最近一次签到结果，按账号列出 |
| CodeArts | 积分余额（头像菜单里「积分用量 x / y」） | 活动福利第一项「每日签到领100积分」是否已领 |
| AStudio | 积分余额 + 套餐（点左下角账号读菜单） | 每日登录积分随登录发放，脚本只确认当天登录过 |
| AutoClaw | 总积分 | 不参与签到 |
两个按钮 + 一个开关：

- **立即签到** → 触发计划任务 `DSH-DailyCheckin`（和每天 9:30 跑的是同一套）
- **刷新余额** → 触发 `DSH-CreditCollect`：后台最小化启动各客户端读一次余额
- **签到后保留客户端**（勾选）→ 签到结束不关窗口，豆包带调试端口常驻，下次直接连上；不勾选则跑完就关（默认）

> 安装后需要刷新一次 DSH 页面（F5）面板才会加载。

## 数据服务

看板的数据由独立进程提供：`board-server.mjs` 监听 `127.0.0.1:47122`（只回环）。

- 计划任务 `DSH-CreditBoard`：登录后 20 秒启动它，失败自动重试
- 计划任务 `DSH-CreditCollect`：按需采集余额
- 计划任务 `DSH-DailyCheckin`：每天 9:30 + 登录后 3 分钟签到

> 为什么数据服务要单独跑：DSH 宿主进程里启动子进程会被拦截，只有计划任务里的脚本能正常拉起客户端。

## 文件

| 文件 | 作用 |
| --- | --- |
| `run-checkin.ps1` | 签到主流程：最小化启动 → 调 `checkin.mjs` → 关闭本次启动的应用 |
| `checkin.mjs` | 签到逻辑（豆包多账号：自动切号、逐个签、切回原账号） |
| `collect.ps1` / `collect.mjs` | 采集余额快照 → `logs\balance.json` |
| `board-server.mjs` | 看板数据服务（127.0.0.1:47122） |
| `install-task.ps1` | 注册签到任务 `DSH-DailyCheckin` |
| `install-board.ps1` | 注册看板服务与采集任务 |
| `runtime\node.exe` | 自带 Node 运行时 |
| `logs\` | `runner.log`、`checkin-*.log`、`balance.json`、`collect.log`、`board-server.log` |

DSH 插件在 `C:\Users\34242\Desktop\deep\credit-board\`（`@local/credit-board`）。

## 常用命令

```powershell
# 手动签到
schtasks /run /tn DSH-DailyCheckin
# 手动采集余额
schtasks /run /tn DSH-CreditCollect
# 重启看板服务
schtasks /end /tn DSH-CreditBoard; schtasks /run /tn DSH-CreditBoard
```

## 已知限制

- **WorkBuddy 的余额**：采集时会自动点开头像面板读「积分余额」，读数格式如 `2,220.5`。
- **豆包的额度**：显示的是「用豆包工作」页面上的总额度（累计获得）；剩余额度要在「设置 → 订阅与额度管理」里看。
- **AutoClaw 的余额采集**：偶尔读不到（客户端启动慢或界面变化），失败时会保留上一次的读数并标记为旧数据。
- **AStudio**：它是 IDE，若你正开着但没带 `--remote-debugging-port=9535`，脚本不会重启它（本次跳过，余额保持上次读数）；在 `config.json` 里加 `"astudio": { "enabled": false }` 可以整行去掉，或 `"restartIfOpenWithoutPort": true` 允许重启。
- 客户端要处于登录状态；退出登录后需要重新登录一次。
- 电脑关机当天签不了，开机/登录后会补跑。
