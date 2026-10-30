# 本地抽帧依赖与宿主读图

v1.11.3（2026-10-30）修复长来源抽帧成功后仍被图片交付层 600 秒校验拒绝的问题。生成层原本已自适应采样且最多 40 帧，本版保持四张一页、原字节与处理预算。正式 v1.11.2 仍可能有该交付故障；不能把本地生成成功当作宿主已收到图像。

1.4.0 增加插件自身的视频获取与抽帧链路：支持图片输入且具备附件服务的宿主调用 `bili_humanism_read` 时，可以在同一次任务中读取文字并取得首四张图片。`bili_humanism_visual` 按已有 readingId 单独获取画面，`bili_humanism_frames` 按偏移读取后续图片。未支持图片、缺少依赖或获取失败时明确说明未取得画面；字幕不代表看过画面。图片语义由宿主视觉模型理解，未内置视觉权重或 OCR；1.6.0 仅增加由人类明确调用的可选 ASR 模型下载器。1.3.4 的旧 release 仍只有文字和手动本地抽帧入口，不具备新增自动链路。

## 自动取图与中间视频清理

自动链路只接受已保存来源的 BV/CID/分 P/时长，固定请求最高 480p（qn=32；qn=16 是 360p）。DASH 轨需具备有效的清晰度、尺寸和带宽；短边最多 480、长边最多 1920、总像素最多 921600，支持符合上限的横屏和竖屏。无 DASH 时仅接受单段 durl，不会只取多段视频的第一段。解码前检查视频流尺寸与时长，逐帧再次核对；未知或超预算的来源明确失败。

文字和自动画面在一个任务内共用最多 12 次请求和 90 秒；媒体最多 32 MiB，最多保留 40 张均匀抽样 JPEG。来源不再默认按 600 秒或其他固定时长拒绝；较长来源会增大抽样间隔，不能因此声称完整观影。使用者仍可通过可选的 `maxMediaSeconds` 明确设限，详见[媒体时长设置](MEDIA_LIMITS.md)。单张最多 2 MiB，每页最多四张；宿主的附件上限可能更小。下载前先用同一个解释器执行依赖预检，缺失时返回 `FRAME_DEPENDENCIES_UNAVAILABLE`。所有子进程共享同一个取消/总时长预算；API 风控暂停不会被画面回退吞掉。

插件在自己的 `dataDir/media-intermediates/` 下为本次下载创建独占文件，成功抽帧、解码或下载失败、取消和超时均在 finally 中关闭句柄/子进程后删除该视频及其空任务目录。清理核对创建时的文件/目录身份，不按后缀、分辨率、mtime 或目录批量删除；身份发生替换或删除失败则报告，不提交可复用的成功画面索引。帧 JPEG、manifest、来源索引和导入文字留在私有 assets/账本中供宿主继续阅读。

普通 `local-frames READING_ID local-video.mp4` 读取的是用户提供的原文件，保持不动。旧技能或其他程序已经下载到其他位置的 480p 视频也不会被追删；本功能只清理新链路自己创建的中间视频。进程被硬终止或断电时不能保证 finally，遗留内容需本人核对，没有后台扫盘删除。

