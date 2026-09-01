// ============================================================
// path-picker.js — 路径输入 + 目录选择 小模块（2026-09-02 用户要求封装复用）
//   · 后端对接：GET /api/browse?path=<dir>（服务器本地目录浏览，见 app.js）
//   · 弹窗 DOM：index.html 里的 #browseMask（目录选择弹窗）
//   · 用法：任何「下载路径」输入框，一行接入，不再手写 📂 按钮/绑定：
//       PathPicker.attach(document.getElementById("xxxPath"));
//     传入 input 元素 → 自动在其后插入 📂 按钮，点击弹出目录浏览器，
//     选目录回填 input.value。弹窗事件只需 bind() 一次（init 时调用）。
// ============================================================
(function (global) {
  "use strict";

  let browseTargetInput = null; // 当前打开的路径输入框

  // ---------- 弹窗 ----------
  async function loadBrowse(p) {
    const el = global.document.getElementById("browsePath");
    if (!el) return;
    el.textContent = "读取中…";
    let r;
    try { r = await api("/api/browse?path=" + encodeURIComponent(p)); }
    catch (e) { el.textContent = "读取失败: " + e.message; return; }
    if (!r || !r.ok) { el.textContent = (r && r.error) || "读取失败"; return; }
    el.textContent = r.path;
    global.document.getElementById("browseSelect").dataset.path = r.path;
    let html = "";
    if (r.parent) html += `<div class="browse-item" data-path="${esc(r.parent)}">⬆ 上级目录</div>`;
    if (!r.dirs.length) html += '<div class="hint">（无子目录）</div>';
    r.dirs.forEach((d) => {
      const full = r.path === "/" ? "/" + d : r.path + "/" + d;
      html += `<div class="browse-item" data-path="${esc(full)}">📁 ${esc(d)}</div>`;
    });
    global.document.getElementById("browseList").innerHTML = html;
    global.document.getElementById("browseList").querySelectorAll(".browse-item").forEach((el2) => {
      el2.addEventListener("click", () => loadBrowse(el2.dataset.path));
    });
  }

  function openBrowse(input) {
    browseTargetInput = input;
    const mask = global.document.getElementById("browseMask");
    if (mask) {
      mask.style.display = "flex";
      global.document.getElementById("browseHint").textContent = "";
      loadBrowse("/");
    }
  }

  // 绑定弹窗关闭/选择事件（init 时调用一次即可）
  function bindEvents() {
    const close = global.document.getElementById("browseClose");
    if (close) close.addEventListener("click", () => { global.document.getElementById("browseMask").style.display = "none"; });
    const mask = global.document.getElementById("browseMask");
    if (mask) mask.addEventListener("click", (e) => { if (e.target === mask) mask.style.display = "none"; });
    const sel = global.document.getElementById("browseSelect");
    if (sel) sel.addEventListener("click", () => {
      const p = sel.dataset.path || "";
      if (browseTargetInput && p) { browseTargetInput.value = p; global.document.getElementById("browseMask").style.display = "none"; }
    });
  }

  // ---------- 一行接入：给 input 追加 📂 目录选择按钮（幂等）----------
  // input 传入 DOM 元素（或 #id 字符串）。返回 input 元素。
  function attach(input) {
    if (typeof input === "string") input = global.document.getElementById(input);
    if (!input || input.dataset.pathPickerDone) return input;
    input.dataset.pathPickerDone = "1";
    const btn = global.document.createElement("button");
    btn.type = "button";
    btn.className = "ghost"; // 复用幽灵按钮样式；.browse-btn 兼容旧布局
    btn.title = "读取本地选择目录";
    btn.textContent = "📂";
    btn.addEventListener("click", () => openBrowse(input));
    if (input.nextSibling) input.parentNode.insertBefore(btn, input.nextSibling);
    else input.parentNode.appendChild(btn);
    return input;
  }

  // 简化别名：给「读本地目录按钮所在的 input」挂选择器（powered by attach）
  global.PathPicker = { attach, openBrowse, loadBrowse, bindEvents };
})(window);