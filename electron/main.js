// ============================================================
// gbmd-v3 Electron 主进程（桌面应用版）
// 职责：
//   1. 内嵌启动 Node 后端（server/app.js，零依赖，本进程直接 require 不起子进程）
//   2. 后端就绪后打开内嵌浏览器窗口加载 http://127.0.0.1:<port>
//   3. 应用退出时同时停掉后端
// 数据目录（config.json / 本地表 / 日志）：
//   - 开发模式：项目内 server/（同命令行版）
//   - 打包后：app.getPath("userData")（如 ~/Library/Application Support/gbmd-v3）
// ============================================================
"use strict";

const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

// ---------- 后端入口（打包后 asar 内的 server/app.js）----------
const SERVER_ENTRY = path.join(__dirname, "..", "server", "app.js");

// ---------- 数据目录（打包后避免写 asar 只读区）----------
const IS_PACKAGED = !!app.isPackaged;
const DATA_DIR = IS_PACKAGED
  ? path.join(app.getPath("userData"), "server")
  : path.join(__dirname, "..", "server");
const DATA_JSON_DIR = IS_PACKAGED
  ? path.join(app.getPath("userData"), "json")
  : path.join(__dirname, "..", "json");
const DATA_MAPPING_DIR = IS_PACKAGED
  ? path.join(app.getPath("userData"), "mapping")
  : path.join(__dirname, "..", "mapping");
process.env.GBMD_DATA_DIR = DATA_DIR;

let backendProcess = null;
let win = null;
let port = 8642;

// ---------- 启动后端（fork 子进程跑 server/app.js）----------
function startBackend() {
  return new Promise((resolve, reject) => {
    const { fork } = require("child_process");
    // 打包后 app.js 用 __dirname 定位 server 目录，正常；数据目录经 GBMD_DATA_DIR 重定向（见下）
    backendProcess = fork(SERVER_ENTRY, [], {
      env: {
        ...process.env,
        PORT: String(port),
        GBMD_DATA_DIR: DATA_DIR,
        // json/ 与 mapping/ 的可写副本（首次启动由 config.js ensureDataDirs 从 asar 内置复制）
        GBMD_JSON_DIR: DATA_JSON_DIR,
        GBMD_MAPPING_DIR: DATA_MAPPING_DIR
      }
    });
    const timer = setTimeout(() => reject(new Error("后端启动超时")), 20000);

    // 轮询 /api/status 直到就绪
    const poll = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/status", timeout: 1500 }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          if (d.includes("needsSetup") || d.includes("ok")) {
            clearTimeout(timer);
            resolve();
          } else poll();
        });
      });
      req.on("error", () => setTimeout(poll, 800));
      req.setTimeout(1500, () => { try { req.destroy(); } catch (_) {} });
    };
    poll();

    backendProcess.on("exit", (code) => {
      if (code !== 0 && !app.isQuitting) {
        dialog.showErrorBox("gbmd-v3", "后端服务异常退出，应用将关闭。\n请查看数据目录日志。");
        app.quit();
      }
    });
  });
}

// ---------- 主窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "gbmd-v3 - GameBanana Mod 下载器",
    autoHideMenuBar: true,
    webPreferences: {
      // 后端自带密码鉴权，窗口内就是网页本身；允许新窗口外链用系统浏览器打开
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  // 外链（GB mod 页面等）用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => { win = null; });
}

app.isQuitting = false;
app.whenReady().then(async () => {
  // 首次启动提示设密
  const { readConfig } = require(path.join(SERVER_ENTRY.replace(/app\.js$/, "config.js")));
  try {
    if (!readConfig().passwordHash) {
      const r = await dialog.showMessageBox({
        type: "info",
        buttons: ["去设置密码", "稍后"],
        title: "gbmd-v3 首次使用",
        message: "尚未设置访问密码",
        detail: "打开网页后请在「设置」页设置密码（或命令行 --set-password）。"
      });
      if (r.response === 0) shell.openExternal(`http://127.0.0.1:${port}`);
    }
  } catch (_) {}

  try {
    await startBackend();
    createWindow();
  } catch (e) {
    dialog.showErrorBox("gbmd-v3 启动失败", e.message);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (backendProcess) {
    try { backendProcess.kill(); } catch (_) {}
  }
});
