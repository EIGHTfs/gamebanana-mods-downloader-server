// ============================================================
// gbmd-v3 - 文件夹合并（自旧项目保留，用户要求保留的功能）
// 用户原话：「文件夹合并功能是比如文件夹 Sandrone 根据映射重命名为 Sandrone – 桑多涅」
// 场景：同一角色有两个目录——「Sandrone – 桑多涅」（英文–中文规范）和「Sandrone」（纯英文）
// 合并规则：
//   · 纯英文目录名在 mapping roles 里查到中文 → 该目录是角色目录
//   · 同仓库下已有「英文 – 中文」规范目录 → 纯英文目录内容移入规范目录（重名跳过），空目录进 .trash
//   · 没有规范目录 → 纯英文目录按映射直接重命名为「英文 – 中文」（Sandrone → Sandrone – 桑多涅）
// 精确判定（避免误合并）：mod 名带 `-`（如 NPC - Calypso nude）不参与
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const cfg = require("../config");
const mapping = require("./mapping");

// 「英文 – 中文」格式 → 英文部分；非该格式（后非中文）返回 null
function roleEnOf(name) {
  const m = String(name || "").match(/^(.+?)\s*[\u2013\u2014]\s*([\u4e00-\u9fff].*)$/);
  return m ? m[1].trim() : null;
}

function normDirName(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, "");
}

// 扫描游戏根下各仓库分类目录，找可合并的角色目录（返回计划）
// 返回 [{ en, zh, cat, canonical, plain: [目录路径] }]
function findRoleDuplicates(root, game) {
  const groups = new Map(); // cat|en -> { en, zh, cat, canonical, plain: [] }
  if (!root || !fs.existsSync(root)) return [];
  let cats = [];
  try { cats = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch (_) { return []; }
  for (const cat of cats) {
    if (cat.name.startsWith(".")) continue;
    const catDir = path.join(root, cat.name);
    let dirs = [];
    try { dirs = fs.readdirSync(catDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")); } catch (_) { continue; }
    for (const d of dirs) {
      const full = path.join(catDir, d.name);
      const enOf = roleEnOf(d.name);
      // 中文名（该角色的中文译名，用于无规范目录时直接重命名）
      let zh = "";
      if (enOf) {
        zh = mapping.roleZhOf(enOf, game) || "";
      } else {
        // 纯英文目录：查映射是否有中文 → 可重命名为「英文 – 中文」
        zh = mapping.roleZhOf(d.name, game) || "";
      }
      const en = enOf || d.name;
      const key = cat.name + "|" + normDirName(en);
      if (!groups.has(key)) groups.set(key, { en, zh, cat: cat.name, canonical: null, plain: [] });
      const g = groups.get(key);
      if (enOf) {
        if (!g.canonical) g.canonical = full;
      } else {
        g.plain.push(full);
      }
    }
  }
  // 只保留：有中文映射的角色目录组（纯英文 且 有 zh；或 有规范目录+纯英文）
  const dups = [];
  for (const g of groups.values()) {
    if (g.zh && g.plain.length) dups.push(g); // 有映射 → 可重命名/合并
  }
  return dups;
}

// 递归合并：把 src 里独有的文件/子目录移入 dst（同名文件跳过不覆盖；同名子目录递归合并内容）
// 返回移动的文件数
// 2026-08-26 修复（实测：合并后英文目录还在——同名子目录整体跳过，内容没并进去）：
//   同名子目录 → 递归合并 src 独有的内容进 dst 的同名子目录，而不是整体跳过
function mergeTree(src, dst) {
  let moved = 0;
  try {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name);
      const d = path.join(dst, ent.name);
      if (ent.isDirectory()) {
        if (fs.existsSync(d)) {
          moved += mergeTree(s, d); // 同名子目录 → 递归合并内容
          try {
            const rest = fs.readdirSync(s).filter((n) => n !== "@eaDir");
            if (rest.length === 0) fs.rmdirSync(s);
          } catch (_) {}
        } else {
          try { fs.renameSync(s, d); moved++; } catch (_) {}
        }
      } else {
        if (fs.existsSync(d)) {
          // 2026-08-26 修复（实测合并不干净）：同名 description.html → 源壳删除（HTML 本就该
          //   以目标/最新为准，重复壳留下会导致英文目录永远清不空）；其他同名文件 → 保留目标不覆盖
          if (ent.name === "description.html") {
            try { fs.unlinkSync(s); } catch (_) {}
          }
          continue;
        }
        try { fs.renameSync(s, d); moved++; } catch (_) {}
      }
    }
  } catch (_) {}
  return moved;
}

// 合并执行：纯英文目录 → 重命名为「英文 – 中文」；已有规范目录则内容并入
function executeMerge(dups, dryRun, root) {
  const merged = [], skipped = [], trashed = [];
  const trashRoot = path.join(root, ".trash");
  for (const g of dups || []) {
    const canonicalName = `${g.en} – ${g.zh}`;
    for (const plain of g.plain) {
      const canonical = g.canonical || path.join(path.dirname(plain), canonicalName);
      if (dryRun) {
        merged.push({ from: plain, to: canonical, dryRun: true });
        continue;
      }
      try {
        if (path.resolve(plain) === path.resolve(canonical)) continue;
        fs.mkdirSync(canonical, { recursive: true });
        let files = 0;
        for (const ent of fs.readdirSync(plain, { withFileTypes: true })) {
          const src = path.join(plain, ent.name);
          const dst = path.join(canonical, ent.name);
          if (fs.existsSync(dst)) {
            // 2026-08-26 修复（实测：合并后英文目录还在——同名子目录整体跳过，内容没并进去）：
            //   同名子目录 → 递归合并（src 独有的文件/子目录移入 dst），文件重名才跳过
            if (ent.isDirectory()) {
              files += mergeTree(src, dst);
              try {
                const rest = fs.readdirSync(src).filter((n) => n !== "@eaDir");
                if (rest.length === 0) fs.rmdirSync(src);
              } catch (_) {}
            } else {
              skipped.push({ from: src, to: dst, reason: "重名跳过" });
            }
            continue;
          }
          fs.renameSync(src, dst);
          files++;
        }
        // 空目录进 .trash（可恢复，不直接删）
        const rest = fs.readdirSync(plain).filter((n) => n !== "@eaDir");
        if (rest.length === 0) {
          fs.mkdirSync(trashRoot, { recursive: true });
          const trash = path.join(trashRoot, new Date().toISOString().replace(/[:.]/g, "-") + "-" + path.basename(plain));
          fs.renameSync(plain, trash);
          trashed.push(trash);
        }
        merged.push({ from: plain, to: canonical, files, trash: rest.length === 0 ? trashed[trashed.length - 1] : "" });
      } catch (e) {
        skipped.push({ from: plain, to: canonical, reason: e.message || String(e) });
      }
    }
  }
  return { merged, skipped, trashed };
}

module.exports = { roleEnOf, findRoleDuplicates, executeMerge };
