// ============================================================
// gbmd - 前端主逻辑（tab + 轮询）
// ============================================================
"use strict";

const $ = (sel) => document.querySelector(sel);

let settings = null;
let searchResults = [];
let searchPollTimer = null;
let taskPollTimer = null;

// ============================================================
// 【模板版】不再在此定义 api()——由外部提供全局 api(path, method, body)：
//   - 纯前端模板：docs/ui-template/mock-api.js 提供（返回空态 + 契约注释）
//   - 接真实后端：提供同签名的 api()，例如原本的 fetch 实现：
// async function api(path, method = "GET", body) {
//   const opts = { method, headers: {} };
//   if (body !== undefined) {
//     opts.headers["Content-Type"] = "application/json";
//     opts.body = JSON.stringify(body);
//   }
//   const r = await fetch(path, opts);
//   if (r.status === 401) { location.href = "/login.html"; throw new Error("未登录"); }
//   return r.json();
// }
// ============================================================

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTs(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return isNaN(d.getTime()) ? "-" : d.toLocaleString("zh-CN", { hour12: false });
}

function typeIcon(t) {
  switch (t) {
    case "file": return "📦";
    case "image": return "🖼";
    case "blocked": return "🚫";
    case "skipped": return "⏭";
    case "error": return "⚠";
    default: return "•";
  }
}

function typeLabel(t) {
  switch (t) {
    case "file": return "文件";
    case "image": return "图片";
    case "blocked": return "已屏蔽";
    case "skipped": return "已忽略";
    case "error": return "错误";
    default: return t;
  }
}

// ---------- Tab 切换 ----------
function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      $("#panel-" + tab.dataset.tab).classList.add("active");
      try { history.replaceState(null, "", "#" + tab.dataset.tab); } catch (_) {}
    });
  });
  window.addEventListener("hashchange", () => {
    const name = location.hash.replace(/^#/, "");
    if (name && document.querySelector(`.tab[data-tab="${name}"]`)) switchTab(name);
  });
  const initial = location.hash.replace(/^#/, "");
  if (initial && document.querySelector(`.tab[data-tab="${initial}"]`)) switchTab(initial);
}

function switchTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

// ---------- 批量下载 ----------
function bindBatch() {
  $("#batchBtn").addEventListener("click", async () => {
    const links = $("#batchInput").value.split("\n").map((s) => s.trim()).filter((s) => s);
    if (!links.length) { $("#batchStatus").textContent = "请输入链接"; return; }
    $("#batchBtn").disabled = true;
    $("#batchStatus").textContent = "启动中…";
    try {
      const r = await api("/api/download", "POST", { links });
      if (!r.ok) throw new Error(r.error || "启动失败");
      $("#batchStatus").textContent = `已启动后台下载（${links.length} 个 mod），进度见「下载进度」标签`;
      $("#batchStatus").className = "status ok";
      switchTab("progress");
    } catch (e) {
      $("#batchStatus").textContent = "启动失败：" + e.message;
      $("#batchStatus").className = "status err";
    } finally {
      $("#batchBtn").disabled = false;
    }
  });
  $("#clearBtn").addEventListener("click", () => {
    $("#batchInput").value = "";
    $("#batchStatus").textContent = "";
  });
}

// ---------- 搜索 ----------
function loadGameSelects() {
  api("/api/games").then((r) => {
    if (!(r && r.ok && r.games)) return;
    const opts = '<option value="">— 请选择游戏 —</option>' +
      Object.entries(r.games).map(([name, entry]) =>
        `<option value="${esc(name)}">${esc(entry && entry.cn ? entry.cn + "（" + name + "）" : name)}</option>`).join("");
    $("#searchGameSelect").innerHTML = opts;
    const mm = $("#mmGameSelect");
    if (mm) mm.innerHTML = opts;
    const mmAdd = $("#mmAddGame");
    if (mmAdd) mmAdd.innerHTML = opts;
    const mmEmpty = $("#mmEmptyGame");
    if (mmEmpty) mmEmpty.innerHTML = opts;
  }).catch(() => {});
}

function bindSearch() {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 86400000);
  // 修复：toISOString() 是 UTC（东八区会显示成前一天），改用本地日期拼 YYYY-MM-DD
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // const localDate = (d) => d.toLocaleDateString("sv-SE"); // 备选写法（sv-SE 恰好输出 YYYY-MM-DD）
  $("#searchEnd").value = localDate(now);
  $("#searchStart").value = localDate(d30);

  $("#earliestBtn").addEventListener("click", () => {
    $("#searchStart").value = "2000-01-01";
    $("#searchStatus").textContent = "开始日期已设为最早（2000-01-01）";
  });

  $("#searchBtn").addEventListener("click", async () => {
    const startDate = $("#searchStart").value;
    const endDate = $("#searchEnd").value;
    if (!startDate || !endDate) { $("#searchStatus").textContent = "请选择日期范围"; return; }
    const game = $("#searchGameSelect").value;
    if (!game) { $("#searchStatus").textContent = "请选择要筛选的游戏"; return; }
    const contentFilter = [];
    if ($("#filterNormal").checked) contentFilter.push("normal");
    if ($("#filterNsfw").checked) contentFilter.push("nsfw");
    if (!contentFilter.length) { $("#searchStatus").textContent = "请至少选择一个内容分级"; return; }
    $("#searchBtn").disabled = true;
    $("#searchStatus").textContent = "启动搜索…";
    try {
      // 2026-08-26 修复（用户反馈：中途搜了别的没覆盖旧搜索）：
      //   先停掉旧搜索（避免「已有搜索任务」报错 + 旧结果残留），再启动新搜索
      try { await api("/api/search/stop", "POST", {}); } catch (_) {}
      // 清空旧的搜索结果显示
      searchResults = [];
      const resEl = $("#searchResult");
      if (resEl) resEl.innerHTML = "";
      const r = await api("/api/search", "POST", { startDate, endDate, contentFilter, games: [game] });
      if (!r.ok) throw new Error(r.error || "启动失败");
      $("#searchStatus").textContent = "搜索中…（后台运行，可切换标签）";
      $("#searchStatus").className = "status";
      $("#stopSearchBtn").style.display = "inline-block";
      startSearchPoll();
    } catch (e) {
      $("#searchStatus").textContent = "搜索失败：" + e.message;
      $("#searchStatus").className = "status err";
      $("#searchBtn").disabled = false;
    }
  });

  $("#stopSearchBtn").addEventListener("click", async () => {
    await api("/api/search/stop", "POST", {});
    $("#stopSearchBtn").style.display = "none";
    $("#searchBtn").disabled = false;
    $("#searchStatus").textContent = "已停止搜索（保留已找到的结果）";
  });

  $("#clearSearchBtn").addEventListener("click", async () => {
    searchResults = [];
    renderSearchResults();
    await api("/api/search/clear", "POST", {});
    $("#searchStatus").textContent = "列表已清空";
  });

  // 2026-08-26 用户要求：导出/导入搜索记录（备份、迁移、手动恢复）
  $("#exportSearchBtn").addEventListener("click", async () => {
    try {
      const r = await fetch("/api/search/export");
      if (r.status === 401) { location.href = "/login.html"; return; }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "gbmd-search-records-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      URL.revokeObjectURL(a.href);
      $("#searchStatus").textContent = "已导出搜索记录 JSON";
    } catch (e) {
      $("#searchStatus").textContent = "导出失败: " + e.message;
      $("#searchStatus").className = "status err";
    }
  });

  $("#importSearchBtn").addEventListener("click", () => { $("#importSearchFile").click(); });
  $("#importSearchFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    $("#searchStatus").textContent = "正在导入 " + file.name + " …";
    try {
      const text = await file.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      let records = null;
      if (Array.isArray(json)) records = json;
      else if (json && Array.isArray(json.results)) records = json.results;
      else if (json && Array.isArray(json.records)) records = json.records;
      if (!records) { $("#searchStatus").textContent = "导入失败: 文件里找不到记录数组（需为 JSON 数组或 {results:[...]}）"; $("#searchStatus").className = "status err"; ev.target.value = ""; return; }
      const r = await api("/api/search/import", "POST", { records });
      if (!r.ok) throw new Error(r.error || "导入失败");
      // 刷新显示：重新拉取合并后的 cache
      const c = await api("/api/search/cache");
      if (c.cache && c.cache.results) { searchResults = c.cache.results; renderSearchResults(); }
      $("#searchStatus").textContent = `✅ 导入完成：新增 ${r.added} 条，覆盖 ${r.replaced} 条，当前共 ${r.total} 条`;
      $("#searchStatus").className = "status";
    } catch (e) {
      $("#searchStatus").textContent = "导入失败: " + e.message;
      $("#searchStatus").className = "status err";
    } finally {
      ev.target.value = ""; // 允许再次选择同一文件
    }
  });

  // 2026-08-31 用户要求：全选也依据上面搜索功能部分的 普通/NSFW 筛选（只勾选符合筛选的）
  $("#selectAllBtn").addEventListener("click", () => {
    const wantNormal = $("#filterNormal").checked;
    const wantNsfw = $("#filterNsfw").checked;
    document.querySelectorAll("#searchResultList input[type=checkbox]").forEach((cb) => {
      const id = cb.id.replace(/^cb-/, "");
      const it = searchResults.find((x) => String(x.modId) === id);
      cb.checked = !!it && (it.isNsfw ? wantNsfw : wantNormal);
    });
  });
  $("#selectNoneBtn").addEventListener("click", () => {
    document.querySelectorAll("#searchResultList input[type=checkbox]").forEach((cb) => (cb.checked = false));
  });

  // 2026-08-31 用户要求：保存（搜索结果覆盖写入 search_cache.json）
  $("#saveSearchBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/search/save", "POST", { results: searchResults });
      if (!r.ok) throw new Error(r.error || "保存失败");
      $("#searchStatus").textContent = `✅ 已保存 ${r.total} 条到 search_cache.json`;
      $("#searchStatus").className = "status ok";
    } catch (e) {
      $("#searchStatus").textContent = "保存失败: " + e.message;
      $("#searchStatus").className = "status err";
    }
  });

  $("#downloadSelectedBtn").addEventListener("click", async () => {
    const selected = searchResults.filter((it) => {
      const cb = document.getElementById("cb-" + it.modId);
      return cb && cb.checked;
    });
    if (!selected.length) { $("#searchStatus").textContent = "请先勾选要下载的 mod"; return; }
    $("#searchStatus").textContent = `正在启动 ${selected.length} 个 mod 的下载…`;
    try {
      const r = await api("/api/download-selected", "POST", { items: selected });
      if (!r.ok) throw new Error(r.error || "启动失败");
      $("#searchStatus").textContent = `已启动后台下载（${selected.length} 个 mod），进度见「下载进度」标签`;
      $("#searchStatus").className = "status ok";
      switchTab("progress");
    } catch (e) {
      $("#searchStatus").textContent = "启动失败：" + e.message;
      $("#searchStatus").className = "status err";
    }
  });
}

