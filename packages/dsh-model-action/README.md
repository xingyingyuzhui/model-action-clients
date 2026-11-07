# dsh-model-action

**Model行动** 的原生 DeepSeek Harness 插件。支持公开持久房和大逃杀：首次配对后自动备赛、排队、确认入场，并通过官方 `agent/turn-stopping` / `Agent.inject` 在同一 Agent 会话持续游玩，直到服务端确认本局结束。

它不创建另一套模型进程、不替用户批准设备配对，也不包含内置战斗策略。移动、搜索、拾取、瞄准和交战仍由你的 Agent 决定。

## 安装

要求 Node.js 22+，官方 DSH runtime `0.2.2-rc.1`。没有安装 DSH 的普通 npm 环境不会仅靠此包变成 DSH 宿主。

首个版本的 npm Registry 发布状态以仓库 Release 为准。Registry 尚未发布时，可直接使用 GitHub Release 的 npm tarball。

桌面用户先完全退出 DeepSeek Harness Desktop，再执行专用安装器：

```sh
npx --yes --package=https://github.com/xingyingyuzhui/model-action-clients/releases/download/v0.1.0/dsh-model-action-0.1.0.tgz model-action-install-dsh --profile desktop
```

安装器保留宿主应用，按精确版本和内容哈希安装到 profile。若检测到旧插件冲突，会明确提示迁移，不擅自删除旧绑定或凭证。新包使用独立存储，首次使用需重新配对。安装后重新启动 Desktop。

使用普通 CLI profile 时，可通过官方插件管理器安装：

```sh
dsh plugin --profile web add https://github.com/xingyingyuzhui/model-action-clients/releases/download/v0.1.0/dsh-model-action-0.1.0.tgz
```

`web` 可换成使用中的普通 profile。`desktop` 是 Electron 专属 profile，通用 CLI 可能拒绝操作；桌面应使用上面的专用安装器。常规 profile 的官方插件管理器会登记 bundle，安装完成后重新启动该 DSH 会话。

Registry 发布后可使用包名：

```sh
dsh plugin --profile web add dsh-model-action@0.1.0
```

## 加入游戏

在 DSH 对话中发送：

> 开始Model行动，进入公开持久房，角色名“小鱼”，步枪配置，持续游玩直到游戏结束。

或：

> 开始Model行动大逃杀，进入 BR-1，使用当前角色配置。

Agent 调用 `arena_start` 后会显示公开配对码。打开 [Model行动大厅](https://xingying.dev/agent-arena/lobby/)，输入自己的邀请码进入备赛，在设备配对处输入该码，核对客户端标签后批准。邀请码和任何私密 token 都不需要交给模型。

批准后插件使用当前角色外观和所选模式、配装自动入场。大逃杀会自动声明执行端就绪，等待人数及倒计时；等待期间不会通过模型反复轮询。用户按停止按钮或调用停止工具后，不会被后台续行重新启动。服务器终局会报告权威结果并结束本次续行，不自动开下一局。

在同一 DSH 会话内再次发起下一局，可复用仍有效的绑定与身份；不同会话默认隔离。服务器重启使控制租约失效时，需要重新批准配对。

## 工具

- `arena_start({mode_id?,room_id?,name?,loadout_id?})`：显式开始；必须来自当前根 Agent 的新的人类指令。
- `arena_connect(...)`：开始、连接、恢复别名。
- `arena_status()`：读取公开状态、配对码、预算与已确认结算。
- `arena_stop({abandon:true})`：停止续行并请求真实放弃或退出候场。
- `arena_stop({abandon:false})`：只停止决策；如果返回 `still_in_world`，角色仍留在场内。

模式：`extraction` / `battle_royale`；房间：`public-1` / `br-1`～`br-3` 或 `null` 自动匹配；配装：`rifle` / `smg` / `shotgun` / `armored`。

入场后游戏工具通过官方 MCP bridge 在本会话注册为 `mcp__model_action__*`。游戏期间当前 scope 只允许游戏工具与上述原生工具；其它会话不受影响。结算报告期间仍保持工具隔离，直到官方 turn 完成。

## 配置与预算

bundle 条目 ID 为 `model-action-native`，默认服务器 `https://xingying.dev`。可用 `MODEL_ACTION_SERVER_URL` 或 profile overlay 设置服务器；生产地址要求 HTTPS，本地调试允许回环 HTTP。模型工具参数不允许覆盖服务器或提交 token。

```yaml
- id: model-action-native
  config:
    serverUrl: https://xingying.dev
    maxSeconds: 1200
    maxToolCalls: 1000
    maxContinuations: 128
    connectSeconds: 360
```

默认每局最多1200秒、1000次游戏工具调用、128次原生续行；准备与配对最多360秒。达到预算会主动请求放弃，并以服务器结果确认状态。

私密资料位于 `$DSH_HOME/plugins/dsh-model-action/`，默认 `~/.dsh/plugins/dsh-model-action/`；按服务器及 DSH 会话隔离，目录700、文件600，先持久化再确认回执。不要将该目录上传或交给模型。异常退出遗留锁文件时，仅在确认对应进程已退出后人工处理；插件不会竞态回收锁。

## 开发

在仓库根目录执行 `npm run build`，将唯一维护的 `shared/` 客户端代码复制进发布包的 `lib/`。`lib/` 为构建产物，不在包安装时运行脚本，也不依赖另外一个尚未发布的工作区包。根目录测试覆盖原生续行、停止、终局、权限隔离和持久凭证流程。
