# -*- coding: utf-8 -*-
# 修复老 bug：/api/browse 目录浏览不显示带 . 的目录
# 用户原话（2026-08-31）：「我发现个老bug，设置目录不显示带.目录」
# 原因：`!e.name.startsWith(".")` 把所有 . 开头目录（.Mods/.代理人等）都过滤了，
#       导致选不到 .../Mods/.Mods/(gamebanana) 这类游戏根。
# 修复：只排除群晖系统目录 @eaDir（每目录都有、刷屏）、#recycle（回收站）、.git（版本库）。
import io

p = "/volume6/Game.Patch N MOD/gamebanana-mods-downloader-server/server/app.js"
s = io.open(p, encoding="utf-8").read()

old = '''        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort();'''
new = '''        const entries = fs.readdirSync(dir, { withFileTypes: true });
        // 2026-08-31 修复老 bug（用户原话：「设置目录不显示带.目录」）：
        //   不再过滤 . 开头目录（.Mods/.代理人/(gamebanana) 深层根需能选到），
        //   只排除群晖系统目录 @eaDir（缩略图缓存，每个目录都有）、#recycle（回收站）、.git（版本库）
        const dirs = entries
          .filter((e) => e.isDirectory() && e.name !== "@eaDir" && e.name !== "#recycle" && e.name !== ".git")
          .map((e) => e.name)
          .sort();'''
assert s.count(old) == 1, f"锚点不唯一: {s.count(old)}"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8").write(s)
print("app.js /api/browse 已修复：显示 . 目录，仅排除 @eaDir/#recycle/.git")