// ==UserScript==
// @name         GameBanana 下载助手（Cookie + 一键发送到服务器）
// @namespace    gbmd-cred
// @version      4.1.0
// @description  右下角 🍌 面板：显示 GameBanana 登录态/用户名/剩余天数、复制完整 Cookie（含 HttpOnly，sess+rmc）；「📤 发送到服务器」把当前 mod 页链接一键推给 GameBanana Mod Downloader 下载（设了密码会自动用保存的密码登录）；「🔄 注入登录态到浏览器」把服务器保存的 Cookie 写回当前浏览器
// @author       fnOS
// @match        https://gamebanana.com/*
// @match        https://www.gamebanana.com/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_cookie.list
// @grant        GM_cookie.set
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/* ============================================================
 * v4.1.0（2026-09-02，参照 iwara 下载助手 v7.5「注入登录态到浏览器」改法）
 * - 新增「🔄 注入登录态到浏览器」：GET /api/cred 从服务器拉明文 gbCookie，
 *   逐项写 document.cookie（HttpOnly 项 GM_cookie.set 兜底），刷新页面生效。
 *   GameBanana 会话绑定创建 UA：返回 gbUserAgent，当前浏览器族不一致时提示可能无效。
 * v4.0.0（2026-09-01，参照 iwara 下载助手 v7 分工改法）
 * - 点右下角 🍌 立即弹面板；打开面板/发送【不读本机 Cookie】
 * - 用 GET /api/gb-login-status 当「服务器在线 + 账号信息」（已登录用户名/剩余天数/是否配置凭证）
 * - 服务器已登录（有凭证）：面板只留「发送到服务器」，不展示本机 Cookie
 * - 服务器没凭证：才 GM_cookie 读本机 Cookie → 复制 / 回传 POST /api/settings
 * - 发送：POST /api/receive { url }（当前 gamebanana.com mod 页链接 → 服务器自行解析下载）
 * - 设了访问密码：自动 POST /api/login（记在本地 GM_setValue）
 * ============================================================ */
