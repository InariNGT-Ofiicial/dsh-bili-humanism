# 安装后从哪里开始、在哪里配置

本插件通过 DSH 对话中的工具使用，配置保存在运行该会话的 profile 中。导出 `Config` schema 负责校验配置和填充默认值，不会自动生成第三方插件页面；宿主有 Web 界面与 `settings.section` 槽位时，插件另外提供一页可选设置（**设置 → 左侧栏「B站内容学习」**），它把同一批配置项做成表单，保存在本地人工覆盖层里，见[设置页](SETTINGS_UI.md)。没有这个页面的宿主（纯 CLI 等）仍按本文件直接改 profile 配置。

**还没安装成功时，先看[Windows 桌面安装三步](WINDOWS_INSTALL.md)。** 推荐插件市场只接受其精选目录中的条目，本插件尚未收录；桌面自带 CLI 可以安装本地 `.tgz`，并由宿主维护 profile 的依赖与 bundle 清单。

## 先确认装在当前 profile，并已启用

在 DSH 侧栏的「插件」中检查已安装组合包 `dsh-bili-humanism` 是否启用。宿主的「设置 → 内置插件」主要提供内置插件清单；它不是本插件的配置入口。上述界面名称依据固定 DSH 版本的上游说明，本项目尚未单独验收桌面图形操作。

如果使用终端安装，`--profile web` 中的 `web` 只是示例；安装的 profile 必须与当前会话使用的 profile 一致。不同 profile 的安装与配置不会自动互通。安装后按宿主方式重新加载，必要时完全退出并重新打开同一 profile。

先在 DSH 对话中发送：

> 请调用 bili_humanism_guide 和 bili_humanism_status，确认这个插件已加载。暂时不要访问 B站或执行账号写入。

没有这两个工具时，先检查安装是否成功、组合包是否开启、profile 是否一致及宿主加载错误；不要通过打开账号写入权限来排查加载问题。检查配置层可用：

```sh
dsh --profile YOUR_PROFILE --dump-config
```

把 `YOUR_PROFILE` 替换为实际名称，查找 `bili-humanism` / `dsh-bili-humanism`。Windows 只有桌面版、找不到 `dsh` 命令时，可在 PowerShell 使用桌面内置 CLI：

```powershell
$DshExe = (Read-Host '请输入 DeepSeek Harness.exe 的完整路径').Trim().Trim('"')
if (-not (Test-Path -LiteralPath $DshExe -PathType Leaf)) { throw '找不到 DSH 程序' }
$DshCli = Join-Path (Split-Path -Parent $DshExe) 'resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
$ProfileName = Read-Host '请输入当前会话实际使用的 profile 名称'
$PreviousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $DshExe --expose-internals $DshCli --profile $ProfileName --dump-config | Out-Host
    if ($LASTEXITCODE -ne 0) { throw '配置检查失败，请查看终端错误' }
} finally {
    $env:ELECTRON_RUN_AS_NODE = $PreviousElectronRunAsNode
}
```

## 默认配置即可开始只读学习

确认工具存在后，再把自己选择的视频链接交给 DSH：

> 用 bili_humanism_read 读取这个视频，说明实际取得了哪些材料、还缺哪些材料。需要继续精读时沿 bili_humanism_source 的 next_offset 读取。只有值得记录的新认识才写手账，并区分事实、作者观点和推测。

1.4.0 在当前模型明确支持图片输入且宿主附件服务可用时，`read` 会同时尝试下载最高 480p 视频、抽帧并交付首四张图片；继续沿 `visual.nextOffset` 调用 `bili_humanism_frames`。已有读取 ID 可用 `bili_humanism_visual` 单独取图。需先按[本地抽帧说明](LOCAL_FRAMES.md)安装依赖并设置绝对 `pythonPath`；文本模型或依赖缺失会明确返回画面不可用，文字仍可读取。

默认匿名读取，人格积累默认开启，历史、收藏、点赞与投币四项账号写入分别默认关闭。账号凭据、可选媒体依赖和平台权限均不是 `guide` / `status` 加载检查的前置条件。空稿、需要登录或媒体能力缺失应按返回的状态处理，不能据此认定整个插件未安装。

从 1.8.0 起，每日取稿默认关闭，需要时由本人设置 `enableDailyFetching: true` 并重载，见[每日取稿](DAILY_FETCH.md)。已发布 v1.7.1 仍默认开启；下面的显式 `false` 配置也可用于关闭旧版调度。

