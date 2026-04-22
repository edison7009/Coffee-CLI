# VibeID — 基于 Claude Code 的 VibeCoding 人格测试

> **版本**: v2（低多边形几何纸艺风格）
> **日期**: 2026-04-20
> **Skill 标识**: `vibeid`（远程 skill，分发路径 `Web-Home/CC-VibeID-test/`）

---

## 一、产品定位

**VibeID** 是一款基于 Claude Code `/insights` 使用数据的 VibeCoding 人格测试。

- **门槛即身份**：必须安装 Claude Code 且使用量达阈值（建议 ≥ 20 小时 / 200+ 消息）
- **精英社交货币**：结果是独特 4 字母代号 + 专属几何人物形象，可分享到 X / 小红书 / 朋友圈
- **零 MBTI 风险**：维度、字母代号、人格命名、角色形象全原创，仅借鉴公有领域心理学（Jung 1921、四气质、Big Five / HEXACO）

**Skill description 定稿**：

> VibeID — 基于 Claude Code 使用行为的 VibeCoding 人格测试。分析 `/insights` 报告中的节奏、工艺、弧线、流向 4 个维度，结合公有领域心理学（Jung 心理类型、古典四气质、Big Five / HEXACO），给出 16 种独特 Claw 家族人格代号与几何角色形象。

---

## 二、视觉基础

### 2.1 风格铁律

| ✅ 必须 | ❌ 禁止 |
|---|---|
| 低多边形 low-poly / 纸艺 origami 几何风 | 像素风 / 8-bit |
| 人形角色（职业化，有道具 + 姿势） | 小怪兽 / chibi / 动物萌系 |
| 扁平色填充 + 少量几何切面阴影 | 写实渲染 / 厚涂 / 漫画线稿 |
| 族色纯色柔和背景 | 复杂场景 / 繁琐装饰 |
| 角色占画面 60-70%，3/4 正面站姿 | 侧身 / 背身 / 超大道具抢戏 |
| 每族统一调色板 | 单张跳色 / 调色混乱 |

### 2.2 历史像素风作废

v1 版的 8-bit 像素小怪兽变体方案（基于 `claudecode-color.png`）**整体作废**，不再使用。理由：
- 像素风 IP 感弱，无法承担"精英社交货币"定位
- AI 生图稳定性差，16 张难统一
- 对标 MBTI 官方配图的"专业插画级质感"，像素风段位不够

---

## 三、心理学底层 & 4 维坐标系（不变）

| 轴 | 心理学根源 | Claude Code 信号源 | 阈值判定 | 左极 | 右极 |
|---|---|---|---|---|---|
| **① Pace 节奏** | Eysenck 反应性 / 冲动 | Response Time median | `< 50s` / `≥ 50s` | **P** Pulse 脉冲 | **T** Tide 潮汐 |
| **② Craft 工艺** | Jung 外倾感觉 vs 内倾直觉 | `(Bash+Edit) / (Read+Grep)` 比值 | `> 1` / `≤ 1` | **F** Forger 铸造 | **S** Seer 观测 |
| **③ Arc 弧线** | Big5 尽责性（C） | Ship-intent / Build-intent 占比 | Ship 主导 / Build 主导 | **V** Voyager 远航 | **A** Architect 营造 |
| **④ Flow 流向** | Jung 注意力广度 | Multi-clauding 百分比 | `< 10%` / `≥ 10%` | **L** Lone 独行 | **H** Hive 群涌 |

**4 字母代号**：`{P|T}{F|S}{V|A}{L|H}` → 16 组合
**和 MBTI 对比**：字母完全不同（MBTI 是 E/I/S/N/T/F/J/P），维度含义完全不同，无任何映射关系。

---

## 四、4 族分色系统（对标 MBTI 官方视觉分组）

16 只 Claw 人格按**节奏 × 工艺**交叉分 4 族，每族 4 人：