async function keywordSearch() {
  const q = ($("#kwInput").value || "").trim();
  const game = $("#searchGameSelect").value;
  const st = $("#kwStatus");
  if (!q || !game) { if (st) { st.textContent = "请输入关键词并选择游戏"; st.className = "status err"; } return; }
  if (st) { st.textContent = "搜索中…"; st.className = "status"; }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await api("/api/keyword-search?q=" + encodeURIComponent(q) + "&game=" + encodeURIComponent(game) + "&perpage=50&max=100");
      if (!r || !r.ok) throw new Error((r && r.error) || "search failed");
      searchResults = r.results || [];
      // 2026-08-31 用户要求：关键词搜索也按 普通/NSFW 筛选（与时间搜索共用筛选）
      const wantNormal = $("#filterNormal") ? $("#filterNormal").checked : true;
      const wantNsfw = $("#filterNsfw") ? $("#filterNsfw").checked : true;
      if (!(wantNormal && wantNsfw)) {
        searchResults = searchResults.filter((it) => (it.isNsfw ? wantNsfw : wantNormal));
      }
      renderSearchResults();
      if (st) {
        const norm = r.normalized ? `（${r.normalized.from} → ${r.normalized.to}）` : "";
        st.textContent = `关键词「${q}」${norm}: ${searchResults.length} 个结果${(wantNormal && wantNsfw) ? "" : "（已按分级筛选）"}`;
        st.className = "status ok";
      }
      return;
    } catch (e) {
      if (attempt < 2) { if (st) { st.textContent = "网络抖动，重试 " + (attempt + 1) + "/2…"; st.className = "status"; } await new Promise((r2) => setTimeout(r2, 1500)); }
      else { if (st) { st.textContent = "搜索失败: " + e.message; st.className = "status err"; } }
    }
  }
}

function bindKeywordSearch() {
  $("#kwSearchBtn").addEventListener("click", keywordSearch);
  $("#kwInput").addEventListener("keydown", (e) => { if (e.key === "Enter") keywordSearch(); });

  // ---- 2026-08-27 用户要求：搜索页「选角色」——从香蕉网获取角色列表（同设置页手动添加映射的机制，仓库目录写死"角色"）----
  const roleInput = $("#kwRoleInput");
  const roleCombo = $("#kwRoleCombo");
  let kwRoleChars = [];
  // 选游戏后加载角色列表（照搬设置页 loadGbCharacters，独立存 kwRoleChars）
  $("#searchGameSelect").addEventListener("change", async () => {
    const game = $("#searchGameSelect").value;
    if (!game) { roleInput.disabled = true; roleInput.value = ""; kwRoleChars = []; return; }
    roleInput.disabled = false;
    roleInput.placeholder = "加载角色…";
    const st = $("#kwStatus");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await api("/api/gb-characters?game=" + encodeURIComponent(game));
        if (!r.ok) throw new Error(r.error || "获取失败");
        kwRoleChars = r.characters || [];
        roleInput.placeholder = "输入过滤，如 Od → Odette";
        if (st) { st.textContent = `已加载 ${kwRoleChars.length} 个角色${r.fromCache ? "（缓存）" : ""}（选角色后自动搜索；设置页可手动刷新）`; st.className = "status ok"; }
        return;
      } catch (e) {
        if (attempt === 0) { if (st) { st.textContent = "获取角色列表失败，重试…"; st.className = "status"; } await new Promise((r2) => setTimeout(r2, 1200)); }
        else { if (st) { st.textContent = "获取角色列表失败: " + e.message; st.className = "status err"; } roleInput.placeholder = "加载失败，可手动输入"; }
      }
    }
  });
  // 自绘过滤下拉（照搬设置页 renderCombo）
  function renderRoleCombo(filter) {
    const q = String(filter || "").trim().toLowerCase();
    const matched = q ? kwRoleChars.filter((c) => c.toLowerCase().includes(q)) : kwRoleChars;
    const shown = matched.slice(0, 20);
    if (!shown.length) { roleCombo.innerHTML = '<div class="combo-empty">无匹配角色</div>'; roleCombo.style.display = "block"; return; }
    roleCombo.innerHTML = shown.map((c) => `<div class="combo-item" data-v="${esc(c)}">${esc(c)}</div>`).join("");
    roleCombo.style.display = "block";
  }
  roleInput.addEventListener("focus", () => { if (!roleInput.disabled) renderRoleCombo(roleInput.value); });
  roleInput.addEventListener("input", () => renderRoleCombo(roleInput.value));
  roleInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      const items = document.querySelectorAll("#kwRoleCombo .combo-item");
      if (items.length) { e.preventDefault(); const cur = document.querySelector("#kwRoleCombo .combo-item.hover") || items[0]; cur.classList.remove("hover"); (cur.nextElementSibling || items[0]).classList.add("hover"); }
    } else if (e.key === "ArrowUp") {
      const items = document.querySelectorAll("#kwRoleCombo .combo-item");
      if (items.length) { e.preventDefault(); const cur = document.querySelector("#kwRoleCombo .combo-item.hover") || items[0]; cur.classList.remove("hover"); (cur.previousElementSibling || items[items.length - 1]).classList.add("hover"); }
    } else if (e.key === "Enter") {
      const cur = document.querySelector("#kwRoleCombo .combo-item.hover");
      if (cur) { e.preventDefault(); roleInput.value = cur.dataset.v; roleCombo.style.display = "none"; pickRole(cur.dataset.v); }
    } else if (e.key === "Escape") {
      roleCombo.style.display = "none";
    }
  });
  document.addEventListener("click", (e) => {
    const item = e.target.closest && e.target.closest("#kwRoleCombo .combo-item");
    if (item) { roleInput.value = item.dataset.v; roleCombo.style.display = "none"; pickRole(item.dataset.v); return; }
    if (!e.target.closest("#kwRoleInput") && !e.target.closest("#kwRoleCombo")) roleCombo.style.display = "none";
  });
  // 选中角色 → 填入关键词并自动搜索（英文名直接搜，含变体合并）
  function pickRole(name) {
    $("#kwInput").value = name;
    keywordSearch();
  }
}

