// ============================================================
// gbmd-v3 - 下载功能（完全重写，旧代码仅供参考）
//
// 用户定义的下载流程（严格按四步，旧项目整理功能全部移除）：
//   第一步（生成 HTML）：
//     输入：香蕉网 mod 地址（https://gamebanana.com/mods/704164 或 704164 均可）
//     根据网页（GB ProfilePage API）生成 HTML 文件，记录：
//       - 标题/作者/游戏/分类（分类 = category / superCategory）
//       - 文件列表（压缩包 md5、大小）、图片名（图片名本身就是 md5）、gif
//     同时算出下载路径 = gamebanana.com.json 中该游戏 downloadPath 根目录
//       + 仓库层（Characters→角色 / Weapons→武器 / Skins→空，per-game mapping 优先）
//       + 角色层（Sandrone → Sandrone – 桑多涅，英文 – 中文）
//       + [作者] mod名
//   第二步（查重归位）：
//     在整个游戏根目录范围搜索压缩包名、图片名；若存在于其他文件夹
//     → 直接 mv 该文件夹为计算出的完整下载路径（文件夹内全部文件完整保留），
//       并将 HTML 存于此文件夹（原有 HTML 则覆盖）
//   第三步（整理阶段）：
//     通过 HTML 检查文件完整性：
//       - 同名 .gbmd.part 处理：主文件+part 都存在 → 删 part；
//         仅 part 存在 → 未下载完，支持断点续传
//       - 文件夹内全部图片文件重命名为图片 hash 值（内容 md5），
//         不保留重复图片，重复的移入根目录垃圾桶文件夹（<根>/.trash）
//   第四步（正式下载）：
//     按 HTML 文件列表下载缺失文件（并发、.part+Range 断点续传、失败重试）；
//     不改原始文件名，除非含 Windows/Linux 非法字符 → 用空格替换
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const cfg = require("../config");
const gbApi = require("./gb-api");
const mapping = require("./mapping");
const organize = require("./organize");

// 2026-08-26 性能优化（实测 images.gamebanana.com 首连接 28-30s，keep-alive 复用后 0.7s）：
//   下载连接池——并发下载图片/文件时复用 TCP/TLS 连接，避免每文件吃一次慢首连接
const KEEP_ALIVE_MS = 60000;
const HTTPS_AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MS, maxSockets: 64, maxFreeSockets: 32 });
const HTTP_AGENT = new http.Agent({ keepAlive: true, keepAliveMsecs: KEEP_ALIVE_MS, maxSockets: 64, maxFreeSockets: 32 });

const TASK_FILE = path.join(__dirname, "..", "download_task.json");
const MAX_RETRY = 3;
const RETRY_DELAY_MS = 1500;

// ---------- 工具 ----------
function fileMd5(filePath) {
  return new Promise((resolve) => {
    try {
      const hash = crypto.createHash("md5");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (c) => hash.update(c));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", () => resolve(""));
    } catch (_) { resolve(""); }
  });
}

function fileMd5Sync(filePath) {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
  } catch (_) { return ""; }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return isNaN(d.getTime()) ? "-" : d.toLocaleDateString("zh-CN");
}

function isImageExt(name) {
  return /\.(jpg|jpeg|png|webp|bmp)$/i.test(String(name || ""));
}

// ---------- HTML 索引块（机器可读，供 2/3/4 步复用）----------
const INDEX_TAG_ID = "gbmd-index";

