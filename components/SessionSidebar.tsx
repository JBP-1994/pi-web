"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties } from "react";
import type { SessionInfo } from "@/lib/types";
import { getProjectActivity, getRecentProjects } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { loadVisibilityMap, saveVisibilityMap, setProjectDeleted } from "@/lib/project-visibility";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null, projectKey?: string | null) => void;
  // compat props kept but ignored (explorer moved to right panel)
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}
interface WorktreeState {
  forCwd: string;
  projectRoot: string;
  projectKey: string;
  isGit: boolean;
  isTopLevel: boolean;
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}
interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const TREE_OPEN_STORAGE_KEY = "pi-web:project-tree-open";
const ADDED_PROJECTS_STORAGE_KEY = "pi-web:added-projects";
const WORKTREE_CACHE_STORAGE_KEY = "pi-web:worktree-cache";
const WORKTREE_CACHE_TTL_MS = 5 * 60 * 1000;
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadAddedProjects(): { key: string; root: string }[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ADDED_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is { key: string; root: string } => typeof (x as { key?: unknown })?.key === "string" && typeof (x as { root?: unknown })?.root === "string");
  } catch { return []; }
}
function saveAddedProjects(projects: { key: string; root: string }[]): void {
  try { window.localStorage.setItem(ADDED_PROJECTS_STORAGE_KEY, JSON.stringify(projects)); } catch {}
}

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try { return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? ""; } catch { return ""; }
}
function saveLastCustomCwd(cwd: string): void {
  try { window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd); } catch {}
}
function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch { return new Set(); }
}
function saveUnreadSessionIds(ids: Set<string>): void {
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {}
}
function loadTreeOpen(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(TREE_OPEN_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch { return new Set(); }
}
function loadWorktreeCache(): Map<string, WorktreeState> {
  if (typeof window === "undefined") return new Map();
  try {
    const raw = window.localStorage.getItem(WORKTREE_CACHE_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const now = Date.now();
    const map = new Map<string, WorktreeState>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = v as { state?: WorktreeState; ts?: number };
      if (!entry?.state || typeof entry.ts !== "number") continue;
      if (now - entry.ts > WORKTREE_CACHE_TTL_MS) continue;
      map.set(k, entry.state);
      // also index by projectKey for lookup parity with fetchWorktree
      if (entry.state.projectKey && entry.state.projectKey !== k) map.set(entry.state.projectKey, entry.state);
      if (entry.state.projectRoot && entry.state.projectRoot !== k && entry.state.projectRoot !== entry.state.projectKey) map.set(entry.state.projectRoot, entry.state);
    }
    return map;
  } catch { return new Map(); }
}
function saveWorktreeCache(cache: Map<string, WorktreeState>): void {
  try {
    const obj: Record<string, { state: WorktreeState; ts: number }> = {};
    const seen = new Set<string>();
    for (const [k, state] of cache.entries()) {
      // dedupe by projectKey to avoid duplicate roots
      const dedupeKey = state.projectKey || k;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      obj[dedupeKey] = { state, ts: Date.now() };
    }
    window.localStorage.setItem(WORKTREE_CACHE_STORAGE_KEY, JSON.stringify(obj));
  } catch {}
}
function saveTreeOpen(ids: Set<string>): void {
  try { window.localStorage.setItem(TREE_OPEN_STORAGE_KEY, JSON.stringify([...ids])); } catch {}
}
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", minWidth: 0, lineHeight: 1.35, direction: "rtl", textAlign: "left", ...style }}>
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);
  useEffect(() => {
    if (!running) { setDisplay(target); return; }
    iterRef.current = 0;
    const totalFrames = target.length * 4;
    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);
      setDisplay(target.split("").map((char, i) => {
        if (char === " ") return " ";
        if (i < resolved) return char;
        return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
      }).join(""));
      if (iterRef.current < totalFrames) frameRef.current = requestAnimationFrame(step);
      else setDisplay(target);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);
  return display;
}
function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);
  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);
  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    const next = !showVersion;
    triggerScramble(next);
    if (next) revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
  }, [showVersion, triggerScramble]);
  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);
  return (
    <button onClick={handleClick} style={{ background: "none", border: "none", padding: 0, cursor: "default", fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em", color: showVersion ? "var(--accent)" : "var(--text)", fontFamily: "var(--font-mono)", minWidth: "6ch" }}>{display}</button>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, selectedCwd: selectedCwdProp, onCwdChange, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const [addedProjects, setAddedProjects] = useState<{ key: string; root: string }[]>(() => []);
  const [visibilityMap, setVisibilityMap] = useState<Map<string, { deletedAt: string }>>(() => new Map());
  const [worktreeCache, setWorktreeCache] = useState<Map<string, WorktreeState>>(() => new Map());
  const [revalidatingKeys, setRevalidatingKeys] = useState<Set<string>>(() => new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => setHasMounted(true), []);
  useEffect(() => { setVisibilityMap(loadVisibilityMap()); }, []);
  useEffect(() => {
    const loaded = loadAddedProjects();
    if (loaded.length === 0) {
      const last = loadLastCustomCwd();
      if (last) {
        const migrated = [{ key: last, root: last }];
        try { window.localStorage.setItem(ADDED_PROJECTS_STORAGE_KEY, JSON.stringify(migrated)); } catch {}
        setAddedProjects(migrated);
        return;
      }
    }
    if (loaded.length > 0) setAddedProjects(loaded);
  }, []);
  useEffect(() => {
    const cached = loadWorktreeCache();
    if (cached.size > 0) setWorktreeCache(cached);
  }, []);
  useEffect(() => {
    const open = loadTreeOpen();
    if (open.size > 0) setExpandedKeys(open);
  }, []);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtToast, setWtToast] = useState<string | null>(null);
  const wtToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showWtToast = useCallback((msg: string) => {
    const cn = translateWorktreeError(msg);
    setWtToast(cn);
    if (wtToastTimerRef.current) clearTimeout(wtToastTimerRef.current);
    wtToastTimerRef.current = setTimeout(() => setWtToast(null), 3000);
  }, []);
  function translateWorktreeError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes("already exists")) return "worktree 已存在";
    if (lower.includes("invalid") || lower.includes("not a valid")) return "worktree 名称不合法";
    if (lower.includes("cannot") && lower.includes("branch")) return "无法创建 worktree，请检查名称";
    if (lower.includes("does not exist") || lower.includes("not found")) return "工作区不存在";
    if (lower.includes("permission") || lower.includes("denied")) return "权限不足，无法创建";
    if (msg.startsWith("HTTP")) return `请求失败 ${msg}`;
    return msg;
  }
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [pendingDeleteProject, setPendingDeleteProject] = useState<{ key: string; root: string; count: number } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [pendingDeleteWorktree, setPendingDeleteWorktree] = useState<{ projectRoot: string; path: string; branch: string | null; isDirty?: boolean } | null>(null);
  const [wtNewFor, setWtNewFor] = useState<string | null>(null);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningRef = useRef<Set<string>>(new Set());
  const currentSuppressedRef = useRef<Set<string>>(new Set());
  const previousSuppressedRef = useRef<Set<string>>(new Set());
  const runningPollAuthoritativeRef = useRef(false);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[]; completionNotificationSuppressedSessionIds?: string[] };
      setAllSessions(data.sessions);
      // Q2A/Q4: refresh (force) pulls hidden projects that have sessions back to visible
      if (force) {
        const keysWithSessions = new Set(getRecentProjects(data.sessions).map((p) => p.key));
        setVisibilityMap((prev) => {
          if (prev.size === 0) return prev;
          let changed = false;
          const next = new Map(prev);
          for (const k of prev.keys()) if (keysWithSessions.has(k)) { next.delete(k); changed = true; }
          if (changed) saveVisibilityMap(next);
          return changed ? next : prev;
        });
      }
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedRef.current = new Set(data.completionNotificationSuppressedSessionIds ?? []);
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      const unreadEligible = new Set(data.sessions.filter((s) => s.relation?.kind !== "subagent").map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligible.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) { setError(String(e)); } finally { if (showLoading) setLoading(false); }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  useEffect(() => { saveUnreadSessionIds(unreadSessionIds); }, [unreadSessionIds]);
  useEffect(() => { saveTreeOpen(expandedKeys); }, [expandedKeys]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => { if (d.home) setHomeDir(d.home); }).catch(() => {});
  }, []);

  // polling
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
    const schedule = () => { clearTimer(); if (stopped || document.visibilityState !== "visible") return; timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS); };
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const cur = new AbortController(); controller?.abort(); controller = cur;
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store", signal: cur.signal });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[]; completionNotificationSuppressedSessionIds?: string[] };
        if (stopped || controller !== cur) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedRef.current = new Set(data.completionNotificationSuppressedSessionIds ?? []);
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {} finally { if (controller === cur) controller = null; schedule(); }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void poll(); else { clearTimer(); controller?.abort(); controller = null; } };
    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stopped = true; clearTimer(); controller?.abort(); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  useEffect(() => { onRunningSessionIdsChange?.(runningSessionIds); }, [onRunningSessionIdsChange, runningSessionIds]);
  useEffect(() => { onSessionsChange?.(allSessions); }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const prev = previousRunningRef.current;
    const completedInBg = [...prev].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagent = new Set(allSessions.filter((s) => s.relation?.kind === "subagent").map((s) => s.id));
    const completedWithNotif = completedInBg.filter((id) => !previousSuppressedRef.current.has(id) && !knownSubagent.has(id));
    const newlyRunning = [...runningSessionIds].filter((id) => !prev.has(id));
    if (completedWithNotif.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prevSet) => {
        const next = new Set(prevSet);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotif.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlisted = newlyRunning.some((id) => !allSessions.some((s) => s.id === id));
    // auto-refresh removed per requirement: manual trigger only (refresh button)
    // if (completedInBg.length > 0 || hasUnlisted) loadSessions(false, true);
    void hasUnlisted; void completedInBg;
    if (completedWithNotif.length > 0) onBackgroundTaskDone?.();
    previousRunningRef.current = runningSessionIds;
    previousSuppressedRef.current = new Set([...runningSessionIds].filter((id) => currentSuppressedRef.current.has(id) || knownSubagent.has(id)));
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => { if (!prev.has(selectedSessionId)) return prev; const next = new Set(prev); next.delete(selectedSessionId); return next; });
  }, [selectedSessionId]);

  // project helpers
  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);
  const allDisplayProjects = useMemo(() => {
    const byKey = new Map<string, { key: string; root: string }>();
    for (const p of recentProjects) byKey.set(p.key, p);
    for (const p of addedProjects) if (!byKey.has(p.key)) byKey.set(p.key, p);
    if (validatedProject && !byKey.has(validatedProject.key)) byKey.set(validatedProject.key, { key: validatedProject.key, root: validatedProject.root });
    const getIsGit = (key: string, root: string): boolean => {
      const ws = worktreeCache.get(key) ?? worktreeCache.get(root);
      return ws ? ws.isGit : true; // unknown as git to avoid flicker (Q1)
    };
    const basename = (root: string) => (root.split("/").pop() || root).toLowerCase();
    return [...byKey.values()].sort((a, b) => {
      const aGit = getIsGit(a.key, a.root);
      const bGit = getIsGit(b.key, b.root);
      if (aGit !== bGit) return aGit ? -1 : 1;
      const an = basename(a.root);
      const bn = basename(b.root);
      if (an !== bn) return an < bn ? -1 : 1;
      return a.root.toLowerCase() < b.root.toLowerCase() ? -1 : a.root.toLowerCase() > b.root.toLowerCase() ? 1 : 0;
    });
  }, [recentProjects, addedProjects, validatedProject, worktreeCache]);
  const displayProjects = useMemo(() => allDisplayProjects.filter((p) => !visibilityMap.has(p.key)), [allDisplayProjects, visibilityMap]);
  const projectActivity = useMemo(() => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds), [allSessions, runningSessionIds, unreadSessionIds]);

  // backfill non-git recent projects into addedProjects for persistence (Q2)
  useEffect(() => {
    if (allSessions.length === 0 || worktreeCache.size === 0) return;
    const toAdd: { key: string; root: string }[] = [];
    for (const p of recentProjects) {
      if (addedProjects.some((ap) => ap.key === p.key)) continue;
      const ws = worktreeCache.get(p.key) ?? worktreeCache.get(p.root);
      if (ws && !ws.isGit) toAdd.push(p);
    }
    if (toAdd.length > 0) {
      setAddedProjects((prev) => {
        const next = [...prev, ...toAdd.filter((tp) => !prev.some((pr) => pr.key === tp.key))];
        saveAddedProjects(next);
        return next;
      });
    }
  }, [allSessions, worktreeCache, recentProjects, addedProjects]);

  const projectFor = useCallback((cwd: string | null): { root: string; key: string } | null => {
    if (!cwd) return null;
    if (validatedProject?.cwd === cwd) return { root: validatedProject.root, key: validatedProject.key };
    const cached = worktreeCache.get(cwd);
    if (cached) return { root: cached.projectRoot, key: cached.projectKey };
    // check if cwd is a worktree path in any cached entry
    for (const ws of worktreeCache.values()) {
      if (ws.worktrees.some((w) => w.path === cwd)) return { root: ws.projectRoot, key: ws.projectKey };
      if (ws.forCwd === cwd) return { root: ws.projectRoot, key: ws.projectKey };
    }
    const match = allSessions.find((s) => s.cwd === cwd || (s.projectRoot ?? s.cwd) === cwd);
    return match ? { root: match.projectRoot ?? match.cwd, key: workspaceKeyOf(match) } : { root: cwd, key: cwd };
  }, [validatedProject, worktreeCache, allSessions]);

  const lastNotifiedRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const proj = projectFor(selectedCwd);
    const prev = lastNotifiedRef.current;
    if (prev?.cwd === selectedCwd && prev.key === (proj?.key ?? null)) return;
    lastNotifiedRef.current = { cwd: selectedCwd, key: proj?.key ?? null };
    onCwdChange?.(selectedCwd, proj?.root ?? null, proj?.key ?? null);
  }, [selectedCwd, onCwdChange, projectFor]);

  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // fetch worktree for a project root (SWR: show cached, revalidate in background)
  const fetchWorktree = useCallback(async (cwd: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setRevalidatingKeys((prev) => { const next = new Set(prev); next.add(cwd); return next; });
    try {
      const res = await fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`);
      const d = await res.json() as { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string };
      if (d.error || !d.projectRoot) return;
      const state: WorktreeState = { forCwd: cwd, projectRoot: d.projectRoot, projectKey: d.projectKey ?? d.projectRoot, isGit: d.isGit ?? false, isTopLevel: d.isTopLevel ?? false, currentWorktreePath: d.currentWorktreePath ?? null, worktrees: d.worktrees ?? [] };
      setWorktreeCache((prev) => {
        const next = new Map(prev);
        next.set(cwd, state);
        next.set(state.projectKey, state);
        next.set(state.projectRoot, state);
        // persist SWR cache
        saveWorktreeCache(next);
        return next;
      });
    } catch {} finally {
      setRevalidatingKeys((prev) => { const next = new Set(prev); next.delete(cwd); return next; });
    }
  }, []);

  // when selectedCwd changes, ensure its worktree fetched
  useLayoutEffect(() => {
    if (!selectedCwd) return;
    if (!worktreeCache.has(selectedCwd)) void fetchWorktree(selectedCwd);
  }, [selectedCwd, worktreeCache, fetchWorktree]);

  // expand selected project by default
  const restoredRef = useRef(false);
  useEffect(() => {
    if (allSessions.length === 0) return;
    if (selectedCwd === null) {
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          setExpandedKeys((prev) => { const next = new Set(prev); next.add(workspaceKeyOf(target)); return next; });
          return;
        }
        onInitialRestoreDone?.();
      }
      if (skipInitialProjectSelection) return;
      const projs = getRecentProjects(allSessions);
      if (projs.length > 0) {
        setSelectedCwd(projs[0].root);
        setExpandedKeys((prev) => { if (prev.size > 0) return prev; const next = new Set(prev); next.add(projs[0].key); return next; });
      }
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // auto expand newly selected project
  useEffect(() => {
    if (!selectedCwd) return;
    const proj = projectFor(selectedCwd);
    if (proj && !expandedKeys.has(proj.key)) {
      if (!worktreeCache.has(proj.root) && !worktreeCache.has(proj.key)) void fetchWorktree(proj.root);
    }
  }, [selectedCwd, projectFor, expandedKeys, worktreeCache, fetchWorktree]);

  // SWR: on mount, revalidate all expanded projects in background (show cached immediately)
  const didSWRInitRef = useRef(false);
  useEffect(() => {
    if (didSWRInitRef.current) return;
    if (displayProjects.length === 0) return;
    didSWRInitRef.current = true;
    for (const key of expandedKeys) {
      const proj = displayProjects.find((p) => p.key === key);
      if (proj) void fetchWorktree(proj.root, { silent: true });
    }
  }, [displayProjects, expandedKeys, fetchWorktree]);

  // Revalidate on tab visibility change
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      for (const key of expandedKeys) {
        const proj = displayProjects.find((p) => p.key === key);
        if (proj) void fetchWorktree(proj.root, { silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [displayProjects, expandedKeys, fetchWorktree]);

  const handleToggleProject = useCallback((key: string, root: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        const hasCached = worktreeCache.has(root) || worktreeCache.has(key);
        void fetchWorktree(root, hasCached ? { silent: true } : undefined);
      }
      return next;
    });
  }, [worktreeCache, fetchWorktree]);

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;
    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: path }) });
      const data = await res.json().catch(() => ({})) as { cwd?: string; projectRoot?: string; projectKey?: string; error?: string };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) { setCustomPathError(data.error ?? `HTTP ${res.status}`); return; }
      setValidatedProject({ cwd: data.cwd, root: data.projectRoot, key: data.projectKey });
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setAddedProjects((prev) => {
        if (prev.some((p) => p.key === data.projectKey)) return prev;
        const next = [...prev, { key: data.projectKey!, root: data.projectRoot! }];
        saveAddedProjects(next);
        return next;
      });
      // auto-restore if previously hidden (Q3)
      setVisibilityMap((prev) => {
        if (!prev.has(data.projectKey!)) return prev;
        const next = setProjectDeleted(data.projectKey!, false, prev);
        showWtToast("已恢复项目，会话已保留");
        return next;
      });
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setExpandedKeys((prev) => { const next = new Set(prev); next.add(data.projectKey!); return next; });
    } catch (e) { setCustomPathError(e instanceof Error ? e.message : String(e)); } finally { setCustomPathValidating(false); }
  }, [customPathValue, customPathValidating, showWtToast]);





  const handleCreateWorktree = useCallback(async (projectRoot: string) => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy) return;
    setWtBusy(true); setWtError(null);
    try {
      const res = await fetch("/api/worktrees", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectRoot, branch }) });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) { const msg = data.error ?? `HTTP ${res.status}`; setWtError(msg); showWtToast(msg); return; }
      setWtNewFor(null); setWtNewBranch("");
      // optimistically add
      setWorktreeCache((prev) => {
        const next = new Map(prev);
        const existing = next.get(projectRoot) ?? next.get(projectRoot);
        if (existing) {
          const updated: WorktreeState = { ...existing, forCwd: data.path!, currentWorktreePath: data.path!, worktrees: [...existing.worktrees, { path: data.path!, branch, isMain: false }] };
          next.set(projectRoot, updated);
          next.set(existing.projectKey, updated);
          next.set(updated.projectRoot, updated);
          saveWorktreeCache(next);
        }
        return next;
      });
      setSelectedCwd(data.path);
      void fetchWorktree(projectRoot);
    } catch (e) { const msg = e instanceof Error ? e.message : String(e); setWtError(msg); showWtToast(msg); } finally { setWtBusy(false); }
  }, [wtNewBranch, wtBusy, fetchWorktree, showWtToast]);

  const handleRemoveWorktree = useCallback(async (projectRoot: string, path: string, force: boolean) => {
    if (wtBusy) return;
    setWtBusy(true); setWtError(null);
    try {
      const res = await fetch("/api/worktrees", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectRoot, path, force }) });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) { setWtConfirmRemove(path); return; }
        const msg = data.error ?? `HTTP ${res.status}`; setWtError(msg); showWtToast(msg); return;
      }
      setWtConfirmRemove(null);
      // if current worktree removed, fallback to root
      if (selectedCwd === path) setSelectedCwd(projectRoot);
      void fetchWorktree(projectRoot);
    } catch (e) { const msg = e instanceof Error ? e.message : String(e); setWtError(msg); showWtToast(msg); } finally { setWtBusy(false); }
  }, [wtBusy, selectedCwd, fetchWorktree, showWtToast]);

  // helper to get worktree activity (one-layer exact cwd — ADR 0004)
  const worktreeActivity = useCallback((worktreePath: string): { running: number; unread: number } => {
    let running = 0, unread = 0;
    for (const s of allSessions) {
      const cwd = s.cwd;
      const belongs = cwd === worktreePath;
      if (!belongs) continue;
      if (runningSessionIds.has(s.id)) running++;
      if (unreadSessionIds.has(s.id)) unread++;
    }
    return { running, unread };
  }, [allSessions, runningSessionIds, unreadSessionIds]);

  const selectedProject = projectFor(selectedCwd);

  const handleDeleteProject = useCallback((projectKey: string) => {
    const rootSessions = allSessions.filter((s) => s.projectKey === projectKey && s.cwd === s.projectRoot);
    const proj = allDisplayProjects.find((p) => p.key === projectKey);
    if (rootSessions.length > 0) {
      setPendingDeleteProject({ key: projectKey, root: proj?.root ?? projectKey, count: rootSessions.length });
    } else {
      // 无根会话直接隐藏
      const wasSelected = selectedProject?.key === projectKey;
      setVisibilityMap((prev) => setProjectDeleted(projectKey, true, prev));
      showWtToast("✓ 已隐藏项目");
      if (wasSelected) {
        const remaining = allDisplayProjects.filter((p) => p.key !== projectKey && !visibilityMap.has(p.key));
        if (remaining.length > 0) setSelectedCwd(remaining[0].root);
        else { setSelectedCwd(null); onCwdChange?.(null, null, null); }
      }
    }
  }, [allSessions, allDisplayProjects, selectedProject, visibilityMap, onCwdChange, showWtToast]);

  const handleConfirmDeleteProject = useCallback(async () => {
    if (!pendingDeleteProject) return;
    const { key: projectKey, count } = pendingDeleteProject;
    const wasSelected = selectedProject?.key === projectKey;
    const rootSessions = allSessions.filter((s) => s.projectKey === projectKey && s.cwd === s.projectRoot);
    setDeleteBusy(true);
    let failed = 0;
    for (const s of rootSessions) {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        if (!res.ok) failed++;
      } catch { failed++; }
    }
    if (failed > 0) showWtToast(`已删除 ${count - failed} 个会话，${failed} 个失败`);
    else showWtToast(`✓ 已删除 ${count} 个会话`);
    setAllSessions((prev) => prev.filter((s) => !rootSessions.some((r) => r.id === s.id)));
    setVisibilityMap((prev) => setProjectDeleted(projectKey, true, prev));
    if (wasSelected) {
      const remaining = allDisplayProjects.filter((p) => p.key !== projectKey && !visibilityMap.has(p.key));
      if (remaining.length > 0) setSelectedCwd(remaining[0].root);
      else { setSelectedCwd(null); onCwdChange?.(null, null, null); }
    }
    setDeleteBusy(false);
    setPendingDeleteProject(null);
  }, [pendingDeleteProject, allSessions, selectedProject, allDisplayProjects, visibilityMap, onCwdChange, showWtToast]);

  const handleConfirmDeleteWorktree = useCallback(async (force = false) => {
    if (!pendingDeleteWorktree) return;
    const { projectRoot, path } = pendingDeleteWorktree;
    setDeleteBusy(true);
    try {
      const res = await fetch("/api/worktrees", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: projectRoot, path, force }) });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          setPendingDeleteWorktree((prev) => prev ? { ...prev, isDirty: true } : prev);
          setDeleteBusy(false);
          return;
        }
        const msg = data.error ?? `HTTP ${res.status}`; setWtError(msg); showWtToast(msg);
        setDeleteBusy(false);
        return;
      }
      // 同步删除该 worktree 下的一层会话（cwd 精确匹配，不递归子目录）
      const worktreeSessions = allSessions.filter((s) => s.cwd === path);
      if (worktreeSessions.length > 0) {
        let failed = 0;
        for (const s of worktreeSessions) {
          try { const r = await fetch(`/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" }); if (!r.ok) failed++; } catch { failed++; }
        }
        setAllSessions((prev) => prev.filter((s) => !worktreeSessions.some((w) => w.id === s.id)));
        if (failed > 0) showWtToast(`✓ 已删除 worktree，${worktreeSessions.length - failed} 个会话已删，${failed} 个失败`);
        else showWtToast(`✓ 已删除 worktree 及 ${worktreeSessions.length} 个会话`);
      } else {
        showWtToast("✓ 已删除 worktree");
      }
      setPendingDeleteWorktree(null);
      if (selectedCwd === path) {
        // 切到目标 worktree 最近活跃会话已由点击处理，删除后仅切回主 worktree
        setSelectedCwd(projectRoot);
        const fallbackSessions = allSessions.filter((s) => s.cwd === projectRoot).sort((a, b) => b.modified.localeCompare(a.modified));
        if (fallbackSessions.length > 0) onSelectSession(fallbackSessions[0]);
      }
      void fetchWorktree(projectRoot);
    } catch (e) { const msg = e instanceof Error ? e.message : String(e); setWtError(msg); showWtToast(msg); }
    finally { setDeleteBusy(false); }
  }, [pendingDeleteWorktree, allSessions, selectedCwd, fetchWorktree, showWtToast, onSelectSession]);

  const handleRestoreProject = useCallback((projectKey: string, projectRoot: string) => {
    setVisibilityMap((prev) => setProjectDeleted(projectKey, false, prev));
    setAddedProjects((prev) => {
      if (prev.some((p) => p.key === projectKey)) return prev;
      const next = [...prev, { key: projectKey, root: projectRoot }];
      saveAddedProjects(next);
      return next;
    });
    setExpandedKeys((prev) => { const next = new Set(prev); next.add(projectKey); return next; });
    showWtToast("已恢复项目");
  }, [showWtToast]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative", userSelect: "none", WebkitUserSelect: "none" }}>
      {customPathOpen && (
        <DirectoryPicker initialPath={customPathValue} busy={customPathValidating} error={customPathError} onCancel={() => { setCustomPathOpen(false); setCustomPathError(null); }} onSelect={(path) => void commitCustomPath(path)} />
      )}
      <div style={{ padding: "12px 10px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiWebTitle />
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => { setCustomPathOpen(true); setCustomPathError(null); }} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 5, background: "var(--bg-hover)", border: "1px solid var(--border)", color: "var(--text-muted)", cursor: "pointer", height: 32, paddingLeft: 10, paddingRight: 12, borderRadius: 7, fontSize: 12, fontWeight: 500 }} title="添加项目">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="6" y1="1" x2="6" y2="11" /><line x1="1" y1="6" x2="11" y2="6" /></svg>
              添加项目
            </button>
            <button onClick={() => loadSessions(false, true)} style={{ display: "flex", alignItems: "center", justifyContent: "center", background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)", border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`, color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)", cursor: "pointer", width: 32, height: 32, borderRadius: 7, padding: 0, flexShrink: 0 }}>
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {wtToast && (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 1200, background: wtToast.startsWith("✓") || wtToast.includes("已删除") || wtToast.includes("已隐藏") || wtToast.includes("已恢复") ? "var(--bg-panel)" : "var(--bg-panel)", border: `1px solid ${wtToast.includes("失败") || wtToast.includes("不存在") || wtToast.includes("权限") ? "#fecaca" : "var(--border)"}`, color: wtToast.includes("失败") || wtToast.includes("不存在") || wtToast.includes("权限") ? "#dc2626" : "var(--text)", fontSize: 12, lineHeight: 1.4, padding: "10px 14px", borderRadius: 20, boxShadow: "0 8px 24px rgba(0,0,0,0.16)", overflowWrap: "anywhere", display: "flex", alignItems: "center", gap: 6, maxWidth: "90vw" }}><span>{wtToast}</span></div>
      )}
      {pendingDeleteProject && (
        <div role="presentation" onClick={(e) => { if (!deleteBusy && e.target === e.currentTarget) setPendingDeleteProject(null); }} style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-project-title" onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)", overflow: "hidden" }}>
            <div style={{ padding: "18px 18px 14px" }}>
              <div id="delete-project-title" style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>删除项目？</div>
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}>将同时删除该根目录下的 <span style={{ color: "#ef4444", fontWeight: 600 }}>{pendingDeleteProject.count}</span> 个会话，子文件夹会话保留。</div>
              <code style={{ display: "block", marginTop: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{pendingDeleteProject.root}</code>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
              <button type="button" onClick={() => setPendingDeleteProject(null)} disabled={deleteBusy} style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: deleteBusy ? "not-allowed" : "pointer", fontSize: 12 }}>取消</button>
              <button type="button" onClick={() => void handleConfirmDeleteProject()} disabled={deleteBusy} style={{ height: 32, padding: "0 12px", border: "1px solid #ef4444", borderRadius: 5, background: "#ef4444", color: "white", cursor: deleteBusy ? "wait" : "pointer", opacity: deleteBusy ? 0.7 : 1, fontSize: 12, fontWeight: 600 }}>{deleteBusy ? "删除中…" : "删除"}</button>
            </div>
          </div>
        </div>
      )}
      {pendingDeleteWorktree && (
        <div role="presentation" onClick={(e) => { if (!deleteBusy && e.target === e.currentTarget) setPendingDeleteWorktree(null); }} style={{ position: "fixed", inset: 0, zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(0,0,0,0.4)" }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-worktree-title" onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "100%", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 12px 36px rgba(0,0,0,0.24)", overflow: "hidden" }}>
            <div style={{ padding: "18px 18px 14px" }}>
              <div id="delete-worktree-title" style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{pendingDeleteWorktree.isDirty ? "强制删除 worktree？" : "删除 worktree？"}</div>
              <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.6, color: "var(--text-muted)" }}>{(() => { const c = allSessions.filter((s) => s.cwd === pendingDeleteWorktree.path).length; const base = c > 0 ? `将同时删除该 worktree 下的 ${c} 个会话（不递归子目录）` : "确认删除该 worktree 检出"; return pendingDeleteWorktree.isDirty ? `${base}，强制删除将丢失未提交修改。` : `${base}？`; })()}</div>
              <code style={{ display: "block", marginTop: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{pendingDeleteWorktree.branch ? `${pendingDeleteWorktree.branch} — ${pendingDeleteWorktree.path}` : pendingDeleteWorktree.path}</code>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
              <button type="button" onClick={() => setPendingDeleteWorktree(null)} disabled={deleteBusy} style={{ height: 32, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "transparent", color: "var(--text-muted)", cursor: deleteBusy ? "not-allowed" : "pointer", fontSize: 12 }}>取消</button>
              <button type="button" onClick={() => void handleConfirmDeleteWorktree(pendingDeleteWorktree.isDirty)} disabled={deleteBusy} style={{ height: 32, padding: "0 12px", border: "1px solid #ef4444", borderRadius: 5, background: "#ef4444", color: "white", cursor: deleteBusy ? "wait" : "pointer", opacity: deleteBusy ? 0.7 : 1, fontSize: 12, fontWeight: 600 }}>{deleteBusy ? "删除中…" : pendingDeleteWorktree.isDirty ? "强制删除" : "删除"}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
        {loading && displayProjects.length === 0 && <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.loading")}</div>}
        {error && <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>{error}</div>}
        {!hasMounted && loading && <div style={{ display: "none" }} aria-hidden="true" />}
        {!loading && !error && displayProjects.length === 0 && <div style={{ padding: "12px 14px", color: "var(--text-muted)", fontSize: 12 }}>暂无项目，请添加</div>}
        {hasMounted && loading && displayProjects.length > 0 && <div style={{ padding: "6px 14px", color: "var(--text-dim)", fontSize: 11, fontStyle: "italic" }}>刷新中…</div>}
        {displayProjects.map((project) => {
          const isExpanded = expandedKeys.has(project.key);
          const isSelectedProject = selectedProject?.key === project.key;
          const ws = worktreeCache.get(project.key) ?? worktreeCache.get(project.root) ?? null;
          const isGit = ws ? ws.isGit : true; // assume git until fetched
          const worktrees = ws?.worktrees ?? [];
          const activity = projectActivity.get(project.key);
          const hasActivity = activity && (activity.running > 0 || activity.unread > 0);

          return (
            <div key={project.key} style={{ marginBottom: 2 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "6px 8px",
                  background: isSelectedProject && worktrees.length === 0 ? "var(--bg-selected)" : "transparent",
                  borderLeft: isSelectedProject && worktrees.length === 0 ? "2px solid var(--accent)" : "2px solid transparent",
                  cursor: "pointer",
                }}
                onClick={() => {
                  if (isGit && worktrees.length > 0) {
                    handleToggleProject(project.key, project.root);
                  } else if (!isGit) {
                    setSelectedCwd(project.root);
                  } else if (worktrees.length === 0) {
                    // fetching not done yet, toggle to trigger fetch
                    handleToggleProject(project.key, project.root);
                  }
                }}
              >
                {isGit ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleToggleProject(project.key, project.root); }}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                    aria-label={isExpanded ? "收起" : "展开"}
                  >
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 2 7 5 3 8" /></svg>
                  </button>
                ) : (
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, flexShrink: 0, color: "var(--text-dim)" }}>
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" /></svg>
                  </span>
                )}
                <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, color: isSelectedProject ? "var(--text)" : "var(--text-muted)" }} />
                {(revalidatingKeys.has(project.root) || revalidatingKeys.has(project.key)) && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>· 同步中</span>}
                {hasActivity && !isExpanded && (
                  <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
                    {activity.running > 0 && <span style={{ display: "inline-flex", alignItems: "center", gap: 2, color: "var(--accent)", fontSize: 10 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />{activity.running}</span>}
                    {activity.unread > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0891b2", display: "inline-block", marginTop: 3 }} />}
                  </span>
                )}
                {isGit && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setWtNewFor(wtNewFor === project.key ? null : project.key);
                      setWtNewBranch("");
                      setWtError(null);
                      setTimeout(() => wtNewInputRef.current?.focus(), 0);
                    }}
                    title={t("sidebar.newWorktree")}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", borderRadius: 4, flexShrink: 0 }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"><line x1="5" y1="1" x2="5" y2="9" /><line x1="1" y1="5" x2="9" y2="5" /></svg>
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void handleDeleteProject(project.key); }}
                  title="删除项目（根目录会话一并删除）"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", borderRadius: 4, flexShrink: 0 }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                </button>
              </div>

              {/* new worktree input — fixed height to avoid jitter */}
              {wtNewFor === project.key && (
                <div
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                      setWtNewFor(null);
                      setWtNewBranch("");
                    }
                  }}
                  style={{ padding: "6px 8px 6px 28px", display: "flex", gap: 4, height: 36, boxSizing: "border-box", alignItems: "center" }}
                >
                  <input ref={wtNewInputRef} value={wtNewBranch} disabled={wtBusy} onChange={(e) => { setWtNewBranch(e.target.value); setWtError(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleCreateWorktree(project.root); } if (e.key === "Escape") { setWtNewFor(null); setWtNewBranch(""); } }} placeholder="新worktree，如 feature/login" style={{ flex: 1, minWidth: 0, height: 28, fontSize: 11, fontFamily: "var(--font-mono)", padding: "0 8px", border: "1px solid var(--accent)", borderRadius: 6, outline: "none", background: "var(--bg)", color: "var(--text)", opacity: wtBusy ? 0.6 : 1 }} />
                  <button onClick={() => void handleCreateWorktree(project.root)} disabled={wtBusy || !wtNewBranch.trim()} title="创建" aria-label="创建" style={{ width: 28, height: 28, padding: 0, background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer", opacity: wtBusy || !wtNewBranch.trim() ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg></button>
                  <button onClick={() => { setWtNewFor(null); setWtNewBranch(""); }} disabled={wtBusy} title="取消" aria-label="取消" style={{ width: 28, height: 28, padding: 0, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: wtBusy ? "not-allowed" : "pointer", opacity: wtBusy ? 0.5 : 1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}><svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><line x1="2" y1="2" x2="8" y2="8" /><line x1="8" y1="2" x2="2" y2="8" /></svg></button>
                </div>
              )}

              {/* worktrees */}
              {isExpanded && (
                <div style={{ paddingLeft: 18 }}>
                  {worktrees.length === 0 && !ws && (
                    <div style={{ padding: "4px 8px 4px 12px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.loading")}</div>
                  )}
                  {worktrees.map((wt) => {
                    const isCurrent = selectedCwd === wt.path;
                    const wtAct = worktreeActivity(wt.path);
                    const showBadge = wtAct.running > 0 || wtAct.unread > 0;
                    if (wtConfirmRemove === wt.path) {
                      return (
                        <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", background: "rgba(239,68,68,0.06)", borderRadius: 6, margin: "2px 8px 2px 0" }}>
                          <span style={{ flex: 1, fontSize: 11, color: "var(--text)" }}>{t("sidebar.forceRemoveCheckout")}</span>
                          <button onClick={() => void handleRemoveWorktree(project.root, wt.path, true)} disabled={wtBusy} style={{ padding: "3px 8px", background: "#ef4444", border: "none", borderRadius: 4, color: "#fff", fontSize: 11, cursor: "pointer" }}>{t("sidebar.force")}</button>
                          <button onClick={() => setWtConfirmRemove(null)} style={{ padding: "3px 8px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>{t("sidebar.cancel")}</button>
                        </div>
                      );
                    }
                    return (
                      <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 4px 4px 8px", margin: "1px 8px 1px 0", borderRadius: 6, background: isCurrent ? "var(--bg-selected)" : "transparent", borderLeft: isCurrent ? "2px solid var(--accent)" : "2px solid transparent", cursor: "pointer" }} onClick={() => {
                        setSelectedCwd(wt.path);
                        // 切换 worktree 同时切到目标 worktree 最近活跃会话
                        const targetSessions = allSessions.filter((s) => s.cwd === wt.path).sort((a, b) => b.modified.localeCompare(a.modified));
                        if (targetSessions.length > 0) {
                          const withActivity = targetSessions.find((s) => runningSessionIds.has(s.id) || unreadSessionIds.has(s.id));
                          onSelectSession(withActivity ?? targetSessions[0]);
                        }
                      }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={wt.isMain ? "var(--text-dim)" : "var(--accent)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
                        <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, color: isCurrent ? "var(--text)" : "var(--text-muted)" }} />
                        {wt.isMain && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{t("sidebar.main")}</span>}
                        {showBadge && (
                          <span style={{ display: "inline-flex", gap: 3, flexShrink: 0, alignItems: "center" }}>
                            {wtAct.running > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />}
                            {wtAct.unread > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#0891b2" }} />}
                          </span>
                        )}
                        {!wt.isMain && (
                          <button onClick={(e) => { e.stopPropagation(); setPendingDeleteWorktree({ projectRoot: project.root, path: wt.path, branch: wt.branch }); }} disabled={wtBusy} title={t("sidebar.removeWorktreeTitle", { path: wt.path })} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", borderRadius: 4 }} onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }} onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
