// ============================================================
// gbmd-v3 - HTTP 入口（零依赖，自旧项目重构）
// 保留：搜索（关键词/按时间）、下载（四步流程）、设置（读 gamebanana.com.json
//       设置游戏下载路径）、文件夹合并、网页界面框架、gbCookie + 登录状态检测
// 移除：旧项目整理功能（扫描/错位/重复/一键整理/散落归组/图片还原/回收站 HTML
//       整理/md5 整理等全部不搬）
// ============================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const urlMod = require("url");
const os = require("os");

const cfg = require("./config");
const auth = require("./auth");
const gbApi = require("./lib/gb-api");
const downloader = require("./lib/downloader");
const search = require("./lib/search");
const mergeDirs = require("./lib/merge-dirs");
const dataBackup = require("./lib/data-backup");
const hashIndex = require("./lib/hash-index");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

// ---------- 命令行：设置密码 ----------
if (process.argv.includes("--set-password")) {
  const idx = process.argv.indexOf("--set-password");
  const pwd = process.argv[idx + 1];
  if (!pwd) { console.error("用法: node app.js --set-password \"你的密码\""); process.exit(1); }
  cfg.setPassword(pwd);
  console.log("密码已设置（scrypt 哈希存入 server/config.json）");
  process.exit(0);
}

// ---------- 工具 ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("无效的 JSON")); }
    });
    req.on("error", reject);
  });
}

