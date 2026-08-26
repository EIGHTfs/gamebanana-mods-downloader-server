# Windows 桌面应用构建指南（给另一台 Windows 电脑的 AI）

> 本文档是给「在一台 Windows 电脑上构建 gbmd-v3 Electron 桌面应用」的完整操作说明。
> 阅读者可以是人，也可以是另一个 AI 助手（把本文档整段发给它即可执行）。

## 目标

在 Windows 电脑上构建出 `gbmd-v3` 的 Windows 安装包（NSIS 安装版 + portable 便携版），产物：
- `dist/gbmd-v3-3.0.0 Setup.exe`（NSIS 安装版）
- `dist/gbmd-v3-3.0.0-portable.exe`（便携版，免安装）

## 前置要求

1. **Windows 10/11**（x64）
2. **Node.js 18+**：从 https://nodejs.org 下载 LTS 版安装（一路默认即可）
3. **网络**：能访问 github.com（用于拉取代码）和 npm（electron 二进制下载）

## 操作步骤

### 1. 获取代码

打开 PowerShell（或 CMD），执行：

```powershell
git clone https://github.com/EIGHTfs/gamebanana-mods-downloader-server.git gbmd-build
cd gbmd-build
```

> 如果 git 不是 git 命令，先装 Git for Windows：https://git-scm.com/download/win

### 2. 安装构建依赖

```powershell
npm install --no-audit --no-fund
```

> 这会下载 electron（约 100MB）和 electron-builder。耐心等待，不要中断。

### 3. 配置打包图标（可选）

electron-builder 无图标时会用 Electron 默认图标。如需自定义：
- 放一个 `build/icon.ico`（Windows 图标，256x256）
- 在 `package.json` 的 `build.win.icon` 指向它

没有图标也能构建（产物正常，只是默认图标）。

### 4. 构建 Windows 包

```powershell
npm run dist:win
```

预期输出（日志尾部类似）：
```
• building target=NSIS file=dist/gbmd-v3-3.0.0 Setup.exe
• building target=portable file=dist/gbmd-v3-3.0.0-portable.exe
```

产物在 `dist/` 目录：
- `gbmd-v3-3.0.0 Setup.exe` —— 安装版
- `gbmd-v3-3.0.0-portable.exe` —— 便携版（双击即用）

### 5. 验证（重要）

**方式 A（命令行验证后端）**：不启动 GUI，先确认后端能跑：

```powershell
node server/app.js --set-password "test123"
$env:PORT="18788"; node server/app.js
# 另开一个 PowerShell：
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:18788/api/status
# 应返回 {"ok":true,...}
```

**方式 B（验证打包后的 exe）**：
1. 双击 `dist/gbmd-v3-3.0.0-portable.exe`
2. 出现窗口后，等 3-5 秒（后端启动）
3. 窗口应加载出 gbmd 网页界面（四个选项卡）
4. 首次运行 SmartScreen 会提示"Windows 已保护你的电脑"→ 点"更多信息" → "仍要运行"

验证要点：
- 窗口正常显示界面
- 数据目录自动生成（`%APPDATA%\gbmd-v3\` 下应有 server/config.json、json 副本、mapping 副本）
- 能正常搜索/下载（可用任意 mod id 测试，如 707326）

### 6. 产物交付

把 `dist/` 下的 exe 文件拷贝给用户（U 盘 / 网盘 / 共享目录均可）。

## 常见问题

| 问题 | 解决 |
|---|---|
| `npm install` 卡在 electron 下载 | 设镜像：`npm config set electron_mirror https://npmmirror.com/mirrors/electron/` 后重试 |
| SmartScreen 拦截 | 未签名应用正常现象，点"仍要运行"；正式分发需代码签名证书 |
| 杀毒软件误报 | 未签名 Electron 应用偶发误报，可加白名单 |
| 端口 8642 被占用 | 应用会 fork 后端到 8642；被占用时改 `server/config.json` 的 port 或设 `PORT` 环境变量 |
| 构建报 `EINVAL` / 权限错误 | 用管理员 PowerShell 重试；关闭杀毒软件实时防护 |

## 注意事项

- 本仓库是**公开仓库**，克隆即可，无需账号
- 构建是纯本地操作，不需要上传任何代码
- Windows 打包**不能**在 macOS/Linux 上交叉构建出完整 exe（electron-builder 需要 Windows 环境生成 NSIS）——所以必须在 Windows 机器上做
- 若同时要 arm64 的 Windows 包（Surface 等 ARM 设备），构建时加 `--arm64`：`npm run dist:win -- --arm64`
