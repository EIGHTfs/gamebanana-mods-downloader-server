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
// ============================================================
// 重写 findRoleDuplicates（2026-08-31）：支持 variants 变体目录 → 合并到 roles 标准目录
// 用户原话：「文件夹合并功能有问题，文件夹是变体里的不能合并成按roles」「有 – 分割就是文件夹两边
//   任意一个在变体里就是不符合，没有 – 分割就是文件夹整体要在变体里（一般这种就是纯英文，纯中文情况）」
// 用户原话：「包括Nekomiya Mana – 猫又·玛娜，我json手动修改成了 "Nekomiya Mana": "猫宫又奈"，
//   Nekomiya Mana – 猫又·玛娜也会被合并成Nekomiya Mana – 猫宫又奈」
// 判定规则：
//   · 目录名有「–」格式：拆 en/zh 两部分；en 命中 roles key 或 variants 英文条目 → 归属该角色；
//     否则 zh 命中 roles value 或 variants 中文条目 → 归属该角色
//   · 目录名无「–」（纯英文/纯中文）：整体命中 roles key/value 或 variants 条目 → 归属该角色
//   · 归属角色后：目录名 === `${标准en} – ${标准zh}` → canonical（标准目录）；
//     否则（变体命名/中文不符）→ plain（需要并入标准目录；标准目录不存在则重命名）
//   · 不匹配任何角色 → 跳过不动（如放错位置的 mod 文件夹 Nico cosplay 東雪蓮 等）
// 生效范围不变：只扫 root/cat/*（角色分类层直接子目录），不进入 mod 文件夹
// ============================================================
// 构建「角色名(标准/变体) → 标准角色 {en, zh}」查找表
// 用户原话：变体「就是为了让你找到标准roles合并」——表的作用就是把任意变体名映射回标准组合
function buildRoleLookup(game) {
  const gameMap = cfg.readGameMapping(game) || {};
  const roles = (gameMap.roles) || {};
  const variants = (gameMap.variants) || {};
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const byEn = new Map(); // 英文(含变体英文) → 标准 {en, zh}
  const byZh = new Map(); // 中文(含变体中文) → 标准 {en, zh}
  for (const [en, zh] of Object.entries(roles)) {
    const role = { en, zh };
    byEn.set(norm(en), role); // 标准英文
    byZh.set(norm(zh), role); // 标准中文
    const arr = Array.isArray(variants[zh]) ? variants[zh] : [];
    for (const v of arr) {
      const n = norm(v);
      if (/[\u4e00-\u9fff]/.test(v)) byZh.set(n, role); // 中文变体 → 中文侧
      else byEn.set(n, role);                              // 英文变体 → 英文侧
    }
  }
  return { byEn, byZh, norm };
}

