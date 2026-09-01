# Pi Web

Pi Web hosts coding-agent sessions for user-selected projects while keeping the web server's runtime concerns separate from project work.

## Language

**Host Runtime Environment**:
The environment owned by the Pi Web server and its framework runtime.
_Avoid_: Project environment, shell environment

**Project Command Environment**:
The environment presented to a command that Pi Web runs on behalf of a user-selected project.
_Avoid_: Host environment, inherited environment

**Built-in Project Shell**:
A shell entry point owned and operated by Pi Web for commands associated with a project.
_Avoid_: Extension shell, arbitrary child process

**Project**:
The stable identity of a checkout group, keyed by `projectKey` (server-normalized main repo root). All linked git worktrees of one repo share one Project.
_Avoid_: folder, directory, workspace, repo (ambiguous)

**Worktree**:
A git worktree — one filesystem checkout belonging to a Project. A git Project may have multiple linked worktrees; a non-git Project has one implicit worktree.
_Avoid_: project, branch, workdir

**Session**:
One persistent agent conversation stored as a `.jsonl` file, always bound to a single Worktree via its `cwd`. Fork creates a new Session file; in-session branch (`navigate_tree`) stays within one file.
_Avoid_: chat, conversation (informal), thread

**Session Family**:
A top-level Session plus its subagent children grouped by `relation.kind === "subagent"`. Forks are not families and appear as independent Sessions.
_Avoid_: tree, group (generic)

**Session Tab**:
A tab representing one Session of the selected Worktree. Single click selects the Session; double click (or long press / Enter when focused) edits the title inline. The tab offers a delete affordance.
_Avoid_: pill, chip, card

**Worktree Session Strip**:
The horizontally scrollable strip at the top of the content area for the selected Worktree.
_Avoid_: session list, tab bar (generic)

**Added Project**:
A Project explicitly added by the user through the directory picker. It remains in the sidebar even when it has no Sessions.
_Avoid_: recent project (derived), cwd history

**Project Visibility**:
Whether a Project appears in the sidebar. A Project is either Visible or Deleted. Deleted is a logical hide — it removes the Project from the default view but does not delete Session files, worktree checkouts, or filesystem content. Deleted Projects can be restored.
_Avoid_: removed, archived, disabled (overloaded)

**Navigation State**:
The URL-persisted hierarchy `project > worktree > session` that restores the left sidebar selection. `project` is the normalized `projectKey`, `worktree` is the selected checkout `cwd`, `session` is the Session `id`. Priority is `session > worktree > project` with validation and auto-correction. `Workspace Memory` (`last-open-by-workspace`) is fallback only when URL has no Navigation State.
_Avoid_: query string (generic), route state, deep link (ambiguous)

**Refresh Scope**:
The extent of data reloaded on refresh. Refresh scans all Sessions across all encoded `cwd` directories and derives each Session’s Project via `resolveProject(cwd)` (root project, not cwd subdir). A Project’s session list is the exact `projectKey` match — one layer, no recursion into subdirectory or nested-repo sessions. “All projects” on refresh therefore means “all root projects that actually own at least one Session”.
_Avoid_: reload all (ambiguous), deep scan, recursive project sessions
