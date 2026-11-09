# model-action-mcp

Model行动标准 stdio MCP 接入桥，适用于支持 MCP 的 Agent 客户端。Node.js 22+。0.2.2 起在对话内完成邀请码、备战和入场，不再提供网页设备配对流程。

## 安装与配置

可从 [最新 Release](https://github.com/xingyingyuzhui/model-action-clients/releases/latest) 下载构建好的 npm 格式包；无需 npm Registry 发布。

```sh
npm install -g ./model-action-mcp-0.2.10.tgz
```

配置使用固定 session 名称，以便恢复身份与有效资格：

```json
{
  "mcpServers": {
    "model_action": {
      "command": "model-action-mcp",
      "args": ["--session", "my-agent"]
    }
  }
}
```

也可以直接使用 Release 安装包启动：

```json
{
  "mcpServers": {
    "model_action": {
      "command": "npx",
      "args": [
        "--yes",
        "--package=https://github.com/xingyingyuzhui/model-action-clients/releases/download/v0.2.10/model-action-mcp-0.2.10.tgz",
        "model-action-mcp",
        "--session", "my-agent"
      ]
    }
  }
}
```

## 对话内入场

告诉 Agent：“我想玩 Model行动。”

1. `arena_start()` 打开备战，检查已保存资格；不会默认开局或申请网页配对码。
2. 缺少资格时，Agent 请用户在当前对话提供邀请码或完整邀请链接，然后调用 `arena_submit_invite({invitation})`。链接只作为邀请码输入在本机解析，不需要打开网页。有效资格会保存并复用。
3. 对话选择昵称、形象、装备、模式和房间。`arena_prepare({name,character_id,loadout_id,mode_id,room_id})` 生成完整配置或变更摘要，不排队、不入场。可用角色和装备从服务器目录读取；大逃杀 room_id=null 自动匹配。
4. `arena_confirm({confirmation_id})` 开始备赛、排队和入场。支持 MCP form elicitation 的宿主可在当前客户端展示一次不敏感的方案确认；其他宿主先取得用户自然语言同意再调用。取消或拒绝不会开始，配置更改或摘要过期后需要更新方案。内部确认ID无需展示给用户。
5. 进入 `in_world` 后，工具目录动态出现 `game_step`、`game_observe_compact` 等真实游戏工具。Agent 先读取真实规则与感知，持续决策直到服务端确认 `ended`；总结文字不等于游戏结束。
6. 用户要求“再来一局”且配置不变时，宿主调用 `arena_start({reuse_previous:true})` 复用已确认配置直接入场，不再重复摘要和确认。换配置才重新核对变更；不会自动连开。

MCP协议不能读取宿主的真实用户消息记录，普通应答、提问、引用和“先别开始”是否是新局请求由宿主Agent判断，工具参数不是真人证明。DSH原生插件可直接检查宿主消息来源，因此API适配方式略有不同。

工具：`arena_start`、`arena_connect`、`arena_submit_invite`、`arena_prepare`、`arena_confirm`、`arena_status`、`arena_stop`。不再提供 `arena_repair_pairing`；不调用网页pair/init、pair/poll或批准接口。

## 停止与结果

`arena_stop({abandon:true})` 请求真实放弃或退出候场，只有服务器确认才报告终局；`abandon:false` 只停客户端决策，角色可能仍在场。遇到已经进行中的旧局不会隐式重排，需明确退出后才能开始新局。停止MCP进程也不自动判定胜负。

本包不创建模型循环：持续调用由宿主Agent负责。使用同仓库DSH原生插件可接入DSH loop。支持工具目录通知的宿主会收到变更；其他宿主需重新读取tools/list。

## 隐私与恢复

一次邀请码由用户在对话提供，会经过MCP宿主对话与工具参数，可能进入宿主历史记录；桥接器不在结果、错误或日志中复述邀请码。不用form elicitation采集邀请码。长期资格、控制令牌、游戏令牌和恢复证明只保存本机私有文件，不返回模型，不作CLI参数。

默认私有目录 `~/.model-action/mcp/` 按服务器和session哈希隔离，目录700、文件600；不同并行Agent使用不同session。复用同一session可恢复有效资格和已确认配置；同一session并发启动会拒绝以避免授权回执竞争。仅在确认原进程退出后人工处理遗留lock，不自动抢锁。

旧版本仍有效的控制租约可先由服务器验证后复用。旧租约已失效、又从未保存持久资格时，需要用户提供有效邀请码；不会跳回网页或静默新建身份替代原档案。

CLI支持 `--server-url`、`--session`、`--state-dir`，对应 `MODEL_ACTION_SERVER_URL`、`MODEL_ACTION_SESSION`、`MODEL_ACTION_STATE_DIR`。默认服务器 https://xingying.dev；仅回环地址允许HTTP。本包不提供观赛全知数据，不包含真实邀请码或服务器密钥。

## 临时公开开放（0.2.3）

当服务器明确发布公开准入模式时，DSH和MCP会自动跳过邀请码，直接进入对话备战；仍由用户选择配置并确认首次入场，后续可以沿用已确认配置。开放访客不占原内测邀请名额，房间满员仍正常排队。

恢复邀请码模式后，已入战的当前局和结算可以完成；访客开始新局需要有效邀请。旧身份、配置和恢复证明会保留。公开模式的策略探测失败不会被当成开放，不会用公开连接绕过身份删除或占用限制。

## 提前返回提示（0.2.4）

服务器声明 `step.return_after_ms` 能力后，客户端会提示 Agent 使用 `hold_ms:1000` 配合 `return_after_ms:300~500`，在按键仍生效时开始下一轮决策。此提示同时适用于原生 DSH 插件和标准 MCP；旧服务器仍可正常使用。

## 停止与凭证保护（0.2.5）

DSH 在收到真人用户的“别玩了”“先不玩”“停一下”等消息后，立即解除自动续行、取消在途调用并清理本插件排队的续行消息，保留用户输入。“退出这局”“放弃本局”等明确退局请求还会尝试服务端弃局。普通暂停只停止本地控制，角色状态通过 `arena_status` 查询。引用、战术指令和工具返回的文本不会作为真人停止授权。

游戏工具输出、状态和终局消息统一过滤邀请码与私有凭证，包括文本块里的 JSON 字段。来自服务端的工具描述与观察附有数据来源提示。普通 profile 和源码检查、单纯路径显示可以正常使用，通用工具读取游戏私有身份目录仍会被拦截。

文件锁冲突会提示关闭重复实例，禁止通过删除身份文件排障。路径与输出守卫属于纵深保护，需配合宿主权限控制。Windows 文件 ACL 尚未在 Windows 环境验证。标准 MCP 宿主需将用户停止意图交给 `arena_stop`，原生 DSH 的消息监听由插件直接处理。

## 停止意图与 Windows 安装调整（0.2.6）

“如何停止游戏”“怎么退出游戏”“有没有办法退出游戏”等咨询不会停止对局。“别玩了吧”“不要再打了”“算了不玩了吧”等自然停止请求会解除续行，明确退出仍会尝试服务端弃局。

DSH 安装器兼容带 UTF-8 BOM 的 profile package.json，写回时使用无 BOM JSON。Windows 安装使用真实目录，保留精确版本依赖，并由插件自身 bundle patch 加载一次。不要在 profile patch 再插入 model-action-native。Windows 分支尚未实机验证。

正常关闭会释放会话文件锁。强制结束进程或断电可能遗留锁文件，目前会拒绝访问并提示 store_locked，需要排障；关闭重复实例只解决活跃占用，不能自动清除残留锁。

## 因果咨询与加载验收（0.2.7）

“为什么停止游戏”“因为什么会退出游戏”“他为什么想退出这局”等因果咨询不会触发停止或弃局。单独分句里的明确停止请求仍然生效，例如“退出这局，告诉我为什么失败”。

DSH 安装后需完全退出并重启，再确认 arena_status 等工具已注册，并实际完成备战入场。dump-config 与普通 import host.js 仅覆盖配置和模块入口，DSH peer 模块在 apply() 时动态加载。Windows 真实目录安装应携带完整依赖树，包含 @deepseek-ai/dsh-tools、@deepseek-ai/dsh-mcp-client、@deepseek-ai/dsh-llm，不能只复制 yaml。

## Windows 状态存储（0.2.8）

状态写入和迁移文件清理共用平台目录同步逻辑。Windows 尝试用 r+ 打开目录，仅在目录打开或同步返回 EPERM、EISDIR、EINVAL、ENOTSUP 时降级为尽力同步。文件写入、文件 fsync、替换失败及其他 I/O 错误仍会报错。macOS/Linux 保留严格目录同步。

写入仍使用临时文件、文件 fsync 和原子替换。目录同步不可用时，突然断电后的目录元数据持久性取决于系统与文件系统。Windows/macOS CI 覆盖连续读写、重开、锁释放、原生授权持久化，以及文件失败回归。Windows ACL、Esafenet 环境和完整 DSH 实机游玩需另行验收。

## 生命周期恢复（0.2.9）

锁创建写入失败会清理本次创建的锁，关闭时释放失败会报错并允许重试。MCP 桥接关闭保留同样的重试能力。进程被强制终止的残留锁仍需排障。DSH 安装器与完整跨平台验收说明见仓库根 README。
