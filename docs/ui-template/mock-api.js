// ================================================================
// mock-api.js — gbmd 纯前端模板的「模拟后端层」
// ----------------------------------------------------------------
// 作用：让 docs/ui-template/ 在不启动任何后端的情况下也能整页打开、
//       所有按钮/轮询/交互正常走通，只是所有数据都是「空态」。
//
// 为什么单独一个文件？
//   模板 app.js 不定义 api()（见该文件顶部注释），api 由本文件提供，
//   因此「换真实后端」只替换本文件里 api() 与 fetch 接管的实现即可，
//   界面逻辑一行不用改。
//
// 契约说明格式：每个端点注释里写了真实后端应返回的结构，
//   接后端时对照着实现即可。
// ================================================================

"use strict";

// ---- 模拟后端路由表：path 前缀（含 query 时截断）→ 空态响应 ----
// 契约以真实 server/app.js 的响应为准；此处只返回「页面能跑、列表为空」的最小结构。
const MOCK_ROUTES = [
  // ---------- 系统/会话 ----------
  {
    match: (p) => p === "/api/status",
    get: () => ({ ok: true, needsSetup: false, needsAuth: false, version: "template" }),
    note: "真实返回：{ ok, needsSetup, needsAuth } — needsSetup=true 显示未设密码警告；needsAuth=true 且未登录跳登录页",
  },
  {
    match: (p) => p === "/api/settings",
    get: () => ({ ok: true, settings: { gbCookie: "", downloadConcurrency: 3 } }),
    note: "真实返回：{ ok, settings:{ gbCookie, downloadConcurrency, sessionHours?, ... } }",
  },
  {
    match: (p) => p === "/api/login",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok } / { ok:false, error }（POST）",
  },
  {
    match: (p) => p === "/api/logout",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST）",
  },
  {
    match: (p) => p === "/api/change-password",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，body {password}）",
  },

  // ---------- 游戏映射（设置页） ----------
  {
    match: (p) => p === "/api/games",
    get: () => ({ ok: true, games: {} }),
    note: "真实返回：{ ok, games: { 游戏名: { cn, id, downloadPath } } }（GET 读 / POST 存）",
  },
  {
    match: (p) => p.startsWith("/api/browse"),
    get: () => ({ ok: true, path: "/", parent: null, dirs: [] }),
    note: "真实返回：{ ok, path, parent, dirs: [] } — 目录选择弹窗数据",
  },

  // ---------- 搜索 ----------
  {
    match: (p) => p === "/api/search",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，启动后台搜索，进度轮询 /api/search-status）",
  },
  {
    match: (p) => p === "/api/search/stop",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST）",
  },
  {
    match: (p) => p === "/api/search/clear",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST）",
  },
  {
    match: (p) => p === "/api/search/save",
    get: () => ({ ok: true, total: 0 }),
    note: "真实返回：{ ok, total }（POST，搜索结果显示写入 search_cache.json）",
  },
  {
    match: (p) => p === "/api/search/import",
    get: () => ({ ok: true, added: 0, replaced: 0, total: 0 }),
    note: "真实返回：{ ok, added, replaced, total }（POST，body {records}）",
  },
  {
    match: (p) => p === "/api/search/cache",
    get: () => ({ ok: true, cache: { results: [] } }),
    note: "真实返回：{ ok, cache:{ results:[...] } } — 最近一次搜索结果显示",
  },
  {
    match: (p) => p === "/api/search-status",
    get: () => ({ ok: true, task: { status: "idle", message: "无搜索任务", results: [] } }),
    note: "真实返回：{ ok, task:{ status:'running'|'done'|..., message, results } } — 2s 轮询",
  },
  {
    match: (p) => p.startsWith("/api/search/export"),
    get: () => ({ ok: true }),
    blob: () => JSON.stringify([]),
    note: "真实返回：文件流（application/json 下载 gbmd-search-records-*.json）",
  },
  {
    match: (p) => p.startsWith("/api/keyword-search"),
    get: () => ({ ok: true, results: [], normalized: null }),
    note: "真实返回：{ ok, results:[{modId,name,profileUrl,game,author,isNsfw,dateAdded,dateUpdated}], normalized }",
  },

  // ---------- 下载任务（下载进度页） ----------
  {
    match: (p) => p === "/api/download",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，body {links:[...]} 批量下载）",
  },
  {
    match: (p) => p === "/api/download-selected",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，body {items:[...]} 勾选下载）",
  },
  {
    match: (p) => p === "/api/task",
    get: () => ({ ok: true, task: null }),
    note: "真实返回：{ ok, task:{ status, items:[{url,path}], resultsMap:{i:{ok,skipped}}, doneCount, currentIndex, results:[] } | null }",
  },
  {
    match: (p) => p === "/api/task/pause",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST）",
  },
  {
    match: (p) => p === "/api/task/resume",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST）",
  },
  {
    match: (p) => p === "/api/task/stop",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST）",
  },
  {
    match: (p) => p === "/api/task/retry-failed",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok, message? }（POST）",
  },
  {
    match: (p) => p === "/api/task/concurrency",
    get: () => ({ ok: true, concurrency: 3 }),
    note: "真实返回：{ ok, concurrency }（POST，body {concurrency}）",
  },
  {
    match: (p) => p === "/api/task/restore-mode",
    get: () => ({ ok: true, restoreOnly: false }),
    note: "真实返回：{ ok, restoreOnly: bool }（GET 读 / POST 写 body {enabled}）",
  },
  {
    match: (p) => p === "/api/skip-all-failed",
    get: () => ({ ok: true, skipped: 0 }),
    note: "真实返回：{ ok, skipped }（POST，一键清除失败项）",
  },
  {
    match: (p) => p === "/api/skip",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，body {url,path} 单条跳过）",
  },

  // ---------- 香蕉网信息（设置页/搜索页角色下拉） ----------
  {
    match: (p) => p.startsWith("/api/gb-login-status"),
    get: () => ({ ok: true, loggedIn: false, configured: false }),
    note: "真实返回：{ ok, loggedIn, configured, detail? }",
  },
  {
    match: (p) => p.startsWith("/api/gb-game-info"),
    get: () => ({ ok: true, info: { id: 0, name: "（模板无后端）", url: "" } }),
    note: "真实返回：{ ok, info:{ id, name, url } } — 按香蕉网 id 取游戏名",
  },
  {
    match: (p) => p.startsWith("/api/gb-characters"),
    get: () => ({ ok: true, characters: [], fromCache: false }),
    note: "真实返回：{ ok, characters:[英文名], fromCache }（GET ?game=&refresh=1）",
  },
  {
    match: (p) => p.startsWith("/api/gb-warehouses"),
    get: () => ({ ok: true, warehouses: [] }),
    note: "真实返回：{ ok, warehouses:[{name,type,from?,local?}] }（GET ?game=）",
  },

  // ---------- 文件夹合并 / 清空（设置页） ----------
  {
    match: (p) => p === "/api/merge-roles",
    get: () => ({ ok: true, groups: 0, merged: [], skipped: [], trashed: [] }),
    note: "真实返回：{ ok, groups, merged:[{from,to}], skipped, trashed }（POST，body {game, dryRun}）",
  },
  {
    match: (p) => p === "/api/cleanup-empty-dirs",
    get: () => ({ ok: true, cleared: [], skipped: [] }),
    note: "真实返回：{ ok, cleared:[{dir}], skipped }（POST，body {game, dryRun}）",
  },
  {
    match: (p) => p === "/api/mapping/add-role",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，body {game,en,zh} 写 mapping/<game>.json）",
  },

  // ---------- Hash 索引 ----------
  {
    match: (p) => p.startsWith("/api/hash-query"),
    get: () => ({ ok: true, found: false }),
    note: "真实返回：{ ok, found, source:'local'|'gb'|'html', mod:{name,author,game,modId,url}, file:{kind,name,gbMd5}, modDir }",
  },
  {
    match: (p) => p === "/api/hash-rebuild",
    get: () => ({ ok: true }),
    note: "真实返回：{ ok }（POST，后台重建索引，轮询 /api/hash-index-status）",
  },
  {
    match: (p) => p === "/api/hash-index-status",
    get: () => ({ ok: true, running: false, gb: 0, local: 0, htmls: 0 }),
    note: "真实返回：{ ok, running, gb, local, htmls }",
  },
  {
    match: (p) => p.startsWith("/api/hash-index-search"),
    get: () => ({ ok: true, count: 0, results: [] }),
    note: "真实返回：{ ok, count, results:[{modName,author,game,url,hasLocal,fileCount}] }",
  },

  // ---------- 数据备份/恢复 ----------
  {
    match: (p) => p.startsWith("/api/data/export"),
    get: () => ({ ok: true }),
    blob: () => "gbmd-userdata-template-placeholder",
    note: "真实返回：zip 文件流（gbmd-userdata-YYYY-MM-DD.zip）",
  },
  {
    match: (p) => p === "/api/data/import",
    get: () => ({ ok: true, restored: [], skipped: [], note: "模板模式：未真正导入" }),
    note: "真实返回：{ ok, restored:[文件清单], skipped:[...], note? }（POST，body {data: base64}）",
  },
];

