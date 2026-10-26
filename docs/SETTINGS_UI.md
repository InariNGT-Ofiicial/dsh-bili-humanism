# 设置页（可选）

在带 Web 界面和 `settings.section` 槽位的 DSH 宿主里，插件会在 **设置 → 左侧栏「B站内容学习」** 注册一页设置，把 `Config` 里的配置项做成表单。它是**可选的第二入口**：没有这一页的宿主（纯 CLI、没有 Web 服务的宿主、或用普通对象调用 `apply()` 的测试）仍然按 `docs/GETTING_STARTED.md` 直接改 profile 配置，插件工具不受影响。

## 位置与前提

1. 宿主是 DSH 桌面版这类带 Web 界面的实现，且提供 `settings.section` 槽位；插件在 `package.json` 里声明 `dsh.client`（`platform: web`、`inject: ["slots"]`、`external: ["react"]`）并导出 `./client` 打包文件。
2. 宿主提供 `webServer` 服务。宿主没有它时，`apply()` 里通过 `ctx.inject(["webServer"], …)` 挂载的路由不会被注册，页面会显示「读不到设置」，但模型工具照常可用。
3. 页面显示的是**合并后的有效值**：页面覆盖层 > profile 的 `cordis.patch.yml` > `Config` 默认值。每项旁边会标「设置页 / 配置文件 / 默认」。

## 能改什么

- 读取与额度：`maxReadTokens`、旧字段 `maxSessionTokens`、`maxMediaSeconds`（可标「不限」）。
- 每日取稿：`enableDailyFetching`、`dailyFetchStart`、`dailyFetchEnd`、`dailyFetchLimit`（1 或 2）。
- 画面与语音：`pythonPath`、`asrModelPath`，各带一个「检查」按钮，只看路径是否存在，不运行 `doctor`。
- 人格与手账：`enablePersonalityLearning`、`enablePersonalityShadow`（实验性）、`shadowMaxReviewsPerDay`（1–10）、`dataDir`。
- 账号与写入：`credentialPath`、`writePolicyPath`、`accountStateDir`，以及历史 / 收藏 / 点赞 / 投币四个写入开关；四个开关默认收起，开启需要在页面上输入确认词「开启写入」。

## 保存在哪里

页面保存到 `<dataDir>/settings.json`（`dataDir` 为空时是 `$DSH_HOME/bili-humanism/settings.json`，桌面版通常是 `~/.dsh/bili-humanism/settings.json`），文件权限 0600，写入采用「临时文件 + 重命名」的原子替换，覆盖已有文件前留一份 `settings.json.bak`。

- 这份文件是**人工覆盖层**，只接受白名单字段；未知字段、越界数值、相对路径、时间顺序错误都会被拒绝，不会被写进文件。
- 文件被手改坏（非法 JSON 或字段）时，载入会忽略坏内容并保留可用字段，页面顶部会提示具体错误。
- 「恢复配置文件值」会删除该文件（仍然留 `.bak`），所有项回到 profile 的 `cordis.patch.yml` 或 `Config` 默认值。

## 什么时候生效

| 改动 | 生效方式 |
| --- | --- |
| 取稿额度、时长上限、`pythonPath`、`asrModelPath`、`credentialPath`、`writePolicyPath`、`accountStateDir` | 保存即写入运行中的 Service |
| 每日取稿开关、时间窗、每天份数 | 保存后重建定时器，即时生效 |
| `shadowMaxReviewsPerDay` | 保存即生效 |
| 打开账号写入开关 | 需重新加载/重启 DSH（工具在 `apply()` 时注册） |
| 打开人格积累、打开人格影子 | 需重新加载/重启 DSH（工具在 `apply()` 时注册） |
| 改 `dataDir` | 需重新加载/重启 DSH（账本根目录在建服务时确定） |

页面保存后会列出本次「即时生效」与「要重启才生效」的项。

## 安全边界

设置页**不是授权**，也不改变插件的写入边界：

1. 四个写入开关只决定 `apply()` 注不注册对应的写入工具。真正调用时仍然需要 `writePolicyPath` 指向的人工授权文件、已有的设备 Cookie，以及人工确认的消费回执；没有这些，工具会拒绝或在调用时失败。
2. 页面不生成、不读取、不回显任何凭据内容，只检查路径是否存在。授权文件与 Cookie 仍由人自行准备。
3. 评论入口始终关闭；页面不提供评论、关注、投稿等能力。
4. 设置页的四条路由（`/dsh-bili-humanism/settings/state|save|clear|check`）是给人用的本地辅助接口，不是模型工具；模型无法通过工具调用改写这份覆盖层。
5. 覆盖层不属于可信授权：即使有人在页面里打开写入开关，插件也不会把「页面开关」当成平台授权。

## 实现与验证

新增 `lib/settings.mjs`（白名单校验、合并、热更新、原子读写）、`lib/settings-http.mjs`（四条本地路由）、`lib/client.js`（设置页，槽位 `settings.section`）；`index.js` 在启动时合并覆盖层、按合并后的值注册写入工具、并通过 `ctx.inject(["webServer"], …)` 挂载路由；`package.json` 增加 `exports["./client"]` 与 `dsh.client`。

已验证：

- `test/settings.test.mjs` 11 项：字段校验、未知字段拒绝、覆盖层合并与 `null` 删除、原子写与备份、坏 JSON 回退、热更新与重启项区分、清除后回退到默认、确认词拦截、路由方法与请求体守卫。
- Windows DSH Desktop `0.2.1-rc.3`（`desktop` profile，link 安装）上：设置页出现在左侧栏；`GET …/settings/state` 返回 200；`POST …/save` 与 `POST …/clear` 往返后 `settings.json` 生成并被删除、备份保留。
- 上游测试套件在本机跑过一遍，与未改动的上游对照：通过项一致；失败的 7 个文件在两边完全相同，原因是本机沙箱禁止子进程（`EPERM`）与缺少 Python 媒体依赖，不是本次改动引起。`node scripts/check.mjs` 通过。

未验证：其他宿主版本、macOS/Linux 桌面、以及非 Web 宿主上的页面行为（预期是不出现该页，仍需实测）；页面的实际观感与键盘可访问性未做人工评审。
