// ============================================================
// gbmd-v3 - 配置管理（零依赖）
// config.json 自动生成，缺失时使用默认值。密码 scrypt 哈希存储。
// 下载根目录不再放 config.json（旧版 gamesRootMap 已移除）——
// 改为读 json/gamebanana.com.json 的 downloadPath（网页设置直接改这个文件）。
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_PATH = path.join(__dirname, "config.json");
const SHARED_JSON_DIR = path.join(__dirname, "..", "json");
const GAME_PATH = path.join(SHARED_JSON_DIR, "gamebanana.com.json");
const MAPPING_DIR = path.join(__dirname, "..", "mapping");

const DEFAULT_CONFIG = {
  port: 8642,
  passwordHash: "",
  passwordSalt: "",
  // GameBanana 登录 cookie（NSFW/需登录文件下载用），手动从浏览器抓取填入
  gbCookie: "",
  // 会话超时（小时），到期需重新登录
  sessionHours: 72,
  // 并发下载数
  downloadConcurrency: 4,
  // 2026-08-27 用户要求：找回模式——开启后下载任务不实际下载文件，
  //   只做 prepareMod（垃圾桶找回/归位/HTML 生成），需下载的项直接标记跳过
  restoreOnly: false,
  // GB 登录检测用 NSFW mod（hide 可见性，未登录拉不到文件列表）
  gbCheckModId: 708465
};

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return Object.assign({}, DEFAULT_CONFIG, c);
    }
  } catch (_) {}
  return Object.assign({}, DEFAULT_CONFIG);
}

function writeConfig(obj) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), "utf8");
}

// 哈希密码：scrypt（返回 {hash, salt}，hex 编码）
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const test = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(test, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setPassword(password) {
  const { hash, salt } = hashPassword(password);
  const cfg = readConfig();
  cfg.passwordHash = hash;
  cfg.passwordSalt = salt;
  writeConfig(cfg);
  return true;
}

function hasPassword() {
  const cfg = readConfig();
  return !!(cfg.passwordHash && cfg.passwordSalt);
}

// ---------- 游戏列表（json/gamebanana.com.json）----------
// 记录：游戏名（GB 英文名做 key，网页显示中文 cn）、香蕉网 id、下载目录路径根目录（downloadPath）
function readGame() {
  if (!fs.existsSync(GAME_PATH)) {
    writeGame({});
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(GAME_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

function writeGame(obj) {
  fs.mkdirSync(path.dirname(GAME_PATH), { recursive: true });
  fs.writeFileSync(GAME_PATH, JSON.stringify(obj || {}, null, 2), "utf8");
}

// 游戏名归一化（忽略大小写/空格/冒号/连字符/下划线），查表用
function normalizeGameKey(name) {
  return String(name || "").toLowerCase().replace(/[\s\-_:：]/g, "");
}

// 查找游戏配置：先精确，再归一化，再按 id 匹配
function findGameEntry(gameNameOrId) {
  const games = readGame();
  if (games[gameNameOrId]) return { name: gameNameOrId, ...games[gameNameOrId] };
  const norm = normalizeGameKey(gameNameOrId);
  if (norm) {
    for (const [name, entry] of Object.entries(games)) {
      if (normalizeGameKey(name) === norm) return { name, ...entry };
    }
  }
  if (gameNameOrId != null && Number(gameNameOrId) > 0) {
    for (const [name, entry] of Object.entries(games)) {
      if (entry && Number(entry.id) === Number(gameNameOrId)) return { name, ...entry };
    }
  }
  return null;
}

// 取游戏下载根目录（gamebanana.com.json downloadPath）
function gameRootOf(gameName) {
  const e = findGameEntry(gameName);
  return e ? String(e.downloadPath || "").trim() : "";
}

// 游戏 id（香蕉网权威 id）
function gameIdOf(gameName) {
  const e = findGameEntry(gameName);
  return e && e.id ? Number(e.id) : 0;
}

// ---------- 映射（mapping/<游戏名>.json）----------
// 代码内部默认映射（仅在没有对应游戏的 mapping JSON 时生效）：
//   Characters → 角色 / Weapons → 武器 / Skins → 角色/.角色
//   （2026-08-26 用户要求：Skins 映射为 角色/.角色——角色仓库隐藏其他区；mapping 文件存在时以文件为准，
//     如崩坏3 skins → 女武神/.女武神）
const CODE_WAREHOUSE_DEFAULTS = {
  characters: "角色",
  character: "角色",
  weapons: "武器",
  weapon: "武器",
  skins: "角色/.角色",
  skin: "角色/.角色",
  ui: "UI",
  interface: "UI",
  "user interface": "UI",
  npcs: "NPC",
  npc: "NPC",
  enemies: "敌人",
  enemy: "敌人",
  objects: "Objects",
  object: "Objects",
  models: "模型",
  audio: "音频",
  music: "音乐",
  effects: "特效",
  environment: "场景",
  maps: "地图",
  gameplay: "玩法",
  textures: "贴图",
  tools: "工具",
  other: "其他",
  misc: "其他"
};

// 读取某游戏的 mapping 文件；不存在返回 null（此时用代码内部默认）
function readGameMapping(gameName) {
  if (!gameName) return null;
  const file = path.join(MAPPING_DIR, gameName + ".json");
  if (!fs.existsSync(file)) {
    // 归一化文件名（大小写/空格差异）再试一次
    const norm = normalizeGameKey(gameName);
    if (!norm) return null;
    let hit = null;
    try {
      for (const f of fs.readdirSync(MAPPING_DIR)) {
        if (f.endsWith(".json") && normalizeGameKey(f.slice(0, -5)) === norm) { hit = f; break; }
      }
    } catch (_) {}
    if (!hit) return null;
    const f2 = path.join(MAPPING_DIR, hit);
    try { return JSON.parse(fs.readFileSync(f2, "utf8")); } catch (_) { return null; }
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// 2026-08-26 用户要求（文件夹合并新增功能）：手动添加角色映射 → 写入 mapping/<游戏名>.json
// 参数：game 游戏名、en 英文名、zh 中文名；写入 roles[en]=zh + variants[zh]=en（搜索归一）
function addRoleMapping(game, en, zh) {
  en = String(en || "").trim();
  zh = String(zh || "").trim();
  if (!game) throw new Error("请选择游戏");
  if (!en || !zh) throw new Error("需要填写英文名和中文名");
  const file = path.join(MAPPING_DIR, game + ".json");
  if (!fs.existsSync(file)) throw new Error(`没有 ${game} 的映射文件（mapping/${game}.json）`);
  const map = readGameMapping(game);
  if (!map || typeof map !== "object") throw new Error(`映射文件读取失败: ${game}`);
  map.roles = map.roles || {};
  map.variants = map.variants || {};
  map.roles[en] = zh;
  if (zh !== en) map.variants[zh] = en;
  fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
  return { ok: true, game, en, zh };
}

module.exports = {
  readConfig,
  writeConfig,
  hashPassword,
  verifyPassword,
  setPassword,
  hasPassword,
  readGame,
  writeGame,
  findGameEntry,
  gameRootOf,
  gameIdOf,
  normalizeGameKey,
  readGameMapping,
  addRoleMapping,
  CODE_WAREHOUSE_DEFAULTS,
  CONFIG_PATH,
  GAME_PATH,
  MAPPING_DIR
};
