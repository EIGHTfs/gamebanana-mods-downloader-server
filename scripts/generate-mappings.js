#!/usr/bin/env node
// ============================================================
// gbmd-v3 - mapping 文件生成器（一次性迁移工具，可重复运行）
//
// 新项目 mapping/ 文件夹：每个游戏一个 JSON 文件，文件用作映射（计算下载路径）。
//   文件格式：
//   {
//     "warehouses": { "characters": "角色", "weapons": "武器", "skins": "" },
//       // 香蕉网大仓库（superCategory）→ 本地分类目录名；skins 映射为空 = 该层跳过
//       // 代码内部默认映射（Characters→角色 / Weapons→武器 / Skins→空）仅在没有
//       // 对应游戏的 mapping JSON 时生效；文件存在则以文件为准
//     "roles": { "Sandrone": "桑多涅", ... },
//       // 角色/具体项英文名 → 中文；目录名 = 「英文 – 中文」（如 Sandrone – 桑多涅）
//     "variants": { "tribble": "Tribbie", "黄泉": "Acheron", ... }
//       // 搜索归一用变体（拼写/别名/中文 → 规范英文）
//   }
//
// 数据源：旧项目 json/mapping.json（roleMapping + variantIndex）为基底；
// 原神/绝区零用本文件内置的完整角色表（旧表缺 Sandrone 等大量角色且有错误条目）。
// 用法：node scripts/generate-mappings.js [旧 mapping.json 路径]
// ============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const OLD_MAPPING = process.argv[2] || "/vol02/1000-0-7ff2e318/deepseek/DeepSeekHarness/deepseek-harness-nas_0.1.1-rc.2_x86/项目/gamebanana-mods-downloader-server/json/mapping.json";
const OUT_DIR = path.join(__dirname, "..", "mapping");

// ---------- 内置完整角色表（原神 / 绝区零）----------
// 官方简体中文名；缺中文的角色用纯英文（目录名回退英文）
const GENSHIN_ROLES = {
  Albedo: "阿贝多", Alhaitham: "艾尔海森", Aloy: "埃洛伊", Amber: "安柏",
  Arlecchino: "阿蕾奇诺", Ayaka: "神里绫华", Ayato: "神里绫人", Baizhu: "白术",
  Barbara: "芭芭拉", Beidou: "北斗", Bennett: "班尼特", Candace: "坎蒂斯",
  Charlotte: "夏洛蒂", Chevreuse: "夏沃蕾", Childe: "达达利亚", Chongyun: "重云",
  Citlali: "茜特菈莉", Clorinde: "克洛琳德", Collei: "柯莱", Columbina: "哥伦比娜",
  Cyno: "赛诺", Dehya: "迪希雅", Diluc: "迪卢克", Diona: "迪奥娜",
  Dori: "多莉", Emilie: "艾梅莉埃", Escoffier: "埃科菲耶", Eula: "优菈",
  Faruzan: "珐露珊", Fischl: "菲谢尔", Freminet: "菲米尼", Furina: "芙宁娜",
  Gaming: "嘉明", Ganyu: "甘雨", Gorou: "五郎", Heizou: "鹿野院平藏",
  "Hu Tao": "胡桃", Iansan: "伊安珊", Itto: "荒泷一斗", Jean: "琴",
  Kachina: "卡齐娜", Kaeya: "凯亚", Kaveh: "卡维", Kazuha: "枫原万叶",
  Keqing: "刻晴", Kinich: "基尼奇", Kirara: "绮良良", Klee: "可莉",
  Kokomi: "珊瑚宫心海", "Kujou Sara": "九条裟罗", "Kuki Shinobu": "久岐忍",
  Layla: "莱依拉", Lisa: "丽莎", Lynette: "琳妮特", Lyney: "林尼",
  Mavuika: "玛薇卡", Mika: "米卡", Mizuki: "梦见月瑞希", Mona: "莫娜",
  Mualani: "玛拉妮", Nahida: "纳西妲", Navia: "娜维娅", Neuvillette: "那维莱特",
  Nilou: "妮露", Ningguang: "凝光", Noelle: "诺艾尔", Ororon: "欧洛伦",
  Qiqi: "七七", "Raiden Shogun": "雷电将军", Razor: "雷泽", Rosaria: "罗莎莉亚",
  Sandrone: "桑多涅", Sayu: "早柚", Shenhe: "申鹤", Sigewinne: "希格雯",
  Skirk: "丝柯克", Sucrose: "砂糖", Tartaglia: "达达利亚", Thoma: "托马",
  Tighnari: "提纳里", Varesa: "瓦雷莎", Venti: "温迪", Wanderer: "流浪者",
  Wriothesley: "莱欧斯利", Xiangling: "香菱", Xiao: "魈", Xianyun: "闲云",
  Xilonen: "希诺宁", Xingqiu: "行秋", Xinyan: "辛焱", Yaoyao: "瑶瑶",
  "Yae Miko": "八重神子", Yanfei: "烟绯", Yelan: "夜兰", Yoimiya: "宵宫",
  "Yun Jin": "云堇", Zhongli: "钟离", "Il Dottore": "博士", "Arataki Itto": "荒泷一斗"
};

