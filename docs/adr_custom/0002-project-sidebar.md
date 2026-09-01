# 0002 — Project sidebar: visibility, navigation and refresh scope

Date: 2026-05-11 (merged 2026-05-11 from 0002/0003/0004)
Status: Accepted

> 合并原 0002（Project logical deletion）、0003（URL Navigation State）、0004（Refresh Scope）为一篇，反映当前实现（含后续迭代：物理删根会话、worktree 一层、popup 确认等）。

## Context
Sidebar 的 Project 来源于 `SessionInfo.projectRoot/projectKey/cwd` 全量推导 + `localStorage added-projects` 补充；`SessionManager.listAll()` 扫 `~/.pi/agent/sessions/**` 并经 `resolveProject(cwd)` 归一化。早期需求为：项目添加/删除为逻辑隐藏不删会话；URL 仅 `?session` 且随后 `replace("/")` 导致刷新/分享丢选中；刷新是否全量/一层存在分歧。

后续迭代明确：
- 删除项目需二次确认 popup，且**一并删除根会话**（`projectKey` 精确匹配且 `cwd === projectRoot`，不递归子目录），worktree 删除亦同步删其下会话；
- 已隐藏项目**彻底不展示**（移除“已隐藏”折叠组），仅手动点刷新（添加项目右边，`force=1`）才把有会话的已隐藏项目拉回；
- worktree 切换需自动进目标 worktree 最近活跃会话；
- 页面刷新（F5）不自动执行上述拉回，仅手动刷新触发。

## Decision

### 1) Project Visibility
- `Project Visibility = Visible | Deleted`，`Deleted` 为逻辑隐藏，`localStorage pi-web:project-visibility { [projectKey]: {deletedAt} }`，`Visible` 为缺省。
- `projectKey` 以 `projectIdentityKey()` 归一化为准（大小写/尾斜杠）。
- 删除项目时：筛选**根会话** `s.projectKey === projectKey && s.cwd === s.projectRoot`（一层，不含子目录 `projectRoot==cwd` 自成项目的会话），popup 二次确认后批量 `DELETE /api/sessions/[id]`，本地 `setAllSessions` 移除，再 `setProjectDeleted(..., true)` 并对选中态 `fallback` 到下一 Visible Project。无根会话则直接隐藏。
- 重选同一目录自动 `Deleted → Visible` 恢复；`addedProjects` 零会话项目被隐藏后不被刷新拉回。

### 2) Navigation State — URL `project > worktree > session`
- URL 常驻三参 `?project=<projectKey>&worktree=<cwd>&session=<id>`（`encodeURIComponent`），优先级 `session > worktree > project`，校验后自动纠正。
- `project` 为归一化 `projectKey`，`worktree` 为绝对 checkout `cwd`，`session` 为 `id`。
- `getInitialNavigation` 兼容旧 `?cwd` → `worktree`；`buildNavigationSearch` 统一构造。
- `AppShell` 的 `handleCwdChange / handleSelectSession / handleNewSession / handleSessionCreated / fork / delete` 均 `router.replace(buildNavigationSearch(...))` 常驻，不 `replace("/")`。`restoreWorkspaceContext` 在无 `lastOpen` 时回退到该 `projectKey` 最近 `modified` 会话并自动进入。
- 校验失败（`validateCwd`/`isExistingFilePathAllowed`）回退首个 Visible Project。

### 3) Refresh Scope & One-Layer Filtering
- **刷新 = 全量发现**：`GET /api/sessions` 全量返回，`addedProjects` 仅补零会话；支持可选 `?projectKey=`（或 `?project=`）服务端一层过滤 `s.projectKey === projectKey`，前端默认仍全量。
- **Project/Worktree 会话 = 一层精确匹配，不递归**：Project 视图仅 `projectKey` 精确匹配；Worktree 顶栏 `worktreeSessions` 与 `worktreeActivity` 均 `s.cwd === worktreePath` 精确匹配，不含 `startsWith` 子目录。
- **自动刷新已移除**：`runningSessionIds` 变化不再自动 `loadSessions`，`worktree` 缓存/轮询保留，仅手动点刷新（`force=1`）才执行全量重扫并触发 Q1 的拉回逻辑；页面 F5 不自动拉回已隐藏。

## Consequences
- 隐藏不丢数据，但删项目会物理删根会话（子目录保留）；worktree 删同步删其下会话，popup 文案同步会话数。
- 切换 worktree 自动进入其最近活跃会话（`running/unread` 优先，否则最近 `modified`）。
- 分享/刷新可还原 `project/worktree/session`，`Workspace Memory` 仅 URL 缺省时 fallback。
- 子目录会话自成 Project，不污染父 Project。

## References
- CONTEXT.md: Project, Added Project, Project Visibility, Navigation State, Refresh Scope
- lib/project-visibility.ts, lib/project-identity.ts, lib/project-groups.ts, lib/initial-navigation.ts, lib/session-reader.ts, lib/worktree.ts
- components/SessionSidebar.tsx, components/AppShell.tsx, app/api/sessions/route.ts
- Supersedes: 0002-project-logical-deletion, 0003-url-navigation-state, 0004-refresh-scope (merged)