(function () {
    "use strict";

    const VER = "4.1.0";
    const SRV_KEY = "gbcred_server";      // gbmd 服务器地址
    const SRV_PWD_KEY = "gbcred_server_pwd"; // 服务器访问密码
    function log(...a) { try { console.log("[gb-cred " + VER + "]", ...a); } catch (_) {} }

    /* ---------- 工具 ---------- */
    function $(sel) { return document.querySelector(sel); }
    function ls(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }

    /** 从 GM_cookie 读取完整 cookie（含 HttpOnly）。返回 { text, count, source, diag } */
    function readCookieGM() {
        return new Promise((resolve) => {
            const fallback = (why) => resolve({ text: document.cookie || "", count: 0, source: "document.cookie", diag: why });
            try {
                if (typeof GM_cookie === "undefined" || !GM_cookie || typeof GM_cookie.list !== "function") {
                    return fallback("GM_cookie 未定义（请用 Violentmonkey 或 Firefox Tampermonkey）");
                }
                GM_cookie.list({}, (cookies, error) => {
                    if (error) return fallback("GM_cookie.list 报错: " + JSON.stringify(error));
                    if (!Array.isArray(cookies)) return fallback("GM_cookie.list 返回非数组");
                    if (cookies.length === 0) return fallback("GM_cookie.list 返回 0 个（可能未授予 cookie 权限）");
                    const gb = cookies.filter((c) => c && c.domain && String(c.domain).indexOf("gamebanana.com") >= 0);
                    const list = (gb.length > 0 ? gb : cookies)
                        .map((c) => (c && c.name) ? c.name + "=" + (c.value || "") : "")
                        .filter(Boolean);
                    resolve({ text: list.join("; "), count: list.length, source: "GM_cookie（" + (gb.length > 0 ? gb.length : cookies.length) + " 个）", diag: "OK" });
                });
            } catch (e) {
                fallback("GM_cookie 异常: " + (e && e.message || e));
            }
        });
    }

    /** 本机 gamebanana.com 登录态（网页本身，不发给服务器） */
    async function detectLocalLogin() {
        try {
            const r1 = await fetch("/apiv13/Member/UiConfig?_sUrl=" + encodeURIComponent(location.pathname), { headers: { "Accept": "application/json" } });
            const cfg = await r1.json();
            if (!cfg || cfg._bIsLoggedIn !== true) return { loggedIn: false, detail: "未登录（UiConfig._bIsLoggedIn=false）" };
            const idRow = cfg._idMemberRow || null;
            let name = "", profileUrl = "";
            if (idRow) {
                try {
                    const r2 = await fetch("/apiv13/Member/" + idRow + "/ProfilePage", { headers: { "Accept": "application/json" } });
                    const m = await r2.json();
                    name = (m && m._sName) || "";
                    profileUrl = (m && m._sProfileUrl) || "";
                } catch (e) { log("ProfilePage 失败:", e); }
            }
            return { loggedIn: true, idRow, name, profileUrl, detail: "已登录" };
        } catch (e) {
            return { loggedIn: false, detail: "检测失败: " + (e && e.message || e) };
        }
    }

    /* ---------- 发送到服务器 ---------- */
    function gmRequest(method, url, body, timeout, extraHeaders) {
        return new Promise((resolve) => {
            try {
                if (typeof GM_xmlhttpRequest !== "function") return resolve({ ok: false, error: "无 GM_xmlhttpRequest 权限" });
                GM_xmlhttpRequest({
                    method, url, timeout: timeout || 8000,
                    data: body !== undefined ? JSON.stringify(body) : undefined,
                    headers: Object.assign(body !== undefined ? { "Content-Type": "application/json" } : {}, extraHeaders || {}),
                    onload: (r) => {
                        let j = null; try { j = JSON.parse(r.responseText); } catch (_) {}
                        let setCookie = "";
                        try { const h = r.responseHeaders || ""; const m = h.match(/Set-Cookie:\s*session=([^;\s]+)/i); if (m) setCookie = m[1]; } catch (_) {}
                        resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: j, text: r.responseText, setCookie });
                    },
                    onerror: (r) => resolve({ ok: false, status: r.status, json: null, text: "", error: r.error || "网络错误" }),
                    ontimeout: () => resolve({ ok: false, status: 0, json: null, text: "", error: "超时" })
                });
            } catch (e) { resolve({ ok: false, status: 0, json: null, text: "", error: String(e.message || e) }); }
        });
    }

    /** 规范化服务器地址：没写协议补 http://；去末尾 / */
    function normalizeServerBase(url) {
        let s = String(url || "").trim();
        if (!s) return "";
        s = s.replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(s)) s = "http://" + s;
        return s;
    }

    /** 探测服务器在线 + 账号信息：GET /api/status（公开）→ 若需密码则 /api/login */
    async function probeServer(url) {
        const base = normalizeServerBase(url);
        if (!base) return { ok: false, error: "地址无效", base };
        const r = await gmRequest("GET", base + "/api/status", undefined, 4000);
        if (!r.ok) return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), base };
        return { ok: true, status: r.json, base };
    }

    /** 服务器自动登录：POST /api/login，返回 session cookie */
    async function serverLogin(base, password) {
        const r = await gmRequest("POST", base + "/api/login", { password }, 8000);
        if (r.ok && r.setCookie) return { ok: true, session: r.setCookie };
        if (r.status === 401) return { ok: false, error: "密码错误（服务器访问密码不对）" };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
    }

    /** 服务器账号状态：GET /api/gb-login-status（需 session） */
    async function serverAccount(base, session) {
        const headers = session ? { "Cookie": "session=" + session } : {};
        const r = await gmRequest("GET", base + "/api/gb-login-status", undefined, 8000, headers);
        if (r.ok && r.json && r.json.ok) return { ok: true, info: r.json, status: r.status };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), status: r.status };
    }

    /** 发送当前 mod 页链接：POST /api/receive { url } */
    async function sendModToServer(base, modUrl, session) {
        const headers = session ? { "Cookie": "session=" + session } : {};
        const r = await gmRequest("POST", base + "/api/receive", { url: modUrl }, 12000, headers);
        if (r.ok && r.json && r.json.ok) return { ok: true, received: r.json.received || 1, status: r.status };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status), status: r.status };
    }

    /** 当前 mod 页链接（非 mod 页返回 ""） */
    function currentModUrl() {
        try {
            const m = location.pathname.match(/\/mods\/(\d+)/i);
            if (!m) return "";
            return location.origin + "/mods/" + m[1];
        } catch (_) { return ""; }
    }

    function copyText(text, okMsg) {
        return new Promise((resolve) => {
            try { if (typeof GM_setClipboard === "function") { GM_setClipboard(text, { type: "text", mimetype: "text/plain" }); showToast(okMsg); resolve(true); return; } } catch (_) {}
            try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => { showToast(okMsg); resolve(true); }, () => resolve(false)); return; } } catch (_) {}
            resolve(false);
        });
    }

    /* ---------- UI ---------- */
    let fabEl = null, panelEl = null, toastEl = null;

    function injectStyle() {
        if (document.getElementById("gbcred-style")) return;
        const style = document.createElement("style");
        style.id = "gbcred-style";
        style.textContent = `
#gbcred-fab{position:fixed;right:14px;bottom:14px;z-index:2147483647;width:56px;height:56px;border-radius:50%;
  padding:0;border:none;cursor:pointer;background:#2f6fed;color:#fff;font-size:26px;
  box-shadow:0 4px 16px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;pointer-events:auto}
#gbcred-panel{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;max-height:80vh;overflow:auto;
  background:#fff;border-radius:16px 16px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.3);
  font:14px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif;color:#222;padding:0 0 16px}
#gbcred-head{position:sticky;top:0;background:#fff;padding:12px 16px;border-bottom:1px solid #eef1f5;
  display:flex;align-items:center;justify-content:space-between;z-index:1}
#gbcred-close{font-size:20px;color:#8a94a3;cursor:pointer;padding:0 6px}
#gbcred-body{padding:12px 16px}
#gbcred-body label{display:block;font-size:12px;color:#5a6472;margin:10px 0 4px}
#gbcred-body textarea{width:100%;box-sizing:border-box;resize:none;padding:8px;border:1px solid #c9cfd8;
  border-radius:8px;font:11px/1.5 ui-monospace,Consolas,monospace;background:#fafbfc;color:#222;overflow:auto}
#gbcred-cookie{height:110px}
#gbcred-btns{display:flex;flex-direction:column;gap:8px;margin-top:12px}
#gbcred-btns button{width:100%;padding:12px;border:none;border-radius:10px;cursor:pointer;font-size:15px;font-weight:600}
#gbcred-copy-all{background:#2f6fed;color:#fff}
#gbcred-copy-cookie{background:#eef4ff;color:#2f6fed;border:1px solid #c9dcff!important}
#gbcred-panel.server-ok #gbcred-local{display:none}
#gbcred-status{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
#gbcred-status.ok{color:#1a9d4b}
#gbcred-status.err{color:#d0392f}
#gbcred-info{margin-top:6px;padding:10px;background:#f7f9fc;border-radius:8px;font-size:13px;color:#5a6472}
#gbcred-userbar{margin:10px 16px 0;padding:12px 16px;background:#f0f7ff;border-radius:10px;
  font-size:14px;color:#1a3d6d;white-space:pre-wrap;line-height:1.6}
#gbcred-userbar.ok{background:#e8f7ee;color:#1a7a3a}
#gbcred-userbar.warn{background:#fff8e1;color:#8a5a00}
#gbcred-userbar.err{background:#fdecea;color:#b3392b}
#gbcred-toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;
  background:rgba(20,24,30,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;
  max-width:86vw;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.3);display:none}
#gbcred-server-row{display:flex;gap:6px;margin-top:4px}
#gbcred-server{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#gbcred-pwd-row{display:flex;gap:6px;margin-top:4px}
#gbcred-server-pwd{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#gbcred-send{background:#1a9d4b;color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;
  font-weight:600;white-space:nowrap;font-size:13px}
#gbcred-send:disabled{background:#9cc9ac;cursor:wait}
#gbcred-srv-actions{display:flex;gap:8px;margin-top:8px}
#gbcred-srv-actions button{flex:1;padding:8px;border-radius:8px;cursor:pointer;font-size:13px}
#gbcred-save{background:#eef4ff;color:#2f6fed;border:1px solid #c9dcff}
#gbcred-srv-status{margin-top:8px;font-size:13px;min-height:18px;color:#5a6472}
#gbcred-srv-status.ok{color:#1a9d4b}
#gbcred-srv-status.err{color:#d0392f}
#gbcred-srv-status.info{color:#2f6fed}
`;
        (document.head || document.documentElement).appendChild(style);
    }

    function ensureUi() {
        if (!document.documentElement) return false;
        injectStyle();
        if (!fabEl || !document.documentElement.contains(fabEl)) {
            if (!fabEl) {
                fabEl = document.createElement("button");
                fabEl.id = "gbcred-fab";
                fabEl.textContent = "🍌";
                fabEl.title = "GameBanana 下载助手";
                fabEl.addEventListener("click", openPanel);
            }
            if (fabEl.parentNode !== document.documentElement) document.documentElement.appendChild(fabEl);
        }
        if (!panelEl || !document.documentElement.contains(panelEl)) {
            if (!panelEl) {
                panelEl = document.createElement("div");
                panelEl.id = "gbcred-panel";
                panelEl.innerHTML = `
<div id="gbcred-head"><b>🍌 GameBanana 下载助手</b><span id="gbcred-close">✕</span></div>
<div id="gbcred-userbar">打开即可发送；没配置凭证时才采集本机 Cookie</div>
<div id="gbcred-body">
  <label>📤 发送到服务器（当前 mod 页链接 → 服务器自行解析下载，不读 Cookie）</label>
  <div id="gbcred-server-row">
    <input id="gbcred-server" placeholder="http://服务器IP:端口（如 http://192.168.1.10:8642）" spellcheck="false">
    <button id="gbcred-send">📤 发送</button>
  </div>
  <label style="margin-top:6px">服务器访问密码（可选；设了密码的服务器自动登录用，记在本地）</label>
  <div id="gbcred-pwd-row">
    <input id="gbcred-server-pwd" type="password" placeholder="服务器访问密码（留空则尝试免登录）" autocomplete="off">
  </div>
  <div id="gbcred-srv-actions">
    <button id="gbcred-save">💾 记住地址</button>
    <button id="gbcred-inject">🔄 注入登录态到浏览器</button>
  </div>
  <div id="gbcred-srv-status"></div>
  <div id="gbcred-local">
    <label>完整 Cookie（仅服务器没有凭证时采集；含 HttpOnly 需 GM_cookie）</label>
    <textarea id="gbcred-cookie" readonly spellcheck="false"></textarea>
    <div id="gbcred-btns">
      <button id="gbcred-copy-all">📋 复制完整 Cookie（粘贴到服务器设置页）</button>
    </div>
  </div>
  <div id="gbcred-status"></div>
  <div id="gbcred-info"></div>
</div>`;
                panelEl.style.display = "none";
                panelEl.querySelector("#gbcred-close").addEventListener("click", () => { panelEl.style.display = "none"; });
                panelEl.querySelector("#gbcred-copy-all").addEventListener("click", async () => {
                    const c = await readCookieGM();
                    copyText(c.text, c.text ? "✅ 已复制完整 Cookie" : "❌ 未读到 Cookie（看诊断）");
                });
                panelEl.querySelector("#gbcred-send").addEventListener("click", doSend);
                panelEl.querySelector("#gbcred-save").addEventListener("click", async () => {
                    try { GM_setValue(SRV_KEY, panelEl.querySelector("#gbcred-server").value); } catch (_) {}
                    try { GM_setValue(SRV_PWD_KEY, panelEl.querySelector("#gbcred-server-pwd").value); } catch (_) {}
                    srvSetStatus("已记住服务器地址" + (panelEl.querySelector("#gbcred-server-pwd").value ? "（含密码）" : ""), "ok");
                });
                panelEl.querySelector("#gbcred-inject").addEventListener("click", srvInjectFlow);
            }
            if (panelEl.parentNode !== document.documentElement) document.documentElement.appendChild(panelEl);
        }
        if (!toastEl || !document.documentElement.contains(toastEl)) {
            toastEl = document.createElement("div");
            toastEl.id = "gbcred-toast";
            document.documentElement.appendChild(toastEl);
        }
        return true;
    }

    function srvSetStatus(m, cls) {
        const el = panelEl && panelEl.querySelector("#gbcred-srv-status");
        if (!el) return;
        el.textContent = m; el.className = "gbcred-srv-status " + (cls || "");
    }

    function showToast(m) { if (!toastEl) return; toastEl.textContent = m; toastEl.style.display = "block"; setTimeout(() => { toastEl.style.display = "none"; }, 4000); }

    /** 打开面板即检测：服务器在线 + 账号；服务器有凭证就不读本机 cookie */
    async function openPanel() {
        if (!ensureUi()) return;
        panelEl.style.display = "block";
        const ub = panelEl.querySelector("#gbcred-userbar");
        const st = panelEl.querySelector("#gbcred-status");
        const ta = panelEl.querySelector("#gbcred-cookie");
        const info = panelEl.querySelector("#gbcred-info");
        ub.className = "gbcred-userbar";
        ub.textContent = "正在检测服务器…";
        st.textContent = ""; st.className = ""; ta.value = ""; info.textContent = "";

        // 恢复已保存的服务器地址/密码
        let srv = "", pwd = "";
        try { srv = GM_getValue(SRV_KEY, "") || ""; } catch (_) {}
        try { pwd = GM_getValue(SRV_PWD_KEY, "") || ""; } catch (_) {}
        if (srv) panelEl.querySelector("#gbcred-server").value = srv;
        if (pwd) panelEl.querySelector("#gbcred-server-pwd").value = pwd;

        // 服务器地址为空 → 提示配置
        if (!normalizeServerBase(srv)) {
            ub.textContent = "未配置服务器地址：在上方填 gbmd 服务器地址后点「💾 记住地址」";
            ub.className = "gbcred-userbar err";
            panelEl.classList.remove("server-ok");
            return;
        }
        const p = await probeServer(srv);
        if (!p.ok) {
            ub.textContent = "❌ 无法连接服务器: " + p.error;
            ub.className = "gbcred-userbar err";
            panelEl.classList.remove("server-ok");
            return;
        }
        // 需要密码则自动登录
        let session = "";
        if (p.status && p.status.needsAuth) {
            const lg = await serverLogin(p.base, pwd);
            if (!lg.ok) {
                ub.textContent = "❌ 服务器设有密码：" + lg.error + "（在上方填访问密码）";
                ub.className = "gbcred-userbar err";
                panelEl.classList.remove("server-ok");
                return;
            }
            session = lg.session;
        }
        const acc = await serverAccount(p.base, session);
        panelEl.classList.toggle("server-ok", !!(acc.ok && acc.info && acc.info.cookieSet));
        if (acc.ok && acc.info && acc.info.loggedIn) {
            const days = acc.info.remainingDays !== null && acc.info.remainingDays !== undefined ? `（剩 ${acc.info.remainingDays} 天）` : "";
            ub.textContent = `✅ 服务器已登录: ${acc.info.username}${days}`;
            ub.className = "gbcred-userbar " + (acc.info.warnLevel === "warn" ? "warn" : "ok");
            info.textContent = "服务器已有凭证，直接发送即可；本机 Cookie 不读取不展示。";
            panelEl.classList.add("server-ok");
            // 自动填充当前 mod 链接提示
            const u = currentModUrl();
            if (u) info.textContent += "\n当前 mod: " + u;
        } else if (acc.ok && acc.info) {
            ub.textContent = "○ 服务器未配置凭证";
            ub.className = "gbcred-userbar err";
            panelEl.classList.remove("server-ok");
            info.textContent = "服务器还没凭证：先点「📋 复制完整 Cookie」把本机 Cookie 粘到服务器设置页，或直接发送（服务器会提示需要 Cookie）。";
            await refreshLocalCred(st, ta, info);
        } else {
            ub.textContent = "❌ 服务器状态获取失败: " + (acc.error || "");
            ub.className = "gbcred-userbar err";
            panelEl.classList.remove("server-ok");
        }
    }

    /** 读本机 cookie 展示到面板（仅服务器没凭证时） */
    async function refreshLocalCred(st, ta, info) {
        st.textContent = "读取本机 Cookie…"; st.className = "";
        const c = await readCookieGM();
        const L = [];
        L.push("GM_cookie 诊断: " + c.diag);
        L.push("完整 Cookie: " + c.text.length + " 字符 / " + c.count + " 项 ｜ 来源: " + c.source);
        L.push("含 sess: " + (c.text.indexOf("sess=") >= 0 ? "✅ 有" : "❌ 无"));
        L.push("含 rmc: " + (c.text.indexOf("rmc=") >= 0 ? "✅ 有" : "❌ 无"));
        st.textContent = L.join("\n");
        st.className = c.count > 0 ? "ok" : "err";
        ta.value = c.text;
        if (info) info.textContent += "\n" + L.slice(1).join("\n");
        if (c.diag !== "OK") info.textContent = "如果 GM_cookie 诊断显示『未定义/0 个』：请用 Violentmonkey 或 Firefox 的 Tampermonkey，并给脚本开启 cookie 权限后重试。";
    }

    /** 发送当前 mod 页链接到服务器 */
    async function doSend() {
        if (!ensureUi()) return;
        const srvEl = panelEl.querySelector("#gbcred-server");
        const pwdEl = panelEl.querySelector("#gbcred-server-pwd");
        const sendBtn = panelEl.querySelector("#gbcred-send");
        const u = currentModUrl();
        if (!u) { srvSetStatus("❌ 当前不是 mod 页（需 gamebanana.com/mods/数字）", "err"); return; }
        const base = normalizeServerBase(srvEl.value);
        if (!base) { srvSetStatus("❌ 请先填服务器地址", "err"); return; }
        sendBtn.disabled = true;
        try {
            srvSetStatus(`服务器在线，正在发送 mod…（${u}）`, "info");
            const p = await probeServer(base);
            if (!p.ok) { srvSetStatus("发送失败：无法连接服务器 " + p.error, "err"); return; }
            let session = "";
            if (p.status && p.status.needsAuth) {
                const lg = await serverLogin(base, pwdEl.value || "");
                if (!lg.ok) { srvSetStatus("发送失败：服务器设有密码 " + lg.error, "err"); return; }
                session = lg.session;
            }
            const r = await sendModToServer(base, u, session);
            if (r.ok) {
                srvSetStatus(`✅ 已发送，服务器已添加 ${r.received} 个下载任务`, "ok");
                showToast("✅ 已发送到服务器");
            } else {
                srvSetStatus(`发送失败：${r.error}`, "err");
            }
        } finally {
            sendBtn.disabled = false;
        }
    }

    /* ---------- 注入登录态到浏览器（v4.1.0，参照 iwara v7.5）---------- */

    /** 从服务器拉明文凭证（GET /api/cred，需登录会话）。 */
    async function fetchServerCreds(base, session) {
        const headers = session ? { "Cookie": "session=" + session } : {};
        const r = await gmRequest("GET", base + "/api/cred", undefined, 12000, headers);
        if (r.ok && r.json && r.json.ok) return { ok: true, cred: r.json };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
    }

    /** 简单判断浏览器族（GameBanana 会话绑定创建 UA，仅提示用）。 */
    function uaFamily(ua) {
        ua = String(ua || "");
        if (ua.indexOf("Edg/") >= 0) return "Edge";
        if (ua.indexOf("Firefox/") >= 0) return "Firefox";
        if (ua.indexOf("Chrome/") >= 0) return "Chrome";
        if (ua.indexOf("Safari/") >= 0) return "Safari";
        return "";
    }

    /** 把 Cookie 项逐个写进当前域（document.cookie；HttpOnly 项 GM_cookie.set 兜底）。 */
    function applyCookieToBrowser(cookieText) {
        const items = String(cookieText || "").split(";").map((s) => s.trim()).filter((p) => p && !/^=/.test(p) && !/deleted/i.test(p));
        let written = 0;
        for (const item of items) {
            const eq = item.indexOf("=");
            if (eq <= 0) continue;
            const name = item.slice(0, eq).trim();
            const value = item.slice(eq + 1).trim();
            if (!name || !value) continue;
            try { document.cookie = name + "=" + value + "; path=/"; written++; } catch (_) {}
            // HttpOnly（如 sess/rmc）document.cookie 写不进，用 GM_cookie.set 兜底
            if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.set === "function") {
                try { GM_cookie.set({ url: location.origin + "/", name, value, path: "/" }, () => {}); } catch (_) {}
            }
        }
        return written;
    }

    /** 注入主流程：连接服务器 → GET /api/cred → 写 cookie，提示刷新。 */
    async function srvInjectFlow() {
        if (!ensureUi()) return;
        const srvEl = panelEl.querySelector("#gbcred-server");
        const base = normalizeServerBase((srvEl && srvEl.value.trim()) || "");
        if (!base) { srvSetStatus("❌ 请先填服务器地址", "err"); return; }
        const btn = panelEl.querySelector("#gbcred-inject");
        if (btn) btn.disabled = true;
        try {
            srvSetStatus("正在连接服务器…", "info");
            const p = await probeServer(base);
            if (!p.ok) { srvSetStatus("注入失败：无法连接服务器 " + p.error, "err"); return; }
            let session = "";
            if (p.status && p.status.needsAuth) {
                const pwdEl = panelEl.querySelector("#gbcred-server-pwd");
                const lg = await serverLogin(base, (pwdEl && pwdEl.value) || "");
                if (!lg.ok) { srvSetStatus("注入失败：服务器设有密码 " + lg.error, "err"); return; }
                session = lg.session;
            }
            srvSetStatus("正在读取服务器凭证…", "info");
            const got = await fetchServerCreds(base, session);
            if (!got.ok) { srvSetStatus("读取凭证失败：" + got.error, "err"); return; }
            const cred = got.cred || {};
            const n = applyCookieToBrowser(cred.cookie);
            const hasSess = /(?:^|;\s*)sess=/i.test(String(cred.cookie || ""));
            const L = [];
            L.push(`已写入 ${n} 个 Cookie 项` + (hasSess ? "（含 sess）" : ""));
            // GameBanana 会话绑定创建时浏览器 UA：浏览器族不一致时提示可能无效
            const curFam = uaFamily(navigator.userAgent);
            const srvFam = uaFamily(cred.userAgent);
            if (srvFam && curFam && srvFam !== curFam) L.push(`⚠ 凭证 UA 是 ${srvFam}，当前 ${curFam}（跨浏览器可能无效）`);
            if (n > 0) {
                srvSetStatus("✅ " + L.join("；") + " —— 请刷新页面生效", "ok");
                showToast("✅ 登录态已注入，请刷新页面");
            } else {
                srvSetStatus("服务器没有可注入的 Cookie（gbCookie 为空）", "err");
            }
        } catch (e) {
            srvSetStatus("注入失败：" + (e && e.message || e), "err");
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    /* ---------- 启动：只挂悬浮按钮，绝不自动弹面板 ---------- */
    function boot() {
        try { if (ensureUi()) log("已就绪，点击 🍌 打开面板"); } catch (e) { log("启动异常", e); }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
    // 防 SPA 把按钮剥掉：只是重新挂按钮，不弹面板
    setInterval(() => { try { ensureUi(); } catch (_) {} }, 3000);
})();
