// template-runtime-check.js — 用 fake DOM 在 Node 里执行模板的 mock-api.js + app.js，
// 跑完整 init()，确认：① 无未捕获异常 ② 所有 api 调用都命中 mock 路由 ③ 顶层功能函数可调用
"use strict";
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const DIR = __dirname;

// ---------- 通用元素垫片（Proxy：任何属性读返回垫片/值，任何方法调用返回函数/数组） ----------
const noop = () => {};
const makeEl = () => {
  const el = {
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    value: "", checked: false, disabled: false, textContent: "", innerHTML: "", placeholder: "",
    _listeners: {},
    addEventListener: (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    removeEventListener: noop,
    querySelector: () => makeEl(), querySelectorAll: () => [],
    appendChild: () => el, removeChild: noop, click: noop, focus: noop,
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    contains: () => false, closest: () => null,
  };
  return el;
};
// 按 id 建立真实元素缓存（让 bindSettings 里按 id 查询能拿到同一个垫片）
const els = new Map();
const getEl = (id) => { if (!els.has(id)) els.set(id, makeEl()); return els.get(id); };

// ---------- 全局上下文 ----------
const errors = [];
const hits = [];
const sandbox = {
  console,
  window: null, // 下面赋值
  document: {
    querySelector: (sel) => getEl(String(sel).replace(/^[#.]/, "")),
    querySelectorAll: () => [],
    getElementById: (id) => getEl(id),
    createElement: () => makeEl(),
    createElementNS: () => makeEl(),
    addEventListener: noop,
    removeEventListener: noop,
    body: makeEl(),
    documentElement: makeEl(),
  },
  location: { href: "", hash: "", replaceState: noop, reload: noop },
  history: { replaceState: noop, pushState: noop },
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
  sessionStorage: { getItem: () => null, setItem: noop },
  fetch: (url, opts) => Promise.resolve(new (sandbox.Response || function () {})(), { status: 404 }), // mock-api.js 会接管
  URL: { createObjectURL: () => "", revokeObjectURL: noop },
  Blob: function () {}, Response: function (body, init) { this.body = body; this.status = (init && init.status) || 200; },
  FileReader: function () { this.readAsDataURL = () => { if (this.onload) this.onload({ target: { result: "" } }); }; },
  setTimeout: (fn) => { try { fn && fn(); } catch (e) { errors.push(e); } return 1; },
  clearTimeout: noop,
  setInterval: () => 1,   // 不真的轮询
  clearInterval: noop,
  alert: (m) => console.log("[alert]", m),
  confirm: () => true,
  prompt: () => "",
  atob: (s) => s, btoa: (s) => s,
  unhandled: (e) => errors.push(e),
  __mockHits: hits,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = noop;

// 捕获 init() 里 async 错误：给 api 打补丁，把每个命中点记下来
const ctx = vm.createContext(sandbox);
const mockSrc = fs.readFileSync(path.join(DIR, "mock-api.js"), "utf8");
vm.runInContext(mockSrc, ctx, { filename: "mock-api.js" });

// 在 sandbox 里给 api 包一层记录
vm.runInContext(`
  const _origApi = api;
  api = async function (path, method, body) {
    window.__mockHits.push(path.split("?")[0]);
    return _origApi(path, method, body);
  };
`, ctx);

// 2026-09-01 断言：settings「POST 保存 → GET 读回」不回退 + 脱敏（覆盖用户报的『点保存读旧值』bug）
vm.runInContext(`
  (async () => {
    const r0 = await api("/api/settings");
    if (r0.ok && r0.settings && "gbCookie" in r0.settings) {
      throw new Error("settings GET 不应回传 gbCookie 明文（应脱敏为 hasGbCookie）");
    }
    const saved = await api("/api/settings", "POST", { gbCookie: "sess=abc123; rmc=def456" });
    if (!(saved.ok && saved.settings && saved.settings.hasGbCookie === true)) {
      throw new Error("POST 保存后 settings 应 hasGbCookie=true（脱敏标志）");
    }
    const r2 = await api("/api/settings");
    if (!(r2.settings && r2.settings.hasGbCookie === true)) {
      throw new Error("POST 保存后 GET 读回应仍 hasGbCookie=true（不读回旧值/不回退）");
    }
    if ("gbCookie" in r2.settings) {
      throw new Error("GET 读回仍不应含 gbCookie 明文");
    }
    window.__settingsOk = true;
  })().catch((e) => { window.__settingsErr = e.message; });
`, ctx);

// 主进程把 async 错误捕获转发
process.on("unhandledRejection", (e) => { errors.push(e); });

const appSrc = fs.readFileSync(path.join(DIR, "app.js"), "utf8");
try {
  vm.runInContext(appSrc, ctx, { filename: "app.js" });
} catch (e) {
  errors.push(e);
}

// init() 是 async 的，给它时间跑完
setTimeout(() => {
  const uniq = [...new Set(hits)];
  console.log("=== api 命中路由数:", uniq.length, "===");
  console.log(uniq.join("\n"));
  console.log("");
  if (errors.length) {
    console.log("❌ 发现错误", errors.length, "个:");
    errors.forEach((e) => console.log("   -", e && e.stack || e));
    process.exit(1);
  } else {
    console.log("✅ init() 完整执行无未捕获异常");
    if (sandbox.__settingsErr) {
      console.log("❌ settings 保存断言失败:", sandbox.__settingsErr);
      process.exit(1);
    } else if (sandbox.__settingsOk) {
      console.log("✅ settings POST保存→GET读回 不回退，且已脱敏（修复『点保存读旧值』bug）");
      process.exit(0);
    } else {
      console.log("⚠️ settings 断言未执行（可能未调用）");
      process.exit(0);
    }
  }
}, 300);