function startSearchPoll() {
  if (searchPollTimer) clearInterval(searchPollTimer);
  // 防重入：上一次请求未返回时跳过本次（原实现无标志，慢响应会堆叠请求）
  let inFlight = false;
  searchPollTimer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await api("/api/search-status");
      const t = r.task;
      if (!t) return;
      if (t.status === "running") {
        $("#searchStatus").textContent = t.message + "（后台运行中）";
      } else {
        clearInterval(searchPollTimer);
        searchPollTimer = null;
        $("#searchBtn").disabled = false;
        $("#stopSearchBtn").style.display = "none";
        $("#searchStatus").textContent = t.message;
        $("#searchStatus").className = "status ok";
      }
      if (t.results) {
        searchResults = t.results;
        renderSearchResults();
      }
    } catch (_) {}
    finally { inFlight = false; }
  }, 2000);
}

function renderSearchResults() {
  $("#resultCount").textContent = `共 ${searchResults.length} 个`;
  if (!searchResults.length) {
    $("#searchResultList").innerHTML = '<div class="empty">暂无结果</div>';
    return;
  }
  $("#searchResultList").innerHTML = searchResults.map((it) => `
    <div class="result-item">
      <input type="checkbox" id="cb-${it.modId}">
      <span class="badge ${it.isNsfw ? "nsfw" : "normal"}">${it.isNsfw ? "NSFW" : "普通"}</span>
      <span class="name"><a href="${esc(it.profileUrl)}" target="_blank">${esc(it.name)}</a></span>
      <span class="meta">${esc(it.game)} · ${esc(it.author)}</span>
      <span class="meta">${(() => { const a = fmtTs(it.dateAdded); return a !== "-" ? a : fmtTs(it.dateUpdated); })()}</span>
    </div>`).join("");
}

// ---------- 下载进度 ----------
function bindProgress() {
  // 2026-08-26 修复：暂停/继续/停止后立即刷新列表（不等 2s 轮询）+ 停止清空列表
  async function refreshTask() {
    try {
      const t = await api("/api/task");
      renderTask(t.task);
    } catch (_) {}
  }
  $("#pauseBtn").addEventListener("click", async () => {
    const r = await api("/api/task/pause", "POST", {});
    if (r && r.ok) refreshTask();
  });
  $("#resumeBtn").addEventListener("click", async () => {
    const r = await api("/api/task/resume", "POST", {});
    if (r && r.ok) refreshTask();
  });
  $("#stopBtn").addEventListener("click", async () => {
    if (!confirm("确定终止下载吗？已下载的文件会保留。")) return;
    const r = await api("/api/task/stop", "POST", {});
    if (r && r.ok) {
      refreshTask(); // 立即刷新（task=null → 列表清空显示"暂无任务"）
    }
  });
  $("#retryBtn").addEventListener("click", async () => {
    const r = await api("/api/task/retry-failed", "POST", {});
    if (r && r.ok) { if (r.message) alert(r.message); try { const t = await api("/api/task"); renderTask(t.task); } catch (_) {} }
    else alert((r && r.error) || "重试失败");
  });
  // 2026-08-26 用户要求加回：一键清除下载失败（失败项标记跳过，前端立即消失）
  $("#clearFailBtn").addEventListener("click", async () => {
    const r = await api("/api/skip-all-failed", "POST", {});
    if (r && r.ok) { if (r.skipped > 0 && r.message) alert(r.message); try { const t = await api("/api/task"); renderTask(t.task); } catch (_) {} }
    else alert((r && r.error) || "清除失败失败");
  });
  // 2026-08-26 用户要求加回：失败行 🔄重试 / 🚫跳过 按钮（事件委托）
  document.addEventListener("click", async (ev) => {
    const retryBtn = ev.target.closest(".mm-retry-btn");
    if (retryBtn) {
      ev.preventDefault();
      const r = await api("/api/task/retry-failed", "POST", {});
      if (r && r.ok) { if (r.message) alert(r.message); try { const t = await api("/api/task"); renderTask(t.task); } catch (_) {} }
      else alert((r && r.error) || "重试失败");
      return;
    }
    const skipBtn = ev.target.closest(".mm-skip-btn");
    if (skipBtn) {
      ev.preventDefault();
      const r = await api("/api/skip", "POST", { url: skipBtn.dataset.url, path: skipBtn.dataset.path });
      if (r && r.ok) { try { const t = await api("/api/task"); renderTask(t.task); } catch (_) {} }
      else alert((r && r.error) || "跳过失败");
      return;
    }
  });
  // 2026-08-26 修复：应用并发数按钮——照搜索的反馈模式（状态文字 + 按钮禁用恢复 + 成功/失败）
  $("#concurrencyBtn").addEventListener("click", async () => {
    const btn = $("#concurrencyBtn");
    const input = $("#concurrencyInput");
    const st = $("#concurrencyStatus");
    const v = parseInt(input.value, 10);
    if (!v || v < 1) { if (st) { st.textContent = "并发数无效（至少 1）"; st.className = "status err"; } return; }
    btn.disabled = true;
    btn.textContent = "应用中…";
    if (st) { st.textContent = "应用并发数…"; st.className = "status"; }
    try {
      const r = await api("/api/task/concurrency", "POST", { concurrency: v });
      if (r && r.ok) {
        input.value = r.concurrency;
        if (st) { st.textContent = "✅ 并发数已设为 " + r.concurrency; st.className = "status ok"; }
        // 立即拉最新任务刷新显示
        try {
          const t = await api("/api/task");
          if (t && t.task) renderTask(t.task);
        } catch (_) {}
      } else {
        if (st) { st.textContent = "应用失败：" + ((r && r.error) || "未知错误"); st.className = "status err"; }
      }
    } catch (e) {
      if (st) { st.textContent = "应用失败：" + (e.message || String(e)); st.className = "status err"; }
    } finally {
      btn.disabled = false;
      btn.textContent = "应用";
    }
  });
  // 2026-08-27 找回模式开关：开启后不实际下载，只归位/找回；仅无任务时可控制
  const rmToggle = $("#restoreModeToggle");
  if (rmToggle) {
    const rmHint = $("#restoreModeHint");
    window.__setRestoreModeDisabled = (task) => {
      const busy = task && (task.status === "running" || task.status === "paused" || task.status === "preparing" || task.status === "done");
      rmToggle.disabled = !!busy;
      if (rmHint) {
        if (rmToggle.disabled) rmHint.textContent = "有任务进行中/已暂停，停止或完成后才能修改";
        else rmHint.textContent = rmToggle.checked ? "当前开启：需下载的项会直接跳过（只找回/归位）" : "当前关闭：正常下载";
      }
    };
    const applyRm = (on) => {
      rmToggle.checked = on;
      if (rmHint) {
        rmHint.textContent = on ? "当前开启：需下载的项会直接跳过（只找回/归位）" : "当前关闭：正常下载";
        rmHint.style.color = on ? "#c62828" : "";
      }
    };
    api("/api/task/restore-mode").then((r) => { if (r && r.ok) applyRm(r.restoreOnly); }).catch(() => {});
    rmToggle.addEventListener("change", async () => {
      if (rmToggle.disabled) { rmToggle.checked = !rmToggle.checked; return; }
      const on = rmToggle.checked;
      try {
        const r = await api("/api/task/restore-mode", "POST", { enabled: on });
        if (r && r.ok) applyRm(r.restoreOnly);
        else { applyRm(!on); if (rmHint) rmHint.textContent = "保存失败：" + ((r && r.error) || "未知错误"); }
      } catch (e) {
        applyRm(!on);
        if (rmHint) rmHint.textContent = "保存失败：" + (e.message || String(e));
      }
    });
  }
  startTaskPoll();
}

// 2026-08-26 及时反馈：顶部浮动提示（2.5s 自动消失）
function showFeedback(msg, type) {
  let el = $("#feedbackToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "feedbackToast";
    el.style.cssText = "position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 20px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity .3s";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = type === "ok" ? "#1e7d32" : "#c62828";
  el.style.color = "#fff";
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = "0"; }, 2500);
}

function startTaskPoll() {
  if (taskPollTimer) clearInterval(taskPollTimer);
  // 防重入：上一次请求未返回时跳过本次
  let inFlight = false;
  taskPollTimer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const r = await api("/api/task");
      renderTask(r.task);
    } catch (_) {}
    finally { inFlight = false; }
  }, 2000);
}

function fmtSpeed(s) {
  if (!s || s <= 0) return "";
  return s >= 1048576 ? (s / 1048576).toFixed(2) + " MB/s" : Math.round(s / 1024) + " KB/s";
}

// 2026-08-26 优化（用户反馈：网页刷新下载进度每次重新加载半天）：
//   renderTask 每次 2 秒轮询都全量遍历 items 分组 + 重渲染 DOM（任务几百上千项时卡顿）。
//   加分组指纹缓存：items/resultsMap 未变化时直接复用上次的 taskList HTML。
let __renderTaskCache = { fingerprint: "", html: "" };

