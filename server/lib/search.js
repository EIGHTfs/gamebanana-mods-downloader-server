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

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      results: (queryTask && queryTask.results) || [],
      startDate: queryTask ? queryTask.startDate : "",
      endDate: queryTask ? queryTask.endDate : "",
      contentFilter: (queryTask && queryTask.contentFilter) || ["normal", "nsfw"],
      queryTime: Date.now()
    }), "utf8");
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

function clearCache() {
  try { fs.unlinkSync(CACHE_FILE); } catch (_) {}
  return { ok: true };
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
  restorePendingQuery
};