匿名返回 `subtitles=[]` 不能证明视频没有字幕：部分字幕轨可能只在有效登录态下返回，具体可用性随来源和平台变化。从 1.7.1 起，允许可信 `credentialPath` JSON 同时提供 `sessdata` 和可选的现有 `buvid3`，读取 API GET 会携带该设备值；不自动获取或生成设备 Cookie，字幕/媒体 CDN 不收到凭据。提供设备值后缓存身份独立，原缓存保留；这不保证解决 HTTP 412，遇 401/403/412/429 或 API 风控仍持久暂停，由本人核对风险后决定是否恢复。不要照反馈中的建议反复探测或取消暂停规则。

## 配置文件的具体位置

配置写在实际 DSH 主目录下的：

```text
$DSH_HOME/profiles/<实际 profile 名>/cordis.patch.yml
```

未自定义 DSH 主目录时通常位于 `~/.dsh`；桌面启动器或自己的启动脚本若使用其他 `DSH_HOME`，须沿用那个目录。另一个终端里的环境变量不一定与已运行的桌面进程相同。不要修改已安装 npm 包内部的 `cordis.patch.yml`，因为它属于组合包自身、可能随更新替换。

在 profile 的 patch 数组中，按已存在的 `id: bili-humanism` 设置 `config`。下面是最小配置示例，不需要另加 `insert` 行：

```yaml
- id: bili-humanism
  config:
    maxReadTokens: 600000
    enablePersonalityLearning: true
    enableDailyFetching: false
    enableHistoryWrites: false
    enableFavoriteWrites: false
    enableLikeWrites: false
    enableCoinWrites: false
```

启用抽帧时，在同一 `config` 中增加 `pythonPath`，例如 Windows 的 `pythonPath: 'C:/your/private/frame-venv/Scripts/python.exe'`，或 macOS/Linux 的 `pythonPath: /your/private/frame-venv/bin/python`。请替换为已经通过 `doctor` 和 `smoke` 的实际绝对路径。它优先于启动进程的 `BILI_HUMANISM_PYTHON`，最后才使用 `python`；模型工具不能更改解释器。

已有该 id 的覆盖项时编辑原项，不要重复追加。保留文件中其他插件的行；`config` 是整项替换，已有 `dataDir`、`credentialPath` 等需要保留的字段也要留在同一项里。先备份自己的配置文件，保存后重新运行 `--dump-config` 检查实际结果，再重载同一 profile。

profile patch 之后还可能叠加主目录级 patch 和命令行 `--patch`。如果保存后结果仍不同，检查这些更高优先级覆盖，不要反复重装插件或清空私人账本。

从 1.4.1 起，`maxReadTokens` 是每份取稿独立的估算 token 上限，默认 `600000`，按正文 UTF-8 字节数保守估算，不累计整场对话。旧字段 `maxSessionTokens` 继续兼容；两者同时填写时新字段优先，人工改高或改低后重载。详见[取稿额度](TOKEN_BUDGET.md)。需要账号接入时，再阅读[账号接入](ACCOUNT_INTEGRATION.md)与[写入配置](WRITE_CONFIG.md)，不要在聊天或 issue 中提交 Cookie、密钥或完整配置转储。

## 独立 CLI 的凭据入口

`node bin/cli.mjs ...` 与 DSH profile 配置是两个加载入口。独立 CLI 不自动查找或解析 profile 的 `cordis.patch.yml`；通过 `BILI_HUMANISM_CREDENTIAL_FILE` 显式指定本地凭据 JSON 路径，或通过 `BILI_HUMANISM_CONFIG_FILE` 指定含 `credentialPath` 与 `dataDir` 的私有 JSON 配置。后者的同名字段覆盖环境变量。只引用自己已有的凭据文件，不把凭据值放进命令或公开反馈。

未加载凭据时遇到一般 API 错误，1.11.1 保留 `API_UNAVAILABLE` 并给出上述提示；这不能证明失败原因就是匿名访问。风险码的分类、持久暂停及可信本地恢复流程保持。

## 当前验证范围

已在 Windows DSH Desktop 内置 CLI `0.2.1-rc.2` 的全新隔离 profile 中，离线安装已发布的 v1.3.4 包，修改该 profile 的 patch，并验证 `--dump-config`、`guide` / `status` 工具执行和配置开关生效。没有使用用户现用 profile、账号凭据、真实模型或 B站请求。这证明文件配置入口可用，不能替代反馈者的安装环境排查或桌面设置界面验收。

上游固定版本说明：[组合包与 profile 层顺序](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/publish.zh.md)、[Config schema](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/user/develop/basic/config.zh.md)、[插件管理与自有配置页](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-plugin-manager/README.zh.md)。