function renderTask(task) {
  const stateText = { running: "下载中", preparing: "准备中", done: "已完成", paused: "已暂停", stopped: "已终止", error: "出错" };
  $("#taskState").textContent = task ? (stateText[task.status] || task.status) : "无任务";
  // 2026-08-27：找回模式开关——有任务时禁用
  if (window.__setRestoreModeDisabled) window.__setRestoreModeDisabled(task);
  if (!task) {
    $("#progressFill").style.width = "0%";
    $("#taskMeta").textContent = "尚未开始下载";
    $("#activeList").innerHTML = "";
    $("#taskList").innerHTML = '<div class="empty">暂无任务</div>';
    $("#pauseBtn").disabled = true;
    $("#resumeBtn").disabled = true;
    $("#stopBtn").disabled = true;
    $("#retryBtn").disabled = true;
    // 2026-08-26 无任务时也显示 config 持久化的并发数
    if (settings && settings.downloadConcurrency) {
      const ci = $("#concurrencyInput");
      if (ci && document.activeElement !== ci) ci.value = settings.downloadConcurrency;
    }
    return;
  }

  // 2026-08-26 修复：doneMap 必须在使用前声明（stuckOrFailed 先引用会 TDZ ReferenceError
  //   → renderTask 每次抛错被轮询 catch 吞掉 → 前端不显示、后台正常——用户反馈的根因）
  const doneMap = task.resultsMap || {};

  // 2026-08-26 修复：失败项 + 卡住项（无结果且任务已结束）都可重试 → 全局重试按钮启用判定
  const stuckOrFailed = (task.items || []).some((it, i) => {
    if (!it || !it.path) return false;
    const rr = doneMap[i];
    return (rr && !rr.ok && !rr.skipped) || (!rr && task.status !== "running" && task.status !== "preparing");
  });
  $("#retryBtn").disabled = !stuckOrFailed;
  const itemsLen = (task.items || []).length;
  const rmKeys = Object.keys(task.resultsMap || {}).map(Number);
  const rmMax = rmKeys.length ? Math.max(...rmKeys) + 1 : 0;
  const total = Math.max(itemsLen, rmMax, task.doneCount || 0, (task.results || []).length);
  const done = task.doneCount != null ? task.doneCount : (task.currentIndex || 0);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $("#progressFill").style.width = pct + "%";

  const doneValues = Object.values(task.resultsMap || {});
  const okCount = doneValues.filter((r) => r && r.ok && !r.skipped).length;
  const skipCount = doneValues.filter((r) => r && r.skipped).length;
  const failCount = doneValues.filter((r) => r && !r.ok).length;
  let metaText = `${done}/${total} 项 | 成功 ${okCount} | 失败 ${failCount}`;
  if (skipCount) metaText += ` | 跳过 ${skipCount}`;
  $("#taskMeta").textContent = metaText + (task.message ? " ｜ " + task.message : "");

  const activeEl = $("#activeList");
  if (task.status === "running" || task.status === "preparing") {
    const preparing = task.preparingItem;
    const active = task.activeItems || [];
    let html = "";
    // 2026-08-26：准备阶段也展示（status=preparing 时同样显示准备进度 + 当前解析的 mod）
    if (preparing && preparing.name) {
      const prepCount = `${(task.buildIndex || 0) + 1}/${(task.pendingMods || []).length}`;
      html += `<div class="item" style="padding:4px 8px;background:var(--card2)"><span class="icon">⏳</span><span>准备 ${prepCount}: ${esc(preparing.name)}</span></div>`;
    } else if (task.status === "preparing" && (task.pendingMods || []).length) {
      const prepCount = `${(task.buildIndex || 0)}/${(task.pendingMods || []).length}`;
      html += `<div class="item" style="padding:4px 8px;background:var(--card2)"><span class="icon">⏳</span><span>准备中（${prepCount}）…</span></div>`;
    }
    if (active.length) {
      html += `<div class="hint" style="margin:4px 0">⬇ 进行中（${active.length} 线程）:</div>`;
      active.forEach((a) => {
        const fromHtml = a.modName ? ` <span class="hint">· 来自 ${esc(a.modName)}</span>` : "";
        const spd = a.speed ? ` <span class="status-text">⚡ ${fmtSpeed(a.speed)}</span>` : "";
        html += `<div class="item" style="padding:4px 8px;background:rgba(59,130,246,.08)"><span class="icon">${typeIcon(a.type)}</span><span>${esc(a.name)}${fromHtml}</span>${spd}</div>`;
      });
    }
    activeEl.innerHTML = html || "";
  } else {
    activeEl.innerHTML = "";
  }

  $("#pauseBtn").disabled = !(task.status === "running" || task.status === "preparing");
  $("#resumeBtn").disabled = !(task.status === "paused");
  $("#stopBtn").disabled = !(task.status === "running" || task.status === "preparing" || task.status === "paused");
  if (task.concurrency && document.activeElement !== $("#concurrencyInput")) $("#concurrencyInput").value = task.concurrency;

  if (task.status === "stopped") {
    $("#taskList").innerHTML = '<div class="empty">已终止</div>';
    return;
  }

  // 2026-08-26 优化：分组指纹缓存——items/resultsMap/status 未变则复用上次 HTML，避免全量重渲染
  const fp = (task.items || []).length + ":" + Object.keys(task.resultsMap || {}).length + ":" + (task.doneCount || 0) + ":" + (task.status || "");
  if (__renderTaskCache.fingerprint === fp && __renderTaskCache.html !== "") {
    $("#taskList").innerHTML = __renderTaskCache.html;
    return;
  }

  const groups = [];
  const groupMap = new Map();
  (task.items || []).forEach((item, idx) => {
    const key = item.modUrl || item.modName || item.targetDir || "(未知)";
    if (!groupMap.has(key)) {
      const g = { key, targetDir: item.targetDir || "", items: [] };
      groupMap.set(key, g);
      groups.push(g);
    }
    groupMap.get(key).items.push({ item, idx });
  });
  const resultOf = (idx) => (doneMap[idx] != null ? doneMap[idx] : (idx < (task.results || []).length ? task.results[idx] : null));  // 正在下载项的实时进度（idx -> {received,total,speed}）——每行文件进度条用
  const activeMap = {};
  (task.activeItems || []).forEach((a) => {
    if (a && a.idx != null) activeMap[a.idx] = { received: a.received || 0, total: a.total || 0, speed: a.speed || 0 };
  });
  // 2026-08-26 用户要求：每组 mod 一组出现在下载列表，整组下载完才从任务列表移除；
  //   组内还有未处理(下载中/准备) → 整组显示全部行（各带状态）；
  //   全部处理完但含失败 → 只留失败行（可 🔄重试 / 🚫跳过）；
  //   全成功/全跳过 → 整组移除不再显示
  const visibleGroups = groups.filter((g) => {
    const hasPending = g.items.some(({ idx }) => resultOf(idx) == null);
    if (hasPending) { g.keptRows = g.items; return true; }
    const failed = g.items.filter(({ idx }) => {
      const r = resultOf(idx);
      return r && r.ok === false && !r.skipped;
    });
    if (failed.length) { g.keptRows = failed; return true; }
    return false;
  });
  const html = visibleGroups.map((g, gi) => {
    const rows = (g.keptRows || g.items).map(({ item, idx }) => {
      let cls = "pending", icon = typeIcon(item.type), statusText = typeLabel(item.type);
      const r = resultOf(idx);
      if (r) {
        if (r.skipped) { cls = "ok"; icon = "⏭"; statusText = r.exists ? "已存在（跳过）" : "已忽略"; }
        else if (r.ok) { cls = "ok"; icon = "✓"; statusText = "成功"; }
        else { cls = "fail"; icon = "✗"; statusText = r.error || "失败"; }
      }
      // 2026-08-26 用户要求加回：失败行 🔄重试 / 🚫跳过 按钮；
      //   2026-08-26 修复：卡住行（无结果且任务非运行中）也显示按钮（重试/跳过后才能处理它）
      let actBtns = "";
      const canAct = r ? (r.ok === false && !r.skipped) : (task.status !== "running" && task.status !== "preparing");
      if (canAct && item.path) {
        actBtns = ` <button class="mm-retry-btn" data-url="${esc(item.url || "")}" data-path="${esc(item.path || "")}" title="重试下载此文件">🔄 重试</button>` +
          ` <button class="mm-skip-btn" data-url="${esc(item.url || "")}" data-path="${esc(item.path || "")}" title="跳过此文件（下次请求可再下载）">🚫 跳过</button>`;
      }
      // 2026-08-26 用户要求：跳过的图片也显示预览图（已存在/已下载的图片项都显示缩略图）
      const hasFile = r && (r.ok || (r.skipped && r.exists)) && item.path;
      const isImgOk = item.type === "image" && !item.isGif && hasFile;
      const thumb = isImgOk ? `<img class="row-thumb" src="/api/image?path=${encodeURIComponent(item.path)}" loading="lazy" alt="${esc(item.displayName || "")}">` : "";
      // 每行文件进度条：成功100%绿 / 下载中实时蓝 / 失败100%红 / 未开始0%
      let barPct = 0, barCls = "row-bar-pending";
      if (r) {
        if (r.ok) { barPct = 100; barCls = "row-bar-ok"; }
        else { barPct = 100; barCls = "row-bar-fail"; }
      } else if (activeMap[idx]) {
        const ap = activeMap[idx];
        barPct = ap.total > 0 ? Math.min(100, Math.round((ap.received / ap.total) * 100)) : 0;
        barCls = "row-bar-active";
        if (ap.speed) statusText += ` ⚡${fmtSpeed(ap.speed)}`;
      }
      const bar = `<span class="row-bar ${barCls}"><span class="row-bar-fill" style="width:${barPct}%"></span></span>`;
      return `<div class="item ${cls}"><span class="icon">${icon}</span><span class="item-name">${esc(item.displayName || item.path || item.url || "")}${bar}</span><span class="status-text">${esc(statusText)}${actBtns}</span>${thumb}</div>`;
    }).join("");
    return `<div class="mod-group">
      <div class="mod-group-head"><span class="group-num">${gi + 1}.</span><span>${esc(g.key)}</span><span class="mod-group-dir">📁 ${esc(g.targetDir)}</span></div>
      ${rows}
    </div>`;
  }).join("");
  __renderTaskCache.fingerprint = (task.items || []).length + ":" + Object.keys(task.resultsMap || {}).length + ":" + (task.doneCount || 0) + ":" + (task.status || "");
  __renderTaskCache.html = html || '<div class="empty">暂无任务</div>';
  $("#taskList").innerHTML = html || '<div class="empty">暂无任务</div>';
}

