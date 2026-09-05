// ============================================================
// gbmd-v3 - 映射与下载路径计算
// 规则（用户定义）：
//   · 下载目录 = gamebanana.com.json 中该游戏的 downloadPath（根目录）
//     + 仓库层 + 角色层 + [作者] mod名
//   · 香蕉网层级示例：Genshin Impact/Mods/Skins/Characters/Sandrone
//     - Skins 映射为空（该层跳过）
//     - Characters 是角色（仓库层 → 角色）
//     - Sandrone 是桑多涅（角色层目录名 = 「Sandrone – 桑多涅」，英文 – 中文）
//     → 下载路径 = 根目录/角色/Sandrone – 桑多涅/[PaimonTaxCollector] Sandrone NSFW
//   · 代码内部默认映射（Characters→角色 / Weapons→武器 / Skins→空）
//     仅在没有对应游戏的 mapping JSON 时生效；文件存在则以文件为准
//   · mapping/<游戏名>.json：warehouses（大仓库映射）+ roles（角色英文→中文）
//     + variants（搜索归一变体）
// ============================================================
"use strict";

const path = require("path");
const fs = require("fs");
const cfg = require("../config");

// ---------- 非法字符映射（最高优先级，2026-09-02）----------
// 独立全局映射文件 mapping/illegalChars.json：{ 非法字符: 合规字符 }，
// 生成目录名/文件名时最先应用（先于 roles/variants/warehouses 映射）。
// 例：{ ": ": "：" } → 半角冒号(Windows 非法，触发 8.3 短名) 换成全角冒号。
// 文件缺失/损坏时返回空映射（不替换任何字符）——行为完全由映射文件决定，代码不写死。
const ILLEGAL_CHARS_FILE = path.join(cfg.MAPPING_DIR, "illegalChars.json");
let _illegalCache = { mtime: 0, map: {} }; // 小缓存：mtime 变化才重读
function illegalCharsOf() {
  try {
    const st = fs.statSync(ILLEGAL_CHARS_FILE);
    if (st.mtimeMs === _illegalCache.mtime) return _illegalCache.map;
    const m = JSON.parse(fs.readFileSync(ILLEGAL_CHARS_FILE, "utf8"));
    if (m && typeof m === "object") {
      _illegalCache = { mtime: st.mtimeMs, map: m };
      return m;
    }
  } catch (_) {}
  return _illegalCache.map; // 读取失败时用上次缓存；从未成功过则空映射
}

// 应用非法字符映射：对 str 中每个 key 做全局替换（split/join 避开正则特殊字符）
function applyIllegalChars(str, map) {
  let s = String(str == null ? "" : str);
  for (const [k, v] of Object.entries(map || {})) {
    if (!k) continue;
    s = s.split(k).join(String(v));
  }
  return s;
}

// ---------- 名称合规化 ----------
// 非法字符全部来自 mapping/illegalChars.json（不再写死正则）；
// 控制字符（\u0000-\u001f）代码兜底仍替换为空格
function sanitizeName(name) {
  return applyIllegalChars(String(name == null ? "" : name), illegalCharsOf())
    .replace(/[\u0000-\u001f]/g, " ") // 控制字符 → 空格（代码兜底，不入映射文件）
    .replace(/\s+/g, " ")                        // 多个空格合并为一个
    .replace(/[. ]+$/g, "")                      // 去尾部点和空格（Windows）
    .trim();
}

// [作者] mod名（sanitize 后）
function buildModDirName(author, name) {
  const a = sanitizeName(author || "?");
  const n = sanitizeName(name || "");
  return "[" + a + "] " + n;
}

// ---------- 仓库层映射 ----------
// 小写归一
function normKey(s) {
  return String(s || "").toLowerCase().trim();
}

// 仓库查找：返回映射值（字符串，可为 ""=跳过该层）；未映射返回 undefined
// 优先查 mapping/<游戏>.json 的 warehouses；无该游戏文件时用代码内部默认
// 归一化仓库名用于匹配：转小写、去空格/连字符、去尾复数 s（Character Skins→characterskins→characterskin）
function normWarehouseKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/s$/, "");
}

