# Sidebar as Project→Worktree tree, sessions as worktree-scoped strip

Pi Web moves sessions out of the sidebar. The sidebar becomes a Project→Worktree tree (non-git Projects have one implicit worktree with no create/delete); the content area gains a worktree-scoped horizontal session strip and the right panel merges FileExplorer above FileViewer. Session lookup stays compatible with legacy `?session=` URLs via worktree reverse lookup.

Chosen over a sidebar session list because Worktree is the correct grouping key for both sessions and files; a strip keeps one-click switching without nesting two lists in the sidebar.
