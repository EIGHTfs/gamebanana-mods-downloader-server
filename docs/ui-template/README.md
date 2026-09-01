# GameBanana Mod Downloader 纯前端 UI 模板（docs/ui-template/）

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
| ✅ 提供 | `path-picker.js`——**路径输入+目录选择小模块**（2026-09-02 用户要求封装复用）：任何下载路径输入框一行 `PathPicker.attach(inputEl)` 即带 📂 目录选择弹窗（游戏路径、默认下载位置均已接入） |
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

### 怎么起真实后端（带端口指定）

模板只含前端；真实后端 = 项目根 `server/app.js` + `start-linux.sh`。启动命令
（`--port` 指定端口，优先级：命令 > config.json 的 `port` > 默认 8642）：

```bash
./start-linux.sh start --port 8643   # 启动，指定端口
./start-linux.sh restart --port 8643 # 重启，指定端口
./start-linux.sh start               # 默认（config.json 的 port，缺省 8642）
./start-linux.sh stop                # 停止
./start-linux.sh status              # 状态
./start-linux.sh --set-password "新密码"  # 设置访问密码
```

> 前端接真实后端时，`api()` 指向 `http://<服务器IP>:<端口>`；油猴脚本的
> 服务器地址输入框填同一地址（**不写死示例 IP**，让用户自己填）。

---

## 三、文件结构

```
docs/ui-template/
├── index.html        主界面（4 个 tab 完整布局）
├── login.html        登录页（纯前端演示用）
├── setup.html        首次设置页（纯前端演示用）
├── style.css         全部样式（含白天/夜间主题变量）
├── favicon.png       浏览器标签页图标（72px，照搬香蕉网官方香蕉 logo，非自绘）
├── favicon.ico       浏览器标签页图标（16px，必须 200——Chrome 标签页图标依赖它）
├── app.js            前端交互逻辑（模板版，已去后端耦合）
├── path-picker.js    ★ 路径输入+目录选择小模块（2026-09-02 新增，见「一」说明；真实版同名文件在 server/public/）
├── mock-api.js       ★ 模拟后端层：全局 api() + fetch 接管 + 接口契约注释
├── template-runtime-check.js   验证脚本（fake-DOM 跑 init，确认无未捕获异常）
└── README.md         本文件
```
> 真实后端的启动脚本在项目根 `start-linux.sh`（本模板目录不含后端，见下「怎么起真实后端」）。

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
6. **状态行样板**：原来 ~40 处散落的 `el.textContent = ...; el.className = "status ok/err"`
   重复写法 → 新增 `setStatus(el, msg, type)` helper 统一收敛（旧代码保留注释）。
7. **原生 alert() 与页面 toast 混用**：信息性 alert（下载失败/重试/跳过等）→
   统一改用 `showFeedback()` toast；`confirm()` 破坏性确认保留。

### B 档：仅记录，模板保留原样（改动风险大/需后端配合）

8. **`window.__games` / `window.__addGameInfo` / `window.__gbChars` /
   `window.__setRestoreModeDisabled` 全局命名空间传递状态**：多个函数靠挂
   window 传值，缺模块化。建议后续改成单例状态对象。
9. **两套「可搜索角色下拉」几乎重复**（bindKeywordSearch 的 `kwRoleCombo` vs
   bindMerge 的 `mmComboList`，各自 20+ 行过滤/键盘/点击处理）→ 建议抽成
   一个 `<role-combo>` 组件。
10. **大量 `catch (_) {}` 静默吞错**（轮询/加载里十几处）→ 建议统一 console.warn。
11. **`api()` 401 硬编码 `location.href = "/login.html"`**：子路径部署会跳错根
    路径 → 建议用相对路径或配置项。
12. **单文件无模块化**（现约 1430 行）：顶层函数全部全局可见，命名冲突风险。
13. **`$("#searchEnd")` 等初始化直接写死当日前端值**：与后端默认范围可能不一致。

> 说明：A 档第 6/7 条（setStatus、alert→toast）已同时修到真实版 server/public/app.js
> 并同步回模板；B 档仍建议后续跟进（需后端回归测试）。

---

## 六、界面文案约定（2026-08-31 用户要求）

- **界面不留「实际例子」**：提示/占位符不写具体 mod 链接（如某 mod id）、
  具体角色名（如某角色名→英文名）、具体 hash（如某 jpg 短名）、具体路径等。
  只保留通用功能说明（例：「每行一个 Mod 链接或纯数字 id」）。
- 若你复用模板做别的东西，提示里也建议避免硬编码示例值，方便换领域复用。

---

## 七、界面里有哪些区域（便于复用裁剪）