function setSessionCookie(res, token) {
  const cfgNow = cfg.readConfig();
  const maxAge = (cfgNow.sessionHours || 72) * 3600;
  res.setHeader("Set-Cookie", `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function requireAuth(req) {
  const cfgNow = cfg.readConfig();
  if (!cfgNow.passwordHash) return true;
  return auth.isValidSession(auth.extractToken(req));
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not Found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    }
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// 解析油猴/手填的组合文本：形如
//   Cookie=xxx; yyy
// （多行，某行以 Cookie= 开头）。非组合文本返回 null。
function parseCredentialText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const get = (key) => {
    const m = text.split(/\r?\n/).find((l) => l.startsWith(key + "="));
    if (!m) return null;
    return m.slice(key.length + 1).trim() || "";
  };
  const cookie = get("Cookie");
  const hit = /(^|\n)(Cookie)=/.test("\n" + text);
  if (!hit) return null; // 不是组合文本
  return { cookie: cookie === null ? null : cookie };
}

// 脱敏：不回传密码哈希/盐与 gbCookie 明文，用 hasGbCookie 表示是否已配置
function publicSettings(c) {
  const { passwordHash, passwordSalt, gbCookie, ...safe } = c;
  return Object.assign({}, safe, {
    hasGbCookie: !!(gbCookie && String(gbCookie).trim())
  });
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const pathname = parsed.pathname;
  const method = req.method;

  try {
    // ---- 公开路由 ----
    if (method === "POST" && pathname === "/api/login") {
      const body = await readBody(req);
      const cfgNow = cfg.readConfig();
      if (!cfgNow.passwordHash) {
        // 2026-08-26 用户约定：初次未设密码 → 只警告，直接视为登录成功（可正常使用）
        const token = auth.createSession(cfgNow.sessionHours || 72);
        setSessionCookie(res, token);
        return sendJson(res, 200, { ok: true, noPassword: true, message: "未设置访问密码，可直接使用（建议尽快设置）" });
      }
      if (cfg.verifyPassword(body.password || "", cfgNow.passwordHash, cfgNow.passwordSalt)) {
        const token = auth.createSession(cfgNow.sessionHours || 72);
        setSessionCookie(res, token);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 401, { ok: false, error: "密码错误" });
    }
    if (method === "POST" && pathname === "/api/logout") {
      auth.destroySession(auth.extractToken(req));
      res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; Max-Age=0");
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === "/api/status") {
      const cfgNow = cfg.readConfig();
      return sendJson(res, 200, { ok: true, needsSetup: !cfgNow.passwordHash, needsAuth: !!cfgNow.passwordHash });
    }

    // ---- 需鉴权 ----
    if (pathname.startsWith("/api/") && !requireAuth(req)) {
      return sendJson(res, 401, { ok: false, error: "未登录" });
    }

    // ---- 设置（config.json：gbCookie/并发/会话时长；下载路径在 /api/games）----
    // 2026-09-01 参照 iwara-downloader-server：设置接口脱敏（不回传 gbCookie 明文）、
    // 敏感字段空串跳过不覆盖（留空 = 不改）、支持油猴/手填的「Cookie=...」组合文本。
    // 旧实现（直接回传含明文 cookie 的 settings，空串会覆盖已有值）已弃用，保留注释：
    //   GET  /api/settings → { ok, settings: safe }（含 gbCookie 明文）
    //   POST /api/settings → 空串也直接写入 cfgNow[k]（会清空已有 cookie）
    if (method === "GET" && pathname === "/api/settings") {
      return sendJson(res, 200, { ok: true, settings: publicSettings(cfg.readConfig()) });
    }
    if (method === "POST" && pathname === "/api/settings") {
      const body = await readBody(req);
      const cfgNow = cfg.readConfig();
      // 兼容油猴脚本自动复制的组合文本（多行 Cookie=...）
      if (typeof body.gbCookie === "string") {
        const parsed = parseCredentialText(body.gbCookie);
        if (parsed) {
          if (parsed.cookie) body.gbCookie = parsed.cookie; // 非空才写，避免空值覆盖
        }
      }
      const allowed = ["gbCookie", "downloadConcurrency", "sessionHours", "port"];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        // 敏感字段（gbCookie）为空串时跳过不覆盖：留空 = 不改
        if (k === "gbCookie" && String(body[k]).trim() === "") continue;
        cfgNow[k] = body[k];
      }
      cfg.writeConfig(cfgNow);
      return sendJson(res, 200, { ok: true, settings: publicSettings(cfg.readConfig()) });
    }
    if (method === "POST" && pathname === "/api/change-password") {
      const body = await readBody(req);
      if (!body.password || String(body.password).length < 4) {
        return sendJson(res, 400, { ok: false, error: "密码至少 4 位" });
      }
      cfg.setPassword(body.password);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 游戏列表（json/gamebanana.com.json：游戏名 + 香蕉网 id + 下载路径根目录）----
    // 网页上的设置功能读取它设置游戏下载路径
    if (method === "GET" && pathname === "/api/games") {
      return sendJson(res, 200, { ok: true, games: cfg.readGame() });
    }
    if (method === "POST" && pathname === "/api/games") {
      const body = await readBody(req);
      const games = (body.games && typeof body.games === "object") ? body.games : cfg.readGame();
      cfg.writeGame(games);
      return sendJson(res, 200, { ok: true, games: cfg.readGame() });
    }


    // ---- hash 反查（手动版，双表：GB 信息表 + 本地表）----
    // GET /api/hash-query?hash=<md5> → 该 hash 所属 mod/目录/文件（O(1) 内存索引）
    //   source: "local"=本地表命中（有实际落盘路径）| "gb"=仅 GB 表命中（线上信息，未在本机下载）
    if (method === "GET" && pathname === "/api/hash-query") {
      const h = String(parsed.query.hash || "").trim().toLowerCase();
      if (!h) return sendJson(res, 400, { ok: false, error: "缺 hash 参数" });
      const hit = hashIndex.queryByHash(h);
      if (!hit) return sendJson(res, 200, { ok: true, found: false, hash: h });
      return sendJson(res, 200, {
        ok: true, found: true, hash: h, source: hit.source || "gb",
        mod: { name: hit.modName || "", url: hit.url || "", author: hit.author || "", game: hit.game || "", modId: hit.modId || "" },
        file: { name: hit.file || hit.fileName || "", gbMd5: hit.gbMd5 || "", hash: hit.hash || "", kind: hit.kind || "file" },
        modDir: hit.modDir || ""
      });
    }
    // GET /api/hash-index-status → 双表状态（GB 表 / 本地表 大小、上次构建耗时）
    if (method === "GET" && pathname === "/api/hash-index-status") {
      return sendJson(res, 200, { ok: true, ...hashIndex.status() });
    }
    // POST /api/hash-rebuild → 后台重建两张表（从全部 description.html 提取；立即返回）
    if (method === "POST" && pathname === "/api/hash-rebuild") {
      hashIndex.rebuild().then(() => {}).catch(() => {});
      return sendJson(res, 200, { ok: true, running: true });
    }
    // GET /api/hash-index-search?q=<关键词>&game=<游戏名可选> → GB 表模糊搜索（离线 mod 目录）
    if (method === "GET" && pathname === "/api/hash-index-search") {
      const q = String(parsed.query.q || "").trim();
      if (q.length < 2) return sendJson(res, 200, { ok: true, results: [], hint: "关键词至少 2 个字符" });
      const game = String(parsed.query.game || "").trim();
      const results = hashIndex.searchGb(q, game);
      return sendJson(res, 200, { ok: true, count: results.length, results });
    }

    // ---- 映射（mapping/<游戏名>.json）----
    if (method === "GET" && pathname === "/api/mapping") {
      const out = {};
      const games = cfg.readGame();
      for (const game of Object.keys(games)) {
        out[game] = cfg.readGameMapping(game) || null;
      }
      return sendJson(res, 200, { ok: true, mapping: out });
    }
    // ---- 手动添加角色映射（文件夹合并新增功能，2026-08-26 用户要求）----
    // POST {game, warehouse, en, zh} → 写入 mapping/<游戏名>.json 的 roles + variants
    if (method === "POST" && pathname === "/api/mapping/add-role") {
      const body = await readBody(req);
      try {
        const r = cfg.addRoleMapping(body.game, body.en, body.zh);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    // ---- 香蕉网获取游戏角色列表（手动添加映射时英文名下拉选择，2026-08-26 用户要求）----
    if (method === "GET" && pathname === "/api/gb-characters") {
      const game = String(parsed.query.game || "").trim();
      if (!game) return sendJson(res, 400, { ok: false, error: "missing game" });
      const gameId = cfg.gameIdOf(game);
      if (!gameId) return sendJson(res, 400, { ok: false, error: "unknown game: " + game });
      // 2026-08-27：角色列表持久化 JSON——默认读缓存，refresh=1 强制重新从香蕉网获取
      const forceRefresh = parsed.query.refresh === "1" || parsed.query.refresh === "true";
      try {
        const characters = await gbApi.fetchGameCharacterList(gameId, game, forceRefresh);
        return sendJson(res, 200, { ok: true, count: characters.length, characters, fromCache: !forceRefresh });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    // ---- 香蕉网游戏信息：按 id 取游戏名 + 根分类（仓库）（2026-08-26 用户要求）----
    // GET /api/gb-game-info?id=<gameId> → {name, roots}（添加游戏自动取名 / 仓库下拉用）
    if (method === "GET" && pathname === "/api/gb-game-info") {
      const id = parseInt(parsed.query.id, 10);
      if (!id || id <= 0) return sendJson(res, 400, { ok: false, error: "无效的香蕉网游戏 id" });
      try {
        const info = await gbApi.fetchGameInfo(id);
        if (!info || !info.name) return sendJson(res, 404, { ok: false, error: "未找到该游戏" });
        return sendJson(res, 200, { ok: true, info });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    // GET /api/gb-warehouses?game=<name> → 该游戏香蕉网根分类（仓库）列表
    if (method === "GET" && pathname === "/api/gb-warehouses") {
      const game = String(parsed.query.game || "").trim();
      const gameId = cfg.gameIdOf(game);
      if (!gameId) return sendJson(res, 400, { ok: false, error: "unknown game: " + game });
      try {
        const info = await gbApi.fetchGameInfo(gameId);
        // 附上本地 mapping 的仓库映射值（如 Skins → 角色）作提示
        const map = cfg.readGameMapping(game);
        const wm = (map && map.warehouses) || {};
        const roots = ((info && info.roots) || []).map((r) => ({
          id: r.id,
          name: r.name,
          itemCount: r.itemCount,
          local: wm[String(r.name).toLowerCase()] !== undefined ? wm[String(r.name).toLowerCase()] : null
        }));
        return sendJson(res, 200, { ok: true, game: info && info.name, warehouses: roots });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }

    // ---- GameBanana 登录状态检测 ----
    // 2026-09-01 改用官方前端真实会话端点 apiv13（从官方前端 JS 反编译确认）：
    //   GET /apiv13/Member/UiConfig?_sUrl=%2F  →  _bIsLoggedIn（是否登录）、_idMemberRow（当前用户 id）
    //   GET /apiv13/Member/{id}/ProfilePage    →  _sName（用户名）、_sProfileUrl
    // 旧实现（拉 NSFW mod 708465 判 _aFiles+_sInitialVisibility=hide）实测匿名也拉得到，会误判，已弃用：
    // if (method === "GET" && pathname === "/api/gb-login-status") {
    //   ... const checkId = parseInt(cfgNow.gbCheckModId, 10) || 708465;
    //   const data = await gbApi.fetchJson(`https://gamebanana.com/apiv11/Mod/${checkId}/ProfilePage`, {}, 1);
    //   const files = ...; const vis = ...; if (files.length > 0 && vis === "hide") { loggedIn:true } ...
    // }
    if (method === "GET" && pathname === "/api/gb-login-status") {
      const cfgNow = cfg.readConfig();
      const cookie = String(cfgNow.gbCookie || "").trim();
      if (!cookie) {
        return sendJson(res, 200, { ok: true, configured: false, loggedIn: false, cookieSet: false, warnLevel: "err", detail: "未配置 gbCookie" });
      }
      try {
        // 2026-09-01 用带响应头的 fetch：解析 Set-Cookie 里 rmc 的 Expires 算剩余天数（参照 iwara 的 /api/account-check）
        const { json: uicfg, setCookies } = await gbApi.fetchJsonHeaders("https://gamebanana.com/apiv13/Member/UiConfig?_sUrl=%2F", {}, 1);
        const loggedIn = !!(uicfg && uicfg._bIsLoggedIn);
        // rmc = remember-me cookie，服务端每次请求会刷新并带 Expires；sess 是会话 cookie 无固定到期
        let expiresAt = 0;
        let remainingDays = null;
        for (const sc of setCookies || []) {
          const m = /^rmc=/i.test(String(sc)) ? sc.match(/Expires=([^;]+)/i) : null;
          if (m) {
            const t = Date.parse(m[1]);
            if (!isNaN(t)) { expiresAt = t; remainingDays = Math.ceil((t - Date.now()) / 86400000); }
          }
        }
        if (!loggedIn) {
          return sendJson(res, 200, { ok: true, configured: true, loggedIn: false, cookieSet: true,
            expiresAt, remainingDays, warnLevel: remainingDays !== null && remainingDays < 0 ? "expired" : "err",
            detail: "未登录（会话失效或 Cookie 不完整；GameBanana 会话含 HttpOnly cookie，需用浏览器 DevTools 或油猴 GM_cookie 复制完整 Cookie）" });
        }
        const idRow = uicfg._idMemberRow || 0;
        let username = "";
        let profileUrl = "";
        if (idRow) {
          try {
            const prof = await gbApi.fetchJson(`https://gamebanana.com/apiv13/Member/${idRow}/ProfilePage`, {}, 1);
            username = (prof && prof._sName) || "";
            profileUrl = (prof && prof._sProfileUrl) || "";
          } catch (_) {}
        }
        // warnLevel：剩 ≤7 天 → warn；已过期 → expired；否则 ok
        const warnLevel = remainingDays !== null && remainingDays < 0 ? "expired" : (remainingDays !== null && remainingDays <= 7 ? "warn" : "ok");
        const dayTxt = remainingDays !== null ? `，剩 ${remainingDays} 天` : "";
        return sendJson(res, 200, { ok: true, configured: true, loggedIn: true, cookieSet: true,
          username, idRow, profileUrl, expiresAt, remainingDays, warnLevel,
          detail: username ? `已登录：${username}${dayTxt}` : `已登录（用户 id ${idRow}）` });
      } catch (e) {
        return sendJson(res, 200, { ok: true, configured: true, loggedIn: false, cookieSet: true, warnLevel: "err", detail: "检测失败: " + (e.message || String(e)) });
      }
    }

    // ---- 关键词搜索（中文/变体 → 英文归一后搜 GB Results API）----
    if (method === "GET" && pathname === "/api/keyword-search") {
      let q = String(parsed.query.q || "").trim();
      const game = String(parsed.query.game || "").trim();
      if (!q || !game) return sendJson(res, 400, { ok: false, error: "missing q or game" });
      const gameId = cfg.gameIdOf(game);
      if (!gameId) return sendJson(res, 400, { ok: false, error: "unknown game id: " + game });
      try {
        const origQ = q;
        q = gbApi.normalizeKeyword(game, q); // 桑多涅 → Sandrone
        const perpage = Math.min(parseInt(parsed.query.perpage, 10) || 50, 100);
        const maxResults = Math.min(parseInt(parsed.query.max || 100, 10) || 100, 500);
        // 2026-08-27 用户要求：合并搜索——搜角色名时自动补搜变体（短名/中文），合并去重。
        //   例：搜 "Jane Doe" → 变体 ["Jane Doe", "Jane", "简·杜", "简"]，各自搜后合并。
        //   GB 关键词搜索只按标题匹配，标题含 "Jane" 但非 "Jane Doe" 的 mod 需变体才能搜到。
        const genVariants = (base) => {
          const vs = new Set();
          vs.add(base);
          // 短名：去全名后缀（Jane Doe → Jane；Burnice White → Burnice）
          const parts = String(base).split(" ");
          if (parts.length > 1) {
            vs.add(parts[0]);
            // 去掉中间名保留前两个（Anby Demara → Anby）
            if (parts.length > 2) vs.add(parts[0] + " " + parts[1]);
          }
          // 中文变体：从映射 roles 反查（简·杜/简）
          try {
            const map = cfg.readGameMapping(game);
            for (const [en, zh] of Object.entries((map && map.roles) || {})) {
              if (String(en).toLowerCase() === String(base).toLowerCase()) {
                vs.add(zh);
                // 中文短名（取 · 前段）
                const zhShort = String(zh).split("·")[0].trim();
                if (zhShort && zhShort.length >= 1) vs.add(zhShort);
              }
            }
          } catch (_) {}
          return [...vs].filter(Boolean);
        };
        const variants = genVariants(q);
        const all = [];
        const seen = new Set();
        for (const vq of variants) {
          for (let page = 1; page <= 12 && all.length < maxResults; page++) {
            const recs = await gbApi.searchGameBananaMods(gameId, vq, perpage, page);
            const mods = (recs || []).filter((r) => r && r.id);
            if (!mods.length) break;
            for (const m of mods) {
              if (seen.has(m.id)) continue;
              seen.add(m.id);
              all.push(m);
            }
            if (mods.length < 10) break;
          }
        }
        const results = all.slice(0, maxResults).map((r) => ({
          modId: r.id, name: r.name, author: r.author || "",
          profileUrl: r.profileUrl || ("https://gamebanana.com/mods/" + r.id),
          game, isNsfw: !!r.isNsfw, dateAdded: 0, dateModified: 0, dateUpdated: 0
        }));
        // 归一关键词无结果且与原词不同 → 回退原词再搜一次
        if (!results.length && q !== origQ) {
          const recs2 = await gbApi.searchGameBananaMods(gameId, origQ, perpage, 1);
          const mods2 = (recs2 || []).filter((r) => r && r.id);
          for (const m of mods2) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            results.push({
              modId: m.id, name: m.name, author: m.author || "",
              profileUrl: m.profileUrl || ("https://gamebanana.com/mods/" + m.id),
              game, isNsfw: !!m.isNsfw, dateAdded: 0, dateModified: 0, dateUpdated: 0
            });
          }
        }
        return sendJson(res, 200, { ok: true, count: results.length, results, pages: all.length >= maxResults, normalized: q !== origQ ? { from: origQ, to: q } : undefined, variants: variants.length > 1 ? variants : undefined });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }

    // ---- 按时间搜索（保留）----
    if (method === "POST" && pathname === "/api/search") {
      const body = await readBody(req);
      const startTs = Math.floor(new Date(body.startDate + "T00:00:00").getTime() / 1000);
      const endTs = Math.floor(new Date(body.endDate + "T00:00:00").getTime() / 1000) + 86400;
      if (isNaN(startTs) || isNaN(endTs)) return sendJson(res, 400, { ok: false, error: "日期格式无效" });
      const contentFilter = Array.isArray(body.contentFilter) && body.contentFilter.length ? body.contentFilter : ["normal", "nsfw"];
      let games = (body.games || []).filter((g) => g && String(g).trim());
      if (!games.length) return sendJson(res, 400, { ok: false, error: "未指定要搜索的游戏" });
      try {
        const t = await search.startSearchTask({ games, startDate: body.startDate, endDate: body.endDate, contentFilter, startTs, endTs });
        return sendJson(res, 200, { ok: true, started: true, task: t });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }
    if (method === "GET" && pathname === "/api/search-status") return sendJson(res, 200, { ok: true, task: search.getQueryTask() });
    if (method === "POST" && pathname === "/api/search/stop") return sendJson(res, 200, search.stopSearch());
    if (method === "GET" && pathname === "/api/search/cache") return sendJson(res, 200, { ok: true, cache: search.getCache() });
    if (method === "POST" && pathname === "/api/search/clear") return sendJson(res, 200, search.clearCache());
    // 2026-08-26 用户要求：手动导入搜索记录（上传 JSON 数组，按 modId 合并，导入覆盖原有）
    if (method === "POST" && pathname === "/api/search/import") {
      const body = await readBody(req);
      let records = body && body.records;
      if (typeof records === "string") {
        try { records = JSON.parse(records); } catch (_) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败，请上传正确的搜索记录数组" }); }
      }
      if (body && body.json && !records) {
        try { records = JSON.parse(body.json); } catch (_) { return sendJson(res, 400, { ok: false, error: "JSON 解析失败，请上传正确的搜索记录数组" }); }
      }
      return sendJson(res, 200, search.importCache(records));
    }
    // 2026-08-31 用户要求：保存搜索结果（把前端当前结果覆盖写入 search_cache.json）
    if (method === "POST" && pathname === "/api/search/save") {
      const body = await readBody(req);
      const results = Array.isArray(body && body.results) ? body.results : [];
      return sendJson(res, 200, search.saveRecords(results));
    }
    // 2026-08-26 用户要求：导出搜索记录（当前 cache 完整 JSON，前端下载为文件）
    if (method === "GET" && pathname === "/api/search/export") {
      const cache = search.exportCache();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="gbmd-search-records-${new Date().toISOString().slice(0, 10)}.json"`);
      return res.end(JSON.stringify(cache, null, 2));
    }

    // ---- 用户数据备份/恢复（2026-08-31 用户要求：zip 导出/导入全部用户数据，按 userdata-manifest.json 清单）----
    if (method === "GET" && pathname === "/api/data/export") {
      try {
        const buf = await dataBackup.exportZip();
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="gbmd-userdata-${new Date().toISOString().slice(0, 10)}.zip"`);
        return res.end(buf);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "备份失败: " + (e && e.message || e) });
      }
    }
    if (method === "POST" && pathname === "/api/data/import") {
      const body = await readBody(req, 512 * 1024 * 1024); // zip 可能几十 MB，放大限制
      const b64 = body && (body.data || body.zip);
      if (!b64 || typeof b64 !== "string") return sendJson(res, 400, { ok: false, error: "缺少 zip 数据（data 字段，base64）" });
      let zipBuf;
      try { zipBuf = Buffer.from(b64, "base64"); }
      catch (e) { return sendJson(res, 400, { ok: false, error: "zip 数据解码失败" }); }
      const zipPath = path.join(os.tmpdir(), "gbmd-upload-" + Date.now() + ".zip");
      fs.writeFileSync(zipPath, zipBuf);
      try {
        const r = await dataBackup.importZip(zipPath);
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "导入失败: " + (e && e.message || e) });
      } finally {
        try { fs.unlinkSync(zipPath); } catch (_) {}
      }
    }

    // ---- 下载（四步流程：生成HTML → 查重归位 → 整理 → 正式下载）----
    // 2026-09-01 参照 iwara：/api/receive 为油猴脚本专用接收口，规整 { url }/ { links } 后走同一套下载
    if (method === "POST" && (pathname === "/api/download" || pathname === "/api/receive")) {
      const body = await readBody(req);
      // 支持完整链接或纯数字 id
      let raw = body.links || [];
      if (pathname === "/api/receive") {
        if (typeof body.url === "string") raw = [body.url];
        else if (Array.isArray(body.urls)) raw = body.urls;
        else if (typeof body.text === "string") raw = body.text.split(/\r?\n/);
        else if (typeof raw === "string") raw = [raw];
      }
      const links = (raw || [])
        .map((s) => String(s).trim())
        .filter((s) => s && (s.includes("gamebanana.com") || /^\d+$/.test(s)));
      if (!links.length) return sendJson(res, 400, { ok: false, error: "没有有效的链接" });
      const t = await downloader.startDownloadTask({ mods: links.map((l) => ({ profileUrl: l })) });
      const out = { ok: true, started: true, task: t };
      if (pathname === "/api/receive") out.received = links.length;
      return sendJson(res, 200, out);
    }
    if (method === "POST" && pathname === "/api/download-selected") {
      const body = await readBody(req);
      const selected = (body.items || []).filter((it) => it && (it.profileUrl || (it.modId && String(it.modId).trim())));
      if (!selected.length) return sendJson(res, 400, { ok: false, error: "没有勾选要下载的 mod" });
      const t = await downloader.startDownloadTask({
        mods: selected.map((it) => ({ profileUrl: it.profileUrl || String(it.modId) }))
      });
      return sendJson(res, 200, { ok: true, started: true, task: t });
    }
    if (method === "GET" && pathname === "/api/task") return sendJson(res, 200, { ok: true, task: downloader.getTask() });
    if (method === "POST" && pathname === "/api/task/pause") return sendJson(res, 200, downloader.pauseTask());
    if (method === "POST" && pathname === "/api/task/resume") return sendJson(res, 200, downloader.resumeTask());
    if (method === "POST" && pathname === "/api/task/stop") return sendJson(res, 200, downloader.stopTask());
    if (method === "POST" && pathname === "/api/task/retry-failed") return sendJson(res, 200, downloader.retryFailed());
    if (method === "POST" && pathname === "/api/task/concurrency") {
      const body = await readBody(req);
      return sendJson(res, 200, downloader.setConcurrency(body.concurrency));
    }
    // 2026-08-27 找回模式开关（不实际下载，只归位/找回/生成 HTML）
    if (method === "POST" && pathname === "/api/task/restore-mode") {
      const body = await readBody(req);
      return sendJson(res, 200, downloader.setRestoreMode(body.enabled));
    }
    if (method === "GET" && pathname === "/api/task/restore-mode") {
      return sendJson(res, 200, { ok: true, restoreOnly: downloader.getRestoreMode() });
    }

    // ---- 本地目录浏览（设置页「读取本地选择」下载路径；用户原话 2026-08-26）----
    if (method === "GET" && pathname === "/api/browse") {
      const p = String(parsed.query.path || "").trim();
      const dir = p && p.startsWith("/") ? p : "/";
      try {
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          return sendJson(res, 400, { ok: false, error: "目录不存在: " + dir });
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // 2026-08-31 修复老 bug（用户原话：「设置目录不显示带.目录」）：
        //   不再过滤 . 开头目录（.Mods/.代理人/(gamebanana) 深层根需能选到），
        //   只排除群晖系统目录 @eaDir（缩略图缓存，每个目录都有）、#recycle（回收站）、.git（版本库）
        const dirs = entries
          .filter((e) => e.isDirectory() && e.name !== "@eaDir" && e.name !== "#recycle" && e.name !== ".git")
          .map((e) => e.name)
          .sort();
        return sendJson(res, 200, { ok: true, path: dir, parent: dir === "/" ? null : path.dirname(dir), dirs });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }

    // ---- 图片预览代理（下载进度页预览图；路径必须在某游戏下载根内，防穿越）----
    if (method === "GET" && pathname === "/api/image") {
      const filePath = parsed.query && parsed.query.path;
      if (!filePath || typeof filePath !== "string") { res.writeHead(400); res.end("bad request"); return; }
      const ext = path.extname(filePath).toLowerCase();
      const mime = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" }[ext];
      if (!mime) { res.writeHead(403); res.end("not an image"); return; }
      const abs = path.resolve(filePath);
      const roots = Object.values(cfg.readGame()).map((e) => e && e.downloadPath).filter((r) => r && String(r).trim());
      const inRoot = roots.some((r) => {
        const rr = path.resolve(r);
        return abs === rr || abs.startsWith(rr + path.sep);
      });
      if (!inRoot) { res.writeHead(403); res.end("forbidden"); return; }
      if (!fs.existsSync(abs)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=3600" });
      fs.createReadStream(abs).pipe(res);
      return;
    }

    // ---- 跳过失败项（单条）/ 一键清除失败（全部）（2026-08-26 用户要求加回）----
    if (method === "POST" && pathname === "/api/skip") {
      const body = await readBody(req);
      return sendJson(res, 200, downloader.skipItem({ path: body.path, url: body.url }));
    }
    if (method === "POST" && pathname === "/api/skip-all-failed") {
      return sendJson(res, 200, downloader.skipAllFailed());
    }

    // ---- 文件夹合并（按映射重命名/合并角色目录）----
    // POST {game, dryRun}：dryRun=true 预览计划；false 执行
    if (method === "POST" && pathname === "/api/merge-roles") {
      const body = await readBody(req);
      const dryRun = body.dryRun !== false;
      try {
        const game = String(body.game || "").trim();
        const root = cfg.gameRootOf(game);
        if (!root) return sendJson(res, 400, { ok: false, error: "该游戏未配置下载路径，无法扫描" });
        const dups = mergeDirs.findRoleDuplicates(root, game);
        const result = mergeDirs.executeMerge(dups, dryRun, root);
        return sendJson(res, 200, { ok: true, dryRun, game, root, groups: dups.length, ...result });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }

    // ---- 清空空文件夹（空壳 / 仅含 HTML，2026-08-31 用户要求）----
    // 用户原话：「设置里面 文件夹合并（按映射重命名角色目录）里面加个手动功能，清空空文件夹
    //   （仅含HTML也算），也是选择游戏，要带被清空目录预览」
    // POST {game, dryRun}：dryRun=true 预览计划；false 执行（空壳目录进 root/.trash 可恢复）
    if (method === "POST" && pathname === "/api/cleanup-empty-dirs") {
      const body = await readBody(req);
      const dryRun = body.dryRun !== false;
      try {
        const game = String(body.game || "").trim();
        const root = cfg.gameRootOf(game);
        if (!root) return sendJson(res, 400, { ok: false, error: "该游戏未配置下载路径，无法扫描" });
        const emptyDirs = mergeDirs.findEmptyDirs(root);
        const result = mergeDirs.cleanupEmptyDirs(emptyDirs, dryRun, root);
        return sendJson(res, 200, { ok: true, dryRun, game, root, count: emptyDirs.length, ...result });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
    }

    // ---- 油猴脚本下载（2026-09-01 参照 iwara-downloader：顶部「📥 油猴脚本」→ 附件下载）----
    // 脚本单一来源：项目根 scripts/gamebanana-cookie-userscript.user.js（SA6400 与本地同源）
    if (method === "GET" && (pathname === "/userscript" || pathname === "/userscript.user.js" || pathname === "/gamebanana-cookie-userscript.user.js")) {
      const scriptPath = path.join(__dirname, "..", "scripts", "gamebanana-cookie-userscript.user.js");
      fs.readFile(scriptPath, (err, data) => {
        if (err) return sendJson(res, 404, { ok: false, error: "油猴脚本不存在" });
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Content-Disposition": "attachment; filename=gamebanana-cookie-userscript.user.js",
          "Cache-Control": "no-store"
        });
        res.end(data);
      });
      return;
    }

    // ---- 静态页面 ----
    if (!pathname.startsWith("/api/")) {
      if (!cfg.readConfig().passwordHash) {
        if (pathname === "/" || pathname === "/index.html" || pathname === "/setup.html") {
          return serveStatic(req, res, "/setup.html");
        }
      }
      return serveStatic(req, res, pathname);
    }

    return sendJson(res, 404, { ok: false, error: "接口不存在" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message || String(e) });
  }
});

// ---------- 启动 ----------
const cfgNow = cfg.readConfig();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (cfgNow.port || 8642);

auth.loadSessions();
downloader.restorePendingTask();
search.restorePendingQuery();

// hash 反查：加载两张持久化索引表（json/gb-hash-index.json + json/local-hash-index.json）
try {
  const r = hashIndex.load();
  console.log(`[hash-index] 已加载: GB 表 ${r.gb} 条, 本地表 ${r.local} 条`);
} catch (e) {
  console.log("[hash-index] 加载失败: " + (e && e.message));
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("==============================================");
  console.log("gbmd-v3 server 已启动");
  console.log(`  本机访问: http://127.0.0.1:${PORT}`);
  console.log(`  局域网访问: http://<本机IP>:${PORT}`);
  if (!cfg.hasPassword()) {
    console.log('  ⚠️  尚未设置密码！首次使用请先设置：node app.js --set-password "你的密码"');
  }
  console.log("==============================================");
});