| 族名 | 对应组合 | 主色背景（柔和） | 角色服装主色 | 点缀色 | 气质 |
|---|---|---|---|---|---|
| **⚡ 焰锻族 Ember** | Pulse × Forger（`PF__`） | `#F5D5C7` 淡橘 | `#C94A3D` 赤红 | `#FFE66D` 火花金 | 快速动手派 |
| **🌞 晴航族 Sunward** | Pulse × Seer（`PS__`） | `#FAEBB8` 淡金 | `#E8A33D` 金黄 | `#8B5A2B` 棕 | 快速探索派 |
| **🌊 潮锻族 Tidal** | Tide × Forger（`TF__`） | `#C6D8E0` 淡青 | `#2E7D87` 深青 | `#C0C8D0` 银灰 | 深度动手派 |
| **🌌 星观族 Starlit** | Tide × Seer（`TS__`） | `#D4CDE4` 淡紫 | `#4A3B8F` 深紫 | `#FFD700` 金星 | 深度探索派 |

---

## 五、16 人格图鉴（角色 + 职业设定）

> **设计原则**：人物姿势+道具一眼传达人格 vibe；同族 4 人服装主色一致，通过**道具/姿势/小配饰**做差异。

### ⚡ 焰锻族 Ember（赤红调）

| 代号 | 中文名 | 英文名 | 职业化形象 | 核心道具 & 姿势 |
|---|---|---|---|---|
| **PFVL** | 闪刃独侠 | Sparkblade | 孤胆剑客 | 右手举能量剑，左手插腰，风衣下摆微扬 |
| **PFVH** | 闪电舰队 | Spark Armada | 雷电指挥官 | 双手握指挥权杖，身后悬浮 3 枚小菱形电光标 |
| **PFAL** | 独锻匠 | Solo Forger | 独行铁匠 | 肩扛大锤，皮围裙，赤红火星从锤头溅出 |
| **PFAH** | 锻造工坊 | Forge Commune | 匠作工头 | 一手持图纸一手指向，身边有 2 个缩小比例的学徒轮廓 |

### 🌞 晴航族 Sunward（金黄调）

| 代号 | 中文名 | 英文名 | 职业化形象 | 核心道具 & 姿势 |
|---|---|---|---|---|
| **PSVL** | 独行侦探 | Lone Scout | 独行侦探 | 侦探大衣，右手举放大镜，左手握卷起的地图 |
| **PSVH** | 蜂群斥候 | Swarm Scout | 斥候队长 | 挎肩包，望远镜垂胸，身边 4 个小斥候剪影呈扇形 |
| **PSAL** | 孤岛制图师 | Lone Cartograph | 制图师 | 坐姿倚桌，羊皮卷展开，羽毛笔在手 |
| **PSAH** | 星图学会 | Star Atlas | 学会主持 | 站立指向悬浮星图，身后有 2 个学徒轮廓 |

### 🌊 潮锻族 Tidal（深青调）

| 代号 | 中文名 | 英文名 | 职业化形象 | 核心道具 & 姿势 |
|---|---|---|---|---|
| **TFVL** | 深海舰长 | Deep Captain | 老船长 | 三角帽+船长大衣，手握船舵，身后有小船剪影 |
| **TFVH** | 星海统帅 | Star Admiral | 星域元帅 | 披风飞扬，手举指挥杖，身后 3 艘星舰剪影 |
| **TFAL** | 夜锻工 | Nightsmith | 深夜铁匠 | 低头专注打铁，月光色火花，独立场景 |
| **TFAH** | 基建巨匠 | Titan Builder | 总工程师 | 安全帽+蓝图，身边 2 个工程师持工具 |

### 🌌 星观族 Starlit（深紫调）

| 代号 | 中文名 | 英文名 | 职业化形象 | 核心道具 & 姿势 |
|---|---|---|---|---|
| **TSVL** | 深潜贤者 | Deep Sage | 冥想哲人 | 盘坐姿，手结印，星点漂浮周围 |
| **TSVH** | 星海学者团 | Starborne Scholar | 学者长老 | 长袍学士帽，手持古籍，身边 2 学徒捧书 |
| **TSAL** | 孤岛建筑师 | Lone Architect | 建筑大师 | 倚绘图桌，T-尺+圆规，身后塔楼剪影 |
| **TSAH** | 群星建筑师 | Star Architect | 总建筑师 | 站立伸手指向悬浮全息蓝图，身边 2 同僚围观 |

