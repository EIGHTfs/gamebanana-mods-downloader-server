// ============================================================
// gbmd-v3 - 按时间搜索 mod（自旧项目保留）
// 三时间字段（added/modified/updated）OR 逻辑，1 页/秒，
// 当某页三字段全部早于 startTs 时提前终止。
// 游戏 id 从 json/gamebanana.com.json 读取。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const { fetchOnePage, processPageRecords } = require("./gb-api");
const cfg = require("../config");

const QUERY_FILE = path.join(__dirname, "..", "search_task.json");
const CACHE_FILE = path.join(__dirname, "..", "search_cache.json");

const MAX_PAGES_PER_GAME = 600;
const MAX_RESULTS = 5000;
const PAGE_INTERVAL_MS = 1000;

let queryTask = null;
let queryRunning = false;

function saveQueryTask() {
  try { fs.writeFileSync(QUERY_FILE, JSON.stringify(queryTask, null, 2), "utf8"); } catch (_) {}
}

function saveCache(explicit) {
  try {
    // 2026-08-26：支持显式传入完整 cache（importCache 手动导入时用，避免 queryTask 为空时写空覆盖）
    const data = explicit || {
      results: (queryTask && queryTask.results) || [],
      startDate: queryTask ? queryTask.startDate : "",
      endDate: queryTask ? queryTask.endDate : "",
      contentFilter: (queryTask && queryTask.contentFilter) || ["normal", "nsfw"],
      queryTime: Date.now()
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), "utf8");
  } catch (_) {}
}

function loadQueryTaskFromDisk() {
  try {
    if (fs.existsSync(QUERY_FILE)) queryTask = JSON.parse(fs.readFileSync(QUERY_FILE, "utf8"));
  } catch (_) {}
  return queryTask;
}

function getQueryTask() { return queryTask; }

function getCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (_) {}
  return null;
}

async function startSearchTask({ games, startDate, endDate, contentFilter, startTs, endTs }) {
  if (queryRunning && queryTask && queryTask.status === "running") {
    throw new Error("已有搜索任务在进行中");
  }
  queryTask = {
    status: "running",
    games: games.slice(),
    gameIndex: 0,
    gameId: 0,
    page: 1,
    startDate, endDate,
    contentFilter: contentFilter || ["normal", "nsfw"],
    startTs, endTs,
    results: [],
    skippedGames: [],
    message: "开始搜索…",
    startedAt: Date.now(),
    updatedAt: Date.now()
  };
  // 定位第一个可识别游戏
  while (queryTask.gameIndex < queryTask.games.length && !queryTask.gameId) {
    const g = queryTask.games[queryTask.gameIndex];
    const gid = cfg.gameIdOf(g);
    if (gid) {
      queryTask.gameId = gid;
      queryTask.page = 1;
    } else {
      queryTask.skippedGames.push(g);
      queryTask.gameIndex++;
    }
  }
  if (queryTask.gameIndex >= queryTask.games.length) {
    queryTask.status = "done";
    queryTask.message = "没有可识别的游戏";
  }
  saveQueryTask();
  runQueryLoop();
  return queryTask;
}

async function runQueryLoop() {
  if (queryRunning) return;
  queryRunning = true;
  try { await doQueryLoop(); }
  finally { queryRunning = false; }
}

async function doQueryLoop() {
  if (!queryTask || queryTask.status !== "running") return;
  try {
    while (queryTask.status === "running") {
      const gameName = queryTask.games[queryTask.gameIndex] || "";
      const page = queryTask.page;
      const gameId = queryTask.gameId;

      const ac = new AbortController();
      queryTask.abortCtl = ac;
      let records, hasMore;
      try {
        ({ records, hasMore } = await fetchOnePage(gameId, page, ac.signal));
      } finally {
        if (queryTask.abortCtl === ac) queryTask.abortCtl = null;
      }
      const { results: pageResults, shouldStop } = processPageRecords(
        records, queryTask.startTs, queryTask.endTs, queryTask.contentFilter, gameName
      );

      queryTask.results = (queryTask.results || []).concat(pageResults);
      if (queryTask.results.length > MAX_RESULTS) {
        queryTask.results = queryTask.results.slice(0, MAX_RESULTS);
      }

      const gameDone =
        shouldStop || !hasMore || page >= MAX_PAGES_PER_GAME || queryTask.results.length >= MAX_RESULTS;

      if (gameDone) {
        queryTask.gameIndex++;
        queryTask.gameId = 0;
        queryTask.page = 1;
        while (queryTask.gameIndex < queryTask.games.length && !queryTask.gameId) {
          const g = queryTask.games[queryTask.gameIndex];
          const gid = cfg.gameIdOf(g);
          if (gid) { queryTask.gameId = gid; queryTask.page = 1; }
          else { queryTask.skippedGames.push(g); queryTask.gameIndex++; }
        }
        if (queryTask.gameIndex >= queryTask.games.length) queryTask.status = "done";
      } else {
        queryTask.page++;
      }

      queryTask.message = `已找到 ${queryTask.results.length} 个`;
      queryTask.updatedAt = Date.now();
      saveQueryTask();
      saveCache();

      if (queryTask.status === "done") {
        queryTask.message = `查询完成，共 ${queryTask.results.length} 个`;
        saveQueryTask();
        break;
      }

      await new Promise((r) => setTimeout(r, PAGE_INTERVAL_MS));
    }
  } catch (e) {
    if (queryTask) {
      if (queryTask.status === "done") {
        queryTask.updatedAt = Date.now();
        saveQueryTask();
        return;
      }
      queryTask.status = "error";
      queryTask.message = "搜索出错: " + (e.message || String(e));
      queryTask.updatedAt = Date.now();
      saveQueryTask();
    }
  }
}

