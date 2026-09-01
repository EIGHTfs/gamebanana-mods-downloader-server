#!/usr/bin/env node
// ============================================================
// gen-mapping.js —— 按官方角色名单 + 磁盘目录反查，生成/重建 映射文件（mapping/<游戏名>.json）
//
// 依据：docs/gbmd-香蕉网角色名获取与映射文件规范-20260830.md 第 3.4 节生成逻辑
//   · roles   ：官方英文全名 → 规范中文，一对一（不出现简写 key）
//   · variants：规范中文 → 变体数组（含中文简写 + 英文变体，供搜索归一化/目录合并）
//   三条铁律：roles 只用官方名；数组必含规范中文+规范英文；变体宁缺毋滥（歧义舍弃）
//
// 用法：
//   node scripts/gen-mapping.js <游戏名> [--root <下载根目录>] [--write] [--out <输出路径>]
//
//   <游戏名>      必填。官方名单取自 json/role/<游戏名>.json 的 characters（需先抓过角色列表）
//   --root <路径> 可选。磁盘目录反查源：扫描该根目录下「英文 – 中文」文件夹，用中文部分当规范中文
//                 （默认自动读 json/gamebanana.com.json 该游戏 downloadPath；无则跳过反查）
//   --write       默认 dryrun（只打印生成结果与反查命中，不写任何文件）；加 --write 才写 mapping 文件
//   --out <路径>  指定输出文件（默认 mapping/<游戏名>.json）
//
// 安全：不加 --write 绝不触碰磁盘上的 mapping 文件；目录反查只读。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

// ---------- 路径 ----------
const ROOT = path.join(__dirname, "..");
const MAPPING_DIR = path.join(ROOT, "mapping");
const ROLE_DIR = path.join(ROOT, "json", "role");
const GAME_FILE = path.join(ROOT, "json", "gamebanana.com.json");

// ---------- 参数 ----------
const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const gameArg = args.find((a) => !a.startsWith("--"));
const writeMode = args.includes("--write");
const rootArg = argVal("--root");
const outArg = argVal("--out");

if (!gameArg) {
  console.error("用法: node scripts/gen-mapping.js <游戏名> [--root <下载根目录>] [--write] [--out <路径>]");
  process.exit(1);
}

// ---------- 工具 ----------
const normEn = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normZh = (s) => String(s || "").replace(/[\s·・]/g, "");

// ---------- 非法字符映射（2026-09-02 用户要求：生成脚本处理映射文件里的非法字符）----------
// 读取全局 mapping/illegalChars.json；key=非法字符 → value=合规字符。
// 用途：
//   1) 官方英文名含非法字符（如半角冒号 Yangyang: Xuanling）→ 自动补清洗后的全角变体进 variants，
//      这样「合并/反查/搜索」同时支持半角与全角两种写法，角色目录不被 8.3 短名化；
//   2) roles key 保持官方英文名（半角）不变——搜索/归一化仍以官方名匹配。
const ILLEGAL_CHARS_FILE = path.join(MAPPING_DIR, "illegalChars.json");
function loadIllegalChars() {
  try {
    if (fs.existsSync(ILLEGAL_CHARS_FILE)) {
      const m = JSON.parse(fs.readFileSync(ILLEGAL_CHARS_FILE, "utf8"));
      if (m && typeof m === "object") return m;
    }
  } catch (_) {}
  return {};
}
const illegalCharsMap = loadIllegalChars();
// 对字符串应用非法字符映射（split/join 全局替换，避开正则特殊字符）
function applyIllegalChars(s, map) {
  let str = String(s == null ? "" : s);
  for (const [k, v] of Object.entries(map || {})) {
    if (!k) continue;
    str = str.split(k).join(String(v));
  }
  return str;
}
// 官方英文名清洗后 ≠ 原名 → 返回清洗版本（作为全角变体）；否则 null
function cleanedVariantOf(en) {
  const cleaned = applyIllegalChars(en, illegalCharsMap);
  return cleaned !== en ? cleaned : null;
}

// 短名 → 官方名：词级相等 或 前缀 或 后缀
function isRelated(short, full) {
  const sn = normEn(short);
  const fn = normEn(full);
  if (!sn || !fn || sn === fn) return false;
  const ws = String(full).toLowerCase().split(/\s+/);
  return ws.some((w) => normEn(w) === sn) || fn.startsWith(sn) || fn.endsWith(sn);
}

// 唯一命中才返回官方名；多候选返回 null（宁缺毋滥）；完全等名直接返回自身
function resolveEn(short, official) {
  const sn = normEn(short);
  if (!sn) return null;
  const exact = official.find((o) => normEn(o) === sn);
  if (exact) return exact;
  const cands = official.filter((o) => isRelated(short, o));
  if (cands.length === 1) return cands[0];
  return null; // 0 或 ≥2 → 舍弃
}

// ---------- 读取输入 ----------
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`⚠️ 读取失败 ${file}: ${e.message}`);
    return null;
  }
}

