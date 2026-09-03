// ==UserScript==
// @name         GameBanana 下载助手（Cookie + 一键发送到服务器）
// @namespace    gbmd-cred
// @version      4.4.0
// @description  右下角 🍌 面板：显示 GameBanana 登录态/用户名/剩余天数、复制完整 Cookie（含 HttpOnly，sess+rmc）；「📤 发送到服务器」把当前 mod 页链接一键推给 GameBanana Mod Downloader 下载（设了密码会自动用保存的密码登录）；「🔄 注入登录态到浏览器」把服务器保存的 Cookie 写回当前浏览器（GM_cookie 双域写入）
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
 * v4.3.0（2026-09-02，注入简化 + 双写存储，参照 iwara）
 * - 移除 UA 拦截/提示：脚本改不了浏览器导航真实 UA，注入直接写 cookie，不再装模作样
 * - 服务器地址/密码改为 GM + localStorage 双写（重装油猴/GM 读失败从本站回填，刷新不丢）
 * v4.2.0（2026-09-02，注入登录态修复：GB 会话绑定 UA + 实测验证）
 * - 修：GameBanana 会话绑定「创建会话时的浏览器 UA」——注入前比对凭证 UA 与当前浏览器
 *   UA（浏览器标识+主版本），不一致直接报错不假装成功（此后移除：拦截无意义，用户删）
 * - 修：注入后实测验证——用当前 UA + 刚写入的 cookie 请求 UiConfig 看 _bIsLoggedIn，
 *   成功才显示 ✅（此后移除：与 UA 拦截一并删）
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

    const VER = "4.4.0";
    const GB_ICON = "data:image/png;base64,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";
    const SRV_KEY = "gbcred_server";      // 当前选中的服务器地址
    const SRV_PWD_KEY = "gbcred_server_pwd"; // 当前选中的访问密码
    // 用户原话「填写和读取分离…添加后的服务端用下拉列表展示选择，不能被修改只能删除」
    const SRV_LIST_KEY = "gbcred_server_list";
    function log(...a) { try { console.log("[gb-cred " + VER + "]", ...a); } catch (_) {} }

    /* ---------- 工具 ---------- */
    function $(sel) { return document.querySelector(sel); }
    function ls(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }

    /** 服务器地址/密码：GM 存储 + localStorage 双写（重装油猴/GM 读失败时从本站回填）。 */
    function storeGet(key) {
        try {
            if (typeof GM_getValue === "function") {
                const v = GM_getValue(key, "");
                if (v !== undefined && v !== null && String(v).trim()) return String(v);
            }
        } catch (_) {}
        try {
            const v = localStorage.getItem("gbcred:" + key);
            if (v && String(v).trim()) return String(v);
        } catch (_) {}
        return "";
    }
    function storeSet(key, val) {
        const s = String(val || "");
        try { if (typeof GM_setValue === "function") GM_setValue(key, s); } catch (_) {}
        try {
            if (s) localStorage.setItem("gbcred:" + key, s);
            else localStorage.removeItem("gbcred:" + key);
        } catch (_) {}
    }

    /** 规范化服务器地址：没写协议补 http://；去末尾 / */
    function normalizeServerBase(url) {
        let s = String(url || "").trim();
        if (!s) return "";
        s = s.replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(s)) s = "http://" + s;
        return s;
    }

    function loadServerList() {
        let raw = storeGet(SRV_LIST_KEY);
        let list = [];
        try { list = raw ? JSON.parse(raw) : []; } catch (_) { list = []; }
        if (!Array.isArray(list)) list = [];
        list = list.map((it) => ({
            url: normalizeServerBase(it && it.url),
            password: String((it && it.password) || "")
        })).filter((it) => it.url);
        const seen = new Set();
        const uniq = [];
        for (const it of list) {
            if (seen.has(it.url)) continue;
            seen.add(it.url);
            uniq.push(it);
        }
        // 【原代码】只记一条 SRV_KEY。【改为】用户原话「下拉列表」【思路】旧地址迁进清单
        const legacy = normalizeServerBase(storeGet(SRV_KEY));
        if (legacy && !uniq.some((it) => it.url === legacy)) {
            uniq.unshift({ url: legacy, password: storeGet(SRV_PWD_KEY) });
            saveServerList(uniq);
        }
        return uniq;
    }
    function saveServerList(list) {
        storeSet(SRV_LIST_KEY, JSON.stringify(list || []));
    }
    function currentServer() {
        const list = loadServerList();
        const sel = normalizeServerBase(storeGet(SRV_KEY));
        return list.find((it) => it.url === sel) || list[0] || null;
    }
    function fillServerSelect() {
        const sel = panelEl && panelEl.querySelector("#gbcred-server");
        if (!sel) return;
        const list = loadServerList();
        const cur = currentServer();
        sel.innerHTML = "";
        if (!list.length) {
            const o = document.createElement("option");
            o.value = "";
            o.textContent = "尚未添加服务端";
            sel.appendChild(o);
            return;
        }
        for (const it of list) {
            const o = document.createElement("option");
            o.value = it.url;
            o.textContent = it.url;
            sel.appendChild(o);
        }
        sel.value = cur ? cur.url : list[0].url;
        if (cur) {
            storeSet(SRV_KEY, cur.url);
            storeSet(SRV_PWD_KEY, cur.password);
        }
    }
    function addServerFromForm() {
        const url = normalizeServerBase(panelEl.querySelector("#gbcred-url-new").value);
        const password = panelEl.querySelector("#gbcred-pwd-new").value || "";
        if (!url) { srvSetStatus("❌ 请填写服务器地址", "err"); return; }
        const list = loadServerList();
        if (list.some((it) => it.url === url)) { srvSetStatus("已存在该地址", "err"); return; }
        list.push({ url, password });
        saveServerList(list);
        storeSet(SRV_KEY, url);
        storeSet(SRV_PWD_KEY, password);
        panelEl.querySelector("#gbcred-add-form").style.display = "none";
        fillServerSelect();
        srvSetStatus("已添加 " + url, "ok");
        openPanel();
    }
    function deleteSelectedServer() {
        const sel = panelEl.querySelector("#gbcred-server");
        const url = sel && sel.value;
        if (!url) { srvSetStatus("没有可删除的服务端", "err"); return; }
        const list = loadServerList().filter((it) => it.url !== url);
        saveServerList(list);
        const next = list[0] || { url: "", password: "" };
        storeSet(SRV_KEY, next.url);
        storeSet(SRV_PWD_KEY, next.password);
        fillServerSelect();
        srvSetStatus("已删除 " + url, "ok");
        openPanel();
    }

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
  padding:0;border:none;cursor:pointer;background:#1e2a33;overflow:hidden;
  box-shadow:0 4px 16px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent;pointer-events:auto}