---

## 六、Prompt 规范

### 6.1 通用基座 Prompt（每张都必须包含）

```
Low-poly geometric character illustration in the style of modern editorial
papercraft origami aesthetic, single human-like character standing or
posing confidently, 3/4 front view, full body visible, flat color fills
with subtle geometric facet shading, clean polygonal shapes, minimalist
contemporary flat illustration, solid pastel color background (single
color, no gradient), character occupies 60-70% of canvas, no text, no
watermark, no logo, centered composition, 1:1 square canvas, high quality
mascot illustration, professional design aesthetic
```

### 6.2 负面 Prompt（每张都加）

```
NOT pixel art, NOT 8-bit, NOT chibi, NOT cartoon monster, NOT anime style,
NOT realistic rendering, NOT 3D render, NOT photography, NOT line art,
no text labels, no signature, no complex background scenery
```

### 6.3 族色调色板（复制到对应 prompt）

**Ember 焰锻族**（`PF__`）：
- 背景：soft peach `#F5D5C7`
- 主服装：crimson red `#C94A3D`
- 点缀：spark gold `#FFE66D`
- 肤色基调：warm neutral

**Sunward 晴航族**（`PS__`）：
- 背景：soft cream yellow `#FAEBB8`
- 主服装：amber gold `#E8A33D`
- 点缀：earth brown `#8B5A2B`
- 肤色基调：warm neutral

**Tidal 潮锻族**（`TF__`）：
- 背景：soft slate blue `#C6D8E0`
- 主服装：deep teal `#2E7D87`
- 点缀：silver gray `#C0C8D0`
- 肤色基调：cool neutral

**Starlit 星观族**（`TS__`）：
- 背景：soft lavender `#D4CDE4`
- 主服装：deep violet `#4A3B8F`
- 点缀：star gold `#FFD700`
- 肤色基调：cool neutral

---

## 七、16 张完整 Prompt

> **使用说明**：
> - 每张 = §6.1 基座 + 下方变体描述 + §6.2 负面 + §6.3 对应族色
> - 先跑 **#1 PFVL** 校准风格，锁定 seed 或 style reference 后批量跑其余
> - 不要机械拼接——把基座、变体、族色揉进一个连贯英文段落，AI 吸收更好

### ⚡ Ember 焰锻族

#### 1. PFVL · 闪刃独侠 Sparkblade
```
Low-poly geometric character illustration, papercraft origami style, a
lone young swordsman standing confidently in 3/4 front pose, wearing a
crimson red long coat #C94A3D with high collar, right arm raised holding
a glowing golden energy sword #FFE66D emitting soft spark particles, left
hand resting on hip, slim athletic build, short dark hair, determined
expression, faceted polygonal shading on coat folds, soft peach #F5D5C7
solid background, minimalist modern editorial illustration, flat color
fills, 1:1 square canvas, character 65% of canvas, no text, no pixel art,
no 3D render, no realistic rendering
```

#### 2. PFVH · 闪电舰队 Spark Armada
```
Low-poly geometric character illustration, papercraft origami style, a
young commander standing tall in 3/4 front pose, wearing a crimson red
military uniform #C94A3D with gold epaulets, both hands holding a tall
lightning-tipped command staff vertically, behind them three small golden
diamond-shaped electric insignia floating in arrow formation, short hair,
confident leadership expression, faceted polygonal shading, spark gold
#FFE66D accents, soft peach #F5D5C7 solid background, minimalist modern
editorial illustration, flat color fills, 1:1 square canvas, no text, no
pixel art
```

#### 3. PFAL · 独锻匠 Solo Forger
```
Low-poly geometric character illustration, papercraft origami style, a
sturdy lone blacksmith standing in 3/4 side-front pose, wearing a crimson
red leather apron #C94A3D over a simple tunic, right shoulder carrying a
large forging hammer, left hand at side, muscular build, bandana
headband, small golden #FFE66D spark particles rising from hammer head,
determined craftsman expression, faceted polygonal shading, soft peach
#F5D5C7 solid background, minimalist modern editorial illustration,
1:1 square canvas, no text, no pixel art, no realistic rendering
```