// 1) 官方名单（权威）
const roleCache = readJson(path.join(ROLE_DIR, `${gameArg}.json`));
const official = (roleCache && roleCache.characters) || [];
if (!official.length) {
  console.error(`❌ ${ROLE_DIR}/${gameArg}.json 无 characters（官方名单）。请先在网页「设置 → 重新获取角色」生成，或确认文件名`);
  process.exit(1);
}
console.log(`官方名单: ${official.length} 个角色（${ROLE_DIR}/${gameArg}.json）`);

// 2) 旧映射（合并基线）
const oldMap = readJson(path.join(MAPPING_DIR, `${gameArg}.json`)) || {};

// 3) 下载根目录（反查源；--root 优先，其次 gamebanana.com.json）
let scanRoot = rootArg;
if (!scanRoot) {
  const games = readJson(GAME_FILE) || {};
  const entry =
    games[gameArg] ||
    Object.values(games).find((e) => e && String(e.id) === String(roleCache && roleCache.gameId));
  scanRoot = entry && entry.downloadPath ? entry.downloadPath : "";
}
if (scanRoot && !fs.existsSync(scanRoot)) {
  console.error(`⚠️ 反查根目录不存在，跳过目录反查: ${scanRoot}`);
  scanRoot = "";
}

// ---------- 目录反查（dryrun 核心）----------
// 扫描 根目录 下任意深度的「英文 – 中文」文件夹（含空格包裹的短横线），提取中文部分
// 匹配：`<英文> – <中文>`（GB 规范目录名 = itemDirName 输出格式）
const dirHits = new Map(); // 规范英文 → 目录反查中文（首个命中）
let scannedDirs = 0;
// 2026-09-02 用户要求：只扫 2 层——仓库层（角色/武器/敌人…）一遍 + 里面角色目录一遍，
//   不要深挖整个目录树（原来扫 6 层会把 4k~5k 个目录都扫一遍，慢且没必要）。
//   角色目录就在 根目录/仓库层/角色目录 这层，更深的全是 mod 内容目录，反查无意义。
// depth 语义：scanDirs(root, 0) 扫 root 子项=仓库层；depth=1 扫仓库层子项=角色目录；
//   depth=2 已到角色目录内部（mod 内容），不再进入。
function scanDirs(dir, depth) {
  if (depth > 1) return; // 只到 角色目录 这一层（root=0, 仓库层=1, 角色目录=2，扫到 depth=1 的仓库层子项即止）
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === ".trash" || ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    scannedDirs++;
    const m = ent.name.match(/^(.+?)\s*–\s*(.+)$/);
    if (m) {
      const en = m[1].trim();
      const zh = m[2].trim();
      // 只收「英文部分与官方名单能对上」的目录（防把无关「A – B」目录当角色）
      if (resolveEn(en, official) && zh && !dirHits.has(en)) {
        dirHits.set(en, zh);
      }
    }
    scanDirs(full, depth + 1);
  }
}
if (scanRoot) {
  console.log(`目录反查: 扫描 ${scanRoot} ...`);
  scanDirs(scanRoot, 0);
  console.log(`目录反查: 扫了 ${scannedDirs} 个目录，命中「英文 – 中文」角色目录 ${dirHits.size} 个`);
}

// ---------- 规范中文判定（优先级：目录反查 > 旧 roles > 旧 variants 反查 > 兜底英文）----------
const oldRoles = oldMap.roles || {};
const oldVariants = oldMap.variants || {};

// 旧 variants 反查表：任意值（含数组元素，中文/英文）→ 中文 key
const variantZhOf = new Map();
for (const [zh, vv] of Object.entries(oldVariants)) {
  const arr = Array.isArray(vv) ? vv : [vv];
  for (const x of arr) {
    const key = String(x).trim();
    if (key && !variantZhOf.has(key)) variantZhOf.set(key, zh);
  }
}

function zhFor(en) {
  const enN = normEn(en);
  // ① 目录反查（最贴近磁盘现状）
  if (dirHits.has(en)) return dirHits.get(en);
  // ② 旧 roles 精确 key
  if (oldRoles[en]) return oldRoles[en];
  // ②' 旧 roles 归一化 key
  for (const [k, v] of Object.entries(oldRoles)) {
    if (normEn(k) === enN) return v;
  }
  // ③ 旧 variants 反查（英文变体唯一命中此官方名才用其中文）
  const zh = variantZhOf.get(en);
  if (zh) return zh;
  for (const [x, z] of variantZhOf) {
    if (normEn(x) === enN) return z;
  }
  // ④ 兜底
  return en;
}

// ---------- 生成 roles / variants ----------
const roles = {};
const variants = {};
const notes = []; // dryrun 提示（歧义/无法解析/兜底）