function buildIndexBlock(obj) {
  return `<script id="${INDEX_TAG_ID}" type="application/json">\n` +
    JSON.stringify(obj, null, 2) +
    `\n</script>`;
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

// ---------- 第一步：生成 HTML ----------
// 可见部分按用户规定的结构：
//   <h1>mod名</h1>
//   <p class="meta">作者 / 游戏 / 分类 / 版本 / 时间 / 原链接 / 下载路径</p>
//   + 文件列表（文件名/大小/MD5）+ 图片 + 描述（gif 外链替换为本地 gif_XXX.gif）
function buildHtmlContent(obj) {
  const cat = [obj.category, obj.superCategory].filter(Boolean).join(" / ");
  const filesHtml = (obj.files || [])
    .map((f) => `<tr><td>${escapeHtml(f.file)}</td><td>${fmtSize(f.size)}</td><td><code>${escapeHtml(f.gbMd5 || f.hash || "-")}</code></td><td>${f.exists ? "已存在" : ""}</td></tr>`)
    .join("");
  const imagesHtml = (obj.images || [])
    .map((img) => `<a href="${escapeHtml(img.file)}" target="_blank"><img src="${escapeHtml(img.file)}" loading="lazy" class="thumb" alt="preview"></a>`)
    .join("");
  let descText = obj.text || "<p>（无描述）</p>";
  if (obj.gifs && obj.gifs.length) {
    obj.gifs.forEach((g, i) => {
      // 2026-08-26：gif 按 GB 原名（g.file），描述外链替换为本地 GB 原名文件
      const localName = g.file || `gif_${String(i + 1).padStart(3, "0")}.gif`;
      if (g.url) descText = String(descText).split(g.url).join(localName);
    });
  }
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(obj.name || "")} - ${escapeHtml(obj.author || "")}</title>
<style>
  body{font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:960px;margin:0 auto;padding:24px;color:#222;background:#fafafa}
  h1{font-size:24px;margin:0 0 4px}
  .meta{color:#666;margin:0 0 16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin:16px 0}
  .thumb{width:100%;border-radius:6px;border:1px solid #ddd}
  table{width:100%;border-collapse:collapse;margin:16px 0;background:#fff}
  th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;font-size:13px;word-break:break-all}
  th{background:#f0f0f0}
  code{color:#0a58ca;font-size:11px}
  .desc{background:#fff;border:1px solid #eee;border-radius:8px;padding:16px;margin:16px 0}
  .desc img{max-width:100%}
  h2{font-size:18px;border-bottom:2px solid #eee;padding-bottom:4px;margin-top:24px}
</style>
</head>
<body>
  <h1>${escapeHtml(obj.name || "")}</h1>
  <p class="meta">
    作者：<strong>${escapeHtml(obj.author || "")}</strong><br>
    游戏：${escapeHtml(obj.game || "")}　分类：${escapeHtml(cat || "-")}<br>
    版本：${escapeHtml(obj.version || "-")}<br>
    提交时间：${fmtDate(obj.dateAdded)}　最后更新：${fmtDate(obj.dateModified)}<br>
    原链接：<a href="${escapeHtml(obj.url || "")}">${escapeHtml(obj.url || "")}</a><br>
    下载路径：${escapeHtml(obj.dir || "-")}
  </p>

  <h2>文件列表（${(obj.files || []).length}）</h2>
  <table>
    <tr><th>文件名</th><th>大小</th><th>MD5</th><th>状态</th></tr>
    ${filesHtml || "<tr><td colspan='4'>（无文件）</td></tr>"}
  </table>

  <h2>图片（${(obj.images || []).length}）</h2>
  <div class="grid">${imagesHtml || "<p>（无预览图）</p>"}</div>

  <h2>描述</h2>
  <div class="desc">${descText}</div>

  ${buildIndexBlock(obj)}
</body>
</html>`;
}

function writeIndexHtml(modDir, obj) {
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "description.html"), buildHtmlContent(obj), "utf8");
}

// ---------- 第一步：解析 + 算路径 + 生成 HTML ----------
async function genIndexHtml(url) {
  const mod = await gbApi.resolveMod(url);
  const target = mapping.buildTargetDir(mod); // 算下载路径（含映射）
  const existing = readIndexObj(target.dir) || null; // 旧 HTML 索引（合并图片 hash 用）
  const obj = {
    schema: 1,
    modId: mod.modId || "",
    name: mod.name || "",
    url: mod.profileUrl || "",
    author: mod.author || "",
    game: mod.game || "",
    category: mod.category || "",
    superCategory: mod.superCategory || "",
    warehouse: target.warehouse || "",
    item: target.item || "",
    dir: target.dir || "",
    version: mod.version || "",
    dateAdded: mod.dateAdded,
    dateModified: mod.dateModified,
    text: mod.text || "",
    // 2026-08-26 用户要求：HTML 追加合并——本地旧 HTML 的文件记录保留（含作者删掉/历史遗留的），
    //   网上获取的新文件记录追加/更新（不直接覆盖）。这样作者删掉的文件仍有记录可寻回。
    files: (() => {
      const merged = [];
      const seen = new Set();
      // ① 旧 HTML 记录（本地历史遗留，含网上已下架的）——保留
      for (const oldF of (existing && existing.files) || []) {
        if (!oldF || !oldF.file) continue;
        const key = String(oldF.file).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ file: oldF.file, url: oldF.url || "", size: oldF.size || 0, gbMd5: oldF.gbMd5 || "", description: oldF.description || "", hash: oldF.hash || "", legacy: true });
      }
      // ② 网上新文件记录——追加（同名则更新为最新）
      for (const f of mod.files || []) {
        const name = mapping.sanitizeName(f.file);
        const key = String(name).toLowerCase();
        const idx = merged.findIndex((x) => String(x.file).toLowerCase() === key);
        if (idx >= 0) {
          merged[idx] = { file: name, url: f.url || "", size: f.size || 0, gbMd5: String(f.md5 || "").toLowerCase(), description: f.description || "", hash: merged[idx].hash || "" };
        } else {
          merged.push({ file: name, url: f.url || "", size: f.size || 0, gbMd5: String(f.md5 || "").toLowerCase(), description: f.description || "", hash: "" });
        }
      }
      return merged;
    })(),
    images: (mod.images || []).map((img) => {
      const name = mapping.sanitizeName((img && img.file) || (img.url ? path.basename(String(img.url).split("?")[0]) : ""));
      // 2026-08-26 优化：合并旧 HTML 已记录的图片内容 hash（重下时据此判断「内容已在库」跳过/垃圾桶找回）
      // gbFile = GB 原始文件名（保留不变，供旧记录匹配；file 可能被整理改名成 md5）
      const old = (existing && existing.images || []).find((x) => x && (x.file === name || x.gbFile === name));
      return { file: name, gbFile: name, url: img.url || "", hash: (old && old.hash) || "" };
    }),
    // 2026-08-26 修复（用户要求：gif 也按 GB 原名）：gb-api 已把 gif 的原始 URL 文件名
    //   提取到 g.file（如 dlni606-ad685320.gif），不再强制改成 gif_XXX.gif 序列名——
    //   序列名是通用名（任何 mod 都有 gif_001.gif），会破坏按原名跳过/找回，也是 step2 误移帮凶。
    //   仅当 GB 原名缺失/非法时才回退序列名。
    gifs: (mod.gifs || []).map((g, i) => {
      const raw = String((g && g.file) || "").trim();
      const safe = raw && !/[/\\:*?"<>|]/.test(raw) ? raw : `gif_${String(i + 1).padStart(3, "0")}.gif`;
      return { file: safe, url: (g && g.url) || "" };
    }),
    history: []
  };
  return { mod, target, obj };
}

// ---------- 第二步：查重归位 ----------
// 在整个游戏根目录范围搜索「压缩包名、图片名」；存在于其他文件夹
// → 直接 mv 该文件夹为计算出的完整下载路径（文件夹内全部文件完整保留），HTML 存入
// 规则（用户原话）：「找到文件路径不对的已下载文件，正式下载时跳过这些文件」
// 候选文件夹判定：
//   · 排除隐藏/.trash/根目录本身
//   · 排除仓库层目录（名字是已知仓库名：角色/光锥/武器/UI/NPC/Objects/.Mods 等）——不能整体移动仓库
//   · 含子目录的候选只接受「[作者] mod名」或「mod名」文件夹（避免移动装有多 mod 的容器目录）
//   · 优先级：含压缩包 > 含图片；文件夹名是 [作者] mod名 > mod名 > 其他
// 2026-08-26 优化（用户反馈大批量「一直准备中」）：原来每个 mod 都整根遍历一次找同名文件，
//   140 个 mod 就要遍历 140 次 → 改为每游戏根建一次「文件名 → 目录」索引缓存（惰性 + 5 分钟 TTL，
//   每次任务开始清空重建），之后每个 mod 的查重 O(1) 查索引，批次内只遍历一次根
let rootNameIndexCache = new Map(); // root -> { at, files: Map<lowername, dir> }

function buildRootNameIndex(root) {
  const files = new Map(); // lowername -> [dir, ...]（2026-08-26：同名文件可能散落在多个旧目录，记数组）
  const stack = [root];
  // 2026-08-26 修复（实测根因）：原来跳过所有 "." 开头目录 → .装备/.武器/.女武神 等隐藏
  //   「其他区」里的文件对第二步不可见 → 旧副本找不到 → 重复下载。
  //   现在只跳过 垃圾桶/git/@eaDir，.仓库名 等其他区正常索引（还能顺带实现"从垃圾桶找回整夹"）
  const skipDirs = new Set([".trash", ".git", "@eaDir", ".DS_Store"]);
  while (stack.length) {
    const dir = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(p);
      } else if (e.isFile() && !e.name.startsWith(".")) {
        const key = String(e.name).toLowerCase();
        if (!files.has(key)) files.set(key, []);
        const arr = files.get(key);
        if (!arr.includes(dir)) arr.push(dir);
      }
    }
  }
  return files;
}

function rootNameIndex(root) {
  const now = Date.now();
  const cached = rootNameIndexCache.get(root);
  if (cached && now - cached.at < 5 * 60 * 1000) return cached.files;
  const files = buildRootNameIndex(root);
  rootNameIndexCache.set(root, { at: now, files });
  return files;
}

function clearRootNameIndex() {
  rootNameIndexCache.clear();
}

// 2026-08-26 用户澄清算法：「按文件名搜索所有根目录文件列表的文件名，然后移动所有旧目录
//   （判定旧目录不是裸仓库目录）」——即：全根文件名索引反查 → 每个匹配文件的所在目录都是
//   「旧目录」→ 只要不是裸仓库目录（角色/装备/武器/UI/其他/.Mods 等分类层），全部移动/合并到
//   计算路径（不再只挑一个候选）。含子目录的容器目录（如角色目录）仍只认 [作者] mod名/mod名，
//   避免把装多个 mod 的容器整体搬走。
// 返回排序后的候选目录数组（含压缩包优先、[作者]mod/mod名优先）
function findExistingDir(root, finalDir, mod, wantFiles) {
  if (!root || !fs.existsSync(root)) return [];
  if (!wantFiles || !Object.keys(wantFiles).length) return [];
  const normDir = path.resolve(finalDir);

  // 已知仓库名（映射值 + 原始 key + 特殊目录）：这些目录是分类层（裸仓库目录），不能整体移动
  const game = (mod && mod.game) || "";
  const knownWh = new Set();
  try {
    const gameMap = cfg.readGameMapping(game);
    const wm = (gameMap && gameMap.warehouses) || {};
    for (const [k, v] of Object.entries(wm)) {
      knownWh.add(String(k).toLowerCase().trim());
      knownWh.add(String(v).toLowerCase().trim());
    }
  } catch (_) {}
  for (const [k, v] of Object.entries(cfg.CODE_WAREHOUSE_DEFAULTS)) {
    knownWh.add(String(k).toLowerCase().trim());
    knownWh.add(String(v).toLowerCase().trim());
  }
  knownWh.add(".mods");

  const bareName = String((mod && mod.name) || "").trim();
  const authoredName = "[" + String((mod && mod.author) || "?") + "] " + bareName;
  const isContainerName = (bn) => bn === authoredName || bn === bareName;

  // 用缓存索引（全根文件名列表）按文件名直接定位所在目录（O(1)）；同名文件可能散落在多个旧目录 → 全记
  const idx = rootNameIndex(root);
  const byDir = new Map(); // dir -> { score, files }
  for (const [name, w] of Object.entries(wantFiles)) {
    for (const dir of idx.get(name) || []) {
      if (!dir || !fs.existsSync(dir)) continue;
      if (path.resolve(dir) === normDir) continue;
      if (!byDir.has(dir)) byDir.set(dir, { score: 0, files: [] });
      const g = byDir.get(dir);
      g.score += w.kind === "archive" ? 100 : 1;
      g.files.push(name);
    }
  }

  const dirs = [];
  // 2026-08-26 用户规则：裸仓库目录（角色/装备等分类层）里的匹配文件移动文件本身
  const warehouseFiles = []; // { dir(裸仓库), files:[...], deleteHtml: true }
  // 2026-08-26 用户规则（新增）：直接移动文件夹前先检查文件夹名是不是当前 mod 名
  //   （[作者] mod名 / mod名）——文件夹名不是 mod 名的（可能是别的 mod 的正确目录，
  //   只是里面混入了本 mod 的文件，如 [Maquian] MAVUIKA-PRIME-SUPER-HEAVY 里混了 Sandrone 文件）
  //   → 不整夹移动，只移动匹配的文件本身（不动别人的目录、不删其 HTML）
  const moveFilesOnly = []; // { dir, files:[...], relDir, deleteHtml: bool }
  for (const [dir, g] of byDir) {
    const bn = path.basename(dir);
    if (knownWh.has(String(bn).toLowerCase().trim())) {
      warehouseFiles.push({ dir, files: g.files, relDir: path.relative(root, dir), deleteHtml: true });
      continue; // 裸仓库目录不整体移动（匹配文件由调用方移动文件本身 + 删仓库根 HTML）
    }
    // 2026-08-26 用户规则：整夹移动前先检查文件夹名是不是当前 mod 名
    if (!isContainerName(bn)) {
      moveFilesOnly.push({ dir, files: g.files, relDir: path.relative(root, dir), deleteHtml: false });
      continue; // 非 mod 名目录（可能是别的 mod 的正确目录）→ 只移动匹配文件本身
    }
    dirs.push({ dir, score: g.score, files: g.files, bn, relDir: path.relative(root, dir) });
  }
  // 排序：含压缩包多优先 → 名字是 [作者]mod/mod名 优先 → 浅优先
  dirs.sort((a, b) =>
    (b.score - a.score) ||
    ((isContainerName(b.bn) ? 1 : 0) - (isContainerName(a.bn) ? 1 : 0)) ||
    (a.relDir.split(path.sep).length - b.relDir.split(path.sep).length)
  );
  return { dirs, warehouseFiles, moveFilesOnly };
}

// 执行移动：mv 源文件夹 → 目标完整下载路径；目标已存在则合并（不覆盖，不丢文件）
// 2026-08-26：残留全重复的旧目录 → 游戏根 .trash（trashRoot 参数；缺省回退 dirname/.trash）
function moveDirTo(src, dst, trashRoot) {
  if (!src || !dst || path.resolve(src) === path.resolve(dst)) return { moved: false, reason: "same" };
  if (!fs.existsSync(src)) return { moved: false, reason: "missing" };
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) {
    try {
      fs.renameSync(src, dst);
      return { moved: true, files: [] };
    } catch (_) {
      // 跨卷/失败 → 逐文件复制再删源
    }
  }
  // 目标已存在或 rename 失败：合并（目标已有文件保留，不覆盖）
  const movedFiles = [];
  try {
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s2 = path.join(src, ent.name);
      const d2 = path.join(dst, ent.name);
      if (fs.existsSync(d2)) continue; // 目标已有 → 保留
      try { fs.renameSync(s2, d2); movedFiles.push(ent.name); } catch (_) {}
    }
    const rest = fs.readdirSync(src).filter((n) => n !== "@eaDir");
    if (rest.length === 0) { try { fs.rmdirSync(src); } catch (_) {} }
    else if (rest.length === 1 && rest[0] === "description.html") {
      // 只剩 HTML 的空壳 → 删除壳
      try { fs.rmSync(path.join(src, "description.html"), { force: true }); fs.rmdirSync(src); } catch (_) {}
    } else {
      // 2026-08-26 用户要求「移动所有旧目录」：残留（目标已有同名=重复）→ 旧目录整体进游戏根垃圾桶（可恢复）
      const allDup = rest.every((n) => {
        try { return fs.existsSync(path.join(dst, n)) && fs.statSync(path.join(src, n)).size === fs.statSync(path.join(dst, n)).size; } catch (_) { return false; }
      });
      if (allDup) {
        const trashDir = trashRoot || path.join(path.dirname(dst), ".trash");
        try {
          fs.mkdirSync(trashDir, { recursive: true });
          const t = path.join(trashDir, "dup-归位-" + path.basename(src) + "-" + Date.now());
          fs.renameSync(src, t);
          return { moved: true, files: movedFiles, trashed: t };
        } catch (_) {}
      }
    }
    return { moved: true, files: movedFiles };
  } catch (e) {
    return { moved: false, reason: e.message || String(e) };
  }
}

// ---------- 第三步：整理阶段（通过 HTML 检查文件完整性）----------
// ① .gbmd.part：主文件+part 都存在 → 删 part；仅 part 存在 → 保留（断点续传）
// 2026-08-26 修复（用户要求）：文件名一律按 GB 原名保存（压缩包/图片/gif 都不重命名，
//   图片就是 GB 短名 _sFile，不是 md5 名）——原「图片重命名为内容 md5 去重」逻辑移除，
//   因为把 GB 原名图片重命名为 md5 会破坏「按原名跳过/找回」的匹配，也是垃圾筒误移的帮凶。
async function integrityCheck(finalDir, obj, root) {
  const report = { partsDeleted: [], imagesRenamed: [], imagesTrashed: [] };
  // ① part 文件
  for (const f of obj.files || []) {
    if (!f || !f.file) continue;
    const full = path.join(finalDir, f.file);
    const part = full + ".gbmd.part";
    if (fs.existsSync(full) && fs.existsSync(part)) {
      try { fs.unlinkSync(part); report.partsDeleted.push(f.file); } catch (_) {}
    }
    // 仅 part 存在 → 不删（未下载完，第四步断点续传）
  }
  // ② 2026-08-26 用户要求：不重命名图片、不自动清理图片（旧序列图/重复图由手动清理）。
  //    文件名字按 GB 原名，HTML 记录与磁盘一致，按原名匹配跳过/找回即可。
  return report;
}

// ---------- 第四步：构建下载项（正式下载由消费者执行）----------
function buildDownloadItems(mod, finalDir, obj) {
  const items = [];
  for (const f of obj.files || []) {
    items.push({
      type: "file",
      url: f.url || "",
      path: path.join(finalDir, f.file),
      displayName: f.file,
      gbMd5: f.gbMd5 || "",
      size: f.size || 0,
      targetDir: finalDir,
      modId: mod.modId, modName: mod.name, modUrl: mod.profileUrl,
      author: mod.author, game: mod.game
    });
  }
  for (const img of obj.images || []) {
    if (!img.url) continue;
    items.push({
      type: "image",
      url: img.url,
      path: path.join(finalDir, img.file),
      displayName: img.file,
      targetDir: finalDir,
      modId: mod.modId, modName: mod.name, modUrl: mod.profileUrl,
      author: mod.author, game: mod.game
    });
  }
  for (const g of obj.gifs || []) {
    if (!g.url) continue;
    // 2026-08-26（实测：kle·Fictional games-Isabella 的 gif 来自 patreon 图床，SA6400 网络不可达
    //   AggregateError 重试必失败）——沿用旧项目经验：不可达图床的 gif 直接标记跳过，不计失败
    const unreachable = /tumblr\.com|tenor\.com|patreonusercontent\.com/i.test(g.url || "");
    items.push({
      type: unreachable ? "skipped" : "image", // gif 走图片下载逻辑
      url: g.url,
      path: path.join(finalDir, g.file),
      displayName: g.file,
      targetDir: finalDir,
      isGif: true,
      skipReason: unreachable ? "gif 源图床不可达（tumblr/tenor/patreon），已跳过" : undefined,
      modId: mod.modId, modName: mod.name, modUrl: mod.profileUrl,
      author: mod.author, game: mod.game
    });
  }
  return items;
}

// 单 mod 准备（第一步→第二步→第三步），返回 { items, obj, finalDir, report }
async function prepareMod(url) {
  const settings = cfg.readConfig();
  const report = { step1: {}, step2: {}, step3: {} };

  // ---- 第一步：生成 HTML + 算下载路径 ----
  const { mod, target, obj } = await genIndexHtml(url);
  const finalDir = target.dir;
  report.step1 = { game: mod.game, warehouse: target.warehouse, item: target.item, dir: finalDir };

  // ---- 第二步：根目录范围搜索压缩包名/图片名，存在则 mv 文件夹 ----
  // 2026-08-26 修复（实测误移根因）：gif 不参与第二步反查——gif 下载后可能被重命名为
  //   gif_XXX.gif（序列名，任何 mod 都有）或 md5.gif，用这些通用名去全根反查会把大量
  //   无关目录（含同名 gif_001.gif 的其他 mod）误判为「旧目录」整体移入，破坏文件结构。
  //   只有压缩包（GB 原名）和预览图（GB 短名 _sFile）参与反查。
  const wantFiles = {}; // lower文件名 -> { kind: "archive" | "image" }
  for (const f of obj.files || []) {
    if (f && f.file) wantFiles[String(f.file).toLowerCase()] = { kind: "archive" };
  }
  for (const img of obj.images || []) {
    if (img && img.file) {
      const k = String(img.file).toLowerCase();
      if (!wantFiles[k]) wantFiles[k] = { kind: "image" };
    }
  }
  // 2026-08-26 用户澄清：第二步 = 按全根文件名索引反查，移动**所有**旧目录（判定不是裸仓库目录）；
  //   裸仓库目录里的匹配文件 → 移动文件本身，并删除该裸仓库目录下的 description.html
  const trashRoot = path.join(target.root, ".trash");
  const found = findExistingDir(target.root, finalDir, mod, wantFiles);
  const foundDirs = (found && found.dirs) || [];
  const warehouseFiles = (found && found.warehouseFiles) || [];
  const moveFilesOnly = (found && found.moveFilesOnly) || []; // 2026-08-26 非 mod 名目录 → 只移匹配文件本身
  const movedList = [];
  if (foundDirs.length) {
    for (const f of foundDirs) {
      const mv = moveDirTo(f.dir, finalDir, trashRoot);
      if (mv.moved) movedList.push(f.relDir + (mv.trashed ? "(重复→trash)" : ""));
      else if (mv.reason === "same") movedList.push(f.relDir + "(已在目标)");
    }
  }
  // 裸仓库目录/非 mod 名目录里的匹配文件：移动文件本身到目标；
  //   裸仓库（warehouseFiles.deleteHtml）→ 顺带删仓库根 HTML；
  //   非 mod 名目录（moveFilesOnly）→ 只移文件，不删其 HTML（那是别的 mod 的目录）
  const moveOnlyAll = [...warehouseFiles, ...moveFilesOnly];
  if (moveOnlyAll.length) {
    for (const w of moveOnlyAll) {
      // 2026-08-26 用户规则：抽文件前检查源目录有没有 description.html——
      //   有 HTML = 完整 mod 目录，里面的同名图片可能被多个 mod 共用（同一 GB 短名
      //   预览图），抽走会破坏其他 mod → 跳过不抽；无 HTML = 残留/散落目录，才抽。
      //   （实测：Necomiya Uncensored 无 HTML，抽走无碍；有 HTML 的目录保守保留）
      const srcHasHtml = fs.existsSync(path.join(w.dir, "description.html"));
      let ents = [];
      try { ents = fs.readdirSync(w.dir, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of ents) {
        if (!e.isFile() || e.name.startsWith(".")) continue;
        if (!wantFiles[String(e.name).toLowerCase()]) continue;
        if (srcHasHtml) continue; // 源目录有 HTML（完整 mod）→ 不抽，防共用图被抢
        const s = path.join(w.dir, e.name);
        const d = path.join(finalDir, e.name);
        if (fs.existsSync(d)) {
          // 目标已有同名 → 移到垃圾桶（重复）
          try { fs.mkdirSync(trashRoot, { recursive: true }); fs.renameSync(s, path.join(trashRoot, "dup-仓库散落-" + Date.now() + "-" + e.name)); movedList.push(w.relDir + "/" + e.name + "(重复→trash)"); } catch (_) {}
        } else {
          try { fs.renameSync(s, d); movedList.push(w.relDir + "/" + e.name); } catch (_) {}
        }
      }
      // 2026-08-26 用户规则：仅裸仓库目录（deleteHtml）删 HTML（残留壳）；非 mod 名目录不删
      if (w.deleteHtml) {
        try { const h = path.join(w.dir, "description.html"); if (fs.existsSync(h)) { fs.unlinkSync(h); console.log("[step2-warehouse-html] 删除仓库根HTML:", h.replace(target.root + "/", "")); } } catch (_) {}
      }
    }
  }
  report.step2 = { found: [...foundDirs.map((f) => f.relDir), ...warehouseFiles.map((w) => w.relDir)], moved: movedList.length, movedList };
  if (movedList.length) console.log("[step2-mv]", movedList.length, "个旧目录/散落文件 →", (finalDir.split("/Mods/")[1] || finalDir).slice(0, 50));

  // ---- 写入 HTML（第二步规定：HTML 存于该文件夹，原有 HTML 覆盖）----
  fs.mkdirSync(finalDir, { recursive: true });
  // 合并旧 HTML 已记录的本地 hash（重下时保留已下载文件的 hash）
  const oldObj = readIndexObj(finalDir);
  if (oldObj && oldObj.files) {
    for (const f of obj.files) {
      const old = oldObj.files.find((x) => x && x.file === f.file);
      if (old && old.hash) f.hash = old.hash;
    }
  }
  writeIndexHtml(finalDir, obj);

  // ---- 第三步：整理阶段（part 文件 + 图片 md5 重命名去重）----
  const root = target.root;
  report.step3 = await integrityCheck(finalDir, obj, root);
  if (report.step3.imagesRenamed.length || report.step3.imagesTrashed.length) {
    writeIndexHtml(finalDir, obj);
  }

  // ---- 2026-08-26 用户要求：垃圾桶找回（压缩包/图片）----
  // 已下载完的 mod 里文件被拿走（比如误进垃圾桶）→ 重新下载时先从垃圾桶找回：
  //   · 压缩包（zip/rar/7z）：垃圾桶里常见「dup-归位-xxx.zip」/「dup-仓库散落-ts-xxx.zip」
  //     前缀名（moveDirTo 归位重复产生的），按**目标文件名**（GB 原名）反查找回，改名移回目标目录
  //   · 图片：按 GB 原名（_sFile）在垃圾桶找同名文件；内容 hash 匹配也补找一次
  //   找回成功 → 该文件不再重新下载（标记已存在）
  const trashDir = path.join(root, ".trash");
  const restored = [];
  if (fs.existsSync(trashDir)) {
    // 垃圾桶文件清单：递归扫描全部子目录（2026-08-26 修复——垃圾桶保留 relDir
    //   结构后文件可能在 trash/角色/Test/[作者] Mod/img.jpg 多层深，必须递归收集，
    //   找回时只按文件名匹配，不判断文件夹层级/深度）
    const trashNames = [];
    const collectTrash = (td, prefix) => {
      let ents = [];
      try { ents = fs.readdirSync(td, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name.startsWith(".")) continue; // 隐藏文件跳过
        const full = path.join(td, e.name);
        if (e.isDirectory()) collectTrash(full, prefix + e.name + path.sep);
        else if (e.isFile()) trashNames.push(prefix + e.name);
      }
    };
    collectTrash(trashDir, "");
    const trashSet = new Set(trashNames);
    // 2026-08-26 修复（实测 bottom_heavy_furina_top_heavy_）：垃圾桶旧版名与 GB 当前名
    //   不同（GB 加 2026_ 年份前缀 + _哈希后缀），精确匹配找回失败 → 加「核心名模糊匹配」。
    //   兼容：直接同名、dup- 前缀、核心名一致（去年份前缀/哈希后缀/去符号）。
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const coreName = (name) =>
      String(name || "")
        .replace(/\.(zip|rar|7z)$/i, "")
        .replace(/^\d{4}_/, "")
        .replace(/_?[0-9a-f]{4,8}$/i, "")
        .replace(/[_\-\s]+/g, "")
        .toLowerCase();
    const isTrashName = (candidate) => {
      if (!candidate) return false;
      if (trashSet.has(candidate)) return true;
      const candCore = coreName(candidate);
      return trashNames.some((n) => {
        const base = path.basename(String(n)); // 子路径（dup-归位-xxx/文件）取文件名匹配
        const re = new RegExp("^dup-归位-([^\-]+)-" + esc(candidate) + "$");
        if (re.test(base)) return true;
        const re2 = new RegExp("^dup-仓库散落-\d+-" + esc(candidate) + "$");
        if (re2.test(base)) return true;
        // 核心名模糊匹配：垃圾桶名(去年份前缀/哈希后缀/符号) == GB 当前名核心 → 可找回
        if (candCore && coreName(base) === candCore) return true;
        return false;
      });
    };
    const wantList = [];
    for (const f of obj.files || []) {
      if (f && f.file) wantList.push({ name: f.file, md5s: [f.hash, f.gbMd5].filter(Boolean) });
    }
    for (const im of obj.images || []) {
      if (im && im.file) wantList.push({ name: im.file, md5s: [im.hash].filter(Boolean) });
    }
    // 旧 HTML 图片记录也纳入匹配（GB 原名可能在旧记录里）
    const oldImgs = (oldObj && oldObj.images) || [];
    for (const im of oldImgs) {
      if (im && im.file) wantList.push({ name: im.file, md5s: [im.hash].filter(Boolean) });
    }
    for (const w of wantList) {
      const dst = path.join(finalDir, w.name);
      if (fs.existsSync(dst)) continue;
      let done = false;
      // ① 按目标文件名（GB 原名）找：直接同名 or dup- 前缀尾（严格正则，防子串误匹配）
      //    2026-08-26 旧版找回：GB 文件名与垃圾桶名版本后缀不同 → 去后缀匹配，找回改名 GB 当前名
      if (isTrashName(w.name)) {
        const exact = path.join(trashDir, w.name);
        let srcPick = null;
        if (fs.existsSync(exact)) srcPick = exact; // 直接同名（完整路径）
        else {
          const esc2 = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const hitName = trashNames.find((n) => {
            const base = path.basename(n); // 子路径取文件名部分匹配
            const re = new RegExp("^dup-归位-([^\-]+)-" + esc2(w.name) + "$");
            const re2 = new RegExp("^dup-仓库散落-\d+-" + esc2(w.name) + "$");
            if (re.test(base) || re2.test(base)) return true;
            // 核心名模糊匹配（2026-08-26 修复）：垃圾桶旧版名核心 == GB 当前名核心
            if (coreName(base) && coreName(base) === coreName(w.name)) return true;
            return false;
          });
          if (hitName) srcPick = path.join(trashDir, hitName); // 可能是子路径 → 完整拼接
        }
        if (srcPick) {
          try { fs.renameSync(srcPick, dst); restored.push(w.name); done = true; } catch (_) {}
        }
      }
      // ② 按内容 hash 找（md5 名文件）
      if (!done) {
        for (const md5 of w.md5s) {
          const md5lower = String(md5).toLowerCase();
          if (!md5lower) continue;
          if (fs.existsSync(path.join(finalDir, md5lower + path.extname(w.name)))) { done = true; break; }
          const src = path.join(trashDir, md5lower + path.extname(w.name));
          if (fs.existsSync(src)) {
            try { fs.renameSync(src, dst); restored.push(w.name); done = true; break; } catch (_) {}
          }
        }
      }
    }
  }
  if (restored.length) {
    report.step3.restored = restored;
    console.log("[trash-restore]", (finalDir.split("/Mods/")[1] || finalDir).slice(0, 40), "←", restored.length, "个文件");
  }

  // ---- 2026-08-26 用户要求：下载时自动整理（不在 HTML 文件列表的文件 → 移入垃圾桶）----
  // 判定（用户原话）：HTML 现在会记住历史文件（legacy 追加合并），真正属于本 mod 的文件
  //   都在列表里；不在列表的 = 错误归类的外部 mod 遗留 → 移入游戏根垃圾桶（.trash）。
  //   移入时保留 GB 原名 → 将来下载其真正所属 mod 时 trash-restore 按原名自动找回归位。
  //   2026-08-26 修复（实测 696913）：必须在 trash-restore 之后执行——否则 auto-organize
  //   移入垃圾桶的历史 md5 名文件会被 trash-restore 按内容 hash 当成「本 mod 丢失文件」捞回，
  //   导致移出又找回（autoOrganized 报告为 0，目录残留 md5 名副本）。先找回本 mod 的、
  //   再清走外部遗留，互不干扰。
  //   2026-08-26 修复（用户指出严重问题：作者更新只保留新版本，旧版本 zip 被误清）：
  //   organizeDir 传当前 modId，name-index 反查命中同 modId 的旧版本文件保留（org.kept），
  //   并追加进 HTML files legacy 记录——下次不再被当外部文件清理。
  try {
    // 2026-08-26 用户要求：垃圾桶保留来源目录结构——传 finalDir 相对游戏根的路径
    let relDir = "";
    try { relDir = path.relative(target.root, finalDir); } catch (_) {}
    const org = organize.organizeDir(finalDir, trashRoot, mod.modId, relDir);
    if (org.kept && org.kept.length) {
      // 旧版本文件（GB 页面已下架，但本地保留）→ 追加进 HTML 记录
      let htmlChanged = false;
      const diskObj = readIndexObj(finalDir) || obj;
      for (const k of org.kept) {
        const base = k.endsWith(".gbmd.part") ? k.slice(0, -(".gbmd.part".length)) : k;
        const lower = String(base).toLowerCase();
        const inFiles = (diskObj.files || []).some((x) => x && String(x.file).toLowerCase() === lower);
        const inImgs = (diskObj.images || []).some((x) => x && (String(x.file || "").toLowerCase() === lower || String(x.gbFile || "").toLowerCase() === lower));
        const inGifs = (diskObj.gifs || []).some((x) => x && String(x.file || "").toLowerCase() === lower);
        if (!inFiles && !inImgs && !inGifs) {
          let st = null;
          try { st = fs.statSync(path.join(finalDir, base)); } catch (_) {}
          if (/.(zip|rar|7z|tar|gz)$/i.test(base)) {
            diskObj.files = diskObj.files || [];
            diskObj.files.push({ file: base, url: "", size: st ? st.size : 0, gbMd5: "", hash: "", description: "旧版本文件（GB 已下架，本地保留）", legacy: true });
            htmlChanged = true;
          } else if (isImageExt(base)) {
            diskObj.images = diskObj.images || [];
            diskObj.images.push({ file: base, gbFile: base, url: "", hash: "" });
            htmlChanged = true;
          }
        }
      }
      if (htmlChanged) writeIndexHtml(finalDir, diskObj);
      console.log("[auto-organize-keep]", (finalDir.split("/Mods/")[1] || finalDir).slice(0, 50), "→ 保留旧版本", org.kept.length, "个（已追加 HTML 记录）");
    }
    if (org.moved && org.moved.length) {
      report.step3.autoOrganized = org.moved;
      console.log("[auto-organize]", (finalDir.split("/Mods/")[1] || finalDir).slice(0, 50), "→ 移出", org.moved.length, "个外部文件");
    }
  } catch (_) {}

  // ---- 第四步：构建下载项（标记已存在）----
  const items = buildDownloadItems(mod, finalDir, obj);
  const exists = new Set();
  for (const it of items) {
    try { if (it.path && fs.existsSync(it.path) && fs.statSync(it.path).size > 0) exists.add(it.path); } catch (_) {}
  }
  // 2026-08-26 修复（用户要求：文件名一律按 GB 原名）：
  //   · 文件/图片按 GB 原名（_sFile 短名）落盘 → 目标路径存在即跳过（不看 hash）
  //   · 图片额外兼容：内容 hash 记录存在且同内容 md5 名文件在 → 也跳过（旧数据迁移场景）
  //   · 仅 part 存在 → 不跳过（断点续传）
  const imgHashFileExists = (it) => {
    const im = (obj.images || []).find((x) => x && (x.file === it.displayName || x.gbFile === it.displayName));
    if (!im || !im.hash) return false;
    const md5name = String(im.hash).toLowerCase() + (path.extname(it.displayName) || "");
    return fs.existsSync(path.join(finalDir, md5name)); // 仅本文件夹内同内容 → 跳过
  };
  for (const it of items) {
    if (exists.has(it.path)) { it._skip = true; it.exists = true; }
    else if (it.type === "image" && !it.isGif && imgHashFileExists(it)) { it._skip = true; it.exists = true; }
    // 仅 part 存在 → 不跳过（断点续传）
  }
  return { mod, obj, finalDir, items, report };
}

// ---------- 下载（断点续传）----------
function downloadToFile(item, settings, onProgress) {
  return new Promise((resolve, reject) => {
    const destPath = item.path;
    const tmp = destPath + ".gbmd.part";
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let resumeOffset = 0;
    if (fs.existsSync(tmp)) {
      try { resumeOffset = fs.statSync(tmp).size; } catch (_) { resumeOffset = 0; }
    }

    function doFetch(u, redirLeft, useRange) {
      const parsed = new URL(u);
      const mod = parsed.protocol === "https:" ? https : http;
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "*/*",
        Referer: "https://gamebanana.com/"
      };
      if (settings.gbCookie) headers.Cookie = settings.gbCookie;
      if (useRange && resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;

      let done = false;
      let stallTimer = null;
      const req = mod.get(u, { headers, timeout: 120000, agent: parsed.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirLeft <= 0) return reject(new Error("重定向次数过多"));
          return doFetch(new URL(res.headers.location, u).toString(), redirLeft - 1, useRange);
        }
        if (code === 416) {
          // Range 无效（part 残留或文件已更新）→ 删 part 从头下
          res.resume();
          try { fs.unlinkSync(tmp); } catch (_) {}
          resumeOffset = 0;
          return doFetch(u, redirLeft, false);
        }
        if (code >= 400) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${code}: ${u}`));
        }
        if (useRange && resumeOffset > 0 && code === 200) {
          // 服务器忽略 Range → 从头下
          res.resume();
          try { fs.unlinkSync(tmp); } catch (_) {}
          resumeOffset = 0;
          return doFetch(u, redirLeft, false);
        }

        const flags = resumeOffset > 0 ? "a" : "w";
        const file = fs.createWriteStream(tmp, { flags });
        const contentLength = parseInt(res.headers["content-length"] || "0", 10);
        let received = resumeOffset;
        const total = contentLength + resumeOffset;

        let stallLast = resumeOffset;
        let stallCount = 0;
        stallTimer = setInterval(() => {
          if (done) { clearInterval(stallTimer); return; }
          if (task && (task.abort || task.pause)) {
            clearInterval(stallTimer);
            try { req.destroy(new Error(task.abort ? "已停止" : "已暂停")); } catch (_) {}
            return;
          }
          let cur = stallLast;
          try { cur = fs.statSync(tmp).size; } catch (_) {}
          if (cur === stallLast) {
            stallCount++;
            if (stallCount >= 2) {
              clearInterval(stallTimer);
              try { req.destroy(new Error("下载停滞（文件大小停止增长且未完成）")); } catch (_) {}
            }
          } else {
            stallCount = 0;
            stallLast = cur;
          }
        }, 2000); // 2026-08-26 缩短到 2s：停止/暂停 2 秒内中断下载（原 20s 太慢），停滞检测仍 2 次×2s

        res.on("data", (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(file);
        res.on("end", () => {
          done = true;
          clearInterval(stallTimer);
          file.close(() => {
            try {
              const st = fs.statSync(tmp);
              if (st.size === 0) return reject(new Error("下载后文件为空: " + destPath));
              if (contentLength > 0 && resumeOffset === 0 && st.size !== contentLength) {
                return reject(new Error(`文件大小不匹配（期望 ${contentLength}，实际 ${st.size}）: ${destPath}`));
              }
              fs.renameSync(tmp, destPath);
              resolve({ size: st.size });
            } catch (e) { reject(e); }
          });
        });
        res.on("error", (e) => {
          done = true;
          clearInterval(stallTimer);
          file.close(() => reject(e));
        });
      });
      req.on("timeout", () => req.destroy(new Error("下载超时（连接空闲）")));
      req.on("error", (e) => {
        done = true;
        clearInterval(stallTimer);
        reject(e);
      });
    }

    doFetch(item.url, 10, resumeOffset > 0);
  });
}

async function executeDownloadItem(item, settings, onProgress) {
  // 2026-08-27 找回模式：不实际下载——需下载的项直接标记跳过（只做 prepareMod 的
  //   垃圾桶找回/归位/HTML 生成）。放在所有判断最前，完全不影响正常下载流程。
  if (settings && settings.restoreOnly && !item._skip && item.type !== "error" && item.type !== "skipped") {
    return { path: item.path || "", ok: true, skipped: true, skipReason: "找回模式（不下载，仅归位/找回）" };
  }
  if (item.type === "error") {
    return { path: item.path || "", ok: false, error: item.buildError || "构建下载任务失败" };
  }
  // 2026-08-26 修复（实测失败 gif 根因）：type="skipped"（不可达图床 gif 等）此前漏了分支，
  //   直接落入下载分支去请求 → AggregateError 失败；这里必须直接返回跳过
  if (item.type === "skipped") {
    return { path: item.path || "", ok: true, skipped: true, skipReason: item.skipReason || "已跳过" };
  }
  if (item._skip) {
    return { path: item.path, ok: true, skipped: true, exists: true };
  }
  let lastErr = null;
  // 2026-08-26 用户要求：自动跳过**仅限 gif**（gif 不强求，失败直接跳过不显示失败）；
  //   压缩包/图片失败 → 正常重试并显示失败（可手动重试/跳过）
  const maxAttempt = item.isGif ? 1 : (MAX_RETRY + 1);
  for (let attempt = 0; attempt < maxAttempt; attempt++) {
    if (attempt > 0) {
      const waited = await new Promise((resolve) => {
        let remaining = RETRY_DELAY_MS;
        const step = 250;
        const timer = setInterval(() => {
          remaining -= step;
          if (task && (task.abort || task.pause)) { clearInterval(timer); resolve(false); return; }
          if (remaining <= 0) { clearInterval(timer); resolve(true); }
        }, step);
      });
      if (!waited) return { path: item.path, ok: false, error: "已停止/暂停，放弃重试" };
    }
    try {
      const info = await downloadToFile(item, settings, onProgress);
      let hash = "";
      let size = 0;
      try {
        hash = await fileMd5(item.path);
        size = fs.statSync(item.path).size;
      } catch (_) {}
      item._hash = hash;
      item._size = size;
      return { path: item.path, ok: true, size, hash, item };
    } catch (e) {
      lastErr = e;
      if (task && (task.abort || task.pause)) break;
    }
  }
  const errMsg = (lastErr && (lastErr.message || String(lastErr))) || "下载失败";
  // gif 失败 → 自动跳过（不显示失败）；其他文件失败 → 正常显示失败（可重试/跳过）
  if (item.isGif) return { path: item.path, ok: true, skipped: true, skipReason: "gif 下载失败，已跳过（不强求）: " + errMsg };
  return { path: item.path, ok: false, error: errMsg };
}

// ---------- 任务状态 ----------
let task = null;
let running = false;
let downloadIdx = 0;
let resultsByIndex = new Map();
let modDirByItem = new Map(); // item -> { finalDir, obj }（下载完成后更新 HTML）

function saveTask() {
  try {
    const t = task ? {
      ...task,
      activeItems: (task.activeItems || []).map((a) => ({ ...a, _spT: undefined, _spLast: undefined })),
      preparingItem: task.preparingItem ? { name: task.preparingItem.name, type: "preparing" } : null
    } : null;
    fs.writeFileSync(TASK_FILE, JSON.stringify(t, null, 2), "utf8");
  } catch (_) {}
}

function getTask() { return task; }

// ---------- 主循环 ----------
async function runDownloadLoop() {
  if (running) return;
  running = true;
  try { await doDownloadLoop(); }
  finally { running = false; }
}

async function doDownloadLoop() {
  if (!task || (task.status !== "running" && task.status !== "preparing")) return;
  const concurrency = task.concurrency || cfg.readConfig().downloadConcurrency || 4;
  const settings = cfg.readConfig();
  task.status = "running";

  // 2026-08-26 修复（实测：同一进程连续下载第二个任务时 doneCount=0 全部未执行）：
  // downloadIdx / resultsByIndex / modDirByItem 是模块级状态，新循环必须重置；
  // 恢复任务时从 task.resultsMap 重建已完成的项（consume 跳过），避免重启后重复下载。
  downloadIdx = 0;
  resultsByIndex = new Map();
  if (task.resultsMap) {
    for (const [k, v] of Object.entries(task.resultsMap)) {
      resultsByIndex.set(parseInt(k, 10), v);
    }
  }
  modDirByItem.clear();
  clearRootNameIndex(); // 2026-08-26：每批任务重建一次「文件名→目录」索引（第二步查重用）

  try {
    // ---------- 生产者：逐个 mod 准备（第一步→第二步→第三步）----------
    const produce = async () => {
      while (task && !task.abort && !task.pause) {
        // 2026-08-26 追加任务立刻开始：pendingMods 处理完不退出——若还有下载项在跑，
        //   等待新追加（task.pendingMods 增长）继续生产；全部完成才退出
        if (task.buildIndex >= (task.pendingMods || []).length) {
          // 2026-08-26 追加任务立刻开始：有活跃下载/未完成项 → produce 等待新追加
          const stillActive = (task.activeItems || []).length > 0 || ((task.items || []).length > 0 && resultsByIndex.size < (task.items || []).length);
          if (stillActive) {
            task.waitingAppend = true;
            await new Promise((r) => setTimeout(r, 300));
            continue; // 新追加后 buildIndex < pendingMods.length → 继续生产
          }
          // 无活跃下载且无未完成项 → 任务完成，produce 退出（等 consume 也退出 → 收尾 done）
          task.waitingAppend = false;
          break;
        }
        task.waitingAppend = false;
        const myIdx = task.buildIndex;
        task.buildIndex++;
        const modRef = task.pendingMods[myIdx];
        task.preparingItem = { name: modRef.name || modRef.profileUrl, type: "preparing" };
        task.message = `准备 ${myIdx + 1}/${(task.pendingMods || []).length} · 已完成 ${resultsByIndex.size} 项`;
        saveTask();
        try {
          const res = await prepareMod(modRef.profileUrl);
          if (res.report.step2.moved) console.log("[step2-mv]", (res.report.step2.found || ""), "→", (res.report.step1.dir || "").split("/Mods/")[1] || "");
          for (const it of res.items) {
            modDirByItem.set(it, { finalDir: res.finalDir, obj: res.obj });
          }
          task.items = task.items || [];
          task.items.push(...res.items);
        } catch (e) {
          task.items = task.items || [];
          if (e && e.skip) {
            task.items.push({ type: "skipped", displayName: modRef.name || modRef.profileUrl, modName: modRef.name, modUrl: modRef.profileUrl, path: "", url: modRef.profileUrl, skipReason: e.message || "未配置根目录" });
          } else {
            task.items.push({ type: "error", displayName: modRef.name || modRef.profileUrl, modName: modRef.name, modUrl: modRef.profileUrl, path: "", url: modRef.profileUrl, buildError: e.message || String(e) });
          }
        }
        task.preparingItem = null;
        task.updatedAt = Date.now();
        saveTask();
      }
    };

    // ---------- 消费者：并发下载 ----------
    const consume = async () => {
      while (task && !task.abort && !task.pause) {
        // 2026-08-26 修复（用户反馈：应用并发数不立即生效）：
        //   并发数原来在任务开始时定死（消费者数量固定），中途改 task.concurrency 无效。
        //   现在每个消费者取项前先按「当前并发数」限流——活跃下载数 ≥ 当前并发则等待，
        //   应用后立即按新并发生效（调大→马上多开；调小→不再开新的，正在下的完成）
        const cur = Math.max(1, Math.min(32, parseInt(task.concurrency, 10) || 4));
        if ((task.activeItems || []).length >= cur) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        const activeIdx = new Set((task.activeItems || []).map((a) => a.idx));
        while (downloadIdx < (task.items || []).length &&
               (resultsByIndex.has(downloadIdx) || activeIdx.has(downloadIdx))) downloadIdx++;
        const idx = downloadIdx;
        if (idx >= (task.items || []).length) {
          // 生产者未完成则等待；produce 在等追加（waitingAppend）也不退出
          const stillProducing = task.buildIndex < (task.pendingMods || []).length || task.preparingItem || task.waitingAppend;
          if (stillProducing) { await new Promise((r) => setTimeout(r, 200)); continue; }
          return;
        }
        downloadIdx++;
        const item = task.items[idx];
        const activeKey = item.path || item.url || `idx${idx}`;
        const activeItem = { key: activeKey, idx, name: item.displayName || item.path || item.url || "", modName: item.modName || "", type: item.type, received: 0, total: 0 };
        if (!task.activeItems) task.activeItems = [];
        task.activeItems.push(activeItem);
        task.currentItem = activeItem;
        task.message = `正在下载 ${resultsByIndex.size + 1}/${(task.items || []).length} 项（${task.activeItems.length} 线程进行中）`;
        saveTask();
        let r;
        try {
          r = await executeDownloadItem(item, settings, (received, total) => {
            activeItem.received = received;
            activeItem.total = total;
            const now = Date.now();
            if (!activeItem._spT) { activeItem._spT = now; activeItem._spLast = received; }
            else {
              const dt = (now - activeItem._spT) / 1000;
              if (dt >= 0.5) {
                activeItem.speed = Math.max(0, (received - activeItem._spLast) / dt);
                activeItem._spT = now;
                activeItem._spLast = received;
              }
            }
          });
          resultsByIndex.set(idx, r);
        } catch (e) {
          resultsByIndex.set(idx, { path: item.path, ok: false, error: e.message || String(e) });
        }
        // 2026-08-26 修复（用户反馈：下载进度 UI 看不到每文件状态）：
        // resultsByIndex 是内存实时表，必须同步回填到 task.resultsMap（前端轮询 /api/task 读它），
        // 否则任务完成后 resultsMap 恒空 → 成功/跳过/失败统计与逐文件状态全部不显示。
        task.resultsMap = {};
        for (const [i, rr] of resultsByIndex) task.resultsMap[i] = rr;
        task.activeItems = (task.activeItems || []).filter((a) => a.key !== activeKey);
        task.doneCount = resultsByIndex.size;
        task.updatedAt = Date.now();
        saveTask();
      }
    };

    const consumers = [];
    for (let i = 0; i < Math.max(1, concurrency); i++) consumers.push(consume());
    await Promise.all([produce(), ...consumers]);

    // ---------- 收尾 ----------
    if (!task) return;
    if (task.abort || task.pause) {
      const wasAbort = task.abort;
      task.status = wasAbort ? "stopped" : "paused";
      task.message = wasAbort ? "已终止" : "已暂停";
      task.abort = false;
      task.pause = false;
      task.currentItem = null;
      task.preparingItem = null;
      task.activeItems = [];
      task.updatedAt = Date.now();
      if (wasAbort) {
        // 2026-08-26 停止后彻底清空：前端列表消失（显示"暂无任务"）
        task = null;
        return;
      }
      saveTask();
      return;
    }

    // 全部完成：更新各 mod 的 HTML（下载后 hash/图片整理）+ 图片 md5 整理收敛
    task.status = "done";
    task.message = "下载完成";
    task.currentItem = null;
    task.preparingItem = null;
    task.activeItems = [];
    task.results = [];
    for (let i = 0; i < (task.items || []).length; i++) {
      task.results.push(resultsByIndex.get(i) || { path: task.items[i].path, ok: false, error: "未执行" });
    }
    try { await finalizeHtmls(); } catch (_) {}
    task.updatedAt = Date.now();
    saveTask();
  } catch (e) {
    if (!task) return;
    task.status = "done";
    task.error = e.message || String(e);
    task.updatedAt = Date.now();
    saveTask();
  }
}

// 下载完成后：把成功下载的文件 hash 写进 HTML files/images 记录 + 图片 md5 整理收敛
// 2026-08-26 修复：不再依赖 produce 阶段的 modDirByItem（重试/跳过补下载时 produce 未运行，
//   modDirByItem 为空 → HTML 不会更新）——改为按 item.targetDir 从 task.items 直接分组，
//   目标目录的 HTML 对象从磁盘读取（readIndexObj）
async function finalizeHtmls() {
  const dirs = new Map(); // finalDir -> { obj, items: [] }
  for (const item of task.items || []) {
    if (!item || !item.targetDir || !item.path) continue;
    if (!dirs.has(item.targetDir)) {
      dirs.set(item.targetDir, { obj: readIndexObj(item.targetDir), items: [] });
    }
    dirs.get(item.targetDir).items.push(item);
  }
  for (const [finalDir, g] of dirs) {
    try {
      let obj = g.obj || readIndexObj(finalDir);
      if (!obj) continue;
      let changed = false;
      // 2026-08-26 用户要求：HTML 只显示「下载完成的」+「追加旧文件」
      //   · 只把本次实际成功下载的文件写进 HTML（失败项不记录，UI 也不显示失败）
      //   · 追加旧文件：GB 页面上没有、但目录里实际存在的旧 mod 压缩包/图片也写进 HTML
      //     （用目标目录磁盘扫描补齐——避免「已下载但不认识」的文件被漏记）
      for (const item of g.items) {
        if (!item || !item.path) continue;
        const name = path.basename(item.path);
        const ok = item._skip || (item._hash !== undefined && item._hash !== "" && fs.existsSync(item.path));
        if (!ok) continue; // 失败/未完成 → 不进 HTML
        const onDisk = fs.existsSync(item.path) && fs.statSync(item.path).size > 0;
        if (item.type === "file") {
          const f = (obj.files || []).find((x) => x && x.file === name);
          if (f) {
            if (!f.hash || f.hash !== item._hash) { f.hash = item._hash || f.hash; f.size = item._size || f.size; changed = true; }
          } else {
            obj.files = obj.files || [];
            obj.files.push({ file: name, url: item.url || "", size: item._size || 0, gbMd5: item.gbMd5 || "", hash: item._hash || "", description: "" });
            changed = true;
          }
        } else if (item.type === "image" && !item.isGif) {
          const im = (obj.images || []).find((x) => x && (x.file === name || x.gbFile === name));
          if (im) {
            if (!im.gbFile && item.displayName) im.gbFile = item.displayName;
            if (!im.hash || im.hash !== item._hash) { im.hash = item._hash || im.hash; changed = true; }
          } else if (onDisk) {
            obj.images = obj.images || [];
            obj.images.push({ file: name, gbFile: item.displayName || name, url: item.url || "", hash: item._hash || "" });
            changed = true;
          }
        }
      }
      // 2026-08-26 下载时顺便还原历史 md5 名图片：HTML 记录 hash(=内容md5) + file(=GB原名)，
      //   若目录里存在 hash.jpg（旧逻辑遗留的 md5 名）→ 重命名为 GB 原名
      let md5Reverted = 0;
      try {
        for (const im of obj.images || []) {
          const md5 = String(im.hash || "").toLowerCase().trim();
          const gbName = im.file || im.gbFile || "";
          if (!/^[0-9a-f]{32}$/.test(md5) || !gbName) continue;
          const md5Path = path.join(finalDir, md5 + path.extname(gbName));
          const gbPath = path.join(finalDir, gbName);
          if (fs.existsSync(md5Path) && !fs.existsSync(gbPath) && path.resolve(md5Path) !== path.resolve(gbPath)) {
            try { fs.renameSync(md5Path, gbPath); md5Reverted++; changed = true; } catch (_) {}
          }
        }
      } catch (_) {}
      if (md5Reverted > 0) console.log(`[md5-revert] ${finalDir.split("/Mods/")[1] || finalDir} ← 还原 ${md5Reverted} 张 md5 名图片为 GB 原名`);
      // 2026-08-26 用户要求：追加旧文件——扫描目标目录，把磁盘上实际存在但 HTML 未记录
      //   的压缩包/图片（旧 mod、历史遗留、GB 页面已下架）补进 files/images（只读记录，不移动）
      const diskNames = [];
      try { diskNames = fs.readdirSync(finalDir); } catch (_) { diskNames = []; }
      for (const dn of diskNames) {
        if (dn.startsWith(".") || dn === "description.html") continue;
        const dp = path.join(finalDir, dn);
        let st = null;
        try { st = fs.statSync(dp); } catch (_) {}
        if (!st || !st.isFile()) continue;
        const lower = dn.toLowerCase();
        if (/\.(zip|rar|7z|tar|gz)$/.test(lower)) {
          if (!(obj.files || []).some((x) => x && x.file === dn)) {
            obj.files = obj.files || [];
            obj.files.push({ file: dn, url: "", size: st.size, gbMd5: "", hash: "", description: "本地旧文件" });
            changed = true;
          }
        } else if (isImageExt(dn)) {
          if (!(obj.images || []).some((x) => x && (x.file === dn || x.gbFile === dn))) {
            obj.images = obj.images || [];
            obj.images.push({ file: dn, gbFile: dn, url: "", hash: "" });
            changed = true;
          }
        }
      }
      // 2026-08-26 修复：不再调用图片 md5 重命名收敛（文件名按 GB 原名，不重命名）
      if (changed) writeIndexHtml(finalDir, obj);
    } catch (_) {}
  }
}

// ---------- 对外控制 ----------
async function startDownloadTask({ mods }) {
  const urls = (mods || [])
    .map((m) => String((m && (m.profileUrl || m.url || m)) || "").trim())
    .filter((u) => u && gbApi.extractModId(u));
  if (!urls.length) throw new Error("没有有效的 mod 链接");

  if (task && (task.status === "running" || task.status === "preparing" || task.status === "paused")) {
    task.pendingMods = task.pendingMods || [];
    task.pendingMods.push(...urls.map((u) => ({ profileUrl: u, name: u })));
    task.message = `已追加 ${urls.length} 个 mod 到下载队列`;
    task.updatedAt = Date.now();
    saveTask();
    // 2026-08-26 修复（用户反馈：paused 时提交显示「追加中」不下载）：
    //   paused 状态提交新 mod → 自动恢复下载（用户期望立即开始，而非只追加）
    if (task.status === "running" || task.status === "preparing") {
      runDownloadLoop();
    } else if (task.status === "paused") {
      task.status = "running";
      task.pause = false;
      task.abort = false;
      task.message = `已恢复下载（追加 ${urls.length} 个 mod）`;
      task.updatedAt = Date.now();
      saveTask();
      runDownloadLoop();
    }
    return task;
  }

  task = {
    status: "preparing",
    // 2026-08-27 找回模式：pendingMods 倒序（旧的 mod 在前，先处理旧 mod 找回）
    pendingMods: (() => {
      const list = urls.map((u) => ({ profileUrl: u, name: u }));
      if (cfg.readConfig().restoreOnly) list.reverse();
      return list;
    })(),
    buildIndex: 0,
    items: [],
    currentIndex: 0,
    results: [],
    resultsMap: {},
    doneCount: 0,
    currentItem: null,
    activeItems: [],
    preparingItem: null,
    concurrency: cfg.readConfig().downloadConcurrency || 4,
    message: `准备中 0/${urls.length}`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    abort: false,
    pause: false
  };
  saveTask();
  runDownloadLoop();
  return task;
}

function pauseTask() {
  if (!task) return { ok: false, error: "没有任务" };
  task.pause = true;
  task.status = "paused";
  task.message = "已暂停";
  task.updatedAt = Date.now();
  saveTask();
  return { ok: true };
}

function resumeTask() {
  if (!task || task.status !== "paused") return { ok: false, error: "没有可继续的任务" };
  task.status = "running";
  task.message = "继续下载…";
  task.pause = false;
  task.abort = false;
  task.updatedAt = Date.now();
  saveTask();
  runDownloadLoop();
  return { ok: true };
}

function stopTask() {
  if (!task) return { ok: false, error: "没有任务" };
  // 2026-08-26 修复（用户反馈：停止后实际还在下载）：
  //   原来设 abort=true 后立即 task=null——下载循环的 abort 检查是「task && task.abort」，
  //   task 变 null 后检查恒 false，正在下载的请求不会中断，继续下完。
  //   正确：设 abort=true 保留 task 引用（下载循环会 destroy 活跃请求），
  //   循环退出（收尾处理 abort）后再由循环把 task 置 null/清理。
  task.abort = true;
  task.pause = false;
  task.status = "stopped";
  task.message = "已终止";
  task.pendingMods = [];
  task.buildIndex = 0;
  task.preparingItem = null;
  task.updatedAt = Date.now();
  try { fs.unlinkSync(TASK_FILE); } catch (_) {}
  // 不再立即 task=null——等 doDownloadLoop 收尾（检测 abort → destroy 请求 → 清理）
  modDirByItem.clear();
  return { ok: true };
}

function setConcurrency(n) {
  let v = parseInt(n, 10);
  if (isNaN(v) || v < 1) v = 1;
  // 2026-08-26 用户要求：并发上限 16 → 32（大任务批量下载时可开到 32）
  if (v > 32) v = 32;
  if (task) {
    task.concurrency = v;
    task.updatedAt = Date.now();
    saveTask();
  }
  // 2026-08-26 修复：应用并发数同时写入 config.json（downloadConcurrency），
  //   无任务/下次新任务也按此并发启动（原来无任务时应用不落盘，下次还是 4）
  try {
    const c = cfg.readConfig();
    if (c.downloadConcurrency !== v) {
      c.downloadConcurrency = v;
      cfg.writeConfig(c);
    }
  } catch (_) {}
  return { ok: true, concurrency: v };
}

// 2026-08-27 找回模式开关：开启后不实际下载，只做找回/归位/HTML 生成
function setRestoreMode(on) {
  const c = cfg.readConfig();
  c.restoreOnly = !!on;
  cfg.writeConfig(c);
  return { ok: true, restoreOnly: c.restoreOnly };
}
function getRestoreMode() {
  return !!cfg.readConfig().restoreOnly;
}

// 2026-08-26 用户要求加回：跳过失败项——按 path 或 url 匹配，标记 skipped
// （前端立即消失；不写 skip-list，下次重新发起下载会再尝试——与旧项目最终行为一致）
// 2026-08-26 修复（用户反馈跳过/重试不能正常使用）：
//   · 结果表同时看 resultsByIndex 与 task.resultsMap（重启/重试后 resultsByIndex 可能不全）
//   · 「卡住」项（无任何结果、任务已 done 的重试残留）也能被跳过/重试
function syncResultsMap() {
  const merged = {};
  if (task.resultsMap) for (const [k, v] of Object.entries(task.resultsMap)) merged[k] = v;
  for (const [i, r] of resultsByIndex) merged[i] = r;
  task.resultsMap = merged;
  task.updatedAt = Date.now();
  saveTask();
}

function resultAt(i) {
  const r = resultsByIndex.get(i);
  if (r) return r;
  return (task.resultsMap && task.resultsMap[i]) || null;
}

function skipItem({ path: p, url: u }) {
  if (!task) return { ok: false, error: "无下载任务" };
  const active = new Set((task.activeItems || []).map((a) => a.idx));
  let found = 0;
  for (let i = 0; i < (task.items || []).length; i++) {
    const item = task.items[i];
    if (!item) continue;
    const matchPath = p && item.path && String(item.path) === String(p);
    const matchUrl = u && item.url && String(item.url) === String(u);
    if (!matchPath && !matchUrl) continue;
    const r = resultAt(i);
    if (r && r.ok && !r.skipped) continue; // 已成功 → 不跳
    if (active.has(i)) continue;           // 正在下载 → 不跳
    const marked = { path: item.path, ok: true, skipped: true, exists: r && r.exists, skipReason: "已跳过（下次请求可再下载）" };
    resultsByIndex.set(i, marked);
    if (task.resultsMap) task.resultsMap[i] = marked;
    found++;
  }
  if (!found) return { ok: true, skipped: 0, message: "无匹配的失败项" };
  syncResultsMap();
  return { ok: true, skipped: found, message: `已跳过 ${found} 个失败项（下次请求可再下载）` };
}

function skipAllFailed() {
  if (!task) return { ok: false, error: "无下载任务" };
  const active = new Set((task.activeItems || []).map((a) => a.idx));
  let n = 0;
  for (let i = 0; i < (task.items || []).length; i++) {
    const item = task.items[i];
    if (!item || !item.path) continue;
    const r = resultAt(i);
    if (r && r.ok) continue;   // 成功/已跳过 → 不动
    if (active.has(i)) continue;
    const marked = { path: item.path, ok: true, skipped: true, skipReason: "已清除（下次请求可再下载）" };
    resultsByIndex.set(i, marked);
    if (task.resultsMap) task.resultsMap[i] = marked;
    n++;
  }
  if (n) syncResultsMap();
  return { ok: true, skipped: n, message: n ? `已清除 ${n} 个失败项（下次请求可再下载）` : "无失败项" };
}

function retryFailed() {
  if (!task) return { ok: false, error: "无下载任务" };
  const active = new Set((task.activeItems || []).map((a) => a.idx));
  const failedIdx = [];
  for (let i = 0; i < (task.items || []).length; i++) {
    const item = task.items[i];
    if (!item || !item.path || item._skip) continue;
    if (active.has(i)) continue;
    const r = resultAt(i);
    if (r && r.ok && !r.skipped) continue; // 已成功
    if (r && r.skipped) continue;          // 已跳过
    failedIdx.push(i); // 失败 或 无结果（卡住：done 任务重试后的残留）→ 重新入队
  }
  if (!failedIdx.length) return { ok: true, retried: 0, message: "无失败项可重试" };
  failedIdx.sort((a, b) => a - b);
  let minIdx = Infinity;
  for (const i of failedIdx) {
    resultsByIndex.delete(i);
    if (task.resultsMap) delete task.resultsMap[i];
    if (i < minIdx) minIdx = i;
  }
  if (downloadIdx > minIdx) downloadIdx = minIdx;
  // 2026-08-26 修复（用户反馈重试不生效）：done 任务重试后必须转 running，
  //   否则 doDownloadLoop 的 status 守卫直接 return，重新入队的项永远不会被下载
  task.status = "running";
  task.pause = false;
  task.abort = false;
  task.message = `已重新入队 ${failedIdx.length} 个失败项`;
  task.updatedAt = Date.now();
  saveTask();
  runDownloadLoop();
  return { ok: true, retried: failedIdx.length, message: `已重新入队 ${failedIdx.length} 个失败项` };
}

// 启动时恢复任务（2026-08-26 修复：重启后下载列表不应消失）
//   · running → 继续下载
//   · paused / done → 恢复任务（列表保留在网页，可继续/重试/查看历史）
//   · preparing（无任何下载项）→ 清理残留
function restorePendingTask() {
  try {
    if (fs.existsSync(TASK_FILE)) {
      task = JSON.parse(fs.readFileSync(TASK_FILE, "utf8"));
    }
  } catch (_) { task = null; }
  if (!task) return;
  const hasItems = Array.isArray(task.items) && task.items.length > 0;
  // 2026-08-26 修复（用户反馈：重启后搜索的巨量任务自动恢复海量下载）：
  //   重启后一律恢复为「暂停」状态——保留列表供查看/手动继续，不自动开始下载。
  //   防止搜索批量（几千个 mod）重启后自动海量下载。
  if ((task.status === "running" || task.status === "paused" || task.status === "done") && hasItems) {
    // 保留列表：paused 停在暂停态，done 保持完成态，前端可见
    task.activeItems = [];
    task.currentItem = null;
    task.preparingItem = null;
    task.status = "paused";
    task.pause = true;
    task.abort = false;
    task.message = "已暂停（重启后保留，点「继续」恢复下载）";
    saveTask();
  } else {
    // preparing 且无下载项 → 残留，清理
    task.status = "stopped";
    task.message = "已终止（启动时清理残留任务）";
    try { fs.unlinkSync(TASK_FILE); } catch (_) {}
    task = null;
  }
}

module.exports = {
  getTask,
  startDownloadTask,
  pauseTask,
  resumeTask,
  stopTask,
  setConcurrency,
  setRestoreMode,
  getRestoreMode,
  retryFailed,
  skipItem,
  skipAllFailed,
  restorePendingTask,
  runDownloadLoop,
  downloadToFile,
  executeDownloadItem,
  prepareMod,
  findExistingDir,
  rootNameIndex,
  integrityCheck,
  buildHtmlContent,
  parseIndexObj,
  readIndexObj
};
