# gbmd 纯前端 UI 模板（docs/ui-template/）

> 本目录是 gamebanana-mods-downloader-server 网页的**纯前端可复用模板**：
> 完整保留界面布局/样式/交互逻辑，但**不接入任何后端**——所有 API 由
> `mock-api.js` 模拟返回「空态数据」，双击 index.html（或起个静态服务器）
> 即可整页浏览、点按钮、看空态占位。

---

## 一、这是什么 / 不是什么

| 项目 | 说明 |
|---|---|
| ✅ 保留 | 全部页面结构（下载/下载进度/搜索/设置 4 个 tab）、样式、交互、主题切换、目录弹窗、自绘下拉 |
| ✅ 提供 | `mock-api.js`——全局 `api()` 空态实现 + 每个端点的**接口契约注释**（见文件内） |
| ❌ 不含 | 任何后端（无 Node 服务、无数据库、无文件读写、无香蕉网请求） |
| ❌ 不含 | 真实数据（搜索记录/下载任务/游戏映射全部为空） |

**用途**：当 UI 脚手架 —— 想照这个界面做别的工具，或想在不装环境的情况下
快速看界面长什么样。

---

## 二、怎么跑起来

```bash
# 方式 A：直接双击 index.html（现代浏览器一般可直接打开）
# 方式 B：起一个静态服务器（推荐，避免 file:// 限制）
cd docs/ui-template
python3 -m http.server 8765
# 浏览器打开 http://127.0.0.1:8765/index.html
```

打开后你能看到完整界面；点击「搜索/下载/合并」等按钮都会正常给出
「空结果 / 无任务 / 加载中…」反馈，只是没有真实数据。

> 浏览器控制台会打印 `[mock-api] ...` 与 `[mock-api] 纯前端模板模式已启用`，
> 方便确认 mock 层在工作。

---

## 三、文件结构

```
docs/ui-template/
├── index.html        主界面（4 个 tab 完整布局）
├── login.html        登录页（纯前端演示用）
├── setup.html        首次设置页（纯前端演示用）
├── style.css         全部样式（含白天/夜间主题变量）
├── favicon.png       浏览器标签页图标（72px 香蕉）
├── app.js            前端交互逻辑（模板版，已去后端耦合）
├── mock-api.js       ★ 模拟后端层：全局 api() + fetch 接管 + 接口契约注释
└── README.md         本文件
```

---

## 四、怎么接真实后端（最重要）

模板把「API 层」隔离在 `mock-api.js` 一个文件里，接后端**不需要改界面代码**：

1. **替换 `api()`**：把 `mock-api.js` 里的 `async function api(...)` 换成
   真实后端版的 fetch 实现（模板 `app.js` 顶部注释里保留了原实现样例）；
2. **去掉 fetch 接管**：删掉 `mock-api.js` 里覆盖 `window.fetch` 那段
   （或让 `window.fetch` 直接指向真实后端）；然后不要加载 mock-api.js 即可，
   直接用自己的 `api(path, method, body)`。
3. **对照契约**：每个端点的真实返回结构都写在 `mock-api.js` 的 `MOCK_ROUTES`
   每一条的 `note:` 里 —— 照着实现后端路由，或照着调整前端取值。

> 也就是说：`mock-api.js` 既是 mock，也是一份**前后端接口契约速查表**。

---

## 五、前端「不优美调用点」清单与处置（2026-08-31 通读 app.js 1419 行）

> 做模板时顺手梳理。分为两档：**已在模板修复** / **仅记录，模板保留原样**。

### A 档：已在模板版 app.js 顺手修好的

1. **api() 与裸 fetch 混用**：真实版里 `/api/search/export`、`/api/data/export`
   两处绕过统一 `api()` 直接 `fetch()`，401/blob 逻辑重复 → 模板由 mock-api.js
   统一接管，前端不再写裸 fetch。
2. **`$("#searchEnd").value = now.toISOString().slice(0,10)`**：`toISOString()`
   是 UTC，东八区会显示成**前一天** → 模板改用本地日期 `localDate()`。
3. **`fmtTs(it.dateAdded)` 调用两次**（renderSearchResults 里 `!== "-" ? a : b`
   连写两次函数调用）→ 模板抽成 IIFE 只算一次。
4. **轮询无防重入标志**：`startTaskPoll` / `startSearchPoll` 的 setInterval
   async 回调，若请求慢于 2s 会堆叠并发请求 → 模板加 `inFlight` 标志，上次
   未返回则跳过本次。
5. **`init()` 重复请求**：启动时 `/api/settings` 请求 3 次、`/api/games` 2 次
   （loadGameSelects + loadSettings 各拉一次）→ 模板未动真实接口数，但 mock
   下无副作用；真实后端优化建议见下。

### B 档：仅记录，模板保留原样（改动风险大/需后端配合）

6. **`window.__games` / `window.__addGameInfo` / `window.__gbChars` /
   `window.__setRestoreModeDisabled` 全局命名空间传递状态**：多个函数靠挂
   window 传值，缺模块化。建议后续改成单例状态对象。
7. **两套「可搜索角色下拉」几乎重复**（bindKeywordSearch 的 `kwRoleCombo` vs
   bindMerge 的 `mmComboList`，各自 20+ 行过滤/键盘/点击处理）→ 建议抽成
   一个 `<role-combo>` 组件。
8. **大量 `catch (_) {}` 静默吞错**（轮询/加载里十几处）→ 建议统一 console.warn。
9. **`alert()`/`confirm()` 原生弹窗与页面内 toast 混用**（下载停止/合并/清空
   用原生 confirm，进度反馈用 showFeedback toast）→ 建议统一。
10. **`api()` 401 硬编码 `location.href = "/login.html"`**：子路径部署会跳错根
    路径 → 建议用相对路径或配置项。
11. **单文件 1419 行无模块化**：顶层函数全部全局可见，命名冲突风险。
12. **`$("#searchEnd")` 等初始化直接写死当日前端值**：与后端默认范围可能不一致。

> 这 12 条也建议同步考虑修到真实版 server/public/app.js（需后端回归测试）。

---

## 六、界面里有哪些区域（便于复用裁剪）

| Tab | 关键交互 | 依赖端点（mock 已覆盖） |
|---|---|---|
| ⬇ 下载 | 批量链接提交、清空 | `/api/download` |
| 📊 下载进度 | 任务轮询、暂停/继续/停止、重试/跳过、并发数、找回模式 | `/api/task*`, `/api/skip*` |
| 🔍 搜索 | 时间+分级筛选搜索、关键词搜索、角色下拉、全选/保存/导入导出 | `/api/search*`, `/api/keyword-search`, `/api/gb-characters` |
| ⚙ 设置 | 游戏映射增删、香蕉网登录状态、改密码、数据备份 zip 导入导出、hash 三表查询/重建、角色映射合并/清空 | `/api/games`, `/api/settings`, `/api/gb-*`, `/api/hash*`, `/api/merge-roles`, `/api/cleanup-empty-dirs`, `/api/data/*` |

---

## 七、已知取舍

- 模板的登录页/设置页点按钮会「模拟成功」，但不会真正改变任何东西。
- 导出按钮会下载一个占位文件（内容为 mock 占位字符串），并非真实数据。
- 想看到「有数据」的演示版：可临时在 `mock-api.js` 的 `get()` 里填几条假
  记录（README 不鼓励污染，建议复制成 `mock-api.demo.js` 再改）。