#### 4. PFAH · 锻造工坊 Forge Commune
```
Low-poly geometric character illustration, papercraft origami style, a
foreman figure in the center holding a blueprint scroll in left hand,
right hand pointing forward giving directions, wearing crimson red work
overalls #C94A3D with gold #FFE66D tool belt accents, two smaller
apprentice silhouettes in the same red palette slightly behind on either
side holding tiny tools, collaborative workshop vibe, faceted polygonal
shading, soft peach #F5D5C7 solid background, minimalist modern editorial
illustration, 1:1 square canvas, no text, no pixel art
```

### 🌞 Sunward 晴航族

#### 5. PSVL · 独行侦探 Lone Scout
```
Low-poly geometric character illustration, papercraft origami style, a
lone detective standing in 3/4 front pose, wearing an amber gold trench
coat #E8A33D with a deerstalker-style cap, right arm raised holding a
large round magnifying glass with brown #8B5A2B frame close to eye level,
left hand holding a rolled parchment map, sharp curious expression,
faceted polygonal shading on coat folds, soft cream yellow #FAEBB8 solid
background, minimalist modern editorial illustration, flat color fills,
1:1 square canvas, no text, no pixel art
```

#### 6. PSVH · 蜂群斥候 Swarm Scout
```
Low-poly geometric character illustration, papercraft origami style, a
scout leader standing in 3/4 front pose, wearing an amber gold #E8A33D
explorer vest with brown #8B5A2B shoulder straps and binoculars hanging
on chest, left hand raised giving a hand signal, four smaller scout
silhouettes in matching gold palette fanning outward behind in a
semicircle, alert explorer expression, faceted polygonal shading, soft
cream yellow #FAEBB8 solid background, minimalist modern editorial
illustration, 1:1 square canvas, no text, no pixel art
```

#### 7. PSAL · 孤岛制图师 Lone Cartograph
```
Low-poly geometric character illustration, papercraft origami style, a
scholarly cartographer seated at a small drawing desk in 3/4 front pose,
wearing an amber gold #E8A33D scholar robe, round brown #8B5A2B spectacles,
right hand holding a feather quill pen, a large unrolled parchment map
spread on desk with tiny geometric lines, focused studious expression,
faceted polygonal shading, soft cream yellow #FAEBB8 solid background,
minimalist modern editorial illustration, 1:1 square canvas, no text
```

#### 8. PSAH · 星图学会 Star Atlas
```
Low-poly geometric character illustration, papercraft origami style, a
senior scholar standing in 3/4 front pose, wearing an amber gold #E8A33D
academic robe with brown #8B5A2B trim and a mortarboard cap with tassel,
right arm raised pointing at a floating geometric star constellation
diagram to the side, two smaller apprentice silhouettes in matching gold
palette behind reading books, wise teaching expression, faceted polygonal
shading, soft cream yellow #FAEBB8 solid background, minimalist modern
editorial illustration, 1:1 square canvas, no text, no pixel art
```

### 🌊 Tidal 潮锻族

#### 9. TFVL · 深海舰长 Deep Captain
```
Low-poly geometric character illustration, papercraft origami style, a
weathered sea captain standing at the helm in 3/4 front pose, wearing a
deep teal #2E7D87 naval peacoat with silver #C0C8D0 buttons and a black
tricorn hat, both hands gripping a wooden ship's wheel in front, a small
silhouette of a sailing ship floating in the background, seasoned
expression, faceted polygonal shading on coat folds, soft slate blue
#C6D8E0 solid background, minimalist modern editorial illustration,
1:1 square canvas, no text, no pixel art
```

#### 10. TFVH · 星海统帅 Star Admiral ⭐
```
Low-poly geometric character illustration, papercraft origami style, a
grand admiral commander standing in a powerful 3/4 front pose, wearing a
deep teal #2E7D87 military jacket with silver #C0C8D0 gold-trim epaulets
and a flowing cape behind the shoulders, left hand holding a tall
command staff, right arm pointing forward, three small silver starship
silhouettes hovering in a diagonal formation behind, commanding leadership
expression, faceted polygonal shading, soft slate blue #C6D8E0 solid
background, minimalist modern editorial illustration, 1:1 square canvas,
no text, no pixel art
```