function stopSearch() {
  if (queryTask && queryTask.status === "running") {
    queryTask.status = "done";
    queryTask.message = "已手动停止";
    queryTask.updatedAt = Date.now();
    if (queryTask.abortCtl) {
      try { queryTask.abortCtl.abort(); } catch (_) {}
      queryTask.abortCtl = null;
    }
    saveQueryTask();
  }
  return { ok: true };
}

// 2026-08-26 用户要求：导出搜索记录（配合手动导入，备份/迁移用）
// 返回完整 cache：{ results, startDate, endDate, contentFilter, queryTime, importedAt }
function exportCache() {
  return getCache() || { results: [], startDate: "", endDate: "", contentFilter: ["normal", "nsfw"], queryTime: 0 };
}

// 2026-08-26 用户要求：手动导入搜索记录（上传 JSON 文件）
// 合并进 search_cache.json：按 modId 去重，**导入的覆盖原有的**（同名 modId 用导入数据替换），
// 新 modId 追加。保存后刷新页面/恢复显示时会展示合并后的记录，不被后续新搜索覆盖。
function importCache(records) {
  if (!Array.isArray(records) || !records.length) {
    return { ok: false, error: "没有有效的搜索记录（需为 JSON 数组）" };
  }
  // 校验 + 规范化字段
  const norm = [];
  const seen = new Set();
  let bad = 0;
  for (const r of records) {
    const modId = String((r && (r.modId || r.id)) || "").trim();
    if (!modId) { bad++; continue; }
    if (seen.has(modId)) continue; // 导入文件内部去重（第一个为准）
    seen.add(modId);
    norm.push({
      modId,
      name: String((r && (r.name || r.modName || r._sName)) || ""),
      author: String((r && (r.author || (r._aSubmitter && r._aSubmitter._sName))) || ""),
      game: String((r && (r.game || r.gameName)) || ""),
      profileUrl: String((r && (r.profileUrl || r.url)) || (modId ? `https://gamebanana.com/mods/${modId}` : "")),
      dateAdded: Number((r && (r.dateAdded || r._tsDateAdded)) || 0) || 0,
      dateModified: Number((r && (r.dateModified || r._tsDateModified)) || 0) || 0,
      dateUpdated: Number((r && (r.dateUpdated || r._tsDateUpdated)) || 0) || 0,
      isNsfw: !!(r && (r.isNsfw || r.nsfw))
    });
  }
  if (!norm.length) return { ok: false, error: "导入文件中没有带 modId 的有效记录" };

  // 合并进现有 cache：导入的覆盖原有的
  const cache = getCache() || { results: [], startDate: "", endDate: "", contentFilter: ["normal", "nsfw"], queryTime: 0 };
  const existing = (cache.results || []).slice();
  const idxMap = new Map();
  existing.forEach((r, i) => { if (r && r.modId) idxMap.set(String(r.modId), i); });
  let replaced = 0, added = 0;
  for (const r of norm) {
    const i = idxMap.get(String(r.modId));
    if (i !== undefined) { existing[i] = r; replaced++; }
    else { idxMap.set(String(r.modId), existing.length); existing.push(r); added++; }
  }
  cache.results = existing;
  cache.queryTime = Date.now();
  cache.importedAt = Date.now();
  saveCache(cache);
  return { ok: true, added, replaced, total: existing.length };
}

function clearCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch (_) {}
  return { ok: true };
}

// 2026-08-31 用户要求：保存搜索结果（覆盖写入 search_cache.json）
//   保存功能作用（用户原话）：「搜索结果覆盖写入 search_cache.json」
function saveRecords(results) {
  const list = Array.isArray(results) ? results : [];
  // 规范化关键字段（与 importCache 一致），保证后续恢复显示/下载可用
  const norm = [];
  for (const r of list) {
    const modId = String((r && (r.modId || r.id)) || "").trim();
    if (!modId) continue;
    norm.push({
      modId,
      name: String((r && (r.name || r.modName || r._sName)) || ""),
      author: String((r && (r.author || (r._aSubmitter && r._aSubmitter._sName))) || ""),
      game: String((r && (r.game || r.gameName)) || ""),
      profileUrl: String((r && (r.profileUrl || r.url)) || (modId ? `https://gamebanana.com/mods/${modId}` : "")),
      dateAdded: Number((r && (r.dateAdded || r._tsDateAdded)) || 0) || 0,
      dateModified: Number((r && (r.dateModified || r._tsDateModified)) || 0) || 0,
      dateUpdated: Number((r && (r.dateUpdated || r._tsDateUpdated)) || 0) || 0,
      isNsfw: !!(r && (r.isNsfw || r.nsfw))
    });
  }
  const cache = getCache() || { results: [], startDate: "", endDate: "", contentFilter: ["normal", "nsfw"], queryTime: 0 };
  cache.results = norm;
  cache.queryTime = Date.now();
  saveCache(cache);
  return { ok: true, total: norm.length };
}

function restorePendingQuery() {
  loadQueryTaskFromDisk();
  if (queryTask && queryTask.status === "running") runQueryLoop();
}

module.exports = {
  startSearchTask,
  getQueryTask,
  getCache,
  stopSearch,
  clearCache,
  importCache,
  exportCache,
  saveRecords,
  restorePendingQuery
};