// 全局 api()：模板版。签名与真实后端版完全一致（path, method, body）。
// 接真实后端时：把本函数替换成真实 fetch 实现即可（参考模板 app.js 顶部注释）。
async function api(path, method = "GET", body) {
  // 统一加个小延迟，模拟网络往返，让「加载中…」状态可见、轮询节奏真实
  await new Promise((r) => setTimeout(r, 60));
  for (const rt of MOCK_ROUTES) {
    if (rt.match(path)) {
      const data = rt.get ? rt.get() : { ok: true };
      console.info("[mock-api] %s %s →", method, path, rt.note || "", data);
      return data;
    }
  }
  const err = { ok: false, error: "mock-api 未定义该端点: " + path };
  console.warn("[mock-api] 未命中路由", method, path);
  return err;
}

// 接管 /api/ 前缀的原生 fetch，让模板里绕开 api() 的直连调用（导出等）也能走通
const realFetch = window.fetch.bind(window);
window.fetch = async function (url, opts) {
  const path = String(url).split("?")[0];
  for (const rt of MOCK_ROUTES) {
    if (rt.match(path)) {
      const data = rt.get ? rt.get() : { ok: true };
      const status = 200;
      if (rt.blob) {
        return new Response(new Blob([rt.blob()], { type: "application/octet-stream" }), { status });
      }
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
  // 非 /api/ 路径照常放行（模板内一般不会发生）
  return realFetch(url, opts);
};

// 模板标识，供页面/控制台辨认运行在模板模式
window.__GBMD_TEMPLATE__ = true;
console.info("[mock-api] 纯前端模板模式已启用（mock-api.js）——未连接任何后端");