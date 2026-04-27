# Contributing to Coffee CLI / 贡献指南

Thanks for your interest in Coffee CLI! / 感谢你对 Coffee CLI 的关注!

---

## English

### How to contribute

1. Fork the repo and create a feature branch from `main`.
2. Run `cargo check` and `cd src-ui && npm run build` before pushing — both
   must be green (see CLAUDE.md release checklist).
3. Use Conventional Commits: `feat(area): ...`, `fix(area): ...`,
   `chore(release): v<x.y.z>`. Commit messages in English.
4. Open a pull request against `main` describing the *why*, not just the
   *what*. Link any related issue.
5. By submitting a pull request, you agree to the Contributor License
   Agreement (CLA) below.

### Contributor License Agreement (CLA)

Coffee CLI is distributed under the **GNU Affero General Public License,
Version 3.0 or later (AGPL-3.0-or-later)**. To keep the project's licensing
flexible (e.g., to allow future dual-licensing for commercial use, or to
relicense to a compatible AGPL-successor in the unlikely event GPL/AGPL
evolves), we ask all contributors to grant the maintainers a broader
license to their contribution than AGPL alone would imply.

By opening a pull request or otherwise submitting code, documentation,
artwork, translations, or other content (your "Contribution") to this
repository, you agree to the following:

1. **Ownership**. You represent that you are the original author of the
   Contribution, that you have the right to submit it, and that the
   Contribution is your own original work — not copied from another
   source under an incompatible license.

2. **License grant to the project**. You grant to edison7009 (the project
   maintainer) and to all recipients of software distributed by the
   project a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license to reproduce, prepare derivative works of,
   publicly display, publicly perform, sublicense, and distribute your
   Contribution and such derivative works under any license — including
   but not limited to AGPL-3.0-or-later, MIT, Apache-2.0, BSL, and
   commercial proprietary licenses.

3. **Patent grant**. If your Contribution incorporates patent claims you
   own or control that are necessarily infringed by the Contribution
   alone or in combination with the project, you grant the project and
   downstream recipients a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable license to make, use, sell, offer for sale,
   import, and otherwise transfer the Contribution.

4. **No warranty**. Your Contribution is provided "as is", without
   warranty of any kind. You retain no obligation to provide support,
   updates, or maintenance.

5. **Attribution**. The project will retain you in the git history and,
   where applicable, in `NOTICE` or other contributor lists. You retain
   all moral rights as the author.

If you cannot agree to this CLA — for example, because your employer
owns the copyright to your work — please discuss with the maintainer
*before* submitting a pull request. We can usually arrange an employer
sign-off (similar to the Linux kernel's Developer Certificate of Origin)
that satisfies both sides.

### Trademarks

The Coffee CLI name, logo, and related marks are governed by
[TRADEMARKS.md](TRADEMARKS.md), not by AGPL-3.0 or this CLA.
Contributing code does not grant you any right to use the marks beyond
what TRADEMARKS.md already permits.

---

## 简体中文

### 贡献流程

1. Fork 仓库,从 `main` 切出 feature 分支。
2. 推送前跑 `cargo check` 和 `cd src-ui && npm run build`,两端都要绿
   (见 CLAUDE.md 的发版检查清单)。
3. 使用 Conventional Commits:`feat(area): ...`、`fix(area): ...`、
   `chore(release): v<x.y.z>`。Commit 消息用英文。
4. 向 `main` 提交 PR,描述*为什么*而非仅*做了什么*。关联相关 issue。
5. 提交 PR 即视为同意下方的贡献者协议(CLA)。

### 贡献者协议(CLA)

Coffee CLI 采用 **GNU Affero General Public License v3 或更高版本
(AGPL-3.0-or-later)** 发布。为保持协议灵活性(例如未来可能进行双许可
以授权商业使用、或在 GPL/AGPL 演进时迁移到兼容协议),我们要求所有
贡献者授予维护者**比单纯 AGPL 更宽**的许可。

提交 PR 或以其他方式向本仓库提交代码、文档、图标、翻译等内容(你的
"贡献")即表示同意以下条款:

1. **权属**。你声明自己是该贡献的原始作者,有权提交,且该贡献是你
   独立创作 —— 不是从其他不兼容许可的来源复制而来。

2. **向本项目授权**。你授予项目维护者 edison7009 及本项目分发软件
   的所有接收者一项**永久、全球、非独占、免版税、不可撤销**的许可,
   允许其在**任何许可证**下(包括但不限于 AGPL-3.0-or-later、MIT、
   Apache-2.0、BSL 及商业专有许可)复制、修改、公开展示、公开表演、
   再许可、分发你的贡献及衍生作品。

3. **专利授权**。若你的贡献涉及你拥有或控制的、为实施该贡献所必然
   会用到的专利权利要求,你授予项目及下游接收者一项永久、全球、
   非独占、免版税、不可撤销的许可,可制造、使用、销售、许诺销售、
   进口及以其他方式转让该贡献。

4. **不提供担保**。你的贡献按"现状"提供,不附任何明示或默示担保。
   你无须承担任何支持、更新或维护义务。

5. **署名**。项目会在 git 历史中保留你的署名,并在适当时记录于
   `NOTICE` 或贡献者名单中。你保留作者人身权(署名权等)。

如你因任何原因(例如雇主拥有你工作产物的著作权)无法同意本 CLA,
请在提交 PR**之前**先与维护者沟通。我们通常可以安排雇主签署(类似
Linux 内核的 Developer Certificate of Origin)来同时满足双方。

### 商标

Coffee CLI 名称、Logo 及相关标识由 [TRADEMARKS.md](TRADEMARKS.md) 管辖,
**不受** AGPL-3.0 或本 CLA 涵盖。贡献代码不会授予你超出 TRADEMARKS.md
允许范围的使用权。

---

*Questions? / 有问题?* Open an issue with label `question`, or 在 issue
区提交 `question` 标签的问题。