function warehouseLookup(name, game) {
  const s = String(name || "").trim();
  if (!s) return undefined;
  const sk = normKey(s);
  const skHead = sk.split("/")[0].trim(); // 复合分类取前段（Other/Misc → other）
  const skNorm = normWarehouseKey(skHead || sk); // "character skins" → "characterskin"
  const gameMap = cfg.readGameMapping(game);
  const tryMatch = (map) => {
    if (!map) return undefined;
    if (map[sk] !== undefined) return String(map[sk]);
    if (skHead && map[skHead] !== undefined) return String(map[skHead]);
    // 2026-08-26 修复：模糊匹配——归一化键相等即可
    for (const [k, v] of Object.entries(map)) {
      const kn = normKey(k).replace(/[\s_-]+/g, "").replace(/s$/, "");
      if (kn === skNorm) return String(v);
    }
    // 首词匹配：Character Skins 的 skNorm=characterskin，映射有 characters（characters→character）→ 命中
    for (const [k, v] of Object.entries(map)) {
      const kn = normKey(k).replace(/[\s_-]+/g, "").replace(/s$/, "");
      if (skNorm.startsWith(kn)) return String(v);
      if (kn.startsWith(skNorm)) return String(v);
    }
    return undefined;
  };
  if (gameMap && gameMap.warehouses && typeof gameMap.warehouses === "object") {
    const hit = tryMatch(gameMap.warehouses);
    if (hit !== undefined) return hit;
    return undefined; // 文件存在但该键未映射（文件为准，不回退代码默认）
  }
  const defaults = cfg.CODE_WAREHOUSE_DEFAULTS;
  const dhit = tryMatch(defaults);
  if (dhit !== undefined) return dhit;
  return undefined;
}