// ---------- 主题切换（2026-08-26 用户要求：蓝白=白天模式，香蕉风深色=夜间模式）----------
function bindTheme() {
  const btn = $("#themeBtn");
  const apply = () => {
    const night = document.documentElement.getAttribute("data-theme") === "night";
    btn.textContent = night ? "☀️ 白天" : "🌙 夜间";
    try { localStorage.setItem("gbmd-theme", night ? "night" : "day"); } catch (_) {}
  };
  btn.addEventListener("click", () => {
    const night = document.documentElement.getAttribute("data-theme") === "night";
    if (night) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", "night");
    apply();
  });
  apply();
}

// ---------- 设置 ----------
function makeRootRow(name, entry) {
  const div = document.createElement("div");
  div.className = "grid-map-row";
  const cn = (entry && entry.cn) || "";
  const id = (entry && entry.id) || "";
  const p = (entry && entry.downloadPath) || "";
  div.innerHTML = `
    <input class="root-game" value="${esc(name)}" readonly style="background:var(--card2);max-width:200px">
    <input class="root-cn" value="${esc(cn)}" readonly style="background:var(--card2);max-width:90px">
    <input class="root-id" value="${esc(id)}" readonly style="background:var(--card2);max-width:70px">
    <input class="root-path" placeholder="下载路径根目录（如 /volume6/.../Mods/）" value="${esc(p)}" style="flex:1">
    <button class="ghost browse-btn" type="button" title="读取本地选择目录">📂</button>`;
  // 2026-08-26 用户要求：设置里设置下载地址增加「读取本地选择」——点 📂 弹目录选择器
  div.querySelector(".browse-btn").addEventListener("click", () => openBrowse(div.querySelector(".root-path")));
  return div;
}

// ---------- 目录选择弹窗（读取本地选择）----------
let browseTargetInput = null;
function openBrowse(input) {
  browseTargetInput = input;
  $("#browseMask").style.display = "flex";
  $("#browseHint").textContent = "";
  loadBrowse("/");
}
async function loadBrowse(p) {
  const el = $("#browsePath");
  el.textContent = "读取中…";
  let r;
  try { r = await api("/api/browse?path=" + encodeURIComponent(p)); }
  catch (e) { el.textContent = "读取失败: " + e.message; return; }
  if (!r || !r.ok) { el.textContent = (r && r.error) || "读取失败"; return; }
  el.textContent = r.path;
  $("#browseSelect").dataset.path = r.path;
  let html = "";
  if (r.parent) html += `<div class="browse-item" data-path="${esc(r.parent)}">⬆ 上级目录</div>`;
  if (!r.dirs.length) html += '<div class="hint">（无子目录）</div>';
  r.dirs.forEach((d) => {
    const full = r.path === "/" ? "/" + d : r.path + "/" + d;
    html += `<div class="browse-item" data-path="${esc(full)}">📁 ${esc(d)}</div>`;
  });
  $("#browseList").innerHTML = html;
  $("#browseList").querySelectorAll(".browse-item").forEach((el2) => {
    el2.addEventListener("click", () => loadBrowse(el2.dataset.path));
  });
}
function bindBrowse() {
  $("#browseClose").addEventListener("click", () => { $("#browseMask").style.display = "none"; });
  $("#browseMask").addEventListener("click", (e) => { if (e.target === $("#browseMask")) $("#browseMask").style.display = "none"; });
  $("#browseSelect").addEventListener("click", () => {
    const p = $("#browseSelect").dataset.path || "";
    if (browseTargetInput && p) { browseTargetInput.value = p; $("#browseMask").style.display = "none"; }
  });
}

function renderGamesRows() {
  const wrap = $("#rootMapRows");
  wrap.innerHTML = "";
  const games = (typeof window.__games === "object" && window.__games) || {};
  for (const [name, entry] of Object.entries(games)) {
    wrap.appendChild(makeRootRow(name, entry));
  }
}

