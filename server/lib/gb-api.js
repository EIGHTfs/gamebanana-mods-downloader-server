// ============================================================
// gbmd-v3 - GameBanana API 封装（零依赖，Node 18+ 原生 fetch）
// 保留自旧项目：resolveMod（带 gbCookie 才能拿到 NSFW/私密 mod 文件列表）、
// 关键词搜索（Results API）、按时间搜索（Index API）、NSFW 判定。
// 游戏 id 统一从 json/gamebanana.com.json 读取（config 模块）。
// ============================================================
"use strict";

const path = require("path");
const cfg = require("../config");

const API_BASE = "https://gamebanana.com/apiv11/Mod";

// ---------- HTTP 工具 ----------
// GameBanana 登录 cookie（config.json 的 gbCookie），附加到请求头
function configCookie() {
  return String(cfg.readConfig().gbCookie || "").trim();
}

async function fetchJson(url, opts = {}, retries = 3) {
  const headers = Object.assign({
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  }, opts.headers || {});
  const cookie = opts.cookie !== undefined ? opts.cookie : configCookie();
  if (cookie) headers.Cookie = cookie;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 30000);
    const extSignal = opts.signal;
    const onAbort = () => controller.abort();
    if (extSignal) {
      if (extSignal.aborted) controller.abort();
      else extSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const resp = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return await resp.json();
    } catch (e) {
      if (e.name === "AbortError") throw e;
      const netErr = e instanceof TypeError || /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up/i.test(String(e.message || ""));
      const maxAttempts = netErr ? Math.max(retries + 2, 6) : retries;
      if (attempt >= maxAttempts) throw e;
      const delay = netErr ? 1200 * Math.pow(2, attempt) : 800 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      if (attempt >= maxAttempts) throw e;
    } finally {
      clearTimeout(timer);
      if (extSignal) extSignal.removeEventListener("abort", onAbort);
    }
  }
}

