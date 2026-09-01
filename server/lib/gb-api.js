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
  const r = await fetchJsonHeaders(url, opts, retries);
  return r.json;
}

// 2026-09-01 带响应头的 fetch（解析 Set-Cookie 拿 rmc 过期时间等）。返回 { json, setCookies: [] }。
async function fetchJsonHeaders(url, opts = {}, retries = 3) {
  // 2026-09-01 UA 改为读 config 的 gbUserAgent（默认 Edge）——GameBanana 会话绑定登录浏览器 UA，
  // 用普通 Chrome UA 会被判定为未登录；此 UA 同时用于登录检测与 NSFW 下载。
  const configUa = String(cfg.readConfig().gbUserAgent || "").trim();
  const headers = Object.assign({
    Accept: "application/json",
    "User-Agent": configUa || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
  }, opts.headers || {});
  const cookie = opts.cookie !== undefined ? opts.cookie : configCookie();
  if (cookie) headers.Cookie = cookie;
  let setCookies = [];
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
      try { setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : []; } catch (_) {}
      return { json: await resp.json(), setCookies };
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
    // 取 variants 项为数组：新规范已是数组；旧规范字符串 → [字符串]
    const arrOf = (v) => (Array.isArray(v) ? v : [v]);
    const isZh = (s) => /[\u4e00-\u9fff]/.test(String(s || ""));
    // 规范中文 → 规范英文（roles 反查）
    const canonEnOf = (zh) => {
      for (const [en, zhv] of Object.entries(roles)) if (String(zhv) === zh) return en;
      return "";
    };
    // 1) variants：key 精确命中
    if (variants[k]) {
      const arr = arrOf(variants[k]);
      if (arr.length === 1 && !isZh(arr[0]) && isZh(k)) {
        // 旧规范：{ 中文: "英文" } → 直接取英文
        return String(arr[0]);
      }
      // 新规范：{ 规范中文: [中文简写..., 英文变体...] } → 返回规范英文
      const ce = canonEnOf(k);
      if (ce) return ce;
      const enHit = arr.find((x) => !isZh(x));
      if (enHit) return enHit;
      return k;
    }
    // 2) k 是某角色的变体（新规范数组内 或 旧规范值）
    for (const [vk, vv] of Object.entries(variants)) {
      const arr = arrOf(vv);
      if (arr.includes(k) || arr.some((x) => String(x).toLowerCase() === String(k).toLowerCase())) {
        if (!isZh(vk)) return vk; // 旧规范值命中：vk=英文 → 已是规范英文
        const ce = canonEnOf(vk);
        if (ce) return ce;
        const enHit = arr.find((x) => !isZh(x));
        return enHit || vk;
      }
    }
    // 3) roles 反向：中文 → 英文
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

// ---------- 按角色/分类浏览（2026-08-27 用户要求）----------
// GB Index API 支持 _aFilters[Generic_Category]=<catId> 过滤（catId 从
//   _aSubCategory._sProfileUrl 的 /mods/cats/<id> 提取）。关键词搜索只按标题匹配，
//   角色分类浏览能拉出该角色全部 mod（如 Jane Doe → cat 30580 → 144 个）。
async function fetchModsByCategory(gameId, catId, page, perpage = 50) {
  const url =
    `${API_BASE}/Index?_nPage=${page}&_nPerpage=${perpage}` +
    `&_aFilters%5BGeneric_Game%5D=${gameId}` +
    `&_aFilters%5BGeneric_Category%5D=${catId}` +
    `&_sSort=Generic_NewAndUpdated`;
  const data = await fetchJson(url, {}, 2);
  const records = Array.isArray(data._aRecords) ? data._aRecords : [];
  return {
    records: records.map((r) => ({
      id: r._idRow,
      name: r._sName || "",
      profileUrl: r._sProfileUrl || ("https://gamebanana.com/mods/" + r._idRow),
      author: (r._aSubmitter && r._aSubmitter._sName) || "",
      isNsfw: isNsfwRecord(r)
    })),
    hasMore: records.length >= perpage
  };
}

// 角色名 → cat ID：翻最新页收集 _aSubCategory（缓存 10 分钟）
const catIdCache = new Map(); // gameId -> { at, map: {roleName: catId} }
const CAT_CACHE_MS = 10 * 60 * 1000;

async function fetchRoleCatIds(gameId) {
  if (!gameId) return {};
  const now = Date.now();
  const hit = catIdCache.get(String(gameId));
  if (hit && now - hit.at < CAT_CACHE_MS) return hit.map;
  const map = {};
  for (let page = 1; page <= 8; page++) {
    try {
      const url =
        `${API_BASE}/Index?_nPage=${page}&_nPerpage=50` +
        `&_aFilters%5BGeneric_Game%5D=${gameId}&_sSort=Generic_NewAndUpdated`;
      const data = await fetchJson(url, {}, 1);
      for (const rec of data._aRecords || []) {
        const sub = rec._aSubCategory;
        if (sub && sub._sName && sub._sProfileUrl) {
          const id = String(sub._sProfileUrl).match(/\/mods\/cats\/(\d+)/);
          if (id && !(sub._sName in map)) map[sub._sName] = id[1];
        }
      }
      if ((data._aRecords || []).length < 50) break;
    } catch (_) { break; }
    await new Promise((r) => setTimeout(r, 350));
  }
  catIdCache.set(String(gameId), { at: now, map });
  return map;
}

// ---------- 游戏角色列表（GB 获取，2026-08-26 用户要求）----------
// 翻该游戏最新若干页 Mod/Index，收集 _aSubCategory（角色/具体项名，如 Sandrone/Odette）；
// 合并本地 mapping roles 的英文 key（补全无近期 mod 的角色）。内存缓存 10 分钟。
const charCache = new Map(); // gameId -> { at, chars: [string] }
const CHAR_PAGE_CAP = 10; // 最多翻 10 页（500 个最新 mod，足够覆盖近期活跃角色）
const CHAR_CACHE_MS = 10 * 60 * 1000;
// 2026-08-27 用户要求：角色列表持久化到 json/role/ 文件夹，每个游戏一个 JSON 文件
//   （文件名 = 游戏名，如 json/role/Genshin Impact.json / json/role/Zenless Zone Zero.json）。
//   搜索页/设置页复用，默认读文件（不用每次翻 GB 页），设置页按钮手动刷新（forceRefresh）。
const CHAR_CACHE_DIR = path.join(__dirname, "..", "..", "json", "role");
const LEGACY_CACHE_FILE = path.join(__dirname, "..", "..", "json", "role-cache.json");

function roleCachePath(gameName) {
  return path.join(CHAR_CACHE_DIR, String(gameName || "unknown").replace(/[\\/:*?"<>|]/g, "_") + ".json");
}
function loadRoleCache(gameName) {
  try {
    const d = JSON.parse(require("fs").readFileSync(roleCachePath(gameName), "utf8"));
    if (d && Array.isArray(d.characters)) return d;
  } catch (_) {}
  // 兼容旧版：单文件 role-cache.json 里的 gameId key / 游戏名 key
  try {
    const legacy = JSON.parse(require("fs").readFileSync(LEGACY_CACHE_FILE, "utf8"));
    return legacy[gameName] || legacy[String(cfg.gameIdOf(gameName))] || null;
  } catch (_) {}
  return null;
}
function saveRoleCache(gameName, obj) {
  try {
    require("fs").mkdirSync(CHAR_CACHE_DIR, { recursive: true });
    require("fs").writeFileSync(roleCachePath(gameName), JSON.stringify({ gameId: obj.gameId, characters: obj.characters, at: obj.at }, null, 2));
  } catch (_) {}
}

async function fetchGameCharacterList(gameId, gameName, forceRefresh) {
  if (!gameId) return [];
  const now = Date.now();
  const gameKey = String(gameName && gameName.trim() ? gameName : gameId);
  // 1) JSON 持久化缓存（默认）：有且未强制刷新 → 直接返回（含本地 mapping 补全）
  const jc = loadRoleCache(gameKey);
  if (!forceRefresh && jc && Array.isArray(jc.characters) && jc.characters.length) {
    // 合并本地 mapping roles（可能后续手动加过角色）
    const merged = new Set(jc.characters);
    try {
      const map = cfg.readGameMapping(gameName);
      for (const en of Object.keys((map && map.roles) || {})) if (en && en.trim().length >= 2) merged.add(en.trim());
    } catch (_) {}
    const list = [...merged].sort((a, b) => a.localeCompare(b, "en"));
    charCache.set(gameKey, { at: now, chars: list });
    return list;
  }
  // 2) 内存缓存（10 分钟）——避免短时间重复翻页
  const hit = charCache.get(gameKey);
  if (!forceRefresh && hit && now - hit.at < CHAR_CACHE_MS) return hit.chars;
  const chars = new Set();
  // 2026-08-30 修复（用户指出：获取角色原名不准——旧实现翻最新 mod 的 _aSubCategory，
  //   会把简写/非官方名混入，如 "Anton" 与 "Anton Ivanov" 并存）：
  //   改用香蕉网官方接口 Mod/Categories——直接拉角色性根分类（Character Skins/Bangboo Skins
  //   等）的官方子分类列表（_sName 即官方角色原名，如 "Anton Ivanov"），A-Z 全量、含空分类。
  try {
    const info = await fetchGameInfo(gameId);
    const roleRoots = ((info && info.roots) || []).filter((r) => /character|skin/i.test(r.name || ""));
    for (const root of roleRoots) {
      try {
        const url = `${API_BASE}/Categories?_idCategoryRow=${root.id}&_sSort=a_to_z&_bShowEmpty=true`;
        const data = await fetchJson(url, {}, 2);
        const cats = (data && data._aRecords) || (Array.isArray(data) ? data : []);
        for (const c of cats || []) {
          const clean = String((c && c._sName) || "").trim();
          if (clean && clean.length >= 2 && !/^(characters|skins|weapons)$/i.test(clean)) chars.add(clean);
        }
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 350));
    }
  } catch (_) {}
  // 本地 mapping roles 英文 key 补全
  try {
    const map = cfg.readGameMapping(gameName);
    for (const en of Object.keys((map && map.roles) || {})) {
      if (en && en.trim().length >= 2) chars.add(en.trim());
    }
  } catch (_) {}
  const list = [...chars].sort((a, b) => a.localeCompare(b, "en"));
  charCache.set(gameKey, { at: now, chars: list });
  // 3) 写回 JSON 持久化（json/role/<游戏名>.json）
  saveRoleCache(gameKey, { gameId, characters: list, at: now });
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
  fetchJsonHeaders,
  extractModId,
  parseProfile,
  resolveMod,
  isNsfwRecord,
  processPageRecords,
  fetchOnePage,
  searchGameBananaMods,
  fetchModsByCategory,
  fetchRoleCatIds,
  normalizeKeyword,
  fetchGameCharacterList,
  fetchGameInfo,
  PAGE_SIZE
};
