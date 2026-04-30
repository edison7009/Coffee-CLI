# Coffee CLI Trademark Policy / 商标政策

> **Plain-English summary / 一句话**: The code is fully open source under
> AGPL-3.0; the **names and logos are protected as trademarks**. Forks are
> welcome — what we object to is **passing off our code as your own
> from-scratch original work**. If your fork honestly credits Coffee CLI
> as upstream (in README, About screen, or product page), you may keep our
> name and logo visible; if you prefer to rebrand entirely, change the
> name and logo but keep the NOTICE attribution intact. The hard line is
> commercial SaaS / app-store products literally branded with our marks
> without permission. Genuinely original code you add on top of a fork
> belongs to you — name it whatever you like.
>
> 代码完全开源 (AGPL-3.0),**名称与图标受商标保护**。Fork 欢迎 —— 我们真正
> 反对的是:**把我们的代码当作你从零写的原创**。
> 如果你的 fork **诚实地标注 Coffee CLI 为上游**(在 README、About 页面或
> 产品页显著位置),你可以保留我们的名字和 Logo;如果你坚持完全重新品牌化
> 也可以,改名 + 替换 Logo,但必须在 NOTICE 中保留致谢。硬底线只有一条:
> 未经授权的商业 SaaS 或应用商店产品字面挂我们的商标。Fork 之上你新增的
> 原创代码归你 —— 你想怎么命名都行。

---

## English

### 1. Marks claimed

The following names, marks, and logos (collectively, the "Marks") are used
in commerce by the Coffee CLI project and its primary maintainer
(edison7009) and are claimed as common-law trademarks based on first use:

| Mark                                                | First public use | Class of goods/services                          |
| --------------------------------------------------- | ---------------- | ------------------------------------------------ |
| **Coffee CLI** (word mark)                          | 2026-04-12       | Computer software; SaaS                          |
| **Gambit**                                          | 2026-04-17       | Software UI feature                              |
| **Pitch**                                           | 2026-04-20       | Per-task TODO-to-Agent dispatch UI               |
| **VibeID**                                          | 2026-04-21       | Personality assessment software                  |
| **Coffee-CLI MCP**                                  | 2026-04-22       | Multi-agent inter-terminal coordination protocol |
| **Sentinel Protocol**                               | 2026-04-25       | Multi-agent supervision protocol                 |
| **Vibetype** (and the 16 individual Vibetype names) | 2026-04-27       | Personality assessment content                   |
| **Hyper-Agent**                                     | 2026-04-30       | Cross-tab admin MCP server for IM-bridged orchestration of running agent team |

These Marks are **not** licensed under the AGPL-3.0. Receiving a copy of
the Coffee CLI source code does not grant you any right to use the Marks.

**Not claimed.** The Coffee CLI app icon is the *coffee-filled-loop* glyph
from the [line-md icon set](https://github.com/cyberalien/line-md) by
Vjacheslav Trushkin, used under the icon set's open-source license (see
[NOTICE](NOTICE)). We claim no trademark rights in the glyph itself —
others are free to use the same icon. We may, in the future, claim rights
in the *combination* of the wordmark *Coffee CLI* with this icon as a
composite brand element, but the icon alone is not ours. Likewise, terms
that originated outside this project — including but not limited to
*VibeCoding* (popularized by Andrej Karpathy) and *Claw* — are not claimed
as marks of Coffee CLI.

Common-law trademark rights arise from use in commerce in jurisdictions
that recognize them (e.g., the United States, the United Kingdom, Canada,
Australia, Hong Kong). In jurisdictions that operate on a first-to-file
basis (e.g., mainland China, the EU under EUTM, Japan), formal registration
will be sought as resources permit. Pending registration does not waive
prior-use evidence.

### 2. Permitted uses (no permission required)

You may use the Marks **without prior permission** to:

