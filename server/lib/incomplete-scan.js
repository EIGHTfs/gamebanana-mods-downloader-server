// ============================================================
// gbmd-v3 - 未完成任务扫描（#16-A，2026-09-02 用户要求）
// 扫描全部游戏根目录的 description.html，找出「未下载完」的 mod：
//   - 目录里有 .part / .gbmd.part 残留文件（下载中断/进行中）
//   - html 索引里记录了文件（obj.files），但本地对应文件缺失（未下载完 / 被清理）
// 整理成任务 json（含 modUrl / name / game / modDir / 缺失文件列表），
//   可一键加入下载任务（/api/download links）或导出/导入任务 json。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const cfg = require("../config");

// 取所有扫描根：已配置游戏的下载根（gameRootOf 已含 #17 默认位置 fallback）
function collectRoots() {
  const games = cfg.readGame() || {};
  const seen = new Set();
  const roots = [];
  for (const name of Object.keys(games)) {
    const r = cfg.gameRootOf(name);
    if (r && !seen.has(r)) { seen.add(r); roots.push(r); }
  }
  // 默认下载位置本身也纳入扫描（自动创建的游戏名文件夹未进游戏列表时仍可扫到）
  const def = String(cfg.readConfig().defaultDownloadPath || "").trim();
  if (def && fs.existsSync(def)) {
    let added = false;
    try {
      for (const ent of fs.readdirSync(def, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const sub = path.join(def, ent.name);
        if (!seen.has(sub)) { seen.add(sub); roots.push(sub); added = true; }
      }
    } catch (_) {}
    // 默认位置本身是文件根（无游戏名子目录）时也扫
    if (!added && !seen.has(def)) { seen.add(def); roots.push(def); }
  }
  return roots.filter((r) => fs.existsSync(r));
}

// 扫描单个 mod 目录：返回未完成信息或 null
function scanModDir(dir) {
  const htmlPath = path.join(dir, "description.html");
  if (!fs.existsSync(htmlPath)) return null;
  let obj = null;
  try { obj = parseIndexObj(fs.readFileSync(htmlPath, "utf8")); } catch (_) {}
  if (!obj) return null;

  // ① .part 残留
  const partFiles = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/\.(part|gbmd\.part)$/i.test(f) || /\.part$/i.test(f)) partFiles.push(f);
    }
  } catch (_) {}

  // ② html 记录的文件本地缺失
  const missing = [];
  const recorded = [];
  for (const f of obj.files || []) {
    const name = String(f && f.file || "").trim();
    if (!name) continue;
    recorded.push(name);
    if (!fs.existsSync(path.join(dir, name))) missing.push(name);
  }

  if (!partFiles.length && !missing.length) return null;
  return {
    modId: obj.modId || (obj.url || "").replace(/^.*mods\/(\d+).*$/, "$1") || "",
    modName: obj.name || "",
    author: obj.author || "",
    game: obj.game || "",
    url: obj.url || "",
    modDir: dir,
    partFiles,
    missingFiles: missing,
    recordedCount: recorded.length
  };
}

// 递归遍历找 description.html 所在目录（与 hash-index 一致）
async function walk(dir, cb) {
  let ents = [];
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (e.name === ".trash" || e.name === ".git" || e.name === "@eaDir") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, cb);
    else if (e.name === "description.html") cb(dir);
  }
}

// 扫描全部根目录，返回未完成任务数组
async function scanIncomplete() {
  const roots = collectRoots();
  const results = [];
  for (const r of roots) {
    await walk(r, (modDir) => {
      const info = scanModDir(modDir);
      if (info) results.push(info);
    });
  }
  return results;
}

// 解析 html 索引（复用 hash-index 的格式）
function parseIndexObj(html) {
  if (!html) return null;
  const re = /<script id="gbmd-index"[^>]*>([\s\S]*?)<\/script>/;
  const m = html.match(re);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[1]);
    if (obj && obj.schema === 1) return obj;
  } catch (_) {}
  return null;
}

// 任务 json 导出格式（#16-B 导入用）：{ schema:"gbmd-tasks-v1", tasks:[{...}] }
function toTaskJson(results) {
  return {
    schema: "gbmd-tasks-v1",
    exportedAt: new Date().toISOString(),
    count: results.length,
    tasks: results.map((r) => ({
      url: r.url || "",
      modId: r.modId || "",
      name: r.modName || "",
      author: r.author || "",
      game: r.game || "",
      modDir: r.modDir || "",
      partFiles: r.partFiles || [],
      missingFiles: r.missingFiles || []
    }))
  };
}

// 从任务 json 提取可下载链接列表（兼容多种格式）
function extractLinks(taskJson) {
  const links = [];
  const tasks = (taskJson && taskJson.tasks) || (Array.isArray(taskJson) ? taskJson : null) || [];
  for (const t of tasks) {
    const u = t && (t.url || t.profileUrl || t.modUrl);
    if (u && /^https?:\/\//.test(String(u))) links.push(String(u));
    else if (t && t.modId) links.push(String(t.modId));
  }
  return [...new Set(links)];
}

module.exports = { collectRoots, scanModDir, scanIncomplete, toTaskJson, extractLinks };
