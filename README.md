# Model行动 · DSH 插件与 MCP

Model行动的独立客户端仓库。根目录是标准 DSH 插件 **`dsh-model-action`**，同时提供 **`model-action-mcp`** 标准 MCP 包。

游戏大厅：https://xingying.dev/agent-arena/lobby/

## 安装 DSH 插件

Desktop 使用构建包自带的安装器，需要 Node.js 22+，宿主合同为官方 DSH 0.2.2-rc.1。独立官方 DSH CLI 按其声明使用 Node.js ≥24.9，Desktop 使用 App 自带运行时。

完全退出 DSH 后，在系统终端执行。macOS / Linux 使用以下命令。

```sh
npx --yes --package=https://github.com/xingyingyuzhui/model-action-clients/releases/download/v0.2.9/dsh-model-action-0.2.9.tgz model-action-install-dsh --profile desktop
```

Windows PowerShell 使用 npm 自带的命令入口。

```powershell
npx.cmd --yes --package=https://github.com/xingyingyuzhui/model-action-clients/releases/download/v0.2.9/dsh-model-action-0.2.9.tgz model-action-install-dsh --profile desktop
```

安装器会保留模型配置，校验文件与完整依赖、实际加载插件并验证 8 个工具注册及卸载。输出 `verified:true` 后，完全重启 DSH，在新会话里说“开启 Model行动”。`--dry-run` 只检查计划，已有旧插件时追加 `--replace-legacy` 完成备份和迁移。

安装成功后会自动清理旧文件：只保留最近 2 份备份，以及当前插件和这两份备份还在用的依赖目录和安装包，其余删除。输出里的 `pruned` 是删除的数量；个别文件删不掉时列在 `cleanup_pending` 里，下次安装会再试，不影响本次安装结果。

**安装被中断。** 安装时按一次 Ctrl-C，安装器会回滚配置、释放锁后退出，可以直接重装。如果连按两次、强制关窗口或断电，锁文件可能残留，之后再装会提示 `profile_install_locked`，并说明锁的状态：
- 「另一个安装器正在使用」：确实有安装在运行，等它结束即可；
- 「上次安装没有正常结束」或「无法确认归属」：确认没有其他安装在运行（包括共享这个 profile 的其他机器）后，在原命令末尾加上 `--force-unlock` 重装。正在运行的安装器不会被强制解锁。

同一个 profile 的安装会互斥。安装期间检测到配置被其他进程修改会终止提交，加载失败会回滚本次改动。旧 runtime 与备份保留，软链接备份依赖对应旧 runtime，请一并保留。发生外部编辑与回滚冲突时保留外部内容并报告 `profile_recovery_conflict`，需结合备份检查。进程被强制终止后的残留锁仍需排障。

支持插件安装命令的独立 CLI profile，也可从 GitHub 安装。

```sh
dsh plugin --profile web add github:xingyingyuzhui/model-action-clients
```

## 在 DSH 对话中开始游戏

发送：

> 开启 Model行动。

插件只打开对话准备，不默认开局，不要求跳转网页：

1. **资格授权**：插件先查询服务器准入策略，公开开放时直接进入备战；邀请制下首次使用时，Agent 会索取 Model行动 邀请码或完整邀请链接。用户直接在当前对话提供，Agent 调用无参数 `arena_submit_invite`；插件从这条真人消息读取，不将邀请码复制到工具参数、输出或回复。已保存且有效的资格可复用。
2. **选择配置**：在对话中说明昵称、角色外观、装备配置、模式和房间。例如“昵称小鱼，Qwen 娘，步枪，持久搜打撤，公开持久房”。大逃杀可选择自动匹配房间。
3. **核对方案**：Agent 使用服务端目录给出完整中文摘要，调用 `arena_prepare` 仅保存方案，不排队开局。要修改配置就重新给出摘要，旧确认 ID 失效。
4. **自然确认**：首次核对方案后，用普通说法同意即可，例如“行，开始吧，这次多搜一点再撤离”。不必逐字匹配口令；中间问过问题，也可以随后确认同一份未变的方案。修改配置时重新核对变更，方案过期时刷新摘要。

确认后由同一 DSH Agent 自主操作，直到服务器确认终局。结束后说“再跑一轮实时”“要多拿点钱再去撤离，再来一轮，确认开始”等即可沿用上局已确认配置入场，不必重复游戏名称或再确认一次。打法要求不会被当成形象、装备等配置变更；要换配置就先核对变更项。插件不会自行开始下一局，也不会把问题、引用或“先别开始”当作入场请求。

0.2.0 已使用过的完整配置与有效资格可直接复用；不用重新填邀请码或在网页配对。停止后不会被后台续行复活，等待邀请码、配置或确认时不阻塞对话。给用户只呈现简洁的备战信息和结果，不要求用户处理内部错误码、确认 ID 或工具调用细节。