// 大仓库 → 本地分类目录名（显示/已知仓库判定用；未映射给兜底名）
function warehouseLocalName(superCategory, game) {
  const v = warehouseLookup(superCategory, game);
  if (v !== undefined) return v;
  const s = String(superCategory || "").trim();
  if (!s) return "";
  const sk = normKey(s);
  const skHead = sk.split("/")[0].trim();
  if (cfg.readGameMapping(game)) return "其他"; // 有文件但未映射 → 其他
  if (sk.includes("/")) return s.charAt(0).toUpperCase() + skHead.slice(1);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 该仓库名是否「已知仓库」（有映射到非空目录）——用于判定层级
function isKnownWarehouse(name, game) {
  const mapped = warehouseLocalName(name, game);
  return mapped !== "" && mapped !== name;
}

// ---------- 角色层映射 ----------
// 角色/具体项英文名 → 「英文 – 中文」目录名（如 Sandrone → Sandrone – 桑多涅）
// 中文缺失时用纯英文名
function itemDirName(category, game) {
  const en = String(category || "").trim();
  if (!en) return "";
  const gameMap = cfg.readGameMapping(game);
  if (!gameMap) return en;
  const roles = (gameMap.roles) || {};
  const variants = (gameMap.variants) || {};
  const illegal = illegalCharsOf(); // 非法字符映射（全局 mapping/illegalChars.json，最高优先级，最后清洗输出）
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const enN = norm(en);
  let zh = roles[en] || "";
  if (!zh) {
    for (const [k, v] of Object.entries(roles)) {
      if (norm(k) === enN) { zh = v; break; }
    }
  }
  if (!zh && variants) {
    // 新规范：variants 数组含英文变体（Anton → 安东·伊万诺夫）
    for (const [vk, vv] of Object.entries(variants)) {
      const arr = Array.isArray(vv) ? vv : [vv];
      if (arr.some((x) => String(x).toLowerCase() === enN || norm(x) === enN)) { zh = vk; break; }
    }
  }
  if (zh && zh !== en) {
    // 用映射 key 的规范英文拼目录（大小写差异对齐：yanqing → YanQing；变体 Anton → 规范 Anton Ivanov）
    let canonEn = en;
    for (const [k, v] of Object.entries(roles)) {
      if (String(v) === zh && (norm(k) === norm(en) || norm(k) === enN)) { canonEn = k; break; }
    }
    if (canonEn === en && variants) {
      for (const [vk, vv] of Object.entries(variants)) {
        const arr = Array.isArray(vv) ? vv : [vv];
        if (vk === zh && arr.some((x) => norm(x) === enN)) {
          for (const [k, v] of Object.entries(roles)) {
            if (String(v) === zh) { canonEn = k; break; }
          }
          break;
        }
      }
    }
    return applyIllegalChars(`${canonEn} – ${zh}`, illegal); // 最高优先级：清洗目录名里的非法字符
  }
  return applyIllegalChars(en, illegal);
}

// 从角色映射判断某名字是否是「角色/具体项」（用于 Skins 层跳过后的处理）
function roleZhOf(name, game) {
  const en = String(name || "").trim();
  if (!en) return "";
  const gameMap = cfg.readGameMapping(game);
  if (!gameMap) return "";
  const roles = (gameMap.roles) || {};
  const variants = (gameMap.variants) || {};
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
  const enN = norm(en);
  if (roles[en]) return roles[en];
  for (const [k, v] of Object.entries(roles)) {
    if (norm(k) === enN) return v;
  }
  // 新规范：variants 数组含英文变体（Anton → 安东·伊万诺夫）
  if (variants) {
    for (const [vk, vv] of Object.entries(variants)) {
      const arr = Array.isArray(vv) ? vv : [vv];
      if (arr.some((x) => String(x).toLowerCase() === enN || norm(x) === enN)) return vk;
    }
  }
  return "";
}

// ---------- 下载路径计算 ----------
// mod = { game, name, author, superCategory, category }
// 返回 { root, warehouse, item, folderName, dir }
//   仓库层：superCategory 映射（Skins→空 时用 category 映射顶替仓库层，角色层留空）
//   角色层：category 映射为「英文 – 中文」
//   无角色层（只有大仓库）→ 直接 仓库/[作者] mod名
function buildTargetDir(mod) {
  const game = (mod && mod.game) || "";
  const root = cfg.gameRootOf(game);
  if (!root) {
    const err = new Error(`游戏 "${game}" 未在 gamebanana.com.json 中配置下载路径，请在网页设置里填写`);
    err.skip = true;
    throw err;
  }

  const scRaw = String((mod && mod.superCategory) || "").trim();
  const catRaw = String((mod && mod.category) || "").trim();

  let warehouse = "";
  let item = "";
  let otherZone = false; // 落「仓库/.仓库名」隐藏其他区

  const scVal = warehouseLookup(scRaw, game); // undefined=未映射；""=映射为空（Skins 跳过该层）

  // 2026-08-26 用户要求：Skins 映射为 "X/.X"（mapping 文件：崩坏3 → 女武神/.女武神；代码默认 → 角色/.角色）
  //   = 该层是「X 仓库的隐藏其他区」：无具体角色 → X/.X；category 是具体角色 → X/<角色>（该层视作跳过）；
  //   category 是其它仓库（如 Skins/Weapons）→ 该仓库的 .仓库名
  const ozMatch = String(scVal || "").match(/^(.+?)\s*\/\.\s*(.+)$/);
  if (ozMatch) {
    const ozWh = ozMatch[1].trim();
    if (catRaw && roleZhOf(catRaw, game)) {
      // category 是具体角色（Skins 下直接是 Ganyu）→ 归该游戏「角色」仓库
      warehouse = warehouseLookup("characters", game) || ozWh;
      item = itemDirName(catRaw, game);
    } else {
      const catWh = warehouseLookup(catRaw, game);
      warehouse = (catWh && catWh !== "" && !String(catWh).includes("/.")) ? catWh : ozWh;
      item = "";
      otherZone = true;
    }
  } else if (scVal === "" ) {
    // superCategory 映射为空（Skins）→ 该层跳过，用下一级（category）决定
    if (catRaw) {
      const catVal = warehouseLookup(catRaw, game);
      if (catVal !== undefined && catVal !== "") {
        warehouse = catVal; // 例：Skins/Characters → 角色（无具体角色）
      } else if (roleZhOf(catRaw, game)) {
        // category 是角色名（例：Skins 下直接是 Ganyu）→ 归该游戏「角色」仓库
        warehouse = warehouseLookup("characters", game) || "角色";
        item = itemDirName(catRaw, game);
      } else {
        warehouse = "其他";
      }
    } else {
      warehouse = "其他";
    }
  } else if (scVal === undefined) {
    // superCategory 未映射：缺失或文件缺键 → category 顶替大仓库
    if (scRaw) {
      warehouse = warehouseLocalName(scRaw, game) || "其他";
    } else if (catRaw) {
      // 2026-08-26 补充：super 缺失时 category 若是具体角色 → 归该游戏「角色」仓库
      if (roleZhOf(catRaw, game)) {
        warehouse = warehouseLookup("characters", game) || "角色";
        item = itemDirName(catRaw, game);
      } else {
        warehouse = warehouseLookup(catRaw, game);
        if (warehouse === undefined || warehouse === "") warehouse = "其他";
      }
    } else {
      warehouse = "其他";
    }
    item = item == null ? "" : item;
  } else {
    // 正常：superCategory 是大仓库，category 是具体项（角色）
    warehouse = scVal;
    item = itemDirName(catRaw, game);
  }

  // 2026-08-26 用户要求：「把香蕉网上的分类 Characters / Skins 映射成 角色/.角色 文件夹（注意后面有点）」
  // 场景：角色大仓库下的「皮肤」子类、没有具体角色（super=Skins+cat=Characters，或复合串 "Characters / Skins"，
  //   或反之 Characters+Skins）→ 归 角色/.角色（角色仓库的隐藏其他区，前面有点）
  // 2026-08-26 AI 思路：warehouse 取该游戏「角色」仓库映射（原神/星铁=角色、崩坏3=女武神），item 留空，
  //   目录用「仓库/.仓库名」形态（与旧项目无 item 落其他区一致，用户要求恢复此形态）
  const scN = normKey(scRaw).replace(/\s+/g, "");
  const catN = normKey(catRaw).replace(/\s+/g, "");
  const isCharsSkins =
    /^(characters|skins)\/(skins|characters)$/.test(scN) ||  // superCategory 复合串 "Characters/Skins"
    /^(characters|skins)\/(skins|characters)$/.test(catN) || // category 复合串
    (scN === "skins" && catN === "characters") ||            // Skins + Characters
    (scN === "characters" && catN === "skins");              // Characters + Skins
  if (isCharsSkins) {
    warehouse = warehouseLookup("characters", game) || "角色";
    item = "";
    otherZone = true;
  }
  // （Skins → X/.X 的映射已由 warehouseLookup 的 "X/.X" 值统一处理——见上方 ozMatch 分支；
  //   崩坏3 文件 skins=女武神/.女武神、代码默认 skins=角色/.角色，无需再硬编码）

  // 大仓库为基准：superCategory 与 category 相同（只有大仓库无具体项）→ 不分类到具体角色
  if (scRaw && catRaw && normKey(scRaw) === normKey(catRaw)) item = "";

  // 2026-08-26 修复（实测：super 空 + cat=Skins 时仓库拿到原样 "女武神/.女武神"，
  //   无 item 规则再拼 "." 产生 女武神/.女武神/.女武神/.女武神 四级嵌套）：
  //   映射值含 "/."（X/.X 其他区）无论从哪个分支进来，最终只解析一次——
  //   拆成 仓库名 + otherZone，dir 构造只补一个 "."，杜绝多次映射链式拼接
  const slashDot = String(warehouse || "").match(/^(.+?)\s*\/\.\s*(.+)$/);
  if (slashDot) {
    warehouse = slashDot[1].trim();
    otherZone = true;
    item = "";
  }

  const folderName = buildModDirName(mod.author, mod.name);
  const wh = warehouse || "其他";
  const it = item;

  let dir;
  if (it) dir = path.join(root, wh, it, folderName);
  else if (otherZone) dir = path.join(root, wh, "." + wh, folderName); // Characters/Skins → 角色/.角色（前面有点）
  // 2026-08-26 用户要求（实测：装备/.装备 有 mod 却被重下到 武器/）：无具体 item 的 mod
  //   一律落 仓库/.仓库名（隐藏其他区，与旧项目「全部无item都进.仓库名」一致）；「其他」保持仓库根
  else if (wh !== "其他") dir = path.join(root, wh, "." + wh, folderName);
  else dir = path.join(root, wh, folderName);

  return { root, warehouse: wh, item: it, folderName, dir };
}

module.exports = {
  sanitizeName,
  buildModDirName,
  warehouseLocalName,
  itemDirName,
  roleZhOf,
  isKnownWarehouse,
  buildTargetDir,
  illegalCharsOf,
  applyIllegalChars
};
