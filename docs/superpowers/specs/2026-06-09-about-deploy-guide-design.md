# 设计文档：后台「关于 & 手册」升级为多 Tab 部署指南

> 日期：2026-06-09
> 状态：已批准（用户确认安装 URL = `gh-raw.966788.xyz/cfd-mgr/install.sh`，范围 = About 页 + 同步 README）
> 作者：用户 + Claude

## 1. 背景与目标

参照配套仓库 `frpc-manager` 已上线的 5-Tab「使用手册 & 部署指南」页，把本仓库
后台的「关于 & 手册」页（[web/src/pages/About.tsx](../../../web/src/pages/About.tsx)）从当前的最简「快速安装」
Alert 升级为同等丰富的多 Tab 文档页，集中提供**各种命令的快捷安装**与**后台使用文档**。

关键事实（已核对）：

- 安装脚本本身**已完整**：`scripts/install.sh` / `scripts/install.ps1` 已支持
  `-y -p -t -v --update --force --uninstall --proxy --no-proxy` 与 `CFDM_*` 环境变量；
  gh-raw 代理 key 默认就是 `cfd-mgr`，域名 `gh-raw.966788.xyz`（+6 个备用）。**本次不改脚本。**
- `deploy/` 已有 `docker-compose.standalone.yml`（image `ghcr.io/mia-clark/cloudflared-manager`，
  host 网络，`./cfdmgr-data:/data`，默认端口经 `CFDM_HTTP_PORT` 默认 17200）与 `.env.example`。
- 国内加速一行命令脚本原文地址：`https://gh-raw.966788.xyz/cfd-mgr/install.sh`、
  `https://gh-raw.966788.xyz/cfd-mgr/install.ps1`。

## 2. 与 frpc 模板的差异（适配点）

| 维度 | frpc | 本仓库（cfd） |
|---|---|---|
| CLI | `fmc`（15 子命令） | `cfm`（**18 子命令**：服务 7 / 信息 3 / 安装维护 3 / 进阶 doctor·backup·restore·watch / help） |
| 旧版迁移 | 有 `upgrade-legacy` | **无**（cfd 无旧版迁移） |
| 内嵌运行时 | 内嵌 frp，version 有 `frp` 字段 | **不内嵌**，cloudflared 二进制由面板下载/多版本管理；version 仅 `daemon/version/build_date` |
| 配套仓库 | frps-manager | **无**；相关链接改为 cloudflared 上游 + Cloudflare Zero Trust 控制台 |
| daemon / 镜像 | frpcmgrd / frpc-manager | `cfdmgrd` / `ghcr.io/mia-clark/cloudflared-manager` |
| 代理 key | `frpc-mgr` | `cfd-mgr` |

## 3. 文件改动

仅前端 + 文档，无后端、无新依赖：

- **改写** `web/src/pages/About.tsx`：保留现有紫粉 Hero 横幅 + `<UpdateCard />`，
  下方新增「使用手册 & 部署指南」卡片，内含 5 个 Tab。复用内联 `<CodeBlock>`（带复制按钮，
  失败回落 `execCommand`）与 `<SectionTitle>`，跟随亮/暗主题。
- **同步** `README.md`：安装章节补充国内 `cfd-mgr` 加速命令（与 About 页一致）。

### 5 个 Tab

1. **相关链接**：本项目仓库 / cloudflared 上游 / Cloudflare Zero Trust 控制台 / Releases /
   在线 API 文档 (`/api/docs/`) / README / 报告 Bug + 构建详情表（应用名 / daemon 版本 / 构建时间 / 前端栈 / 实时通道）。
2. **快速部署**：
   - 国内加速（`gh-raw.966788.xyz/cfd-mgr/install.sh`）：交互 / 全自动 `-y` / 指定端口令牌 `-y -p -t`；
   - GitHub 直连 `raw.githubusercontent.com/.../install.sh -s -- -y`；
   - Windows PowerShell：`irm https://gh-raw.966788.xyz/cfd-mgr/install.ps1 | iex`，及环境变量全自动；
   - 三系统对照（Linux/macOS 同脚本 + Windows）；
   - 升级 `--update --force`；卸载 `--uninstall`；手动下载二进制；
   - 智能代理说明（内置 7 家 gh-raw，`--proxy` / `--no-proxy` 覆盖）。
3. **Docker**：docker run 单条（host 网络 + 随机 token）/ compose 模板（贴合 standalone）/
   一键拉 `deploy/docker-compose.standalone.yml` + `.env.example` / 运维命令 / 数据持久化说明。
4. **cfm 命令**：18 子命令分组表（可逐条复制），底部「忘了令牌看 `cfm info`」。
5. **环境变量**：`CFDM_*` 全量表（来自 README §7）+ 三系统配置文件/数据目录位置。

## 4. 技术约束

- 纯前端，无新后端 API，不引代码高亮库（YAGNI）。
- 跟随全站亮/暗主题（不写死深色）。
- `tsc -b && vite build` 必须通过。

## 5. 范围之外

- 不改安装脚本 / deploy 模板（已完整）。
- 不做全文搜索、多语言、外链预览。

## 6. 验证

- `cd web && npx tsc -b` 通过。
- 菜单「帮助 → 关于 & 手册」打开 5 Tab；命令块点击/按钮复制提示「已复制」；
  外链新窗口可达；亮/暗主题正常。