原生工具：`arena_start`、`arena_connect`、`arena_submit_invite`、`arena_prepare`、`arena_confirm`、`arena_status`、`arena_stop`。`arena_repair_pairing` 仅用于显式兼容旧网页配对，新版对话流程不需要它。游戏工具命名空间为 `mcp__model_action__*`。

默认服务器 https://xingying.dev，可通过 `MODEL_ACTION_SERVER_URL` 或 `model-action-native` 的 profile 配置修改。`arena_status` 提供当前对话阶段、安全选项、方案与权威游戏结果；已有进行中的服务器对局会明确显示，不擅自重排或默认接管。

插件只管理生命周期和预算，不提供战斗脚本或全知观赛信息。每个 DSH 会话单独保存连接，控制租约、档案恢复和游戏凭证保留在客户端私有存储，不进入工具输出。官方工具管线会阻止通用工具直接访问私有身份路径，并在输出进入会话前拦截已知凭证字段与格式。此措施不替代操作系统沙箱；不要让 Agent 用 Bash 排查或删除身份文件。

## 构建 npm 安装包

```sh
npm ci --ignore-scripts
npm run check
```

构建结果位于 dist/：

- dsh-model-action-0.2.9.tgz
- model-action-mcp-0.2.9.tgz
- SHA256SUMS、manifest.json

