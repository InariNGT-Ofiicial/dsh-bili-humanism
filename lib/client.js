// DSH「B站内容学习」· 网页半边
//
// 只在 **DSH 设置** 左侧栏加一项「B站内容学习」，把插件的配置摆出来：
// 取稿额度、每日取稿、画面依赖、人格积累、账号写入开关与数据路径。
//
// ⚠ 这里不读也不写文件：所有值都走宿主半边的 /dsh-bili-humanism/settings
//   路由，存到 <dataDir>/settings.json 这份人工覆盖层，删掉它就回到 profile 的
//   cordis.patch.yml。与 dsh-fish-memory / dsh-speak-up 用的是同一套槽位与做法。
//
// ⚠ 四个账号写入开关只是「注不注册写工具」。真正发出去还要可信授权文件、
//   设备 Cookie 和人工确认的回执，本页不生成任何凭据，也不代表本人在平台上同意。
window.__ModuleLoader__.load({
  id: "dsh-bili-humanism",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const inject = ["slots"];

    const B = "/dsh-bili-humanism/settings";
    const CONFIRM_WORD = "开启写入";

    const RESTART_LABEL = {
      dataDir: "账本目录（dataDir）",
      enableHistoryWrites: "历史写入工具",
      enableFavoriteWrites: "收藏写入工具",
      enableLikeWrites: "点赞写入工具",
      enableCoinWrites: "投币写入工具",
      enablePersonalityLearning: "人格审阅工具",
      enablePersonalityShadow: "人格影子工具",
      dailyFetch: "每日取稿调度",
    };
    const APPLIED_LABEL = {
      maxReadTokens: "取稿额度",
      maxSessionTokens: "旧额度字段",
      maxMediaSeconds: "时长上限",
      pythonPath: "抽帧 Python",
      asrModelPath: "ASR 模型",
      credentialPath: "账号凭据",
      writePolicyPath: "写入授权文件",
      accountStateDir: "账号状态目录",
      enableHistoryWrites: "历史写入",
      enableFavoriteWrites: "收藏写入",
      enableLikeWrites: "点赞写入",
      enableCoinWrites: "投币写入",
      enablePersonalityLearning: "人格积累",
      dailyFetch: "每日取稿调度",
    };
    const SRC_LABEL = {
      settings: "设置页",
      config: "配置文件",
      default: "默认",
    };

    // 校验错误码（settings.mjs 里那几条）翻成人话 —— 原来把
    // `maxReadTokens:integer` 这种码直接甩给用户，等于没说。
    const FIELD_LABEL = {
      maxReadTokens: "每份取稿的估算上限",
      maxSessionTokens: "旧额度字段",
      maxMediaSeconds: "单条视频时长上限",
      dailyFetchStart: "时间窗开始",
      dailyFetchEnd: "时间窗结束",
      dailyFetchLimit: "每天最多几份",
      pythonPath: "抽帧 Python",
      asrModelPath: "本地 ASR 模型目录",
      dataDir: "账本目录",
      credentialPath: "账号凭据 JSON",
      writePolicyPath: "写入授权文件",
      accountStateDir: "账号状态目录",
      enableHistoryWrites: "历史写入",
      enableFavoriteWrites: "收藏写入",
      enableLikeWrites: "点赞写入",
      enableCoinWrites: "投币写入",
      enablePersonalityLearning: "人格积累",
      enablePersonalityShadow: "人格影子",
      shadowMaxReviewsPerDay: "影子每日审阅次数",
      enableDailyFetching: "每日取稿",
    };
    const KIND_LABEL = {
      text: "内容不合法",
      absolute: "要填绝对路径",
      boolean: "只能是开或关",
      positive: "要填正整数",
      limit: "只能选 1 或 2",
      time: "要填 HH:mm 格式",
      integer: "要填正整数，不能留空",
      empty: "不能留空",
    };
    const explainError = (code) => {
      const s = String(code);
      if (s === "SETTINGS_INVALID") return "提交的数据不合法";
      if (s === "dailyFetch:order") return "每日取稿：结束时间要晚于开始时间";
      if (s.startsWith("unknown:")) return "不认识的字段：" + s.slice(8);
      const at = s.indexOf(":");
      if (at < 0) return s;
      const key = s.slice(0, at);
      const kind = s.slice(at + 1);
      return (
        (FIELD_LABEL[key] || key) + "：" + (KIND_LABEL[kind] || "取值不合法")
      );
    };

    const css = `
[data-bh]{--bh-line:var(--dsw-alias-border-l2,rgba(127,127,127,.28));display:flex;flex-direction:column;gap:14px;padding:4px 2px 28px;font-size:13px;}
[data-bh] .bh-card{border:1px solid var(--bh-line);border-radius:10px;padding:12px 14px;}
[data-bh] .bh-h{font-size:13px;font-weight:600;opacity:.9;margin:-2px 0 10px;}
[data-bh] .bh-row{display:flex;gap:12px;align-items:flex-start;padding:6px 0;border-top:1px dashed rgba(127,127,127,.18);}
[data-bh] .bh-row:first-of-type{border-top:none;}
[data-bh] .bh-lab{flex:0 0 210px;min-width:150px;line-height:1.5;padding-top:4px;}
[data-bh] .bh-ctl{flex:1 1 260px;min-width:200px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
[data-bh] .bh-hint{flex-basis:100%;font-size:11.5px;opacity:.6;line-height:1.55;}
[data-bh] input[type=text], [data-bh] input[type=number], [data-bh] input[type=time], [data-bh] select{
  padding:5px 8px;border-radius:7px;border:1px solid var(--bh-line);background:transparent;color:inherit;font-size:12.5px;min-width:90px;}
[data-bh] input[type=text]{flex:1 1 320px;min-width:220px;font-family:ui-monospace,Consolas,monospace;}
[data-bh] input[type=number]{width:130px;}
[data-bh] .bh-sw{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;}
[data-bh] .bh-sw input{width:15px;height:15px;cursor:pointer;}
[data-bh] .bh-badge{font-size:10.5px;padding:1px 6px;border-radius:20px;border:1px solid var(--bh-line);opacity:.75;white-space:nowrap;}
[data-bh] .bh-badge[data-src=settings]{border-color:#8a6d3b;color:#8a6d3b;opacity:1;}
[data-bh] .bh-btn{padding:5px 12px;border-radius:7px;border:1px solid var(--bh-line);background:transparent;color:inherit;font-size:12.5px;cursor:pointer;}
[data-bh] .bh-btn:hover{background:rgba(127,127,127,.12);}
[data-bh] .bh-btn[data-primary]{border-color:#3a7d44;color:#3a7d44;font-weight:600;}
[data-bh] .bh-btn[data-danger]{border-color:#b0413e;color:#b0413e;}
[data-bh] .bh-btn:disabled{opacity:.45;cursor:default;}
[data-bh] .bh-note{font-size:12px;line-height:1.6;padding:8px 10px;border-radius:8px;background:rgba(127,127,127,.08);}
[data-bh] .bh-note[data-tone=bad]{background:rgba(176,65,62,.12);color:#b0413e;}
[data-bh] .bh-note[data-tone=warn]{background:rgba(138,109,59,.14);}
[data-bh] .bh-note[data-tone=ok]{background:rgba(58,125,68,.12);color:#3a7d44;}
[data-bh] .bh-mono{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all;opacity:.8;}
[data-bh] .bh-dirty{color:#b0413e;font-weight:600;}
[data-bh] .bh-ok{color:#3a7d44;}
[data-bh] .bh-bad{color:#b0413e;}
`;
    let cssDone = false;
    const ensureCss = () => {
      if (cssDone || typeof document === "undefined") return;
      const style = document.createElement("style");
      style.setAttribute("data-bh-style", "");
      style.textContent = css;
      document.head.appendChild(style);
      cssDone = true;
    };

    const getJson = async (url) => {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok)
        throw new Error((body && body.error) || "HTTP " + res.status);
      return body;
    };
    const postJson = async (url, payload) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload || {}),
      });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body };
    };

    const num = (v) =>
      v === "" || v === null || v === undefined ? "" : String(v);

    const toForm = (values) => {
      const v = values || {};
      return {
        maxReadTokens: num(v.maxReadTokens),
        maxSessionTokens: num(v.maxSessionTokens),
        unlimitedMedia:
          v.maxMediaSeconds === null || v.maxMediaSeconds === undefined,
        maxMediaSeconds: num(v.maxMediaSeconds),
        enableDailyFetching: v.enableDailyFetching === true,
        dailyFetchStart: v.dailyFetchStart || "21:30",
        dailyFetchEnd: v.dailyFetchEnd || "22:00",
        dailyFetchLimit: String(v.dailyFetchLimit || 2),
        pythonPath: v.pythonPath || "",
        asrModelPath: v.asrModelPath || "",
        enablePersonalityLearning: v.enablePersonalityLearning !== false,
        enablePersonalityShadow: v.enablePersonalityShadow === true,
        shadowMaxReviewsPerDay: String(v.shadowMaxReviewsPerDay || 2),
        dataDir: v.dataDir || "",
        credentialPath: v.credentialPath || "",
        writePolicyPath: v.writePolicyPath || "",
        accountStateDir: v.accountStateDir || "",
        enableHistoryWrites: v.enableHistoryWrites === true,
        enableFavoriteWrites: v.enableFavoriteWrites === true,
        enableLikeWrites: v.enableLikeWrites === true,
        enableCoinWrites: v.enableCoinWrites === true,
      };
    };

    const toPayload = (f) => ({
      maxReadTokens: Number(f.maxReadTokens),
      maxSessionTokens: Number(f.maxSessionTokens),
      maxMediaSeconds: f.unlimitedMedia ? null : Number(f.maxMediaSeconds),
      enableDailyFetching: f.enableDailyFetching,
      dailyFetchStart: String(f.dailyFetchStart).trim(),
      dailyFetchEnd: String(f.dailyFetchEnd).trim(),
      dailyFetchLimit: Number(f.dailyFetchLimit),
      pythonPath: f.pythonPath,
      asrModelPath: f.asrModelPath,
      enablePersonalityLearning: f.enablePersonalityLearning,
      enablePersonalityShadow: f.enablePersonalityShadow,
      shadowMaxReviewsPerDay: Number(f.shadowMaxReviewsPerDay),
      dataDir: f.dataDir,
      credentialPath: f.credentialPath,
      writePolicyPath: f.writePolicyPath,
      accountStateDir: f.accountStateDir,
      enableHistoryWrites: f.enableHistoryWrites,
      enableFavoriteWrites: f.enableFavoriteWrites,
      enableLikeWrites: f.enableLikeWrites,
      enableCoinWrites: f.enableCoinWrites,
    });

    const WRITE_FIELDS = [
      ["enableHistoryWrites", "历史（观看进度）"],
      ["enableFavoriteWrites", "收藏"],
      ["enableLikeWrites", "点赞"],
      ["enableCoinWrites", "投币"],
    ];

    function Switch({ checked, onChange, label, disabled }) {
      return h(
        "label",
        { className: "bh-sw" },
        h("input", {
          type: "checkbox",
          checked: !!checked,
          disabled: !!disabled,
          onChange: (e) => onChange(e.target.checked),
        }),
        h("span", null, label),
      );
    }

    function Section() {
      ensureCss();
      const [snapshot, setSnapshot] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [baseline, setBaseline] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [note, setNote] = React.useState(null);
      const [checks, setChecks] = React.useState({});
      const [openWrites, setOpenWrites] = React.useState(false);
      const [confirmWord, setConfirmWord] = React.useState("");
      const [clearArmed, setClearArmed] = React.useState(false);
      const [loadError, setLoadError] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const data = await getJson(B + "/state");
          const next = toForm(data.values);
          setSnapshot(data);
          setForm(next);
          setBaseline(next);
          setLoadError(null);
        } catch (error) {
          setLoadError(String((error && error.message) || error));
        }
      }, []);

      React.useEffect(() => {
        load();
      }, [load]);

      const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

      const dirty =
        !!(form && baseline) &&
        JSON.stringify(toPayload(form)) !== JSON.stringify(toPayload(baseline));
      const turningOn =
        !!(form && baseline) &&
        WRITE_FIELDS.filter(
          ([key]) => form[key] === true && baseline[key] !== true,
        );
      const needConfirm =
        turningOn.length > 0 && confirmWord.trim() !== CONFIRM_WORD;

      const check = async (key) => {
        const path = String(form[key] || "");
        if (!path) return;
        setChecks((c) => ({ ...c, [key]: { pending: true } }));
        try {
          const result = await postJson(B + "/check", { path });
          const body = result.body || {};
          setChecks((c) => ({ ...c, [key]: body }));
        } catch (error) {
          setChecks((c) => ({
            ...c,
            [key]: { exists: false, path, error: true },
          }));
        }
      };

      const save = async () => {
        if (busy || !form) return;
        setBusy(true);
        try {
          const result = await postJson(B + "/save", {
            values: toPayload(form),
            confirm: confirmWord.trim(),
          });
          const body = result.body || {};
          if (!result.ok) {
            const detail =
              (body.errors || []).map(explainError).join("；") ||
              (body.error ? explainError(body.error) : "未知错误");
            if (body.error === "CONFIRM_REQUIRED")
              setNote({
                tone: "bad",
                text:
                  "要开启账号写入，请先在下面对话框里输入「" +
                  CONFIRM_WORD +
                  "」。",
              });
            else setNote({ tone: "bad", text: "保存失败：" + detail });
            return;
          }
          const applied = (body.applied || []).map(
            (k) => APPLIED_LABEL[k] || k,
          );
          const restart = (body.restart || []).map(
            (k) => RESTART_LABEL[k] || k,
          );
          setNote({
            tone: restart.length ? "warn" : "ok",
            text:
              "已保存。" +
              (applied.length ? "即时生效：" + applied.join("、") + "。" : "") +
              (restart.length
                ? "要重启 DSH 才完整生效：" + restart.join("、") + "。"
                : ""),
          });
          setConfirmWord("");
          await load();
        } finally {
          setBusy(false);
        }
      };

      const clear = async () => {
        if (busy) return;
        if (!clearArmed) {
          setClearArmed(true);
          setNote({
            tone: "warn",
            text: "再点一次「确认恢复」，设置页的覆盖会删掉，全部回到 profile 的 cordis.patch.yml。",
          });
          return;
        }
        setBusy(true);
        try {
          const result = await postJson(B + "/clear", {});
          const body = result.body || {};
          if (!result.ok) {
            setNote({
              tone: "bad",
              text: "恢复失败：" + (body.error || "未知错误"),
            });
            return;
          }
          const restart = (body.restart || []).map(
            (k) => RESTART_LABEL[k] || k,
          );
          setNote({
            tone: restart.length ? "warn" : "ok",
            text:
              (body.cleared
                ? "已删除设置页覆盖，回到配置文件的值。"
                : "本来就没有覆盖，已经和配置文件一致。") +
              (restart.length
                ? "要重启 DSH 才完整生效：" + restart.join("、") + "。"
                : ""),
          });
          setClearArmed(false);
          setConfirmWord("");
          await load();
        } finally {
          setBusy(false);
        }
      };

      if (loadError)
        return h(
          "div",
          { "data-bh": "" },
          h(
            "div",
            { className: "bh-note", "data-tone": "bad" },
            "读不到设置：" +
              loadError +
              "。确认插件已加载、并且当前 DSH 版本带 web 服务。",
          ),
          h(
            "div",
            { style: { marginTop: 10 } },
            h("button", { className: "bh-btn", onClick: load }, "重试"),
          ),
        );

      if (!form || !snapshot)
        return h(
          "div",
          { "data-bh": "" },
          h("div", { className: "bh-note" }, "正在读取插件配置…"),
        );

      const src = snapshot.sources || {};
      const status = snapshot.status || {};
      const badge = (key) =>
        src[key] && src[key] !== "default"
          ? h(
              "span",
              { className: "bh-badge", "data-src": src[key] },
              SRC_LABEL[src[key]],
            )
          : null;

      const row = (key, label, control, hint) =>
        h(
          "div",
          { className: "bh-row" },
          h("div", { className: "bh-lab" }, label, " ", badge(key)),
          h(
            "div",
            { className: "bh-ctl" },
            control,
            hint ? h("div", { className: "bh-hint" }, hint) : null,
          ),
        );

      const fileLine = (label, value) =>
        h(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          h("span", { style: { opacity: 0.62 } }, label),
          h(
            "span",
            { className: value && value.exists ? "bh-ok" : "bh-bad" },
            value && value.exists
              ? "存在"
              : value && value.path
                ? "不存在"
                : "未设置",
          ),
          h("span", { className: "bh-mono" }, (value && value.path) || "—"),
        );

      // Result line for a row's「检查」button. It reads `checks[key]` (the
      // fresh /check answer), not `snapshot.status` — the snapshot only
      // refreshes on load, so a click would otherwise look like nothing
      // happened on rows that had no inline line of their own.
      const checkLine = (key) => {
        const c = checks[key];
        if (!c) return null;
        return h(
          "span",
          { style: { flexBasis: "100%" } },
          c.pending
            ? "检查中…"
            : c.exists
              ? h(
                  "span",
                  { className: "bh-ok" },
                  "✓ 路径存在" +
                    (c.isFile ? "（文件）" : c.isDirectory ? "（目录）" : ""),
                )
              : h("span", { className: "bh-bad" }, "✗ 路径不存在"),
        );
      };

      return h(
        "div",
        { "data-bh": "" },
        h(
          "div",
          { className: "bh-card" },
          h("div", { className: "bh-h" }, "状态"),
          h(
            "div",
            { className: "bh-hint", style: { marginBottom: 8 } },
            "账本：" +
              (status.dataDir || "—") +
              "（" +
              (status.ledger && status.ledger.exists
                ? "ledger.sqlite 已存在"
                : "还没有账本文件") +
              "）",
          ),
          h(
            "div",
            { className: "bh-hint" },
            "已注册工具：" +
              ((status.tools || []).length || 0) +
              " 个" +
              (status.daily
                ? "　每日取稿：" +
                  (status.daily.enabled ? "开" : "关") +
                  "（" +
                  status.daily.start +
                  "–" +
                  status.daily.end +
                  "，每天最多 " +
                  status.daily.limit +
                  " 份" +
                  (status.daily.nextAt
                    ? "，下次 " + new Date(status.daily.nextAt).toLocaleString()
                    : "") +
                  "）"
                : ""),
          ),
          h(
            "div",
            { className: "bh-hint", style: { marginTop: 6 } },
            "设置页覆盖：" +
              (snapshot.file && snapshot.file.exists
                ? "settings.json 已存在" +
                  (snapshot.file.updatedAt
                    ? "（上次 " +
                      new Date(snapshot.file.updatedAt).toLocaleString() +
                      "）"
                    : "")
                : "还没有，当前全部来自配置文件或默认值"),
          ),
          snapshot.file && snapshot.file.exists
            ? h("div", { className: "bh-mono" }, snapshot.file.path)
            : null,
          snapshot.file && snapshot.file.error
            ? h(
                "div",
                {
                  className: "bh-note",
                  "data-tone": "warn",
                  style: { marginTop: 8 },
                },
                "这份 settings.json 有读不懂的字段（已忽略）：" +
                  snapshot.file.error,
              )
            : null,
        ),

        h(
          "div",
          { className: "bh-card" },
          h("div", { className: "bh-h" }, "读取与额度"),
          row(
            "maxReadTokens",
            "每份取稿的估算上限",
            h("input", {
              type: "number",
              min: 1,
              value: form.maxReadTokens,
              onChange: (e) => set("maxReadTokens", e.target.value),
            }),
            "按正文 UTF-8 字节数保守估算，单位是“估算 token”，每份独立，不累计整场对话。默认 600000。",
          ),
          row(
            "maxSessionTokens",
            "旧额度字段",
            h("input", {
              type: "number",
              min: 1,
              value: form.maxSessionTokens,
              onChange: (e) => set("maxSessionTokens", e.target.value),
            }),
            "旧版 maxSessionTokens，仍兼容；和上面同时填时以上面那个为准。",
          ),
          row(
            "maxMediaSeconds",
            "单条视频时长上限",
            h(
              React.Fragment,
              null,
              h(Switch, {
                checked: form.unlimitedMedia,
                label: "不限",
                onChange: (v) => set("unlimitedMedia", v),
              }),
              form.unlimitedMedia
                ? null
                : h("input", {
                    type: "number",
                    min: 1,
                    value: form.maxMediaSeconds,
                    onChange: (e) => set("maxMediaSeconds", e.target.value),
                  }),
              form.unlimitedMedia
                ? null
                : h("span", { style: { opacity: 0.6 } }, "秒"),
            ),
            "不限时仍受请求数、字节数、实际耗时和帧数预算约束。",
          ),
        ),

        h(
          "div",
          { className: "bh-card" },
          h("div", { className: "bh-h" }, "每日取稿"),
          row(
            "enableDailyFetching",
            "开启每日取稿",
            h(Switch, {
              checked: form.enableDailyFetching,
              label: form.enableDailyFetching ? "开" : "关",
              onChange: (v) => set("enableDailyFetching", v),
            }),
            "默认关。打开后只在 DSH 运行期间、每天时间窗内取一次只读文字稿，不调模型、不写手账、不碰平台。",
          ),
          row(
            "dailyFetchStart",
            "时间窗开始",
            h(
              React.Fragment,
              null,
              h("input", {
                type: "time",
                value: form.dailyFetchStart,
                onChange: (e) => set("dailyFetchStart", e.target.value),
              }),
              h("span", { style: { opacity: 0.6 } }, "到"),
              h("input", {
                type: "time",
                value: form.dailyFetchEnd,
                onChange: (e) => set("dailyFetchEnd", e.target.value),
              }),
            ),
            "北京时间，HH:mm；结束必须晚于开始。",
          ),
          row(
            "dailyFetchLimit",
            "每天最多几份",
            h(
              "select",
              {
                value: form.dailyFetchLimit,
                onChange: (e) => set("dailyFetchLimit", e.target.value),
              },
              h("option", { value: "1" }, "1 份"),
              h("option", { value: "2" }, "2 份"),
            ),
            "只算成功的新稿件；没有可读来源时会如实说没有，不硬凑。",
          ),
        ),

        h(
          "div",
          { className: "bh-card" },
          h("div", { className: "bh-h" }, "画面与语音（可选）"),
          row(
            "pythonPath",
            "抽帧 Python",
            h(
              React.Fragment,
              null,
              h("input", {
                type: "text",
                value: form.pythonPath,
                placeholder: "C:/…/Scripts/python.exe（留空自动找）",
                onChange: (e) => set("pythonPath", e.target.value),
              }),
              h(
                "button",
                {
                  className: "bh-btn",
                  onClick: () => check("pythonPath"),
                  disabled: !form.pythonPath,
                },
                "检查",
              ),
            ),
            checkLine("pythonPath"),
            "必须是绝对路径；要先按 docs/LOCAL_FRAMES.md 装好依赖并用 doctor 验过。留空时依次找环境变量、插件自带环境、系统 python。",
          ),
          row(
            "asrModelPath",
            "本地 ASR 模型目录",
            h(
              React.Fragment,
              null,
              h("input", {
                type: "text",
                value: form.asrModelPath,
                placeholder: "留空使用插件托管的模型",
                onChange: (e) => set("asrModelPath", e.target.value),
              }),
              h(
                "button",
                {
                  className: "bh-btn",
                  onClick: () => check("asrModelPath"),
                  disabled: !form.asrModelPath,
                },
                "检查",
              ),
            ),
            checkLine("asrModelPath"),
            "只有走本地语音识别才需要；不填就用 setup-media 下载的托管模型。",
          ),
        ),

        h(
          "div",
          { className: "bh-card" },
          h("div", { className: "bh-h" }, "人格与手账"),
          row(
            "enablePersonalityLearning",
            "人格积累",
            h(Switch, {
              checked: form.enablePersonalityLearning,
              label: form.enablePersonalityLearning ? "开" : "关",
              onChange: (v) => set("enablePersonalityLearning", v),
            }),
            "默认开。开着手账保存后会排队一次人格审阅，每天最多选一句留下；关闭则不再审阅、也不注册对应工具。",
          ),
          row(
            "enablePersonalityShadow",
            "人格影子（实验性）",
            h(
              React.Fragment,
              null,
              h(Switch, {
                checked: form.enablePersonalityShadow,
                label: form.enablePersonalityShadow ? "开" : "关",
                onChange: (v) => set("enablePersonalityShadow", v),
              }),
              form.enablePersonalityShadow
                ? h(
                    "select",
                    {
                      value: form.shadowMaxReviewsPerDay,
                      onChange: (e) =>
                        set("shadowMaxReviewsPerDay", e.target.value),
                    },
                    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
                      h(
                        "option",
                        { value: String(n), key: n },
                        "每天 " + n + " 次",
                      ),
                    ),
                  )
                : null,
            ),
            "默认关。打开后整理本 profile 的新对话，先读已有正式人格，只有值得的新认识才选一句写进 human-world.md，和手账共享每天最多一句；候选可能误报，可修正撤回。改动要重启才生效。",
          ),
          row(
            "dataDir",
            "账本目录",
            h("input", {
              type: "text",
              value: form.dataDir,
              placeholder: "留空 = DSH_HOME/bili-humanism",
              onChange: (e) => set("dataDir", e.target.value),
            }),
            "换这里等于换账本，旧账本不会自动迁移；改完要重启 DSH。当前实际：" +
              (status.dataDir || "—"),
          ),
        ),

        h(
          "div",
          { className: "bh-card" },
          h("div", { className: "bh-h" }, "账号与写入"),
          h(
            "div",
            { className: "bh-note", style: { marginBottom: 10 } },
            "这四项默认全关。开着不等于会发：每次真正写入还要可信授权文件里的人工授权、已有的设备 Cookie、以及人工确认的回执。评论接口在本插件里始终关闭。",
          ),
          row(
            "credentialPath",
            "账号凭据 JSON",
            h(
              React.Fragment,
              null,
              h("input", {
                type: "text",
                value: form.credentialPath,
                placeholder: "含 sessdata 的本地 JSON 路径",
                onChange: (e) => set("credentialPath", e.target.value),
              }),
              h(
                "button",
                {
                  className: "bh-btn",
                  onClick: () => check("credentialPath"),
                  disabled: !form.credentialPath,
                },
                "检查",
              ),
            ),
            h(
              "span",
              { style: { flexBasis: "100%" } },
              fileLine("状态：", status.credential),
            ),
            checkLine("credentialPath"),
            "插件不会生成或轮换设备 Cookie，只读你给的那份。",
          ),
          row(
            "writePolicyPath",
            "写入授权文件",
            h(
              React.Fragment,
              null,
              h("input", {
                type: "text",
                value: form.writePolicyPath,
                placeholder: "人工写好的授权 JSON 路径",
                onChange: (e) => set("writePolicyPath", e.target.value),
              }),
              h(
                "button",
                {
                  className: "bh-btn",
                  onClick: () => check("writePolicyPath"),
                  disabled: !form.writePolicyPath,
                },
                "检查",
              ),
            ),
            h(
              "span",
              { style: { flexBasis: "100%" } },
              fileLine("状态：", status.writePolicy),
            ),
            checkLine("writePolicyPath"),
            "授权范围、账号和上限都在这份文件里；本页不写它、也不替你授权。",
          ),
          row(
            "accountStateDir",
            "账号状态目录",
            h("input", {
              type: "text",
              value: form.accountStateDir,
              placeholder: "留空 = 插件默认",
              onChange: (e) => set("accountStateDir", e.target.value),
            }),
            "放账号锁、额度与回执；一般不用改。",
          ),

          h(
            "div",
            {
              style: {
                borderTop: "1px dashed rgba(127,127,127,.18)",
                marginTop: 10,
                paddingTop: 10,
              },
            },
            h(
              "button",
              {
                className: "bh-btn",
                onClick: () => setOpenWrites((v) => !v),
              },
              openWrites ? "收起账号写入开关" : "展开账号写入开关（默认全关）",
            ),
            openWrites
              ? h(
                  "div",
                  { style: { marginTop: 10 } },
                  h(
                    "div",
                    {
                      className: "bh-note",
                      "data-tone": "warn",
                      style: { marginBottom: 10 },
                    },
                    "⚠ 打开下面任意一项，等于允许插件注册对应的公开写入工具；真正调用时仍要授权文件与回执。打开需要重启 DSH 才会生效。",
                  ),
                  WRITE_FIELDS.map(([key, label]) =>
                    row(
                      key,
                      label,
                      h(Switch, {
                        checked: form[key],
                        label: form[key] ? "开" : "关",
                        onChange: (v) => set(key, v),
                      }),
                      key === "enableCoinWrites"
                        ? "投币会花账号里的硬币；额度与单片上限在授权文件里定。"
                        : null,
                    ),
                  ),
                  turningOn.length
                    ? h(
                        "div",
                        { style: { marginTop: 8 } },
                        h(
                          "div",
                          { className: "bh-hint", style: { marginBottom: 4 } },
                          "要开启：" +
                            turningOn.map(([, l]) => l).join("、") +
                            "。请输入「" +
                            CONFIRM_WORD +
                            "」：",
                        ),
                        h("input", {
                          type: "text",
                          value: confirmWord,
                          placeholder: CONFIRM_WORD,
                          onChange: (e) => setConfirmWord(e.target.value),
                        }),
                      )
                    : null,
                )
              : null,
          ),
        ),

        h(
          "div",
          {
            className: "bh-card",
            style: {
              display: "flex",
              gap: 10,
              flexWrap: "wrap",
              alignItems: "center",
            },
          },
          h(
            "button",
            {
              className: "bh-btn",
              "data-primary": "",
              onClick: save,
              disabled: busy || !dirty || needConfirm,
            },
            dirty ? "保存设置" : "没有改动",
          ),
          h(
            "button",
            {
              className: "bh-btn",
              "data-danger": clearArmed ? "" : undefined,
              onClick: clear,
              disabled: busy,
            },
            clearArmed ? "确认恢复配置文件值" : "恢复配置文件值",
          ),
          h(
            "button",
            { className: "bh-btn", onClick: load, disabled: busy },
            "重新读取",
          ),
          dirty ? h("span", { className: "bh-dirty" }, "有改动还没保存") : null,
          needConfirm
            ? h("span", { className: "bh-bad" }, "账号写入需要输入确认词")
            : null,
        ),

        note
          ? h(
              "div",
              { className: "bh-note", "data-tone": note.tone || "ok" },
              note.text,
            )
          : null,

        h(
          "div",
          { className: "bh-hint" },
          "说明：本页保存的是一份人工覆盖层（settings.json），它盖住 profile 里 cordis.patch.yml 的同名项；" +
            "删掉它就回到配置文件。模型工具不能读写这份文件。",
        ),
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      slots.inject("settings.section", () =>
        slots.register(
          {
            name: "settings.section",
            id: "bili-humanism",
            order: 54,
            label: () => "B站内容学习",
          },
          Section,
        ),
      );
    }

    return { apply, inject };
  },
});