function bindSettings() {
  // 保存下载路径
  $("#saveGamesBtn").addEventListener("click", async () => {
    const games = {};
    document.querySelectorAll("#rootMapRows .grid-map-row").forEach((row) => {
      const name = row.querySelector(".root-game").value.trim();
      const cn = row.querySelector(".root-cn").value.trim();
      const id = row.querySelector(".root-id").value.trim();
      const p = row.querySelector(".root-path").value.trim();
      if (!name) return;
      games[name] = { cn, id: id ? Number(id) : 0, downloadPath: p };
    });
    try {
      const r = await api("/api/games", "POST", { games });
      if (!r.ok) throw new Error(r.error || "保存失败");
      window.__games = r.games;
      renderGamesRows();
      $("#gamesStatus").textContent = "已保存到 json/gamebanana.com.json";
      $("#gamesStatus").className = "status ok";
    } catch (e) {
      $("#gamesStatus").textContent = "保存失败：" + e.message;
      $("#gamesStatus").className = "status err";
    }
  });

  // 2026-08-26 用户要求：输入香蕉网 id 添加游戏，游戏名自动获取
  $("#fetchGameBtn").addEventListener("click", async () => {
    const id = parseInt($("#addGameId").value, 10);
    const st = $("#addGameStatus");
    if (!id || id <= 0) { st.textContent = "请输入香蕉网游戏 id"; st.className = "status err"; return; }
    st.textContent = "获取中…"; st.className = "status";
    try {
      const r = await api("/api/gb-game-info?id=" + id);
      if (!r.ok) throw new Error(r.error || "获取失败");
      window.__addGameInfo = r.info;
      $("#addGameName").textContent = `游戏名：${r.info.name}（香蕉网 id ${id}）`;
      $("#addGamePreview").style.display = "flex";
      st.textContent = "";
    } catch (e) {
      st.textContent = "获取失败: " + e.message;
      st.className = "status err";
    }
  });
  $("#addGameConfirmBtn").addEventListener("click", async () => {
    const info = window.__addGameInfo;
    const st = $("#addGameStatus");
    if (!info) return;
    const games = { ...(window.__games || {}) };
    games[info.name] = { id: info.id, cn: info.name, downloadPath: "" };
    try {
      const r = await api("/api/games", "POST", { games });
      if (!r.ok) throw new Error(r.error || "添加失败");
      window.__games = r.games;
      renderGamesRows();
      st.textContent = `已添加「${info.name}」（下载路径请在下方填写后保存）`;
      st.className = "status ok";
      $("#addGamePreview").style.display = "none";
      $("#addGameId").value = "";
    } catch (e) {
      st.textContent = "添加失败: " + e.message;
      st.className = "status err";
    }
  });

  $("#saveSettingsBtn").addEventListener("click", async () => {
    // 2026-08-26 用户要求：设置里不要并发数（只在「下载进度」页改并发）——payload 只存 gbCookie
    const payload = {
      gbCookie: $("#gbCookie").value.trim()
    };
    try {
      const r = await api("/api/settings", "POST", payload);
      if (!r.ok) throw new Error(r.error || "保存失败");
      settings = r.settings;
      $("#settingsStatus").textContent = "已保存";
      $("#settingsStatus").className = "status ok";
    } catch (e) {
      $("#settingsStatus").textContent = "保存失败：" + e.message;
      $("#settingsStatus").className = "status err";
    }
  });

  $("#gbLoginCheckBtn").addEventListener("click", checkGbLoginStatus);
  checkGbLoginStatus();

  $("#changePwdBtn").addEventListener("click", async () => {
    const pwd = $("#newPwd").value;
    if (pwd.length < 4) { $("#pwdStatus").textContent = "密码至少 4 位"; return; }
    try {
      const r = await api("/api/change-password", "POST", { password: pwd });
      if (!r.ok) throw new Error(r.error || "修改失败");
      $("#pwdStatus").textContent = "密码已修改";
      $("#pwdStatus").className = "status ok";
      $("#newPwd").value = "";
    } catch (e) {
      $("#pwdStatus").textContent = e.message;
      $("#pwdStatus").className = "status err";
    }
  });

  // ---- 数据备份/恢复（2026-08-31 用户要求：zip 导出/导入全部用户数据）----
  $("#exportDataBtn").addEventListener("click", async () => {
    const st = $("#dataStatus");
    st.textContent = "正在导出…";
    st.className = "status";
    try {
      const r = await fetch("/api/data/export");
      if (r.status === 401) { location.href = "/login.html"; return; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "导出失败"); }
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "gbmd-userdata-" + new Date().toISOString().slice(0, 10) + ".zip";
      a.click();
      URL.revokeObjectURL(a.href);
      st.textContent = "✅ 已导出用户数据 zip（含全部清单文件）";
      st.className = "status ok";
    } catch (e) {
      st.textContent = "导出失败: " + (e && e.message || e);
      st.className = "status err";
    }
  });

  $("#importDataBtn").addEventListener("click", () => { $("#importDataFile").click(); });
  $("#importDataFile").addEventListener("change", async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    const st = $("#dataStatus");
    if (!file) return;
    st.textContent = "正在导入 " + file.name + " …";
    st.className = "status";
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      if (!b64) throw new Error("读取文件失败");
      const r = await api("/api/data/import", "POST", { data: b64 });
      if (!r.ok) throw new Error(r.error || "导入失败");
      st.textContent = `✅ 导入完成：恢复 ${r.restored.length} 个文件，跳过 ${r.skipped.length} 个` + (r.note ? "。" + r.note : "");
      st.className = "status ok";
    } catch (e) {
      st.textContent = "导入失败: " + (e && e.message || e);
      st.className = "status err";
    } finally {
      ev.target.value = "";
    }
  });

  // ---- HTML 反查（2026-08-26：hash md5 或图片原始短名都支持）----
  // 三表：本地表命中（source=local）→ 有实际落盘路径；GB 表命中（source=gb）→ 仅线上信息；
  //       HTML 表命中（source=html）→ 按 GB 原名（图片短名/压缩包名）从 description.html 反查
  async function hashQuery() {
    const h = String($("#hashInput").value || "").trim();
    const st = $("#hashStatus"), res = $("#hashResult");
    if (!h) { st.textContent = "请输入 hash 或图片短名"; st.className = "status err"; return; }
    st.className = "status";
    st.textContent = "查询中…";
    try {
      const r = await api("/api/hash-query?hash=" + encodeURIComponent(h));
      if (!r.ok) throw new Error(r.error || "查询失败");
      if (!r.found) {
        st.textContent = "未找到（试试：压缩包 GB 页面 MD5 / 图片原始短名如 69b46e18405cc.jpg，或先「重建索引」）";
        st.className = "status err";
        res.innerHTML = "";
        return;
      }
      const isLocal = r.source === "local";
      const srcLabel = isLocal ? "✅ 本地表命中" : (r.source === "html" ? "ℹ️ HTML 表命中（按 GB 原名反查）" : "ℹ️ GB 表命中（此 mod 未在本机下载）");
      st.textContent = srcLabel + "（" + (r.file.kind === "image" ? "图片" : "文件") + "）";
      st.className = isLocal ? "status ok" : "status";
      const rel = (r.modDir || "").split("/").slice(-4).join("/");
      res.innerHTML =
        '<div class="mm-mis">📦 <b>' + esc(r.mod.name) + '</b> by ' + esc(r.mod.author) +
        (r.mod.game ? "（" + esc(r.mod.game) + "）" : "") +
        (r.mod.modId ? " [mods/" + esc(r.mod.modId) + "]" : "") + "</div>" +
        '<div class="hint">🔗 <a href="' + esc(r.mod.url || "") + '" target="_blank">' + esc(r.mod.url || "") + "</a></div>" +
        (isLocal ? '<div class="hint">📁 本地目录：<code>' + esc(rel) + "</code></div>" : "") +
        '<div class="hint">文件：<code>' + esc(r.file.name || "") + "</code>" +
        (r.file.gbMd5 ? "（MD5: <code>" + esc(r.file.gbMd5) + "</code>）" : "") + "</div>" +
        (!isLocal && r.mod.url
          ? '<div class="row mt"><button id="hashDlBtn" type="button" class="primary">⬇ 下载此 mod</button><span class="hint" id="hashDlStatus"></span></div>'
          : "");
      // GB 表命中 → 提供「下载此 mod」
      const dlBtn = $("#hashDlBtn");
      if (dlBtn) {
        dlBtn.addEventListener("click", async () => {
          const ds = $("#hashDlStatus");
          if (ds) { ds.textContent = "已提交下载…"; ds.className = "status"; }
          try {
            const rr = await api("/api/download", "POST", { links: [r.mod.url] });
            if (!rr.ok) throw new Error(rr.error || "提交失败");
            if (ds) { ds.textContent = "✅ 已加入下载（见「下载进度」页）"; ds.className = "status ok"; }
            dlBtn.disabled = true;
          } catch (e) {
            if (ds) { ds.textContent = "失败: " + e.message; ds.className = "status err"; }
          }
        });
      }
    } catch (e) {
      st.textContent = "查询失败: " + e.message;
      st.className = "status err";
    }
  }
  const hq = $("#hashQueryBtn");
  if (hq) hq.addEventListener("click", hashQuery);
  const hi = $("#hashInput");
  if (hi) hi.addEventListener("keydown", (e) => { if (e.key === "Enter") hashQuery(); });
  const hr = $("#hashRebuildBtn");
  if (hr) hr.addEventListener("click", async () => {
    const st = $("#hashStatus");
    st.className = "status";
    st.textContent = "后台重建两张表（GB 信息表 + 本地表）…（可继续查询旧索引）";
    try {
      const r = await api("/api/hash-rebuild", "POST", {});
      if (!r.ok) throw new Error(r.error || "启动失败");
      // 轮询直到完成
      const poll = async () => {
        const s = await api("/api/hash-index-status");
        if (s && s.running) { setTimeout(poll, 1500); return; }
        st.textContent = "✅ 索引已重建：GB 表 " + (s ? s.gb : "?") + " 条，本地表 " + (s ? s.local : "?") + " 条（" + (s ? s.htmls : "?") + " 个 HTML）";
        st.className = "status ok";
      };
      setTimeout(poll, 1200);
    } catch (e) {
      st.textContent = "重建失败: " + e.message;
      st.className = "status err";
    }
  });
  // 展示双表状态
  api("/api/hash-index-status").then((s) => {
    if (s && s.ok) {
      const st = $("#hashStatus");
      if (st) {
        st.textContent = "索引：GB 表 " + (s.gb || 0) + " 条 / 本地表 " + (s.local || 0) + " 条" + (s.running ? "，重建中…" : "");
        st.className = "status";
      }
    }
  }).catch(() => {});

  // ---- GB 表模糊搜索（2026-08-26 用户要求：离线 mod 目录，按 mod 名/作者查）----
  async function hashSearch() {
    const q = String($("#hashSearchInput").value || "").trim();
    const st = $("#hashSearchStatus"), res = $("#hashSearchResult");
    if (q.length < 2) { st.textContent = "关键词至少 2 个字符"; st.className = "status err"; return; }
    st.className = "status";
    st.textContent = "搜索中…";
    try {
      const r = await api("/api/hash-index-search?q=" + encodeURIComponent(q));
      if (!r.ok) throw new Error(r.error || "搜索失败");
      if (!r.count) {
        st.textContent = "GB 表中无匹配（试试其他关键词，或先「重建索引」覆盖全部已下载 mod）";
        st.className = "status";
        res.innerHTML = "";
        return;
      }
      st.textContent = "✅ 命中 " + r.count + " 个 mod（GB 表）";
      st.className = "status ok";
      res.innerHTML = r.results.map((m) =>
        '<div class="mm-mis">📦 <b>' + esc(m.modName) + '</b> by ' + esc(m.author) +
        (m.game ? "（" + esc(m.game) + "）" : "") +
        (m.hasLocal ? ' <span class="badge" style="background:#2e7d32">已下载</span>' : ' <span class="badge" style="background:#888">未下载</span>') +
        ' <span class="hint">' + m.fileCount + " 个文件</span></div>" +
        '<div class="row" style="margin:2px 0 8px 0"><a class="hint" href="' + esc(m.url || "") + '" target="_blank">' + esc(m.url || "") + "</a>" +
        (!m.hasLocal && m.url
          ? '<button class="ghost" data-dl="' + esc(m.url) + '" style="margin-left:8px">⬇ 下载</button>'
          : "") + "</div>"
      ).join("");
      // 下载按钮委托
      res.querySelectorAll("button[data-dl]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          btn.textContent = "提交中…";
          try {
            const rr = await api("/api/download", "POST", { links: [btn.dataset.dl] });
            if (!rr.ok) throw new Error(rr.error || "提交失败");
            btn.textContent = "✅ 已加入下载";
          } catch (e) { btn.textContent = "失败: " + e.message; btn.disabled = false; }
        });
      });
    } catch (e) {
      st.textContent = "搜索失败: " + e.message;
      st.className = "status err";
    }
  }
  const hss = $("#hashSearchBtn");
  if (hss) hss.addEventListener("click", hashSearch);
  const hsi = $("#hashSearchInput");
  if (hsi) hsi.addEventListener("keydown", (e) => { if (e.key === "Enter") hashSearch(); });
}