// 支持完整链接（https://gamebanana.com/mods/704164）或纯数字（704164）
function extractModId(url) {
  const s = String(url || "").trim();
  const m = s.match(/mods\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

// ---------- 解析 mod ----------
function parseProfile(profile, modId) {
  const author = (profile._aSubmitter && profile._aSubmitter._sName) || "";
  const game = (profile._aGame && profile._aGame._sName) || "";
  const gameId = (profile._aGame && profile._aGame._idRow) || 0;
  const category = (profile._aCategory && profile._aCategory._sName) || "";
  const superCategory = (profile._aSuperCategory && profile._aSuperCategory._sName) || "";

  const images = [];
  const imgs = (profile._aPreviewMedia && profile._aPreviewMedia._aImages) || [];
  for (const img of imgs) {
    if (img._sBaseUrl && img._sFile) {
      images.push({
        type: img._sType || "screenshot",
        url: `${img._sBaseUrl}/${img._sFile}`,
        thumbUrl: img._sFile800
          ? `${img._sBaseUrl}/${img._sFile800}`
          : `${img._sBaseUrl}/${img._sFile}`,
        file: img._sFile
      });
    }
  }

  // 简介文本里的 gif 外链（下载并替换为本地引用）
  const gifs = [];
  const text = profile._sText || "";
  const gifRe = /https?:\/\/[^\s"'<>]+\.gif/gi;
  const gifMatches = text.match(gifRe) || [];
  for (const gifUrl of gifMatches) {
    const clean = gifUrl.replace(/[)"']+$/, "");
    let fname = "";
    try {
      const u = new URL(clean);
      fname = u.pathname.split("/").pop() || "";
    } catch (_) {}
    if (!fname) fname = `gif_${gifs.length + 1}.gif`;
    gifs.push({ url: clean, file: fname });
  }

  // 2026-08-26 用户要求：旧归档版本也要全部下载——GB ProfilePage 的 _aArchivedFiles
  //   记录被替换掉的旧版文件（如 weebovz_..._sfw_7e4c1.rar），下载器一并拉取，
  //   避免用户手里有归档文件却因为「文件名与当前版不同」被跳过/重复下载。
  //   归档文件标记 archived: true（HTML 记录、步骤流程与普通文件一致）。
  const files = (profile._aFiles || []).map((f) => ({
    id: f._idRow,
    file: f._sFile,
    size: f._nFilesize || 0,
    url: f._sDownloadUrl || `https://gamebanana.com/dl/${f._idRow}`,
    md5: f._sMd5Checksum || "",
    description: f._sDescription || "",
    archived: false
  }));
  for (const af of profile._aArchivedFiles || []) {
    // 归档文件可能与当前文件重名（不同版本同文件名）→ 跳过已存在的名字，避免重复
    if (files.some((f) => f.file === af._sFile)) continue;
    files.push({
      id: af._idRow,
      file: af._sFile,
      size: af._nFilesize || 0,
      url: af._sDownloadUrl || `https://gamebanana.com/dl/${af._idRow}`,
      md5: af._sMd5Checksum || "",
      description: af._sDescription || "",
      archived: true
    });
  }

  return {
    modId,
    name: profile._sName || "",
    author,
    game,
    gameId,
    category,
    superCategory,
    text,
    images,
    gifs,
    files,
    profileUrl: profile._sProfileUrl || `https://gamebanana.com/mods/${modId}`,
    dateAdded: profile._tsDateAdded,
    dateModified: profile._tsDateModified,
    version: profile._sVersion || "",
    tags: profile._aTags || [],
    license: profile._sLicense || "",
    credits: profile._aCredits || []
  };
}

async function resolveMod(url) {
  const modId = extractModId(url);
  if (!modId) throw new Error("无效的 Mod 链接：" + url);
  let profile = null;
  let profileErr = null;
  for (let pTry = 0; pTry < 3; pTry++) {
    try {
      profile = await fetchJson(`${API_BASE}/${modId}/ProfilePage`);
      if (profile && typeof profile === "object") { profileErr = null; break; }
      profileErr = new Error("GB ProfilePage 返回异常(非对象): " + url);
    } catch (e) { profileErr = e; }
    await new Promise((r) => setTimeout(r, 600 * (pTry + 1)));
  }
  if (!profile || typeof profile !== "object") throw profileErr || new Error("GB ProfilePage 返回异常: " + url);
  return parseProfile(profile, modId);
}

// ---------- NSFW 判定（保留旧项目实测结论）----------
// hide / warn 或 _bHasContentRatings / _aContentRatings 非空 = NSFW
function isNsfwRecord(rec) {
  if (rec._sInitialVisibility === "hide") return true;
  if (rec._sInitialVisibility === "warn") return true;
  if (rec._bHasContentRatings === true) return true;
  if (rec._aContentRatings && Object.keys(rec._aContentRatings).length > 0) return true;
  return false;
}

// ---------- 关键词归一（中文/变体 → 英文）----------
// 查 mapping/<游戏>.json 的 variants（变体→规范英文）+ roles 反向（中文→英文）
function normalizeKeyword(game, kw) {
  const k = String(kw || "").trim();
  if (!k) return k;
  try {
    const map = cfg.readGameMapping(game);
    if (!map) return k;
    const roles = (map.roles || {});
    const variants = (map.variants || {});
    // 1) variants：key 精确命中 → 规范英文
    if (variants[k]) return String(variants[k]);
    for (const [vk, vv] of Object.entries(variants)) {
      if (String(vv) === k) return k; // 传入已是规范英文，保持原词
    }
    // 2) roles 反向：中文 → 英文
    for (const [en, zh] of Object.entries(roles)) {
      if (String(zh) === k) return en;
    }
  } catch (_) {}
  return k;
}

// keyword search on GameBanana (Results API), paginated
async function searchGameBananaMods(gameId, name, perpage = 50, page = 1) {
  const url =
    `https://gamebanana.com/apiv11/Util/Search/Results?_sSearchString=${encodeURIComponent(name)}` +
    `&_idGameRow=${gameId}&_nPage=${page}&_nPerpage=${perpage}`;
  const data = await fetchJson(url, {}, 2);
  const recs = (data && data._aRecords) || [];
  return recs
    .filter((r) => r._sModelName === "Mod")
    .map((r) => ({
      id: r._idRow,
      name: r._sName,
      profileUrl: r._sProfileUrl,
      author: (r._aSubmitter && r._aSubmitter._sName) || "",
      isNsfw: isNsfwRecord(r)
    }));
}

// ---------- 按时间搜索（Index API）----------
const PAGE_SIZE = 50;

function processPageRecords(records, startTs, endTs, contentFilter, gameName) {
  const out = [];
  let shouldStop = false;
  for (const rec of records) {
    const added = rec._tsDateAdded || 0;
    const modified = rec._tsDateModified || 0;
    const updated = rec._tsDateUpdated || 0;

    if (added < startTs && modified < startTs && updated < startTs) {
      shouldStop = true;
      break;
    }

    const nsfw = isNsfwRecord(rec);
    const wantNormal = contentFilter.includes("normal");
    const wantNsfw = contentFilter.includes("nsfw");
    if (wantNormal && wantNsfw) {
      // 都选：都接受
    } else if (wantNsfw && !nsfw) continue;
    else if (wantNormal && nsfw) continue;
    else if (!wantNormal && !wantNsfw) continue;

    const inRange =
      (added >= startTs && added <= endTs) ||
      (modified >= startTs && modified <= endTs) ||
      (updated >= startTs && updated <= endTs);

    if (inRange) {
      out.push({
        modId: rec._idRow,
        name: rec._sName || "",
        author: (rec._aSubmitter && rec._aSubmitter._sName) || "",
        game: (rec._aGame && rec._aGame._sName) || gameName,
        profileUrl: rec._sProfileUrl || `https://gamebanana.com/mods/${rec._idRow}`,
        dateAdded: added,
        dateModified: modified,
        dateUpdated: updated,
        isNsfw: nsfw
      });
    }
  }
  return { results: out, shouldStop };
}

async function fetchOnePage(gameId, page, signal) {
  const url =
    `${API_BASE}/Index?_nPage=${page}&_nPerpage=${PAGE_SIZE}` +
    `&_aFilters%5BGeneric_Game%5D=${gameId}` +
    `&_sSort=Generic_NewAndUpdated`;
  const data = await fetchJson(url, { signal });
  if (!data || typeof data !== "object") {
    throw new Error("GameBanana 返回异常（空响应）: " + url);
  }
  const records = Array.isArray(data._aRecords) ? data._aRecords : [];
  return { records, hasMore: records.length >= PAGE_SIZE };
}

// ---------- 游戏角色列表（GB 获取，2026-08-26 用户要求）----------
// 翻该游戏最新若干页 Mod/Index，收集 _aSubCategory（角色/具体项名，如 Sandrone/Odette）；
// 合并本地 mapping roles 的英文 key（补全无近期 mod 的角色）。内存缓存 10 分钟。
const charCache = new Map(); // gameId -> { at, chars: [string] }
const CHAR_PAGE_CAP = 10; // 最多翻 10 页（500 个最新 mod，足够覆盖近期活跃角色）
const CHAR_CACHE_MS = 10 * 60 * 1000;

async function fetchGameCharacterList(gameId, gameName) {
  if (!gameId) return [];
  const now = Date.now();
  const hit = charCache.get(String(gameId));
  if (hit && now - hit.at < CHAR_CACHE_MS) return hit.chars;
  const chars = new Set();
  // GB 侧：最新 mod 的角色/子类名（Skins/Characters 大仓库下的子类 = 角色）
  for (let page = 1; page <= CHAR_PAGE_CAP; page++) {
    try {
      const url =
        `${API_BASE}/Index?_nPage=${page}&_nPerpage=50` +
        `&_aFilters%5BGeneric_Game%5D=${gameId}&_sSort=Generic_NewAndUpdated`;
      const data = await fetchJson(url, {}, 1);
      for (const rec of data._aRecords || []) {
        const root = (rec._aRootCategory && rec._aRootCategory._sName) || "";
        const sub = (rec._aSubCategory && rec._aSubCategory._sName) || "";
        if (!sub || !/^(Characters|Skins)$/i.test(String(root).trim())) continue; // 角色性大仓库下的子类
        const clean = sub.trim();
        if (clean && clean.length >= 2 && !/^(characters|skins|weapons)$/i.test(clean)) chars.add(clean);
      }
      if ((data._aRecords || []).length < 50) break;
    } catch (_) { break; }
    await new Promise((r) => setTimeout(r, 350));
  }
  // 本地 mapping roles 英文 key 补全
  try {
    const map = cfg.readGameMapping(gameName);
    for (const en of Object.keys((map && map.roles) || {})) {
      if (en && en.trim().length >= 2) chars.add(en.trim());
    }
  } catch (_) {}
  const list = [...chars].sort((a, b) => a.localeCompare(b, "en"));
  charCache.set(String(gameId), { at: now, chars: list });
  return list;
}

// ---------- 游戏信息 + 根分类（仓库）（2026-08-26 用户要求）----------
// Game/<id>/ProfilePage 的 _aModRootCategories = 香蕉网根分类（仓库），如 Skins/UI/Objects…
// 缓存 10 分钟
const gameInfoCache = new Map(); // gameId -> { at, info }
const GAME_INFO_CACHE_MS = 10 * 60 * 1000;

async function fetchGameInfo(gameId) {
  if (!gameId) return null;
  const now = Date.now();
  const hit = gameInfoCache.get(String(gameId));
  if (hit && now - hit.at < GAME_INFO_CACHE_MS) return hit.info;
  const data = await fetchJson(`https://gamebanana.com/apiv11/Game/${gameId}/ProfilePage`, {}, 1);
  const info = {
    id: gameId,
    name: (data && data._sName) || "",
    roots: ((data && data._aModRootCategories) || []).map((r) => ({
      id: r._idRow,
      name: r._sName || "",
      itemCount: r._nItemCount || 0,
      categoryCount: r._nCategoryCount || 0
    }))
  };
  gameInfoCache.set(String(gameId), { at: now, info });
  return info;
}

module.exports = {
  API_BASE,
  fetchJson,
  extractModId,
  parseProfile,
  resolveMod,
  isNsfwRecord,
  processPageRecords,
  fetchOnePage,
  searchGameBananaMods,
  normalizeKeyword,
  fetchGameCharacterList,
  fetchGameInfo,
  PAGE_SIZE
};