| Tab | 关键交互 | 依赖端点（mock 已覆盖） |
|---|---|---|
| ⬇ 下载 | 批量链接提交、清空 | `/api/download` |
| 📊 下载进度 | 任务轮询、暂停/继续/停止、重试/跳过、并发数、找回模式、**任务 json 导出/导入** | `/api/task*`, `/api/skip*`, `/api/task/export`, `/api/task/import` |
| 🔍 搜索 | 时间+分级筛选搜索、关键词搜索、角色下拉、全选/保存/导入导出 | `/api/search*`, `/api/keyword-search`, `/api/gb-characters` |
| ⚙ 设置 | 游戏映射增删、**默认下载位置（带 📂 目录选择）**、香蕉网登录状态（检测=多行块）、改密码、数据备份 zip 导入导出、hash 三表查询/**重建（选游戏）**、**未完成任务扫描（重建顺带开关，导出/一键加入有数据才可点）**、角色映射合并/清空 | `/api/games`, `/api/settings`, `/api/browse`, `/api/gb-*`, `/api/hash*`, `/api/scan-incomplete`, `/api/scan-incomplete/download`, `/api/merge-roles`, `/api/cleanup-empty-dirs`, `/api/data/*` |

---

## 八、SA6400 上现成的预览服务（可选）

本项目的 SA6400 上已另起一个独立静态服务（与 8642 后端无关）：

```bash
# 服务在 SA6400 后台运行（python3 -m http.server 8890，目录=docs/ui-template）
# 浏览器打开（局域网内任意设备）：
#   http://sa6400.local:8890/index.html
# 进程：python3（PID 可在 SA6400 `netstat -tlnp | grep 8890` 查到），
# 日志：/tmp/gbmd-template-httpd.log
```

> 注意：该服务是临时起的，NAS 重启后不会自动恢复；要长期留用可把命令写进
> 部署脚本。

---

## 九、检测登录状态 & 油猴脚本输出规范（2026-09-01 对齐 iwara 改法）

### 设置页「检测登录状态」（多行块）
- 点按钮 → `GET /api/gb-login-status`（需登录 session）→ 渲染进
  `<pre id="gbLoginStatus" class="login-detect">`，三态配色 `.ok/.warn/.err`。
- 多行格式（与油猴面板同一套）：
  ```
  ✅ 已登录（剩 61 天）
  👤 用户名: fluquor
  🆔 用户 id: 2330203
  🔗 https://gamebanana.com/members/2330203
  ───
  完整 Cookie: 125 字符 / 2 项 ｜ 存于服务器（不回传明文）
  含 sess: ✅ 有
  含 rmc: ✅ 有
  ```
- 后端返回契约（`mock-api.js` 已同步）：`{ ok, loggedIn, configured, cookieSet,
  username?, idRow?, profileUrl?, expiresAt?, remainingDays?, warnLevel?(ok|warn|expired),
  cred?{ cookieChars, cookieItems, hasSess, hasRmc }, detail? }`。
- `remainingDays` 来自服务器解析 GameBanana **rmc 的 Expires**（sess 是会话 cookie 无到期）；
  剩 ≤7 天 → warn（⚠️），<0 → expired（❌）。

### 顶栏用户名徽章（三态）
- `#gbUserBadge`：未配置凭证→「未配置凭证」(err)；已登录→「👤 用户名 · 剩 N 天」(ok，
  剩≤7天转 ⚠️ warn)；过期→「❌ 已过期」(err)。夜间模式单独配色。

### 油猴脚本输出（浏览器直接触发安装/更新）
- 服务器输出 `.user.js` 时 **必须 `Content-Disposition: inline`**（不是 attachment）：
  ```
  Content-Type: text/javascript; charset=utf-8
  Content-Disposition: inline; filename=xxx.user.js
  Cache-Control: no-store
  ```
  `attachment` 会强制浏览器下载文件（用户看到「弹下载」），`inline` 让浏览器直接打开
  → Tampermonkey/Violentmonkey 自动弹安装/更新。
- 脚本 `@name`/`@version` 每次升级都要变，油猴才认「有更新」；模板里只演示前端，
  油猴脚本本体在项目根 `scripts/gamebanana-cookie-userscript.user.js`（SA6400 同源）。

---

## 十、已知取舍

- 模板的登录页/设置页点按钮会「模拟成功」，但不会真正改变任何东西。
- 导出按钮会下载一个占位文件（内容为 mock 占位字符串），并非真实数据。
- 想看到「有数据」的演示版：可临时在 `mock-api.js` 的 `get()` 里填几条假
  记录（README 不鼓励污染，建议复制成 `mock-api.demo.js` 再改）。