#### 11. TFAL · 夜锻工 Nightsmith
```
Low-poly geometric character illustration, papercraft origami style, a
solitary night blacksmith standing in 3/4 side-front pose focused on
work, wearing a deep teal #2E7D87 heavy apron over dark clothing, both
hands gripping a forging hammer mid-swing, silver-blue #C0C8D0 flame
sparks from the hammer head, small crescent moon silhouette in upper
corner, contemplative craftsman expression, faceted polygonal shading,
soft slate blue #C6D8E0 solid background, minimalist modern editorial
illustration, 1:1 square canvas, no text, no pixel art
```

#### 12. TFAH · 基建巨匠 Titan Builder
```
Low-poly geometric character illustration, papercraft origami style, a
chief construction engineer standing in 3/4 front pose, wearing a deep
teal #2E7D87 work vest with a yellow safety hardhat and silver #C0C8D0
tool belt, right hand holding a rolled blueprint scroll, left hand on
hip, two smaller engineer silhouettes behind operating tiny geometric
crane shapes, confident leadership expression, faceted polygonal shading,
soft slate blue #C6D8E0 solid background, minimalist modern editorial
illustration, 1:1 square canvas, no text, no pixel art
```

### 🌌 Starlit 星观族

#### 13. TSVL · 深潜贤者 Deep Sage
```
Low-poly geometric character illustration, papercraft origami style, a
meditating sage figure seated cross-legged in full lotus pose, wearing a
deep violet #4A3B8F flowing robe with a hood, hands in a calm mudra hand
gesture, small golden #FFD700 star particles and constellation dots
floating softly around the body, serene closed-eye expression, faceted
polygonal shading on robe folds, soft lavender #D4CDE4 solid background,
minimalist modern editorial illustration, 1:1 square canvas, no text,
no pixel art
```

#### 14. TSVH · 星海学者团 Starborne Scholar
```
Low-poly geometric character illustration, papercraft origami style, a
senior scholar elder standing in 3/4 front pose, wearing a deep violet
#4A3B8F academic robe with gold #FFD700 trim and a graduation cap, small
round spectacles, right arm holding an ancient tome, left hand open
gesturing teaching, two smaller apprentice silhouettes in matching
violet palette behind holding books, wise thoughtful expression, faceted
polygonal shading, soft lavender #D4CDE4 solid background, minimalist
modern editorial illustration, 1:1 square canvas, no text, no pixel art
```

#### 15. TSAL · 孤岛建筑师 Lone Architect
```
Low-poly geometric character illustration, papercraft origami style, a
lone master architect leaning on a small drafting table in 3/4 front
pose, wearing a deep violet #4A3B8F long jacket over a lighter vest,
right hand holding an architect's T-square ruler, left hand holding a
golden #FFD700 compass, a geometric blueprint unrolled on the table, a
distant tower silhouette in the background, focused visionary expression,
faceted polygonal shading, soft lavender #D4CDE4 solid background,
minimalist modern editorial illustration, 1:1 square canvas, no text
```

#### 16. TSAH · 群星建筑师 Star Architect
```
Low-poly geometric character illustration, papercraft origami style, a
chief architect leading a design review, standing in 3/4 front pose,
wearing a deep violet #4A3B8F structured coat with gold #FFD700 tool
belt, right arm extended pointing at a floating geometric holographic
blueprint to the side, two smaller colleague silhouettes in matching
violet palette alongside examining the plans, confident mastermind
expression, faceted polygonal shading, soft lavender #D4CDE4 solid
background, minimalist modern editorial illustration, 1:1 square canvas,
no text, no pixel art
```

---

## 八、生成建议 & 验收标准

### 8.1 生成工具推荐优先级（low-poly 友好）

1. **Midjourney v6+** — 加 `--style raw --stylize 200 --ar 1:1`，效果最稳
2. **DALL·E 3 / GPT Image** — low-poly 几何风非常强项
3. **即梦 AI / 豆包** — 国内首选，支持参考图锁定
4. **Nano Banana**（Google，fal.ai 封装）— API 批量友好
5. **Ideogram** — 文字处理强但本方案不需要文字