async function checkGbLoginStatus() {
  const el = $("#gbLoginStatus");
  const btn = $("#gbLoginCheckBtn");
  if (!el) return;
  el.className = "status";
  el.textContent = "检测中…";
  if (btn) btn.disabled = true;
  try {
    const r = await api("/api/gb-login-status");
    if (r && r.ok && r.loggedIn) {
      el.textContent = `✅ ${r.detail || "已登录"}`;
      el.className = "status ok";
    } else if (r && r.ok && r.configured) {
      el.textContent = `⚠️ ${r.detail || "未登录"}`;
      el.className = "status err";
    } else {
      el.textContent = "○ 未配置 gbCookie（浏览器登录 gamebanana.com 后复制完整 cookie）";
      el.className = "status";
    }
  } catch (e) {
    el.textContent = "检测失败: " + (e.message || String(e));
    el.className = "status err";
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadSettings() {
  try {
    const r = await api("/api/settings");
    settings = r.settings;
    // 2026-08-26 用户要求：设置里不要并发数（只在「下载进度」页改）——不再回填 dlConcurrency
    $("#gbCookie").value = settings.gbCookie || "";
  } catch (_) {}
  try {
    const g = await api("/api/games");
    if (g.ok && g.games) {
      window.__games = g.games;
      renderGamesRows();
    }
  } catch (_) {}
}

// ---------- 文件夹合并 ----------
let mergePlan = [];
async function mergeRolesPreview() {
  const game = $("#mmGameSelect").value;
  const st = $("#mmMergeStatus");
  if (!game) { st.textContent = "请先选择游戏"; st.className = "status err"; return; }
  st.textContent = "扫描角色目录…";
  st.className = "status";
  const d = await api("/api/merge-roles", "POST", { dryRun: true, game });
  const el = $("#mmMergePlan");
  if (!d || !d.ok) { st.textContent = "失败: " + ((d && d.error) || "未知"); st.className = "status err"; return; }
  mergePlan = d.merged || [];
  st.textContent = `发现 ${d.groups} 组可合并角色目录（${mergePlan.length} 个将归一到标准「英文 – 中文」，变体目录并入标准目录）`;
  st.className = "status ok";
  el.innerHTML = mergePlan.length
    ? mergePlan.map((m) => `<div class="mm-mis">🔀 ${esc(m.from.split("/Mods/")[1] || m.from)} → <b>${esc(m.to.split("/Mods/")[1] || m.to)}</b></div>`).join("")
    : '<div class="hint">无需要合并的角色目录</div>';
}
async function mergeRolesRun() {
  if (!mergePlan.length) { alert("请先「预览合并计划」"); return; }
  if (!confirm(`执行合并：${mergePlan.length} 个目录归一为「英文 – 中文」（变体目录并入标准目录；同角色已有规范目录则并入，空目录进 .trash）？`)) return;
  const game = $("#mmGameSelect").value;
  const st = $("#mmMergeStatus");
  st.textContent = "合并中…";
  st.className = "status";
  const d = await api("/api/merge-roles", "POST", { dryRun: false, game });
  if (!d || !d.ok) { st.textContent = "失败: " + ((d && d.error) || "未知"); st.className = "status err"; return; }
  st.textContent = `合并完成：${(d.merged || []).length} 个目录，${(d.skipped || []).length} 跳过，${(d.trashed || []).length} 进回收站`;
  st.className = "status ok";
  $("#mmMergePlan").innerHTML = "";
  mergePlan = [];
}

// ---------- 清空空文件夹（2026-08-31 用户要求：空壳/仅含HTML也算，选游戏，带被清目录预览）----------
let emptyPlan = [];
async function emptyDirsPreview() {
  const game = $("#mmEmptyGame").value;
  const st = $("#mmEmptyStatus");
  if (!game) { st.textContent = "请先选择游戏"; st.className = "status err"; return; }
  st.textContent = "扫描空文件夹…";
  st.className = "status";
  const d = await api("/api/cleanup-empty-dirs", "POST", { dryRun: true, game });
  const el = $("#mmEmptyPlan");
  if (!d || !d.ok) { st.textContent = "失败: " + ((d && d.error) || "未知"); st.className = "status err"; return; }
  emptyPlan = (d.cleared || []).map((m) => m.dir);
  st.textContent = `发现 ${emptyPlan.length} 个空文件夹（空壳/仅含HTML，预览见下）`;
  st.className = "status ok";
  el.innerHTML = emptyPlan.length
    ? emptyPlan.map((dir) => `<div class="mm-mis">🗑 ${esc((dir || "").split("/Mods/")[1] || dir)}</div>`).join("")
    : '<div class="hint">没有空文件夹</div>';
}
async function emptyDirsRun() {
  if (!emptyPlan.length) { alert("请先「预览待清空」"); return; }
  if (!confirm(`确认清空 ${emptyPlan.length} 个空文件夹（空壳/仅含HTML，进游戏根 .trash 可恢复）？`)) return;
  const game = $("#mmEmptyGame").value;
  const st = $("#mmEmptyStatus");
  st.textContent = "清空中…";
  st.className = "status";
  const d = await api("/api/cleanup-empty-dirs", "POST", { dryRun: false, game });
  if (!d || !d.ok) { st.textContent = "失败: " + ((d && d.error) || "未知"); st.className = "status err"; return; }
  st.textContent = `已清空：${(d.cleared || []).length} 个，跳过 ${(d.skipped || []).length} 个（已进 .trash 可恢复）`;
  st.className = "status ok";
  $("#mmEmptyPlan").innerHTML = "";
  emptyPlan = [];
}

function bindMerge() {
  $("#mmMergeBtn").addEventListener("click", mergeRolesPreview);
  $("#mmMergeGoBtn").addEventListener("click", mergeRolesRun);

  // ---- 2026-08-31 用户要求：清空空文件夹（空壳/仅含HTML也算，选游戏，带预览）----
  $("#mmEmptyBtn").addEventListener("click", emptyDirsPreview);
  $("#mmEmptyGoBtn").addEventListener("click", emptyDirsRun);

  // ---- 2026-08-26 用户要求：手动添加映射（选游戏/仓库 → 从香蕉网获取角色列表 → 写入 mapping JSON）----
  // 级联（2026-08-26 用户要求）：先选游戏 → 才能选仓库；先选仓库 → 才能选角色（英文名）
  $("#mmAddGame").addEventListener("change", async () => {
    const game = $("#mmAddGame").value;
    const wh = $("#mmAddWarehouse");
    const en = $("#mmAddEn"), zh = $("#mmAddZh");
    // 未选游戏：仓库/角色禁用
    if (!game) {
      wh.disabled = true; en.disabled = true; zh.disabled = true;
      wh.innerHTML = '<option value="">— 请先选择游戏 —</option>';
      en.value = ""; zh.value = "";
      return;
    }
    wh.disabled = false;
    en.disabled = true; zh.disabled = true; en.value = ""; zh.value = "";
    wh.innerHTML = '<option value="">— 加载中 —</option>';
    try {
      const r = await api("/api/gb-warehouses?game=" + encodeURIComponent(game));
      if (!r.ok) throw new Error(r.error || "获取失败");
      wh.innerHTML = '<option value="">— 请选择仓库 —</option>' +
        (r.warehouses || []).map((w) =>
          `<option value="${esc(w.name)}">${esc(w.name)}${w.type === "characters" && w.from ? "（来自" + esc(w.from) + "）" : ""}${w.local && w.type !== "characters" ? "（" + esc(w.local) + "）" : ""}</option>`).join("");
      // 2026-08-26：选完游戏即预加载角色列表（英文名下拉数据先就绪，选了仓库立即可用）
      loadGbCharacters();
    } catch (e) {
      wh.innerHTML = '<option value="">— 获取失败 —</option>';
    }
  });
  $("#mmAddWarehouse").addEventListener("change", () => {
    const en = $("#mmAddEn"), zh = $("#mmAddZh");
    if (!$("#mmAddWarehouse").value) { en.disabled = true; zh.disabled = true; en.value = ""; return; }
    en.disabled = false; zh.disabled = false; // 选了仓库才能选角色/填中文
    loadGbCharacters();
  });
  // 选仓库（角色等）→ 获取角色列表填入英文名下拉（2026-08-27：默认读 JSON 缓存，force=true 强制重新获取）
  async function loadGbCharacters(force) {
    const game = $("#mmAddGame").value;
    const st = $("#mmAddStatus");
    if (!game) return;
    if (st) { st.textContent = force ? "从香蕉网重新获取角色列表…" : "加载角色列表…"; st.className = "status"; }
    const qs = "/api/gb-characters?game=" + encodeURIComponent(game) + (force ? "&refresh=1" : "");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await api(qs);
        if (!r.ok) throw new Error(r.error || "获取失败");
        window.__gbChars = r.characters || [];
        if (st) {
          st.textContent = force
            ? `已重新获取并保存 ${window.__gbChars.length} 个角色（json/role-cache.json）`
            : `已加载 ${window.__gbChars.length} 个角色${r.fromCache ? "（缓存）" : "（新获取）"}（英文名输入时过滤选择，如 Od → Odette）`;
          st.className = "status ok";
        }
        return;
      } catch (e) {
        if (attempt === 0) { if (st) { st.textContent = "网络抖动，重试…"; st.className = "status"; } await new Promise((r2) => setTimeout(r2, 1200)); }
        else if (st) { st.textContent = "获取失败: " + e.message; st.className = "status err"; }
      }
    }
  }
  // 2026-08-27 用户要求：设置页「重新获取角色」按钮——强制从香蕉网拉取并保存 JSON
  $("#mmRefreshChars").addEventListener("click", () => {
    if (!$("#mmAddGame").value) { const st = $("#mmAddStatus"); if (st) { st.textContent = "请先选择游戏"; st.className = "status err"; } return; }
    loadGbCharacters(true);
  });
  // 可搜索角色下拉（自绘，最多显示 20 条，输入过滤）
  function renderCombo(filter) {
    const list = window.__gbChars || [];
    const el = $("#mmComboList");
    const q = String(filter || "").trim().toLowerCase();
    const matched = q
      ? list.filter((c) => c.toLowerCase().includes(q))
      : list;
    const shown = matched.slice(0, 20);
    if (!shown.length) { el.innerHTML = '<div class="combo-empty">无匹配角色</div>'; el.style.display = "block"; return; }
    el.innerHTML = shown.map((c) => `<div class="combo-item" data-v="${esc(c)}">${esc(c)}</div>`).join("");
    el.style.display = "block";
  }
  $("#mmAddEn").addEventListener("focus", () => { if (!$("#mmAddEn").disabled) renderCombo($("#mmAddEn").value); });
  $("#mmAddEn").addEventListener("input", () => renderCombo($("#mmAddEn").value));
  $("#mmAddEn").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      const items = document.querySelectorAll("#mmComboList .combo-item");
      if (items.length) { e.preventDefault(); const cur = document.querySelector("#mmComboList .combo-item.hover") || items[0]; cur.classList.remove("hover"); (cur.nextElementSibling || items[0]).classList.add("hover"); }
    } else if (e.key === "ArrowUp") {
      const items = document.querySelectorAll("#mmComboList .combo-item");
      if (items.length) { e.preventDefault(); const cur = document.querySelector("#mmComboList .combo-item.hover") || items[0]; cur.classList.remove("hover"); (cur.previousElementSibling || items[items.length - 1]).classList.add("hover"); }
    } else if (e.key === "Enter") {
      const cur = document.querySelector("#mmComboList .combo-item.hover");
      if (cur) { e.preventDefault(); $("#mmAddEn").value = cur.dataset.v; $("#mmComboList").style.display = "none"; }
    } else if (e.key === "Escape") {
      $("#mmComboList").style.display = "none";
    }
  });
  document.addEventListener("click", (e) => {
    const item = e.target.closest && e.target.closest(".combo-item");
    if (item) { $("#mmAddEn").value = item.dataset.v; $("#mmComboList").style.display = "none"; return; }
    if (!e.target.closest || !e.target.closest("#mmAddEn")) $("#mmComboList").style.display = "none";
  });
  $("#mmAddWarehouse").addEventListener("change", loadGbCharacters);
  $("#mmAddGame").addEventListener("change", () => { window.__gbChars = []; $("#mmComboList").style.display = "none"; });

  // 添加映射
  $("#mmAddBtn").addEventListener("click", async () => {
    const game = $("#mmAddGame").value;
    const en = $("#mmAddEn").value.trim();
    const zh = $("#mmAddZh").value.trim();
    const st = $("#mmAddStatus");
    if (!game || !en || !zh) { if (st) { st.textContent = "请选择游戏并填写英文名/中文名"; st.className = "status err"; } return; }
    try {
      const r = await api("/api/mapping/add-role", "POST", { game, en, zh });
      if (!r.ok) throw new Error(r.error || "添加失败");
      if (st) { st.textContent = `已添加：${en} → ${zh}（已写入 mapping/${game}.json）`; st.className = "status ok"; }
      $("#mmAddEn").value = "";
      $("#mmAddZh").value = "";
    } catch (e) {
      if (st) { st.textContent = "添加失败: " + e.message; st.className = "status err"; }
    }
  });
}