GitHub Actions 运行测试并上传同样的构建产物，可在 [Actions](https://github.com/xingyingyuzhui/model-action-clients/actions) 下载。没有 npm Registry 发布步骤，也不需要 npm 发布凭证。

根目录及 MCP 包自带构建后的 lib/，GitHub 安装不需要运行构建脚本。唯一共享源码在 shared/；修改后运行 npm run build 更新两处产物，npm run build:check 校验一致性。

## 其它 MCP 客户端

安装构建好的标准包：

```sh
npm install -g ./dist/model-action-mcp-0.2.9.tgz
```

然后配置 MCP：

```json
{
  "mcpServers": {
    "model_action": {
      "command": "model-action-mcp",
      "args": ["--session", "my-client"]
    }
  }
}
```

不同客户端使用不同 session 名称。MCP 也在对话内完成：arena_start → arena_submit_invite({invitation}) → arena_prepare（昵称、形象、装备、模式、房间）→ arena_confirm，默认不打开网页、不申请配对码。已有有效资格会复用；下局用户要求再玩时，宿主调用 arena_start({reuse_previous:true}) 沿用已确认配置，不再二次确认。入场后动态提供 game_* 工具。标准 MCP 的持续决策由宿主 Agent 执行；DSH 插件接入宿主原生 loop。[MCP 包说明](packages/model-action-mcp/README.md)。

MCP 无法直接读取宿主的真人会话记录：一次邀请码由用户在对话提供，经 invitation 工具参数提交，可能被宿主记录，不会回显；长期资格、控制和恢复凭证仍只存本机私有文件。可选 MCP 表单仅用于不敏感的方案确认，不用于收集邀请码；不支持表单的客户端由宿主取得用户同意后调用确认工具。

游戏服务端与前端仍在 [agent-extraction-arena](https://github.com/xingyingyuzhui/agent-extraction-arena)。此仓库不包含服务端、邀请码、游戏令牌、模型密钥或运行数据。当前代码许可为 UNLICENSED。

## 临时公开开放（0.2.3）

当服务器明确发布公开准入模式时，DSH和MCP会自动跳过邀请码，直接进入对话备战；仍由用户选择配置并确认首次入场，后续可以沿用已确认配置。开放访客不占原内测邀请名额，房间满员仍正常排队。

恢复邀请码模式后，已入战的当前局和结算可以完成；访客开始新局需要有效邀请。旧身份、配置和恢复证明会保留。公开模式的策略探测失败不会被当成开放，不会用公开连接绕过身份删除或占用限制。

## 提前返回提示（0.2.4）

服务器声明 `step.return_after_ms` 能力后，客户端会提示 Agent 使用 `hold_ms:1000` 配合 `return_after_ms:300~500`，在按键仍生效时开始下一轮决策。此提示同时适用于原生 DSH 插件和标准 MCP；旧服务器仍可正常使用。

## 停止与凭证保护（0.2.5）

DSH 在收到真人用户的“别玩了”“先不玩”“停一下”等消息后，立即解除自动续行、取消在途调用并清理本插件排队的续行消息，保留用户输入。“退出这局”“放弃本局”等明确退局请求还会尝试服务端弃局。普通暂停只停止本地控制，角色状态通过 `arena_status` 查询。引用、战术指令和工具返回的文本不会作为真人停止授权。

游戏工具输出、状态和终局消息统一过滤邀请码与私有凭证，包括文本块里的 JSON 字段。来自服务端的工具描述与观察附有数据来源提示。普通 profile 和源码检查、单纯路径显示可以正常使用，通用工具读取游戏私有身份目录仍会被拦截。

文件锁冲突会提示关闭重复实例，禁止通过删除身份文件排障。路径与输出守卫属于纵深保护，需配合宿主权限控制。Windows 文件 ACL 尚未在 Windows 环境验证。标准 MCP 宿主需将用户停止意图交给 `arena_stop`，原生 DSH 的消息监听由插件直接处理。

可在安装官方 DSH 的 macOS 上运行中途停止回归，模型端使用本地模拟响应，游戏端使用隔离的真实房间 worker。

```bash
node scripts/e2e-natural-entry.mjs --game-dir /absolute/path/to/agent-extraction-arena --stop
```

## 停止意图与 Windows 安装调整（0.2.6）

“如何停止游戏”“怎么退出游戏”“有没有办法退出游戏”等咨询不会停止对局。“别玩了吧”“不要再打了”“算了不玩了吧”等自然停止请求会解除续行，明确退出仍会尝试服务端弃局。

DSH 安装器兼容带 UTF-8 BOM 的 profile package.json，写回时使用无 BOM JSON。Windows 安装使用真实目录，保留精确版本依赖，并由插件自身 bundle patch 加载一次。不要在 profile patch 再插入 model-action-native。Windows 分支尚未实机验证。

正常关闭会释放会话文件锁。强制结束进程或断电可能遗留锁文件，插件会拒绝访问并提示 store_locked，不会自动清除，见下面「残留的会话锁」。

### 残留的会话锁

提示 `store_locked` 时，先关闭所有 DSH 窗口和进程（或其他 MCP 宿主）再重试。仍然提示的话，就是强制退出留下的锁，需要你本人手动删除：

- DSH 插件：`~/.dsh/plugins/dsh-model-action/` 下各子目录里以 `.json.lock` 结尾的文件（设置了 `DSH_HOME` 时在 `$DSH_HOME/plugins/dsh-model-action/`）；
- MCP 包：`~/.model-action/mcp/` 下各子目录里以 `.json.lock` 结尾的文件。

只删 `.lock` 文件，不要删同名的 `.json` 身份文件，也不要让模型去做这一步：插件会阻止模型访问这些目录。

## 因果咨询与加载验收（0.2.7）

“为什么停止游戏”“因为什么会退出游戏”“他为什么想退出这局”等因果咨询不会触发停止或弃局。单独分句里的明确停止请求仍然生效，例如“退出这局，告诉我为什么失败”。

DSH 安装后需完全退出并重启，再确认 arena_status 等工具已注册，并实际完成备战入场。dump-config 与普通 import host.js 仅覆盖配置和模块入口，DSH peer 模块在 apply() 时动态加载。Windows 真实目录安装应携带完整依赖树，包含 @deepseek-ai/dsh-tools、@deepseek-ai/dsh-mcp-client、@deepseek-ai/dsh-llm，不能只复制 yaml。

## Windows 状态存储（0.2.8）

状态写入和迁移文件清理共用平台目录同步逻辑。Windows 尝试用 r+ 打开目录，仅在目录打开或同步返回 EPERM、EISDIR、EINVAL、ENOTSUP 时降级为尽力同步。文件写入、文件 fsync、替换失败及其他 I/O 错误仍会报错。macOS/Linux 保留严格目录同步。

写入仍使用临时文件、文件 fsync 和原子替换。目录同步不可用时，突然断电后的目录元数据持久性取决于系统与文件系统。Windows/macOS CI 覆盖连续读写、重开、锁释放、原生授权持久化，以及文件失败回归。Windows ACL、Esafenet 环境和完整 DSH 实机游玩需另行验收。

## 安装与生命周期回归（0.2.9）

发布验证增加打包后真实安装、重复升级、损坏包拒绝、配置保护、备份与失败回滚。安装完成前，在独立进程里调用实际 apply() 并验证工具注册和卸载。Windows、macOS、Linux CI 先跑 Node 22 组件回归，再在 Node 24 使用官方 DSH 0.2.2-rc.1 进行五轮对话、备战入场、游戏调用、再入场、真人退出和退出后重开。模型与游戏响应为显式本地测试桩，未使用付费模型，完整生产游戏和企业 DLP 环境需单独验收。

停止意图按完整的直接请求识别。“我没有让你退出这局”“如果快死了就退出这局”“stop shooting”等不会触发生命周期改变。明确的“请立即停止游戏”“现在退出这局”继续生效。锁创建失败清理本次锁，释放失败会报错并允许重试；宿主清理失败也会尝试关闭存储。备战连接中的停止会取消底层请求。
