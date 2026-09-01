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