#gbcred-fab img{width:100%;height:100%;object-fit:contain;display:block}
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
#gbcred-server-row{display:flex;gap:6px;margin-top:4px;align-items:center}
#gbcred-server{flex:1;min-width:0;padding:8px;border:1px solid #c9cfd8;border-radius:8px;
  font:13px/1.4 ui-monospace,Consolas,monospace;color:#222;background:#fafbfc}
#gbcred-add-form{display:none;margin-top:8px;padding:8px;background:#f7f9fc;border-radius:8px}
#gbcred-add-form input{width:100%;box-sizing:border-box;margin:4px 0;padding:8px;border:1px solid #c9cfd8;border-radius:8px}
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
                fabEl.title = "GameBanana 下载助手";
                const img = document.createElement("img");
                img.src = GB_ICON;
                img.alt = "GameBanana";
                fabEl.appendChild(img);
                fabEl.addEventListener("click", openPanel);
            }
            if (fabEl.parentNode !== document.documentElement) document.documentElement.appendChild(fabEl);
        }
        if (!panelEl || !document.documentElement.contains(panelEl)) {
            if (!panelEl) {
                panelEl = document.createElement("div");
                panelEl.id = "gbcred-panel";
                panelEl.innerHTML = `
<div id="gbcred-head"><b>GameBanana 下载助手</b><span id="gbcred-close">✕</span></div>
<div id="gbcred-userbar">打开即可发送；没配置凭证时才采集本机 Cookie</div>
<div id="gbcred-body">
  <label>📤 发送到服务器（当前 mod 页链接 → 服务器自行解析下载，不读 Cookie）</label>
  <div id="gbcred-server-row">
    <select id="gbcred-server"></select>
    <button id="gbcred-send">📤 发送</button>
  </div>
  <div id="gbcred-srv-actions">
    <button id="gbcred-add">➕ 添加</button>
    <button id="gbcred-del">🗑 删除</button>
    <button id="gbcred-inject">🔄 注入登录态到浏览器</button>
  </div>
  <div id="gbcred-add-form">
    <input id="gbcred-url-new" placeholder="http://IP:端口" spellcheck="false">
    <input id="gbcred-pwd-new" type="password" placeholder="访问密码（可空）" autocomplete="off">
    <div id="gbcred-srv-actions">
      <button id="gbcred-add-ok">确认添加</button>
      <button id="gbcred-add-cancel">取消</button>
    </div>
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
                panelEl.querySelector("#gbcred-add").addEventListener("click", () => {
                    panelEl.querySelector("#gbcred-add-form").style.display = "block";
                    panelEl.querySelector("#gbcred-url-new").value = "";
                    panelEl.querySelector("#gbcred-pwd-new").value = "";
                });
                panelEl.querySelector("#gbcred-add-cancel").addEventListener("click", () => {
                    panelEl.querySelector("#gbcred-add-form").style.display = "none";
                });
                panelEl.querySelector("#gbcred-add-ok").addEventListener("click", addServerFromForm);
                panelEl.querySelector("#gbcred-del").addEventListener("click", deleteSelectedServer);
                panelEl.querySelector("#gbcred-server").addEventListener("change", () => {
                    const url = panelEl.querySelector("#gbcred-server").value;
                    const hit = loadServerList().find((it) => it.url === url);
                    if (!hit) return;
                    storeSet(SRV_KEY, hit.url);
                    storeSet(SRV_PWD_KEY, hit.password);
                    openPanel();
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

        fillServerSelect();
        const cur = currentServer();
        let srv = cur ? cur.url : "";
        let pwd = cur ? cur.password : "";

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
        const sendBtn = panelEl.querySelector("#gbcred-send");
        const u = currentModUrl();
        if (!u) { srvSetStatus("❌ 当前不是 mod 页（需 gamebanana.com/mods/数字）", "err"); return; }
        const cur = currentServer();
        const base = cur ? cur.url : "";
        const pwdEl = { value: cur ? cur.password : "" };
        if (!base) { srvSetStatus("❌ 请先添加并选择服务器", "err"); return; }
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

    /* ---------- 注入登录态到浏览器（v4.3.0，参照 iwara：直接写 cookie，不拦截）---------- */

    /** 从服务器拉明文凭证（GET /api/cred，需登录会话）。 */
    async function fetchServerCreds(base, session) {
        const headers = session ? { "Cookie": "session=" + session } : {};
        const r = await gmRequest("GET", base + "/api/cred", undefined, 12000, headers);
        if (r.ok && r.json && r.json.ok) return { ok: true, cred: r.json };
        return { ok: false, error: (r.json && r.json.error) || r.error || ("HTTP " + r.status) };
    }

    /** 把 Cookie 项写进浏览器：document.cookie（当前域）+ GM_cookie.set 兜底（双域）。 */
    function applyCookieToBrowser(cookieText) {
        const items = String(cookieText || "").split(";").map((s) => s.trim()).filter((p) => p && !/^=/.test(p) && !/deleted/i.test(p));
        const gbHosts = ["gamebanana.com", "www.gamebanana.com"];
        let written = 0;
        for (const item of items) {
            const eq = item.indexOf("=");
            if (eq <= 0) continue;
            const name = item.slice(0, eq).trim();
            const value = item.slice(eq + 1).trim();
            if (!name || !value) continue;
            try { document.cookie = name + "=" + value + "; path=/"; written++; } catch (_) {}
            // HttpOnly（sess/rmc）document.cookie 写不进，GM_cookie.set 兜底；gamebanana.com 与 www 双域都写
            if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.set === "function") {
                for (const host of gbHosts) {
                    try { GM_cookie.set({ url: "https://" + host + "/", name, value, path: "/" }, () => {}); } catch (_) {}
                }
            }
        }
        return written;
    }

    /** 注入主流程：连接服务器 → GET /api/cred → 写 cookie，提示刷新。 */
    async function srvInjectFlow() {
        if (!ensureUi()) return;
        const cur = currentServer();
        const base = cur ? cur.url : "";
        if (!base) { srvSetStatus("❌ 请先添加并选择服务器", "err"); return; }
        const btn = panelEl.querySelector("#gbcred-inject");
        if (btn) btn.disabled = true;
        try {
            srvSetStatus("正在连接服务器…", "info");
            const p = await probeServer(base);
            if (!p.ok) { srvSetStatus("注入失败：无法连接服务器 " + p.error, "err"); return; }
            let session = "";
            if (p.status && p.status.needsAuth) {
                const lg = await serverLogin(base, (cur && cur.password) || "");
                if (!lg.ok) { srvSetStatus("注入失败：服务器设有密码 " + lg.error, "err"); return; }
                session = lg.session;
            }
            srvSetStatus("正在读取服务器凭证…", "info");
            const got = await fetchServerCreds(base, session);
            if (!got.ok) { srvSetStatus("读取凭证失败：" + got.error, "err"); return; }
            const cred = got.cred || {};
            const cookieText = String(cred.cookie || "");
            if (!cookieText.trim()) { srvSetStatus("服务器没有可注入的 Cookie（gbCookie 为空）", "err"); return; }

            // 写入 cookie（document.cookie + GM_cookie.set 双域兜底）
            const n = applyCookieToBrowser(cookieText);
            const hasSess = /(?:^|;\s*)sess=/i.test(cookieText);
            if (n > 0) {
                srvSetStatus(`✅ 已写入 ${n} 个 Cookie 项` + (hasSess ? "（含 sess）" : "") + " —— 请刷新页面生效", "ok");
                showToast("✅ 登录态已注入，请刷新页面");
            } else {
                srvSetStatus("Cookie 写入失败（0 项），请确认已开启 GM_cookie 权限", "err");
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
