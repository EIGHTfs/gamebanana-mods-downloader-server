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
//   零依赖（fs/path），供 downloader.js / hash-index.js 复用，避免循环引用。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const INDEX_TAG_ID = "gbmd-index";

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

// 扫描 modDir：不在 HTML 文件列表里的文件 → 移入 trashDir（保留原名，同名冲突加前缀）
// 返回 { moved: [文件名], skipped: bool, reason: string }
function organizeDir(modDir, trashDir) {
  const obj = readIndexObj(modDir);
  if (!obj) return { moved: [], skipped: true, reason: "无 HTML 索引" };
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
  try { ents = fs.readdirSync(modDir, { withFileTypes: true }); } catch (_) { return { moved: [], error: "读取目录失败" }; }
  fs.mkdirSync(trashDir, { recursive: true });
  const moved = [];
  for (const e of ents) {
    if (!e.isFile()) continue; // 只处理文件（子目录由各自 HTML 管理，不整夹移动）
    const name = e.name;
    if (name === "description.html") continue;
    if (name.startsWith(".")) continue; // 隐藏文件（.DS_Store 等）不动
    // part 文件按主文件名判断（断点续传）：主文件在列表 → 保留 part
    const base = name.endsWith(".gbmd.part") ? name.slice(0, -(".gbmd.part".length)) : name;
    if (known.has(String(base).toLowerCase())) continue; // 本 mod 文件（含历史记录）→ 保留
    // 不在列表 = 外部 mod 遗留 → 移入垃圾桶（保留原名，供 trash-restore 按原名找回）
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
  return { moved, skipped: false };
}

module.exports = { organizeDir, readIndexObj, parseIndexObj };