- **Refer to the project factually** in articles, blog posts, tutorials,
  conference talks, or academic papers (e.g., "I used Coffee CLI to manage
  my agents").
- **State compatibility** in your own software (e.g., "Plugin for Coffee
  CLI", "Imports Coffee CLI session files"), provided your software is not
  itself confusingly named.
- **Distribute unmodified binaries** built from this repository, with the
  original Marks intact.
- **Cite VibeID archetypes** in personality-test results and write-ups,
  attributed to "VibeID by Coffee CLI".

### 3. Uses that require permission

You **must** obtain written permission before:

- Using the Coffee CLI **logo, icon, or wordmark** in **paid advertising,
  app-store listings, merchandise, or other commercial product
  marketing** — non-commercial fork README/About-screen attribution
  (per §4 Option A) does not need permission.
- Operating a **commercial SaaS or hosted service** that uses any of the
  Marks as its **headline brand** in name, branding, or domain.
- Registering any of the Marks (or confusingly similar variants) as a
  trademark, domain name, company name, or product name in any jurisdiction.

To request permission, open an issue or contact the maintainer through the
repository's contact channels.

### 4. Forks: how to handle naming

If you fork Coffee CLI and intend to distribute the fork, choose **one
of two paths**. Forcing every fork to scrub our identity would just
hide the upstream from end users, which serves nobody — so we let you
decide.

**Option A — Keep our name visible (preferred)**

Make it obvious that your fork derives from Coffee CLI:

1. Use a name that clearly indicates derivation, e.g.
   "Coffee CLI Community Edition by X", "X-fork of Coffee CLI",
   "Coffee CLI Plus" — prefixes/suffixes on the Mark **are** allowed
   under this option.
2. You may keep our logo visible (add your own next to it as a co-mark
   if you want).
3. In the product README, About screen, or main product page,
   prominently link to the upstream:
   `Based on Coffee CLI by edison7009 — https://coffeecli.com`.
4. Keep AGPL-3.0 LICENSE, NOTICE, and TRADEMARKS.md intact.

Under Option A you still **cannot**:

- Run a commercial SaaS or app-store product with "Coffee CLI" /
  "Gambit" / "VibeID" / "Hyper-Agent" / etc. as the **headline brand**
  without written permission.
- Use the Marks in a way that suggests **endorsement** by the upstream
  Coffee CLI project.

**Option B — Rebrand entirely**

If you prefer to fork without keeping our identity:

1. Change the product name to something clearly distinct.
2. Replace the logo with your own, or remove it.
3. Update the user-facing strings in `src-ui/` and installer copy.
4. Keep AGPL-3.0 LICENSE, NOTICE, and TRADEMARKS.md intact, and **add
   a clear line in NOTICE** crediting Coffee CLI as the upstream
   codebase. AGPL already requires source disclosure; this just makes
   the lineage visible to end users too.

**Both options share one absolute red line**: do not present the code
as your own from-scratch original work. Removing copyright headers,
scrubbing NOTICE, or claiming authorship of any pre-existing code is
incompatible with both AGPL-3.0 and this trademark policy.

Adding genuinely new code on top of either option? Name it whatever
you want — those parts are your original work and your trademarks.

You may always state factually that your fork is "based on Coffee CLI"
or "a fork of Coffee CLI" — this is nominative fair use and is permitted.

### 5. Why this exists

Open-source licenses govern code. They do **not** govern brand identity.
Without a separate trademark policy, anyone could legally take this code,
ship it under the *Coffee CLI* name, and profit from confusion with the
original project. This document closes that gap.

### 6. Contact

Trademark questions, permission requests, and infringement reports:
open an issue at https://github.com/edison7009/Coffee-CLI/issues with the
label `trademark`.

---

## 简体中文

### 1. 主张的商标

以下名称、标识与 Logo(下称"标识")为 Coffee CLI 项目及其主要维护者
(edison7009)在商业中实际使用,基于"先用先得"原则主张为普通法商标
(common-law trademark):

| 标识                                                | 首次公开使用 | 商品/服务类别                  |
| --------------------------------------------------- | ------------ | ------------------------------ |
| **Coffee CLI**(文字商标)                          | 2026-04-12   | 计算机软件;SaaS              |
| **Gambit**                                          | 2026-04-17   | 软件 UI 功能                   |
| **Pitch / 投递**                                    | 2026-04-20   | 单条任务从 TODO 看板投递到 Agent |
| **VibeID**                                          | 2026-04-21   | 人格测评软件                   |
| **Coffee-CLI MCP**                                  | 2026-04-22   | 多终端 Agent 互联协调协议      |
| **哨兵协议** / **Sentinel Protocol**                | 2026-04-25   | 多 Agent 监督协议              |
| **Vibetype / Vibe 型**(及 16 个具体 Vibetype 名称) | 2026-04-27   | 人格测评内容                   |
| **Hyper-Agent**                                     | 2026-04-30   | 跨 Tab 超管 MCP 服务器,用于 IM 桥接调度运行中 agent 团队 |

这些标识**不**包含在 AGPL-3.0 协议授权范围内。获得 Coffee CLI 源代码
副本**不**等于获得使用上述标识的权利。

**不主张的部分**。Coffee CLI 应用图标采用
[line-md 图标集](https://github.com/cyberalien/line-md) 中的
*coffee-filled-loop* 图形,作者 Vjacheslav Trushkin,按其开源协议
使用(见 [NOTICE](NOTICE))。我们**不**对该图标本身主张商标权 ——
他人同样可以自由使用同一图标。未来我们可能会就"*Coffee CLI* 文字 +
该图标"的**组合**作为复合品牌元素主张权利,但单独的图标不归我们所有。
同理,**起源于本项目之外的词语** —— 包括但不限于 *VibeCoding*
(由 Andrej Karpathy 推广的概念)与 *Claw* —— 也不在 Coffee CLI 商标
主张范围内。

普通法商标权在承认该制度的法域(如美、英、加、澳、香港)凭"在商业中
首次使用"产生。在中国大陆、欧盟、日本等"先申请制"法域,本项目将在
资源允许时申请正式注册;在未注册期间,本声明作为先用证据存档。

### 2. 无需许可的使用方式

以下使用**无需事先获得授权**:

- 在文章、博客、教程、会议演讲、学术论文中**事实性引用**项目名称
  (例:"我用 Coffee CLI 管理我的 agents")。
- 在你自己的软件中**声明兼容性**(例:"Coffee CLI 插件"、"导入 Coffee
  CLI 会话文件"),前提是你的软件本身命名不会引起混淆。
- **分发由本仓库直接构建的未修改二进制**,保留原始标识。
- 在人格测试结果中**引用 VibeID 人格类型**,并标注来源为"VibeID by
  Coffee CLI"。

### 3. 必须获得许可的使用方式

以下行为**必须**事先获得书面许可:

- 在**付费广告、应用商店上架、周边商品或其他商业产品宣传**中使用
  Coffee CLI 的 **Logo、图标或文字商标** —— 非商业 fork 在 README /
  About 页面的署名(按 §4 方案 A)**无需**授权。
- 运营**字面挂任何标识作为头牌品牌**的商业 SaaS 或托管服务。
- 在任何法域将任何标识(或近似变体)注册为**商标、域名、公司名或
  产品名**。

申请许可:在仓库 issues 提交带 `trademark` 标签的请求,或通过仓库
联系渠道联系维护者。

### 4. Fork 时如何处理命名

若你 fork 本项目并打算分发,**两条路任选其一**。强迫每个 fork 都
抹掉我们的身份,只会让上游对终端用户隐形,谁都不受益 —— 所以由你来
选择。

**方案 A — 保留我们的名字可见(推荐)**

让你的 fork 显著表明派生自 Coffee CLI:

1. 使用**清晰表明派生关系**的名字,例如"Coffee CLI 社区版 by X"、
   "X-fork of Coffee CLI"、"Coffee CLI Plus" —— 在本方案下,**允许**
   在原标识前后加前缀/后缀。
2. 你可以保留我们的 Logo(也可以叠加你自己的 Logo 作为联合标识)。
3. 在产品 README、关于页面或产品主页**显著位置**注明上游链接:
   `基于 Coffee CLI by edison7009 — https://coffeecli.com`。
4. 保留 AGPL-3.0、NOTICE 与 TRADEMARKS.md 原貌。

方案 A 下你仍**不可以**:

- 在没有书面许可的情况下,运营**字面挂"Coffee CLI" / "Gambit" /
  "VibeID" / "Hyper-Agent"等作为头牌品牌**的商业 SaaS 或应用商店产品。
- 以暗示得到 Coffee CLI 上游**官方背书**的方式使用我们的标识。

**方案 B — 完全重新品牌化**

如果你坚持 fork 时去除我们的身份:

1. 更改产品名称为显著区别的名字。
2. 替换 Logo 为你自己的,或移除。
3. 更新 `src-ui/` 与安装器中的用户可见字符串。
4. 保留 AGPL-3.0、NOTICE 与 TRADEMARKS.md 原貌,并在 **NOTICE 中
   明确添加一行**致谢 Coffee CLI 作为代码上游来源。AGPL 本身已要求
   公开源码;这一行让上游谱系对终端用户也可见。

**两个方案的共同红线**:不要把代码呈现为你从零写的原创。删除版权头、
清空 NOTICE、对预先存在的代码主张原创身份,既违反 AGPL-3.0 也违反
本商标政策。

在两个方案之上**新增**真正原创的代码?**随便你怎么命名 —— 那部分
是你的原创成果,商标也归你**。

事实性说明"本 fork 基于 Coffee CLI"或"本项目是 Coffee CLI 的一个分支",
属于**指示性合理使用**,始终允许。

### 5. 为什么需要这份文档

开源协议管的是**代码**,不管**品牌**。如果没有独立的商标政策,任何人
都可以合法拿走代码、用 *Coffee CLI* 这个名字发布、并利用与原项目的
混淆牟利。本文档堵住这个口子。

### 6. 联系方式

商标问题、授权申请、侵权举报:在
https://github.com/edison7009/Coffee-CLI/issues 提交,标签 `trademark`。

---

*Last updated / 最后更新: 2026-04-30*
*This policy is non-binding promotional language; the AGPL-3.0 LICENSE file
governs code use. This document governs brand and naming use, which is
outside the scope of any open-source license.*