1.11.1 增加[响应预算诊断](MEDIA_LIMITS.md#响应字节与时长的诊断1111)：`RESPONSE_TOO_LARGE` 报具体响应字节门限与观测值，不能解读成超过600秒；`status.media` 同时列出媒体/JSON字节和任务请求/墙钟预算。原有预算保持。

## 一条命令安装独立环境（1.6.0 起）

先确认 Python 3.10+ 可用，并进入插件的实际安装目录（包含 `bin/cli.mjs`）。将私有数据目录设为与宿主插件 **同一个 `dataDir`**，再执行：

```powershell
$env:BILI_HUMANISM_HOME = 'D:\your-private\bili-humanism'
node bin/cli.mjs setup-media
node bin/cli.mjs doctor
```

macOS/Linux 对应 `export BILI_HUMANISM_HOME=/your/private/bili-humanism`，其余 Node 命令相同。Node 需满足本包的 24+ 要求。找不到 Python 时可加 `--python` 和解释器绝对路径；Windows 优先探测 DSH 已安装的 primary runtime Python，再查系统命令，不会安装或修改全局 Python。

安装器在 `dataDir/media-runtime/venv` 创建专用环境，以固定版本、仅二进制 wheel 安装 `av==16.1.0` 与 `Pillow==12.3.0`，实际运行四色合成视频 smoke 后才保存完成标记。此后插件自动使用该环境，无需另填 pythonPath。原有人工 `pythonPath` 和 `BILI_HUMANISM_PYTHON` 优先；如果它们指向另一个 Python，`doctor` 会显示实际采用的解释器和缺失组件，需本人移除旧覆盖或在该环境安装依赖。无需手工复制 node_modules。

安装需要访问官方 PyPI；没有匹配 wheel、网络不可用或导入失败会明确失败，不能当作已装好。只安装在私有目录，不通过 npm prepare/postinstall 或模型工具暗中运行 pip。中断留下 `setup.lock` 时先确认旧安装器已退出，再本人核对该私有锁文件；不会自动删除未知环境。

### 可选本地 ASR

```powershell
node bin/cli.mjs setup-media --asr --download-model
node bin/cli.mjs doctor
```

该明确命令安装 [`faster-whisper==1.2.1`](https://pypi.org/project/faster-whisper/1.2.1/) 及 CPU 依赖，并下载官方 [`Systran/faster-whisper-small`](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120) 固定提交的四个文件，共 **486,212,372 字节（约 464 MiB）**，逐文件核对大小和 SHA-256，再实际以 CPU/int8 加载模型。使用公开 HTTPS 下载，不读取 Hugging Face token 或浏览器凭据，不装 CUDA。模型和环境不进入 npm 包或 GitHub 附件。仅 `--asr` 会安装依赖而不下载权重，doctor 如实显示 `model_missing`；已有模型可由本人配置绝对 `asrModelPath`。实际 wheel 支持取决于 Python/系统，Windows Python 3.12 已验证；不承诺所有 Python 版本和架构。

安装后本地 ASR 可省略模型路径：

```sh
node bin/cli.mjs audio READING_ID
node bin/cli.mjs local-asr READING_ID /your/private/downloaded-audio.m4s
```

`audio` 返回本地路径，填入第二条命令；已有音频也可直接使用。结果直接保存 A3 来源并返回来源 ID，继续按已有来源工具阅读。仍受 32 MiB 下载、90 秒任务等预算约束；ASR 是机器转写，专名需回查。取到部分 A1 字幕时不会自动启动 ASR 去补后半段，A2 仍只在没有可用 A1 时回退。每日定时取稿也不会触发媒体或模型下载。

**装依赖不能让纯文本模型接收图片。** 抽帧就绪与宿主支持图片、附件交付、模型确实读过画面是不同状态。纯文本路由仍明确返回未取得画面，不更改用户模型或把字幕推断冒充视觉识别。

## 手工安装可选抽帧依赖

Python 3.10 以上；固定使用 [PyAV `av==16.1.0`](https://pypi.org/project/av/16.1.0/) 和 [Pillow `12.3.0`](https://pypi.org/project/pillow/12.3.0/)。这两个版本支持 Python 3.10 以上，PyPI 提供 Windows amd64 的 cp310 至 cp314 wheel；其他系统和架构以实际 wheel 可用性为准，不表示已完成跨平台实测。`numpy`、`faster-whisper` 与 ASR 模型不是本抽帧路径的必需依赖。先创建专用虚拟环境，再以同一个解释器安装、诊断和执行抽帧；不要修改全局 Python 环境。

PyAV 官方说明其二进制 wheel 已链接 FFmpeg 库；本脚本直接使用 PyAV 解码，不调用系统 `ffmpeg.exe`，因此按本说明成功安装官方 wheel 后，此抽帧路径不要求另装 FFmpeg 命令行程序。源码编译或其他软件的 FFmpeg 需求另论，见 [PyAV 安装说明](https://pypi.org/project/av/16.1.0/#description)。

Windows PowerShell，在源码根目录执行：

```powershell
python -m venv .venv-frames
.\.venv-frames\Scripts\python.exe -m pip install --only-binary=:all: -r scripts/requirements-frames.txt
.\.venv-frames\Scripts\python.exe scripts/frame_environment.py doctor
.\.venv-frames\Scripts\python.exe scripts/frame_environment.py smoke
$env:BILI_HUMANISM_PYTHON = (Resolve-Path .\.venv-frames\Scripts\python.exe).Path
```

macOS / Linux，在源码根目录执行：

```sh
python3 -m venv .venv-frames
.venv-frames/bin/python -m pip install --only-binary=:all: -r scripts/requirements-frames.txt
.venv-frames/bin/python scripts/frame_environment.py doctor
.venv-frames/bin/python scripts/frame_environment.py smoke
export BILI_HUMANISM_PYTHON="$PWD/.venv-frames/bin/python"
```

1.4.0 的 npm 包含两个 Python 脚本和依赖清单，已发布的旧 1.3.4 tarball 不会因此改变。从 npm 包使用时，将命令中的 `scripts/` 改为该安装包内的实际脚本目录，虚拟环境放在自己的私有工作目录。npm 安装不会执行 pip 或安装 Python 依赖。`--only-binary` 在当前 Python/平台没有匹配 wheel 时明确失败，不会自动改成从源码编译；请选择存在官方 wheel 的 Python/平台后重试。

`BILI_HUMANISM_PYTHON` 由启动 DSH 的进程继承；在另一个终端设置不保证已经运行的 Desktop 进程能看到。先在同一个终端用本地 CLI 验证，并让宿主采用同一个已确认的解释器路径。

Desktop 可以在该 profile 的可信插件配置中填写绝对 `pythonPath`，保存后重载。优先顺序为人工 `pythonPath`、进程环境 `BILI_HUMANISM_PYTHON`、最后 `python`；相对的配置路径会被拒绝。模型工具没有解释器或路径设置参数。

```sh
node bin/cli.mjs visual READING_ID
node bin/cli.mjs visual-frames READING_ID 4
```

CLI 返回受控图片元数据供本地检查；DSH 工具通过宿主附件协议把实际图片交给模型，单独的本机路径不算图片已送达。

## doctor 与 smoke 的含义

`doctor` 实际导入 `av` 和 `PIL.Image`，以 JSON 返回版本、固定版本匹配结果、缺失依赖及 Python 版本支持情况。依赖不可用、版本不符或 Python 版本不支持时退出码为 2。它不会尝试安装、下载模型、读取凭据或调用 B站。

`smoke` 生成四秒的合成四色视频，调用发行的 `media.py frames`，检查四张 JPEG 的尺寸、时间戳和颜色，结束后删除临时媒体。通过时只说明本机解码、抽样和图片输出可用。`host_vision.status` 保持 `not_tested`，不是完整画面理解验收，也不是实际视频质量结论。诊断和 smoke 均不访问平台或视觉服务。

## 从图片到可追溯的文字

先取得自己有权处理的本地视频，并用同一视频的 reading ID 抽帧：

```sh
node bin/cli.mjs local-frames READING_ID local-video.mp4
```

返回目录中包含 `manifest.json` 和 JPEG。把实际图片交给支持图片输入的宿主，连同 manifest 时间戳让它阅读；没有图片或宿主不支持读图时，不能把字幕推断说成看到了画面。均匀抽样最多 40 张，可能漏掉页、按钮状态和运动细节，不是逐页检测。

宿主读图后生成本地 `visual-text.json`；下面仅为合成格式示例：

```json
{
  "route": "frame",
  "segments": [
    {
      "start": 5,
      "end": 6,
      "text": "合成示例：该帧上可见的文字；不清晰处保留不确定性。"
    }
  ]
}
```

```sh
node bin/cli.mjs import READING_ID visual-text.json
```

也可由宿主调用已注册的 `bili_humanism_import`；`json` 参数必须是序列化后的 JSON 字符串，不是嵌套对象，例如：

```json
{
  "readingId": "READING_ID",
  "json": "{\"route\":\"frame\",\"segments\":[{\"start\":5,\"end\":6,\"text\":\"合成画面文字\"}]}"
}
```

按导入结果返回的来源 ID 调用 `bili_humanism_source` 查看；保存状态为 `visual_text_partial`，不会冒充语音稿，也不保证对画面含义的判断正确。图片、源视频、导入正文和私人阅读记录留在本地，不加入仓库或 release 附件。