for (const en of official) {
  const zh = zhFor(en);
  roles[en] = zh;

  const arr = [zh, en];
  const zhN = normZh(zh);

  // 2026-09-02 用户要求：生成脚本处理映射文件里的非法字符。
  //   官方英文名含非法字符（半角冒号等）→ 自动补「清洗后的全角变体」进 variants，
  //   使合并/反查/搜索同时支持半角与全角两种写法（目录不被 8.3 短名化）。
  const cleaned = cleanedVariantOf(en);
  if (cleaned && !arr.includes(cleaned)) arr.push(cleaned);

  // 旧 roles 的英文 key：唯一命中官方名且非全等 → 变体
  for (const [k, v] of Object.entries(oldRoles)) {
    if (normEn(k) === normEn(en)) continue; // 就是它自己
    const hit = resolveEn(k, official);
    if (hit === en) {
      if (!arr.includes(k)) arr.push(k);
    } else if (hit === null && String(v) === zh) {
      // 未唯一命中官方名，但中文相同 → 中文简写可收（如旧「安东」→ 安东·伊万诺夫）
      if (!arr.includes(k)) arr.push(k);
    }
  }

  // 旧 variants 的中文 key / 数组值：中文 key 反查英文唯一命中此角色 → 收中文简写
  for (const [vk, vv] of Object.entries(oldVariants)) {
    const arrV = Array.isArray(vv) ? vv : [vv];
    // 中文 key 本身是变体（如「安东」）
    if (normZh(vk) === zhN && !arr.includes(vk)) {
      // 只有它能解析到该官方名（或其英文值能解析）才收，否则宁缺毋滥
      const enInArr = arrV.find((x) => /[a-z]/i.test(x));
      if (resolveEn(enInArr || vk, official) === en || resolveEn(vk, official) === en) {
        arr.push(vk);
      }
    }
    // 数组里的中文短名（如「安东」在 安东·伊万诺夫 的数组里）
    for (const x of arrV) {
      if (!/[a-z]/i.test(x)) continue; // 只处理英文值
      if (resolveEn(x, official) === en && !arr.includes(x)) arr.push(x);
    }
  }

  // 规范中文「·」前段（如 安东·伊万诺夫 → 安东）且旧 variants 有同值 → 收
  if (zh.includes("·")) {
    const head = zh.split("·")[0].trim();
    if (head && head !== zh && (oldVariants[head] !== undefined || variantZhOf.has(head))) {
      if (!arr.includes(head)) arr.push(head);
    }
  }

  // 去重 + 排序：规范中文在前，其余中文其次，英文按字母序在后
  const uniq = [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
  const zhItems = uniq.filter((x) => !/[a-z]/i.test(x));
  const enItems = uniq.filter((x) => /[a-z]/i.test(x)).sort((a, b) => a.localeCompare(b));
  const zhSorted = [zh, ...zhItems.filter((x) => x !== zh)].sort((a, b) => {
    const an = normZh(a);
    const bn = normZh(b);
    if (an === zhN) return -1;
    if (bn === zhN) return 1;
    return a.localeCompare(b, "zh");
  });
  variants[zh] = [...new Set([...zhSorted, ...enItems])]; // 兜底 zh===en 时去重
}

// 提示：官方名单里有、但旧 roles 有而官方没有的（通常不需要提示，roles 以官方为准）
const droppedKeys = Object.keys(oldRoles).filter((k) => !official.some((o) => normEn(o) === normEn(k)));
if (droppedKeys.length) {
  notes.push(`⚠️ 旧 roles 有 ${droppedKeys.length} 个 key 不在官方名单（已不写进 roles，但可能进了 variants）: ${droppedKeys.slice(0, 8).join(", ")}${droppedKeys.length > 8 ? " ..." : ""}`);
}

// ---------- 输出 ----------
// illegalChars 是独立全局文件 mapping/illegalChars.json（2026-09-02），不写进游戏映射
const out = { warehouses: oldMap.warehouses || {}, roles, variants };
const outPath = outArg || path.join(MAPPING_DIR, `${gameArg}.json`);
const json = JSON.stringify(out, null, 2) + "\n";

if (!writeMode) {
  console.log("\n================ DRYRUN（未写文件） ================");
  console.log(`roles: ${Object.keys(roles).length} 条 | variants: ${Object.keys(variants).length} 条`);
  if (notes.length) notes.forEach((n) => console.log(n));
  console.log("\n--- 目录反查命中（新中文来源） ---");
  if (dirHits.size) {
    for (const [en, zh] of dirHits) {
      console.log(`  ${en} → ${zh}`);
    }
  } else {
    console.log("  （无，中文来自旧映射/兜底）");
  }
  console.log("\n--- 变体样例（前 8 个角色） ---");
  Object.entries(variants)
    .slice(0, 8)
    .forEach(([zh, arr]) => console.log(`  ${zh}: ${JSON.stringify(arr)}`));
  console.log("\n--- 兜底中文=英文（缺中文，需人工补） ---");
  const noZh = Object.entries(roles).filter(([en, zh]) => zh === en);
  console.log(noZh.length ? noZh.map(([en]) => en).join("\n") : "  （无）");
  console.log(`\n将写入: ${outPath}（加 --write 生效）`);
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, "utf8");
  console.log(`✅ 已写入 ${outPath}（roles ${Object.keys(roles).length} / variants ${Object.keys(variants).length}）`);
  if (notes.length) notes.forEach((n) => console.log(n));
}
