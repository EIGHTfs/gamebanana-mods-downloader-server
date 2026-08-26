// ============================================================
// gbmd - 自动整理（2026-08-26 用户要求）
//   判定规则（用户原话）：扫描 mod 目录，不在 HTML 文件列表（files/images/gifs 文件名）
//   里的文件 = 错误归类的外部 mod 遗留 → 移入游戏根垃圾桶（<根>/.trash）。
//   HTML 现在会 append-merge 记住历史文件（legacy），真正属于本 mod 的文件都在列表里，
//   所以误杀率很低（仅很久以前无 HTML 记录的老 mod 文件可能误移，且垃圾桶可找回）。
//   触发时机：
//     1) 下载时：prepareMod 生成/合并 HTML 后顺带清理本 mod 目录（downloader.js 调用）
//     2) 手动建立 HTML 反查索引时：hash-index.rebuild 全库扫描 description.html 顺带清理
//   找回闭环：移入垃圾桶时保留 GB 原名 → 将来下载该文件真正所属的 mod 时，
//     downloader 的 trash-restore 按原名从垃圾桶找回并归位到正确目录。
//   2026-08-26 修复（用户指出严重问题：作者更新只保留新版本，旧版本 zip 被误清）：
//     · 不在列表的文件先按 name-index 反查——命中且 modId 与当前 mod 相同 → 旧版本，
//       保留（下载方追加进 HTML legacy）
//     · 压缩包（zip/rar/7z 等）反查不到也保留——体积大、大概率是本 mod 旧版本（命名
//       差异）或别 mod 文件（其所属 mod 下载时自会处理），误清损失大
//     · 仅图片类（jpg/png/gif/webp 等）不在列表且反查不到（或属别 mod）→ 移入垃圾桶
//       （md5 名图、image_001.jpg 序列名图等历史遗留，体积小且垃圾桶可找回）
//   零依赖（fs/path），供 downloader.js / hash-index.js 复用。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_TAG_ID = "gbmd-index";
const JSON_DIR = process.env.GBMD_JSON_DIR ? path.resolve(process.env.GBMD_JSON_DIR) : path.join(__dirname, "..", "..", "json");
const NAME_FILE = path.join(JSON_DIR, "html-name-index.json");

let nameIndexCache = null; // { at, map } 懒加载 + 缓存（organize 高频调用时避免反复读盘）

function loadNameIndex() {
  const now = Date.now();
  if (nameIndexCache && now - nameIndexCache.at < 60 * 1000) return nameIndexCache.map;
  try {
    const obj = JSON.parse(fs.readFileSync(NAME_FILE, "utf8"));
    nameIndexCache = { at: now, map: new Map(Object.entries(obj || {})) };
  } catch (_) {
    nameIndexCache = { at: now, map: new Map() };
  }
  return nameIndexCache.map;
}

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

// 反查文件名属于哪个 modId（name-index 精确名，忽略后缀再查一次）
function lookupModId(fileName) {
  const key = String(fileName || "").toLowerCase().trim();
  if (!key) return "";
  const idx = loadNameIndex();
  const hit = idx.get(key) || idx.get(key.replace(/\.[a-z0-9]+$/i, ""));
  return hit ? String(hit.modId || "") : "";
}

// 压缩包扩展名（旧版本/归档文件都可能是 zip/rar/7z——体积大，误清损失大）
const ARCHIVE_RE = /\.(zip|rar|7z|tar|gz|tar\.gz)$/i;

// 扫描 modDir：不在 HTML 文件列表里的文件 → 移入 trashDir（保留原名，同名冲突加前缀）
// modId 参数：当前 mod 的 modId；反查命中同 modId 的文件视为旧版本，保留（返回 kept）
// 返回 { moved: [文件名], kept: [文件名], skipped: bool, reason: string }
function organizeDir(modDir, trashDir, modId) {
  const obj = readIndexObj(modDir);
  if (!obj) return { moved: [], kept: [], skipped: true, reason: "无 HTML 索引" };
  const known = new Set(); // 小写文件名集合（files/images/gifs，含 legacy 历史记录）
  for (const f of obj.files || []) if (f && f.file) known.add(String(f.file).toLowerCase());
  for (const im of obj.images || []) {
    if (im) {
      if (im.file) known.add(String(im.file).toLowerCase());
      if (im.gbFile) known.add(String(im.gbFile).toLowerCase());
    }
  }
  for (const g of obj.gifs || []) if (g && g.file) known.add(String(g.file).toLowerCase());

  let ents = [];
  try { ents = fs.readdirSync(modDir, { withFileTypes: true }); } catch (_) { return { moved: [], kept: [], error: "读取目录失败" }; }
  fs.mkdirSync(trashDir, { recursive: true });
  const moved = [];
  const kept = [];
  const curModId = String(modId || obj.modId || "").trim();
  for (const e of ents) {
    if (!e.isFile()) continue; // 只处理文件（子目录由各自 HTML 管理，不整夹移动）
    const name = e.name;
    if (name === "description.html") continue;
    if (name.startsWith(".")) continue; // 隐藏文件（.DS_Store 等）不动
    // part 文件按主文件名判断（断点续传）：主文件在列表 → 保留 part
    const base = name.endsWith(".gbmd.part") ? name.slice(0, -(".gbmd.part".length)) : name;
    if (known.has(String(base).toLowerCase())) continue; // 本 mod 文件（含历史记录）→ 保留
    // 2026-08-26 修复（用户指出）：作者更新只保留新版本，旧版本 zip 从 GB 页面消失。
    //   ① 反查 name-index：命中且 modId == 当前 mod → 旧版本，保留（下载方追加进 HTML）
    const ownerModId = lookupModId(base);
    if (curModId && ownerModId && ownerModId === curModId) {
      kept.push(name);
      continue;
    }
    // ② 压缩包（zip/rar/7z）反查不到/属别 mod → 也保留（体积大，可能是本 mod 旧版本
    //    命名差异，或别 mod 文件——其所属 mod 下载时自会归位；误清损失大）
    if (ARCHIVE_RE.test(base)) {
      kept.push(name);
      continue;
    }
    // ③ 仅图片类（jpg/png/gif/webp 等）不在列表 → 移入垃圾桶（md5 名图、序列名图、
    //    别 mod 预览图等历史遗留；保留原名供 trash-restore 找回）
    const src = path.join(modDir, name);
    let dst = path.join(trashDir, name);
    if (fs.existsSync(dst)) dst = path.join(trashDir, `auto-整理-${Date.now()}-${name}`);
    try {
      fs.renameSync(src, dst);
      moved.push(name);
    } catch (_) {
      // 跨卷/失败 → 复制再删源
      try { fs.copyFileSync(src, dst); fs.unlinkSync(src); moved.push(name); } catch (_) {}
    }
  }
  return { moved, kept, skipped: false };
}

module.exports = { organizeDir, readIndexObj, parseIndexObj, lookupModId };
