# Sidereal · 协作开发仓库（教学源码版）

这是 Sidereal 网站的**精简源码快照**，用于共同学习、维护及后续扩展法学资料分类与题库。原始说明见 [`先读这个.md`](./先读这个.md)。

> 注意：本仓库不包含实际法条/教材/题库的加密文件、`vault/`、真实密钥、星空与行星的大型贴图和部分测试文件，**不能据此原样还原在线网站**。这并非完整可部署发行包。
>
> 代码与资源属于原作者及相应权利人。未附开源授权许可证，不代表可以公开分发或商业使用。建议仓库保持私有，公开前取得作者许可并完成版权审查。

## 项目结构

- `work/next-zone/src/`：浏览器主程序、Three.js 星空和作品阅读入口。
- `work/next-zone/build.mjs`：外壳构建程序；依赖在 `work/next-zone/vendor/`。
- `work/cloudflare/`：Cloudflare 静态资源发布工具与部署防护。
- `work/incremental/`：加密作品的增量管理脚本。
- `work/theme-rollout/`：文档样式、划线笔记和内容转换工具。

## 本次协作的第一个目标

在**不破坏原有星空和阅读功能**的前提下，设计法学资料与练习题的分类数据模块。第一步可以从 `work/next-zone/src/law-categories.js` 着手，但该文件尚未创建：由参与者自行编写和评审。

## 建议的开发方式

1. 在 VS Code 中克隆本仓库并打开根目录。
2. 每个人从最新 `main` 分支建立个人功能分支，例如 `feat/law-categories` 或 `feat/question-types`。
3. 小范围修改、检查 diff，提交有意义的 commit，然后推送分支。
4. 通过 Pull Request 互相审阅，确认后合并到 `main`。
5. 合并之后先 `git pull --ff-only` 更新 `main`，再开始下一轮。

在没有完整素材和真实测试环境时，**不要把源码检查当成网站已经可运行**。

更具体的命令与合作约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