// ---------- 退出 ----------
function bindLogout() {
  $("#logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", "POST", {});
    location.href = "/login.html";
  });
}

// ---------- 启动 ----------
async function init() {
  try {
    const st = await api("/api/status");
    // 2026-08-26 用户要求：未设置密码 → 不强制跳 setup，直接可用（页面顶部警告）
    if (st.needsSetup) {
      const w = $("#noPwdWarn");
      if (w) w.style.display = "block";
      // 未设密码时隐藏退出按钮（没有登录态概念）
      const lb = $("#logoutBtn");
      if (lb) lb.style.display = "none";
    } else if (st.needsAuth) {
      // 已设密码但未登录 → 登录页
      const s = await api("/api/settings");
      if (!s.ok) { location.href = "/login.html"; return; }
    }
  } catch (_) {}
  bindTabs();
  bindBatch();
  bindSearch();
  bindKeywordSearch();
  bindProgress();
  bindSettings();
  bindBrowse();
  bindMerge();
  bindTheme();
  bindLogout();
  // 2026-08-26 修复：刷新后并发数显示 config 持久化值（无任务时 input 回填 downloadConcurrency）
  try {
    const sr = await api("/api/settings");
    if (sr && sr.ok && sr.settings && sr.settings.downloadConcurrency) {
      const ci = $("#concurrencyInput");
      if (ci && document.activeElement !== ci) ci.value = sr.settings.downloadConcurrency;
    }
  } catch (_) {}
  loadGameSelects();
  await loadSettings();
  try {
    // 2026-08-26 恢复显示最近一次搜索结果（用户要求：重启后恢复显示，不被覆盖）
    const c = await api("/api/search/cache");
    if (c.cache && c.cache.results && c.cache.results.length) {
      searchResults = c.cache.results;
      renderSearchResults();
    }
    // 恢复「搜索正在后台运行」的状态：若 search-status 是 running 才继续轮询
    const st = await api("/api/search-status");
    if (st.task && st.task.status === "running") {
      $("#searchBtn").disabled = true;
      $("#stopSearchBtn").style.display = "inline-block";
      startSearchPoll();
    }
  } catch (_) {}
  setInterval(() => {
    $("#serverTime").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
  }, 1000);
}

init();
