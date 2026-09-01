export interface InitialNavigation {
  requestedCwd: string | null;
  projectKey: string | null;
  worktreePath: string | null;
  sessionId: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const rawWorktree = searchParams.get("worktree")?.trim() || searchParams.get("cwd")?.trim() || null;
  const rawProject = searchParams.get("project")?.trim() || null;
  const rawSession = searchParams.get("session")?.trim() || null;
  // session > worktree > project (ADR 0003)
  return {
    requestedCwd: rawWorktree,
    projectKey: rawProject,
    worktreePath: rawWorktree,
    sessionId: rawSession || null,
  };
}

export function buildNavigationSearch(params: { project?: string | null; worktree?: string | null; session?: string | null }): string {
  const sp = new URLSearchParams();
  if (params.project) sp.set("project", params.project);
  if (params.worktree) sp.set("worktree", params.worktree);
  if (params.session) sp.set("session", params.session);
  const qs = sp.toString();
  return qs ? `?${qs}` : "/";
}
