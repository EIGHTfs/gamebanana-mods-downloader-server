// ==UserScript==
// @name         GameBanana Cookie/登录态获取器 v3（点击悬浮窗获取）
// @namespace    gbmd-cred
// @version      3.0.0
// @description  右下角 🍌 按钮，点击才检测登录态/用户名并读取含 HttpOnly 的完整 Cookie。不自动弹出。
// @author       fnOS
// @match        https://gamebanana.com/*
// @match        https://www.gamebanana.com/*
// @grant        GM_setClipboard
// @grant        GM_cookie.list
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    "use strict";
    const VER = "3.0.0";
    function log(...a) { try { console.log("[gb-cookie v3]", ...a); } catch (_) {} }

    /** 读取完整 cookie（含 HttpOnly）。返回 { text, count, source, diag } */
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

    async function detectLogin() {
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

    /* ---------- UI（仅点击按钮才出现） ---------- */
    let fabEl = null, panelEl = null, toastEl = null;

    function ensureFab() {
        if (!document.body) return false;
        if (!fabEl || !document.body.contains(fabEl)) {
            fabEl = document.createElement("button");
            fabEl.textContent = "🍌";
            fabEl.title = "GameBanana 会话检测 / 复制完整 Cookie";
            Object.assign(fabEl.style, {
                position: "fixed", right: "14px", bottom: "14px", zIndex: "2147483647",
                width: "56px", height: "56px", borderRadius: "50%", background: "#2f6fed",
                color: "#fff", border: "none", fontSize: "24px", cursor: "pointer",
                boxShadow: "0 4px 16px rgba(0,0,0,.35)",
            });
            fabEl.addEventListener("click", openPanel);
            document.body.appendChild(fabEl);
        }
        return true;
    }

    function openPanel() {
        if (!ensureFab()) return;
        if (!panelEl) {
            panelEl = document.createElement("div");
            panelEl.id = "gbcred-panel";
            Object.assign(panelEl.style, {
                position: "fixed", left: "0", right: "0", bottom: "0", zIndex: "2147483647",
                maxHeight: "80vh", overflow: "auto", background: "#fff", borderRadius: "16px 16px 0 0",
                boxShadow: "0 -6px 30px rgba(0,0,0,.3)", font: "14px/1.6 system-ui,'Microsoft YaHei',sans-serif",
                color: "#222", padding: "0 0 16px",
            });
            panelEl.innerHTML = `
<div id="gbcred-head" style="position:sticky;top:0;background:#fff;padding:12px 16px;border-bottom:1px solid #eef1f5;display:flex;align-items:center;justify-content:space-between">
  <b>🍌 GameBanana 会话</b><span id="gbcred-close" style="cursor:pointer;font-size:20px;color:#8a94a3">✕</span>
</div>
<div id="gbcred-status" style="padding:12px 16px;background:#f0f7ff;border-radius:10px;margin:10px;font-size:14px;color:#1a3d6d;white-space:pre-wrap">正在检测…</div>
<div style="padding:0 16px">
  <label style="display:block;font-size:12px;color:#5a6472;margin:10px 0 4px">完整 Cookie（含 HttpOnly，GM_cookie 读取）</label>
  <textarea id="gbcred-cookie" readonly spellcheck="false" style="width:100%;box-sizing:border-box;resize:none;padding:8px;border:1px solid #c9cfd8;border-radius:8px;font:11px/1.5 ui-monospace,Consolas,monospace;background:#fafbfc;color:#222;overflow:auto;height:110px"></textarea>
  <div style="margin-top:12px">
    <button id="gbcred-copy-all" style="width:100%;padding:12px;border:none;border-radius:10px;cursor:pointer;font-size:15px;font-weight:600;background:#2f6fed;color:#fff">📋 复制完整 Cookie</button>
  </div>
  <div id="gbcred-msg" style="font-size:12px;color:#8a94a3;margin-top:8px"></div>
</div>`;
            document.body.appendChild(panelEl);
            panelEl.querySelector("#gbcred-close").addEventListener("click", () => { panelEl.style.display = "none"; });
            panelEl.querySelector("#gbcred-copy-all").addEventListener("click", async () => {
                const c = await readCookieGM();
                copyText(c.text).then((ok) => showToast(ok ? "✅ 已复制完整 Cookie" : "❌ 复制失败"));
            });
        }
        if (!toastEl || !document.body.contains(toastEl)) {
            toastEl = document.createElement("div");
            Object.assign(toastEl.style, {
                position: "fixed", left: "50%", bottom: "90px", transform: "translateX(-50%)", zIndex: "2147483647",
                background: "rgba(20,24,30,.92)", color: "#fff", padding: "10px 16px", borderRadius: "10px",
                fontSize: "14px", display: "none",
            });
            document.body.appendChild(toastEl);
        }
        panelEl.style.display = "block";
        run();
    }

    async function run() {
        const st = panelEl.querySelector("#gbcred-status");
        const ta = panelEl.querySelector("#gbcred-cookie");
        const msg = panelEl.querySelector("#gbcred-msg");
        st.textContent = "正在检测…"; ta.value = "";
        let det; try { det = await detectLogin(); } catch (e) { det = { loggedIn: false, detail: "异常:" + e }; }
        let c; try { c = await readCookieGM(); } catch (e) { c = { text: "", count: 0, source: "?", diag: "异常:" + e }; }
        const L = [];
        L.push(det.loggedIn ? "✅ 已登录" : "❌ 未登录");
        if (det.loggedIn) {
            L.push("👤 用户名: " + (det.name || "(未取到)"));
            if (det.idRow) L.push("🆔 用户 id: " + det.idRow);
            if (det.profileUrl) L.push("🔗 " + det.profileUrl);
        }
        L.push("───");
        L.push("GM_cookie 诊断: " + c.diag);
        L.push("完整 Cookie: " + c.text.length + " 字符 / " + c.count + " 项 ｜ 来源: " + c.source);
        L.push("含 cf_clearance: " + (c.text.indexOf("cf_clearance") >= 0 ? "✅ 有" : "❌ 无"));
        L.push("含 sess: " + (c.text.indexOf("sess=") >= 0 ? "✅ 有" : "❌ 无"));
        L.push("含 rmc: " + (c.text.indexOf("rmc=") >= 0 ? "✅ 有" : "❌ 无"));
        st.textContent = L.join("\n");
        ta.value = c.text;
        msg.textContent = "如果 GM_cookie 诊断显示『未定义/0 个』：请用 Violentmonkey 或 Firefox 的 Tampermonkey，并给脚本开启 cookie 权限后重试。";
    }

    function copyText(text) {
        return new Promise((res) => {
            try { if (typeof GM_setClipboard === "function") { GM_setClipboard(text, { type: "text", mimetype: "text/plain" }); return res(true); } } catch (_) {}
            try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(() => res(true), () => res(false)); return; } } catch (_) {}
            res(false);
        });
    }
    function showToast(m) { if (!toastEl) return; toastEl.textContent = m; toastEl.style.display = "block"; setTimeout(() => { toastEl.style.display = "none"; }, 4000); }

    /* ---------- 启动：只挂悬浮按钮，绝不自动弹面板 ---------- */
    function boot() {
        try { if (ensureFab()) log("已就绪，点击 🍌 获取"); } catch (e) { log("启动异常", e); }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
    // 防 SPA 把按钮剥掉：只是重新挂按钮，不弹面板
    setInterval(() => { try { ensureFab(); } catch (_) {} }, 3000);
})();