### 8.2 批量生成流程

1. **跑校准张**：用 **#1 PFVL** 连续跑 5-8 次，挑出最接近"现代编辑插画"质感的一张
2. **锁定风格**：记录工具的 seed / style reference image / 具体参数（MJ 的 `--sref` 最有用）
3. **批量跑**：以同一 seed/sref 跑其余 15 张，每张出 3-4 候选
4. **一致性检查**：16 张按族平铺对比，挑出破坏一致性的（比如某张风格飘了、身高比例变了）并重跑
5. **交付**：按 §8.3 Checklist 验收

### 8.3 验收 Checklist

- [ ] 同族 4 张服装主色一致，背景色一致
- [ ] 4 族之间通过背景+服装能一眼区分（暖红 / 暖金 / 冷青 / 冷紫）
- [ ] 人物身高比例在 16 张之间不跳（Q 版比例保持稳定）
- [ ] 每张有明确的职业道具+姿势，能传达对应代号的 vibe
- [ ] 无任何文字、水印、AI 签名
- [ ] 纯色背景，角色占画面 60-70%
- [ ] 输出格式：PNG 透明背景（或纯色背景），1024×1024
- [ ] 文件命名：`PFVL.png`、`PFVH.png` ... 按代号命名

### 8.4 文件落位

```
Web-Home/CC-VibeID-test/personas/images/
  ├── PFVL.png  ├── PFVH.png  ├── PFAL.png  ├── PFAH.png
  ├── PSVL.png  ├── PSVH.png  ├── PSAL.png  ├── PSAH.png
  ├── TFVL.png  ├── TFVH.png  ├── TFAL.png  ├── TFAH.png
  └── TSVL.png  ├── TSVH.png  ├── TSAL.png  ├── TSAH.png
```

同目录下 `matrix.json`（后续开发者补充）字段预览：

```json
{
  "PFVL": {
    "code": "PFVL",
    "name_en": "Sparkblade",
    "name_cn": "闪刃独侠",
    "family": "Ember",
    "family_cn": "焰锻族",
    "image": "images/PFVL.png",
    "axes": {"pace": "P", "craft": "F", "arc": "V", "flow": "L"},
    "palette": {
      "background": "#F5D5C7",
      "costume": "#C94A3D",
      "accent": "#FFE66D"
    },
    "tagline": "电光石火一刀劈 bug，独来独往的赏金猎人",
    "profession": "孤胆剑客"
  }
}
```

---

## 九、下一步

- [ ] **你负责**：拿 §7 的 16 个 low-poly prompt 去生图工具批量生成，填入 `Web-Home/CC-VibeID-test/personas/images/`
- [ ] **后续开发**：
  1. 完整版 `SKILL.md`（替代 `~/.claude/skills/vibecoding-poc/` 的 POC）
  2. `scripts/analyze.js`（解析 report.html → 4 维坐标 JSON）
  3. `scripts/inject.js`（把人格卡片注入 report.html 顶部）
  4. `matrix.json`（16 人格元数据）
  5. Coffee CLI 侧集成（Lab tab + 下载 skill + 启动 CC 流程）

---

## 十、开源 / 法律合规备注

- **心理学理论来源**：Jung 1921《Psychological Types》（公有领域）、Hippocrates/Galen 四气质（公有领域）、Big Five / HEXACO（IPIP 开源 license）
- **商标规避**：不使用 MBTI / Myers-Briggs / INTJ / ENFP 等受保护表述；4 字母代号的字母选择（P/T/F/S/V/A/L/H）和轴含义与 MBTI 字母（E/I/S/N/T/F/J/P）无重叠、无映射
- **视觉规避**：所有 16 个角色形象为独立原创设定（职业、道具、姿势、配色），不复制任何现有测评产品的具体角色造型
- **致谢建议**：产品页面可标注 "Inspired by public-domain psychology typologies including Jungian Psychological Types (1921) and classical Four Temperaments"