const ZZZ_ROLES = {
  "Zhu Yuan": "朱鸢", "Yidhari Murphy": "伊德海莉", Anby: "安比", "Anby Alexandra": "安比·亚历克斯",
  Nicole: "妮可", "Nicole Demara": "妮可·德玛拉", Lucy: "露西", Corin: "可琳",
  Ellen: "艾莲", Grace: "格莉丝", Koleda: "珂蕾妲", Nekomata: "猫又",
  Piper: "派派", Qingyi: "青衣", Rina: "丽娜", "Soldier 11": "「11号」",
  Soukaku: "苍角", "Billy Kid": "比利·奇德", Ben: "本", "Ben Bigger": "本·比格",
  Anton: "安东", "Anton Ivanov": "安东·伊万诺夫", Lycaon: "莱卡恩", "Von Lycaon": "冯·莱卡恩",
  Caesar: "凯撒", "Caesar King": "凯撒·金", Burnice: "柏妮思", "Burnice White": "柏妮思·怀特",
  "Jane Doe": "简·杜", Seth: "赛斯", "Seth Lowell": "赛斯·洛威尔", Yanagi: "柳",
  "Yanagi Tsukishiro": "月城柳", Lighter: "莱特", Harumasa: "悠真", "Asaba Harumasa": "浅羽悠真",
  Miyabi: "星见雅", "Hoshimi Miyabi": "星见雅", Evelyn: "伊芙琳", "Evelyn Chevalier": "伊芙琳·雪瓦利耶",
  "Astra Yao": "艾斯特拉·耀", Hugo: "雨果", "Hugo Vlad": "雨果·弗拉德", Vivian: "薇薇安",
  Trigger: "扳机", Pulchra: "波丽娜"
};

