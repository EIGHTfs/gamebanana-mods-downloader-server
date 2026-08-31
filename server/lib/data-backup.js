// ============================================================
// data-backup.js —— 用户数据备份/恢复（2026-08-31 用户要求）
//   导出：按 userdata-manifest.json 收集全部用户数据 → zip（保留目录结构）
//   导入：上传 zip → 按清单白名单校验路径 → 解压写回
//   清单文件驱动，新增用户数据文件时改 userdata-manifest.json 即可
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const APP_ROOT = path.join(__dirname, "..", ".."); // 项目根（server/lib → 项目根）
const MANIFEST_FILE = path.join(APP_ROOT, "userdata-manifest.json");

// 压缩工具：优先用项目自带 tool/bin/ 下的二进制（随项目/套件分发，不依赖系统装了 zip 没有）；
//   找不到再回退系统 PATH。2026-08-31 用户要求：tool 文件夹放可用的压缩工具（zip/tar）。
function findTool(name) {
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const e of exts) {
    const local = path.join(APP_ROOT, "tool", "bin", name + e);
    if (fs.existsSync(local)) return local;
  }
  return name; // 回退系统 PATH
}
const ZIP_BIN = () => findTool("zip");
const UNZIP_BIN = () => findTool("unzip");

// ---- 读清单 ----
function readManifest() {
  const m = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  if (m.schema !== 1) throw new Error("不支持的清单版本 schema=" + m.schema);
  return m;
}

// ---- 收集全部用户数据文件（相对项目根）----
function collectFiles() {
  const m = readManifest();
  const files = [];
  for (const f of m.files || []) {
    const abs = path.join(APP_ROOT, f.rel);
    if (fs.existsSync(abs)) files.push(f.rel);
  }
  for (const d of m.dirs || []) {
    const dirAbs = path.join(APP_ROOT, d.rel);
    if (!fs.existsSync(dirAbs)) continue;
    for (const n of fs.readdirSync(dirAbs)) {
      if (d.suffix && !n.endsWith(d.suffix)) continue;
      const abs = path.join(dirAbs, n);
      if (fs.statSync(abs).isFile()) files.push(d.rel + "/" + n);
    }
  }
  files.sort();
  return files;
}

// ---- zip 导出（返回 Buffer）----
function exportZip() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbmd-backup-"));
  const zipPath = path.join(tmpDir, "gbmd-userdata.zip");
  const files = collectFiles();
  // 把清单也带进去（导入时用 zip 内的清单校验，避免换机后清单版本不同）
  fs.copyFileSync(MANIFEST_FILE, path.join(tmpDir, "userdata-manifest.json"));
  for (const rel of files) {
    const src = path.join(APP_ROOT, rel);
    const dst = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // 2026-08-31 修复：tmpDir 清理必须在 zip 命令完成后执行（原来 finally 在 Promise 返回时
  //   立即删除临时目录，zip 还没跑完就报 No such file or directory）
  return new Promise((resolve, reject) => {
    execFile(ZIP_BIN(), ["-r", "-q", zipPath, "userdata-manifest.json"].concat(files), { cwd: tmpDir, maxBuffer: 1024 * 1024 * 512 }, (err) => {
      const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };
      if (err) { cleanup(); return reject(err); }
      try { const buf = fs.readFileSync(zipPath); cleanup(); resolve(buf); }
      catch (e) { cleanup(); reject(e); }
    });
  });
}

// ---- zip 导入（zipPath 为上传文件已落磁盘的路径）----
function importZip(zipPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gbmd-restore-"));
  const outDir = path.join(tmpDir, "out");
  // 1) 先读 zip 内的 manifest（如存在）用于白名单；失败则用项目当前清单
  let manifest = null;
  try { manifest = readManifest(); } catch (_) {}
  // 2) 解压到隔离目录（2026-08-31 修复：清理放在 unzip 完成后，避免临时目录提前被删）
  return new Promise((resolve, reject) => {
    execFile(UNZIP_BIN(), ["-o", "-q", zipPath, "-d", outDir], { maxBuffer: 1024 * 1024 * 512 }, (err) => {
      const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };
      if (err) { cleanup(); return reject(err); }
      try { const r = restoreFromDir(outDir, manifest); cleanup(); resolve(r); }
      catch (e) { cleanup(); reject(e); }
    });
  });
}

// ---- 从解压目录恢复（白名单校验并写回）----
function restoreFromDir(outDir, manifest) {
  // 使用 zip 内的清单（如有），否则项目当前清单
  let m = manifest;
  const zipManifestPath = path.join(outDir, "userdata-manifest.json");
  if (fs.existsSync(zipManifestPath)) {
    try { m = JSON.parse(fs.readFileSync(zipManifestPath, "utf8")); } catch (_) {}
  }
  if (!m || m.schema !== 1) throw new Error("未找到 userdata-manifest.json（无法校验白名单）");
  if (!m.files || !m.dirs) throw new Error("清单格式无效");

  // 白名单：精确文件 + dirs 目录下以 suffix 结尾
  const allowedExact = new Set(m.files.map((f) => f.rel));
  const allowedDirSuffix = (m.dirs || []).map((d) => ({ dir: d.rel, suffix: d.suffix || "" }));
  const isAllowed = (rel) => {
    if (allowedExact.has(rel)) return true;
    for (const { dir, suffix } of allowedDirSuffix) {
      const prefix = dir + "/";
      if (rel.startsWith(prefix) && rel.endsWith(suffix)) return true;
    }
    return false;
  };

  const restored = [];
  const skipped = [];
  // 遍历解压目录所有文件（相对 outDir）
  const walk = (dir, prefix) => {
    for (const n of fs.readdirSync(dir)) {
      const abs = path.join(dir, n);
      const rel = prefix ? prefix + "/" + n : n;
      if (fs.statSync(abs).isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!isAllowed(rel)) { skipped.push(rel); continue; }
      const dst = path.join(APP_ROOT, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst);
      restored.push(rel);
    }
  };
  walk(outDir, "");

  return {
    ok: true,
    restored,
    skipped,
    note: "导入完成。config/sessions/下载任务等如服务运行中，部分文件需重启服务后完全生效（./start-linux.sh restart）"
  };
}

module.exports = { readManifest, collectFiles, exportZip, importZip };