function findRoleDuplicates(root, game) {
  const { byEn, byZh, norm } = buildRoleLookup(game);
  const groups = new Map(); // cat|标准en -> { en, zh, cat, canonical, plain: [] }
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
      // 拆「英文 – 中文」：parts[0]=en、parts[1]=zh（无 – 时整体当名字查）
      const parts = String(d.name).split(/\s*[\u2013\u2014]\s*/);
      const enPart = parts.length > 1 ? parts[0].trim() : "";
      const zhPart = parts.length > 1 ? parts[1].trim() : "";
      let role = null;
      if (enPart) role = byEn.get(norm(enPart)) || null;      // 英文侧（标准/变体）优先
      if (!role && zhPart) role = byZh.get(norm(zhPart)) || null; // 中文侧兜底
      if (!role && !enPart) role = byEn.get(norm(d.name)) || byZh.get(norm(d.name)) || null; // 无 – 整体查
      if (!role) continue; // 不匹配任何角色 → 跳过（放错位置的 mod 目录不动）
      const canonicalName = role.en + " – " + role.zh;
      const key = cat.name + "|" + norm(role.en);
      if (!groups.has(key)) groups.set(key, { en: role.en, zh: role.zh, cat: cat.name, canonical: null, plain: [] });
      const g = groups.get(key);
      if (d.name === canonicalName) {
        if (!g.canonical) g.canonical = full; // 标准目录名精确匹配 → canonical
      } else {
        g.plain.push(full); // 变体命名/中文不符 → 待合并（并入 canonical；无则重命名）
      }
    }
  }
  // 只保留：有待合并目录的角色组
  const dups = [];
  for (const g of groups.values()) {
    if (g.plain.length) dups.push(g);
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
          //   以目标/最新为准，重复壳留下会导致英文目录永远清不空）
          // 2026-08-30 修复（实测：纯英文目录与规范目录同名子目录文件完全重复时，跳过文件留在
          //   源目录 → 源目录清不空 → 不进垃圾桶残留）——同名文件且大小一致 → 视为重复副本，
          //   从源删除（目标已有同一份）；大小不同 → 可能是不同版本，保留目标不覆盖
          if (ent.name === "description.html") {
            try { fs.unlinkSync(s); } catch (_) {}
          } else {
            let same = false;
            try { same = fs.statSync(s).size === fs.statSync(d).size; } catch (_) {}
            if (same) { try { fs.unlinkSync(s); moved++; } catch (_) {} }
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

// ============================================================
// 清空空文件夹（2026-08-31 用户要求增加网页手动功能）
// 用户原话：「设置里面 文件夹合并（按映射重命名角色目录）里面加个手动功能，清空空文件夹
//   （仅含HTML也算），也是选择游戏，要带被清空目录预览」
// 空壳定义：目录内除 @eaDir（群晖元数据目录）外没有任何条目 = 完全空；
//   或仅含 .html/.htm 文件（如 description.html）= 仅含HTML空壳（用户：仅含HTML也算）
// 安全：不直接删除，一律 rename 进 root/.trash（可恢复，符合 safe-delete-trash 铁律）
// 递归扫描整个游戏根，跳过 .trash 与 @eaDir；后序遍历（先处理子目录再判断父级）
function findEmptyDirs(root) {
  const empty = [];
  if (!root || !fs.existsSync(root)) return empty;
  const isHTML = (n) => /\.(html?|htm)$/i.test(n);
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "@eaDir" && e.name !== ".trash") {
        walk(path.join(dir, e.name)); // 先深入子目录
      }
    }
    // 再判断本目录：除 @eaDir 外无任何条目 = 完全空
    const real = entries.filter((e) => e.name !== "@eaDir");
    if (real.length === 0) { empty.push(dir); return; }
    // 仅含 HTML 文件（无子目录、无其他文件）= 空壳也算（用户：仅含HTML也算）
    const allHTML = real.every((e) => !e.isDirectory() && isHTML(e.name));
    if (allHTML) { empty.push(dir); }
  };
  walk(root);
  return empty;
}

// 执行清空：把空壳目录整体 rename 进 root/.trash（可恢复），与合并共用 .trash 目录
function cleanupEmptyDirs(emptyDirs, dryRun, root) {
  const cleared = [], skipped = [];
  const trashRoot = path.join(root, ".trash");
  for (const dir of (emptyDirs || [])) {
    if (dryRun) { cleared.push({ dir, dryRun: true }); continue; }
    try {
      // 执行前复核仍为空壳（防止预览后目录内新增了文件）
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== "@eaDir");
      const isHTML = (n) => /\.(html?|htm)$/i.test(n);
      const stillEmpty = entries.length === 0 || entries.every((e) => !e.isDirectory() && isHTML(e.name));
      if (!stillEmpty) { skipped.push({ dir, reason: "执行时已非空壳" }); continue; }
      fs.mkdirSync(trashRoot, { recursive: true });
      const trash = path.join(trashRoot, new Date().toISOString().replace(/[:.]/g, "-") + "-" + path.basename(dir));
      fs.renameSync(dir, trash);
      cleared.push({ dir, trash });
    } catch (e) {
      skipped.push({ dir, reason: e.message || String(e) });
    }
  }
  return { cleared, skipped };
}

module.exports = { roleEnOf, findRoleDuplicates, executeMerge, findEmptyDirs, cleanupEmptyDirs };