// 5 个游戏：warehouses（大仓库映射）+ rolesOverride（完整角色表，未设置则用旧 mapping.json 数据）
const GAMES = {
  "Honkai Impact 3rd": {
    cn: "崩坏 3",
    warehouses: {
      characters: "女武神",   // 用户示例：mapping/Honkai Impact 3rd.json 内容 Characters 映射为女武神
      weapons: "武器",
      skins: "",
      enemies: "敌人",
      npcs: "NPC",
      ui: "UI",
      objects: "Objects",
      models: "模型",
      audio: "音频",
      other: "其他"
    }
  },
  "Genshin Impact": {
    cn: "原神",
    warehouses: {
      characters: "角色",     // 用户示例：Characters → 角色
      weapons: "武器",
      skins: "",              // Skins 映射为空（该层跳过）
      enemies: "敌人",
      npcs: "NPC",
      ui: "UI",
      objects: "Objects",
      models: "模型",
      audio: "音频",
      other: "其他"
    },
    rolesOverride: GENSHIN_ROLES
  },
  "Honkai Star Rail": {
    cn: "星穹铁道",
    warehouses: {
      characters: "角色",
      weapons: "光锥",        // 用户示例：mapping/Honkai Star Rail.json 内容 Weapons 映射为光锥
      skins: "",
      enemies: "敌对物种",
      npcs: "NPC",
      ui: "UI",
      objects: "Objects",
      models: "模型",
      audio: "音频",
      other: "其他"
    }
  },
  "Zenless Zone Zero": {
    cn: "绝区零",
    warehouses: {
      characters: "角色",
      weapons: "武器",
      skins: "",
      enemies: "敌人",
      npcs: "NPC",
      ui: "UI",
      objects: "Objects",
      models: "模型",
      audio: "音频",
      other: "其他"
    },
    rolesOverride: ZZZ_ROLES
  },
  "Wuthering Waves": {
    cn: "鸣潮",
    warehouses: {
      characters: "角色",
      weapons: "武器",
      skins: "",
      enemies: "敌人",
      npcs: "NPC",
      ui: "UI",
      objects: "Objects",
      models: "模型",
      audio: "音频",
      other: "其他"
    }
  }
};

const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

function main() {
  let old = {};
  try { old = JSON.parse(fs.readFileSync(OLD_MAPPING, "utf8")); }
  catch (e) { console.error("读取旧 mapping.json 失败:", e.message); process.exit(1); }

  const roleMapping = (old && old.roleMapping) || old || {};
  const variantIndex = (old && old.variantIndex) || {};

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];

  for (const [game, conf] of Object.entries(GAMES)) {
    const src = conf.rolesOverride || (roleMapping && roleMapping[game]) || {};
    const rolesOut = {};
    for (const [en, zh] of Object.entries(src)) {
      if (!en || !zh) continue;
      const nk = norm(en);
      const existing = Object.keys(rolesOut).find((k) => norm(k) === nk);
      if (existing) continue;
      rolesOut[en] = zh;
    }

    // variants：① 旧 variantIndex 中规范英文属于本游戏的 ② 每个角色中文名 → 英文（搜索归一）
    const variantsOut = {};
    for (const [v, canon] of Object.entries(variantIndex)) {
      if (v === "_说明") continue;
      if (typeof canon !== "string") continue;
      const inThisGame =
        rolesOut[canon] !== undefined ||
        Object.keys(rolesOut).some((k) => norm(k) === norm(canon));
      if (!inThisGame) continue;
      if (!variantsOut[v] && norm(v) !== norm(canon)) variantsOut[v] = canon;
    }
    for (const [en, zh] of Object.entries(rolesOut)) {
      if (zh && zh !== en && !variantsOut[zh]) variantsOut[zh] = en;
    }

    const out = {
      warehouses: conf.warehouses,
      roles: rolesOut,
      variants: variantsOut
    };
    // 2026-08-26 合并式：mapping/<游戏>.json 已存在时，保留已有 roles/variants（如萌娘百科补全的别名），
    //   重新生成只叠加不丢失——保证可重复运行
    const existingFile = path.join(OUT_DIR, game + ".json");
    if (fs.existsSync(existingFile)) {
      try {
        const old = JSON.parse(fs.readFileSync(existingFile, "utf8"));
        for (const [en, zh] of Object.entries(old.roles || {})) {
          if (!out.roles[en]) out.roles[en] = zh;
        }
        for (const [v, c] of Object.entries(old.variants || {})) {
          if (!out.variants[v]) out.variants[v] = c;
        }
      } catch (_) {}
    }
    const file = path.join(OUT_DIR, game + ".json");
    fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
    files.push({ file, roles: Object.keys(rolesOut).length, variants: Object.keys(variantsOut).length });
  }

  console.log("已生成 mapping 文件：");
  for (const f of files) console.log("  " + f.file.replace(OUT_DIR + "/", "") + `  （角色 ${f.roles} 个，变体 ${f.variants} 个）`);
}

main();
