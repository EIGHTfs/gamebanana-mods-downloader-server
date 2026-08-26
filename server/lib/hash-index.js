// ============================================================
// gbmd - hash 反查（双表版，2026-08-26 用户要求拆分）
//   两张持久化索引表（JSON 文件，启动加载进内存 Map）：
//   1) json/gb-hash-index.json   —— GB 信息表（hash → 香蕉网侧信息）
//      记录香蕉网上 mod 的文件 MD5 及其所属 mod（modId/名/作者/游戏/链接/GB文件名）。
//      放项目目录、提交 git：所有人可查（谁 clone 下来都能反查这个 md5 是哪个 mod）。
//      来源：下载时从 GB 文件列表（gbMd5）追加。
//   2) json/local-hash-index.json —— 本地信息表（hash → 本地落盘信息）
//      记录本地实际下载的文件（mod 目录、本地文件名、本地内容 hash）。
//      下载完成时追加；.gitignore 忽略（仅本机/本部署可见）。
//   查询：本地表优先（能定位到本地路径），无则查 GB 表（只有线上信息）。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const JSON_DIR = process.env.GBMD_JSON_DIR ? path.resolve(process.env.GBMD_JSON_DIR) : path.join(__dirname, "..", "..", "json");
const GB_FILE = path.join(JSON_DIR, "gb-hash-index.json");
const LOCAL_FILE = path.join(JSON_DIR, "local-hash-index.json");
const NAME_FILE = path.join(JSON_DIR, "html-name-index.json"); // HTML 反查：GB 原名(短名) -> mod

const INDEX_TAG_ID = "gbmd-index";

let gbIndex = new Map();      // hash -> {modId, modName, author, game, url, fileName, gbMd5}
let localIndex = new Map();   // hash -> {modDir, file, hash, gbMd5}
let nameIndex = new Map();    // GB 原名(短名/压缩包名) -> {modId, modName, author, game, url, kind}（HTML 反查用）
let buildState = { running: false, lastAt: 0, lastMs: 0, error: "" };

// ---------- 文件读写 ----------
function loadMap(file) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Map(Object.entries(obj || {}));
  } catch (_) { return new Map(); }
}

function saveMap(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2));
    return true;
  } catch (_) { return false; }
}

// ---------- HTML 索引块解析 ----------
function parseIndexObj(html) {
  if (!html) return null;
  const re = new RegExp(`<script id="${INDEX_TAG_ID}"[^>]*>([\\s\\S]*?)<\\/script>`);
  const m = html.match(re);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && obj.schema === 1) return obj;
  } catch (_) {}
  return null;
}

function readIndexObj(modDir) {
  const p = path.join(modDir, "description.html");
  if (!fs.existsSync(p)) return null;
  try { return parseIndexObj(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

// ---------- 启动加载 ----------
function load() {
  gbIndex = loadMap(GB_FILE);
  localIndex = loadMap(LOCAL_FILE);
  nameIndex = loadMap(NAME_FILE);
  return { gb: gbIndex.size, local: localIndex.size, name: nameIndex.size };
}

// ---------- 查询（HTML 反查）----------
// 返回 { source: "local"|"gb"|"html", ... }；找不到返回 null
// 优先 hash 精确（本地表→GB 表），再按 GB 原名（短名/压缩包名）反查 HTML 索引
// 2026-08-26：GB 原名查询忽略后缀——输入 "69b46e18405cc" 或 "69b46e18405cc.jpg" 都命中
function queryByHash(hash) {
  const raw = String(hash || "").trim();
  if (!raw) return null;
  const key = raw.toLowerCase();
  const local = localIndex.get(key);
  if (local) return { source: "local", ...local };
  const gb = gbIndex.get(key);
  if (gb) return { source: "gb", ...gb };
  // HTML 反查：GB 原名（图片短名如 69b46e18405cc.jpg / 压缩包名）
  const byName = nameIndex.get(key);
  if (byName) return { source: "html", ...byName, file: byName.fileName || byName.file || key, kind: byName.kind || "file", modDir: "" };
  // 忽略后缀再查：输入 "69b46e18405cc"（无 .jpg）→ 补后缀匹配
  const noExt = key.replace(/\.[a-z0-9]+$/i, "");
  if (noExt !== key) {
    const byName2 = nameIndex.get(noExt);
    if (byName2) return { source: "html", ...byName2, file: byName2.fileName || byName2.file || key, kind: byName2.kind || "file", modDir: "" };
    // 也尝试已知图片后缀补齐
    for (const ext of [".jpg", ".png", ".jpeg", ".gif", ".webp"]) {
      const cand = nameIndex.get(noExt + ext);
      if (cand) return { source: "html", ...cand, file: cand.fileName || cand.file || key, kind: cand.kind || "file", modDir: "" };
    }
  }
  return null;
}

// ---------- GB 表模糊搜索（2026-08-26 用户要求：当离线 mod 目录用）----------
// 按 mod 名/作者 模糊匹配 GB 表，按 modId 去重；标注该 mod 是否本地已下载（本地表命中任一 hash）。
// 返回 [{modId, modName, author, game, url, fileCount, hasLocal}]
function searchGb(keyword, gameFilter) {
  const q = String(keyword || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const gf = String(gameFilter || "").trim().toLowerCase();
  const mods = new Map(); // modId -> 聚合
  for (const info of gbIndex.values()) {
    const name = String(info.modName || "").toLowerCase();
    const author = String(info.author || "").toLowerCase();
    if (!name.includes(q) && !author.includes(q)) continue;
    if (gf && String(info.game || "").toLowerCase() !== gf) continue;
    const modId = String(info.modId || (info.url || "").replace(/^.*mods\/(\d+).*$/, "$1") || info.modName || "");
    if (!mods.has(modId)) {
      mods.set(modId, {
        modId, modName: info.modName || "", author: info.author || "",
        game: info.game || "", url: info.url || "", fileCount: 0, hasLocal: false
      });
    }
    const m = mods.get(modId);
    m.fileCount++;
    // hasLocal：任一文件 hash 在本地表
    if (!m.hasLocal) {
      const hk = String(info.gbMd5 || "").toLowerCase().trim();
      if (hk && localIndex.has(hk)) m.hasLocal = true;
    }
  }
  return [...mods.values()].sort((a, b) => String(b.modName).localeCompare(String(a.modName), "en"));
}

// ---------- 下载时增量追加（2026-08-26 用户要求：每次新下载顺手更新）----------
// 从单个 mod 目录的 description.html 提取：
//   · GB 表：files[].gbMd5 → GB 侧信息（mod 元数据来自 obj）
//   · 本地表：files[].hash / images[].hash → 本地落盘信息（modDir + 文件名）
// 只增不删；返回 { gbAdded, localAdded }
function ingestModDir(modDir) {
  if (!modDir || !fs.existsSync(path.join(modDir, "description.html"))) return { gbAdded: 0, localAdded: 0 };
  const obj = readIndexObj(modDir);
  if (!obj) return { gbAdded: 0, localAdded: 0 };

  const gbMeta = {
    modId: obj.modId || (obj.url || "").replace(/^.*mods\/(\d+).*$/, "$1") || "",
    modName: obj.name || "",
    author: obj.author || "",
    game: obj.game || "",
    url: obj.url || ""
  };

  let gbAdded = 0, localAdded = 0;

  const putGb = (gbMd5, fileName) => {
    const key = String(gbMd5 || "").toLowerCase().trim();
    if (!key) return;
    if (!gbIndex.has(key)) {
      gbIndex.set(key, { ...gbMeta, fileName, gbMd5: key });
      gbAdded++;
    }
  };
  // 本地表条目同时带 GB 元信息（双表命中时网页能显示 mod 名/作者/游戏/链接）
  const putLocal = (hk, fileName, kind) => {
    const key = String(hk || "").toLowerCase().trim();
    if (!key) return;
    if (!localIndex.has(key)) {
      localIndex.set(key, { modDir, file: fileName, hash: key, gbMd5: key, kind, ...gbMeta });
      localAdded++;
    }
  };

  const putName = (name, kind) => {
    const key = String(name || "").toLowerCase().trim();
    if (!key) return;
    if (!nameIndex.has(key)) {
      nameIndex.set(key, { modId: gbMeta.modId, modName: gbMeta.modName, author: gbMeta.author, game: gbMeta.game, url: gbMeta.url, fileName: name, kind });
    }
  };
  for (const f of obj.files || []) {
    putGb(f.gbMd5, f.file);
    putLocal(f.gbMd5, f.file, "file");
    putLocal(f.hash, f.file, "file");
    putName(f.file, "file");
  }
  for (const im of obj.images || []) {
    putLocal(im.hash, im.file || im.gbFile || "", "image");
    putName(im.file || im.gbFile || "", "image");
  }

  let saved = 0;
  if (gbAdded > 0 && saveMap(GB_FILE, gbIndex)) saved++;
  if (localAdded > 0 && saveMap(LOCAL_FILE, localIndex)) saved++;
  if (nameIndex.size > 0 && saveMap(NAME_FILE, nameIndex)) saved++;
  return { gbAdded, localAdded, saved };
}

// ---------- 全量重建（从所有游戏根 description.html 提取，写入两张表）----------
async function rebuild() {
  if (buildState.running) return { running: true, error: "正在重建中" };
  buildState.running = true;
  buildState.error = "";
  const t0 = Date.now();
  const gb = new Map();
  const local = new Map();
  const name = new Map();
  let htmls = 0;
  try {
    const cfg = require("../config");
    const games = cfg.readGame() || {};
    const seen = new Set();
    const roots = [];
    for (const g of Object.values(games)) {
      const r = String((g && g.downloadPath) || "").trim();
      if (r && !seen.has(r)) { seen.add(r); roots.push(r); }
    }
    let count = 0;
    const walk = async (dir) => {
      let ents = [];
      try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name === ".trash" || e.name === ".git" || e.name === "@eaDir" || e.name.startsWith(".")) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(p);
        } else if (e.name === "description.html") {
          const obj = readIndexObj(dir);
          if (obj) {
            htmls++;
            const gbMeta = {
              modId: obj.modId || (obj.url || "").replace(/^.*mods\/(\d+).*$/, "$1") || "",
              modName: obj.name || "",
              author: obj.author || "",
              game: obj.game || "",
              url: obj.url || ""
            };
            for (const f of obj.files || []) {
              const key = String(f.gbMd5 || "").toLowerCase().trim();
              if (key && !gb.has(key)) gb.set(key, { ...gbMeta, fileName: f.file, gbMd5: key });
              const lk = String(f.hash || "").toLowerCase().trim();
              if (lk && !local.has(lk)) local.set(lk, { modDir: dir, file: f.file, hash: lk, gbMd5: key, kind: "file", ...gbMeta });
              if (key && !local.has(key)) local.set(key, { modDir: dir, file: f.file, hash: key, gbMd5: key, kind: "file", ...gbMeta });
              const nk = String(f.file || "").toLowerCase().trim();
              if (nk && !name.has(nk)) name.set(nk, { modId: gbMeta.modId, modName: gbMeta.modName, author: gbMeta.author, game: gbMeta.game, url: gbMeta.url, fileName: f.file, kind: "file" });
            }
            for (const im of obj.images || []) {
              const lk = String(im.hash || "").toLowerCase().trim();
              if (lk && !local.has(lk)) local.set(lk, { modDir: dir, file: im.file || im.gbFile || "", hash: lk, gbMd5: lk, kind: "image", ...gbMeta });
              const nk = String(im.file || im.gbFile || "").toLowerCase().trim();
              if (nk && !name.has(nk)) name.set(nk, { modId: gbMeta.modId, modName: gbMeta.modName, author: gbMeta.author, game: gbMeta.game, url: gbMeta.url, fileName: im.file || im.gbFile || "", kind: "image" });
            }
            // 2026-08-26 补全（垃圾桶反查）：旧版下载的 HTML 图片 hash 为空，但磁盘图片是
            //   md5 名（内容 hash）——扫描目录里 md5 名图片文件，用文件名(=内容hash)直接建本地索引，
            //   使垃圾桶里同 hash 的图片（内容 md5 名）也能反查到所属 mod 目录。
            try {
              const diskFiles = fs.readdirSync(dir);
              for (const dn of diskFiles) {
                const dm = String(dn).match(/^([0-9a-f]{32})\.(jpg|jpeg|png|webp|gif)$/i);
                if (!dm) continue;
                const dk = dm[1].toLowerCase();
                if (!local.has(dk)) local.set(dk, { modDir: dir, file: dn, hash: dk, gbMd5: dk, kind: "image", ...gbMeta });
              }
            } catch (_) {}
          }
        }
        if (++count % 300 === 0) await new Promise((r) => setImmediate(r));
      }
    };
    for (const r of roots) { if (r && fs.existsSync(r)) await walk(r); }
    gbIndex = gb;
    localIndex = local;
    nameIndex = name;
    saveMap(GB_FILE, gbIndex);
    saveMap(LOCAL_FILE, localIndex);
    saveMap(NAME_FILE, nameIndex);
    buildState.lastAt = Date.now();
    buildState.lastMs = Date.now() - t0;
    return { ok: true, htmls, gb: gb.size, local: local.size, name: name.size, ms: buildState.lastMs };
  } catch (e) {
    buildState.error = e.message || String(e);
    return { ok: false, error: buildState.error };
  } finally {
    buildState.running = false;
  }
}

function status() {
  return { ...buildState, gb: gbIndex.size, local: localIndex.size, total: gbIndex.size + localIndex.size };
}

module.exports = { load, rebuild, queryByHash, searchGb, ingestModDir, status };
