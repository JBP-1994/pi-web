"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { SessionInfo } from "@/lib/types";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  onSelect: (session: SessionInfo) => void;
  onCreate: () => void;
  onDelete: (sessionId: string) => void;
  onRename: (sessionId: string, newName: string) => void;
}

function getTitle(session: SessionInfo): string {
  const collapsed = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  return session.name?.trim() || collapsed.slice(0, 50) || "新会话";
}

export function WorktreeSessionTabs({ sessions, selectedSessionId, onSelect, onCreate, onDelete, onRename }: Props) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startEdit = useCallback((session: SessionInfo) => {
    if (session.transient) return;
    setEditValue(getTitle(session));
    setEditingId(session.id);
    setConfirmDeleteId(null);
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingId) return;
    const trimmed = editValue.trim();
    const session = sessions.find((s) => s.id === editingId);
    if (session && trimmed && trimmed !== (session.name ?? "")) {
      // No-op if user didn't change the derived title fallback
      const fallback = getTitle({ ...session, name: undefined });
      if (trimmed !== fallback || session.name) {
        onRename(editingId, trimmed);
      }
    }
    setEditingId(null);
  }, [editingId, editValue, sessions, onRename]);

  // Auto scroll selected tab into view
  useEffect(() => {
    if (!selectedSessionId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-tab-id="${selectedSessionId}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selectedSessionId]);

  // Sorted by created descending per spec
  const sorted = [...sessions].sort((a, b) => b.created.localeCompare(a.created));

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        flexShrink: 0,
        minHeight: 38,
      }}
    >
      <button
        type="button"
        onClick={onCreate}
        title={t("sidebar.new")}
        aria-label={t("sidebar.new")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          flexShrink: 0,
          background: "var(--bg-hover)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          color: "var(--text-muted)",
          cursor: "pointer",
          position: "sticky",
          left: 0,
          zIndex: 1,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-selected)";
          e.currentTarget.style.color = "var(--accent)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <line x1="6" y1="1" x2="6" y2="11" />
          <line x1="1" y1="6" x2="11" y2="6" />
        </svg>
      </button>

      <div
        ref={scrollRef}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          overflowX: "auto",
          flex: 1,
          minWidth: 0,
          scrollbarWidth: "thin",
        }}
      >
        {sorted.map((session) => {
          const isSelected = session.id === selectedSessionId;
          const isEditing = editingId === session.id;
          const isConfirming = confirmDeleteId === session.id;
          const title = getTitle(session);
          const displayTitle = session.transient && !session.name && !session.firstMessage ? "新会话 · 未开始" : title;

          return (
            <div
              key={session.id}
              data-tab-id={session.id}
              tabIndex={isEditing ? -1 : 0}
              onClick={() => {
                if (isEditing || isConfirming) return;
                onSelect(session);
              }}
              onKeyDown={(e) => {
                if (isEditing || isConfirming) return;
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  startEdit(session);
                }
              }}
              title={title}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: 28,
                padding: "0 8px",
                borderRadius: 6,
                border: isSelected ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: isSelected ? "var(--bg-selected)" : "var(--bg-hover)",
                color: isSelected ? "var(--text)" : "var(--text-muted)",
                cursor: isEditing ? "default" : "pointer",
                flexShrink: 0,
                maxWidth: 200,
                minWidth: 80,
                fontSize: 12,
                whiteSpace: "nowrap",
                opacity: session.transient ? 0.7 : 1,
              }}
            >
              {isEditing ? (
                <input
                  ref={inputRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    padding: "2px 4px",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    outline: "none",
                    background: "var(--bg)",
                    color: "var(--text)",
                  }}
                />
              ) : (
                <>
                  <span
                    onDoubleClick={(e) => {
                      if (isConfirming) return;
                      e.stopPropagation();
                      startEdit(session);
                    }}
                    onTouchStart={() => {
                      if (isConfirming || session.transient) return;
                      const id = session.id;
                      const timer = setTimeout(() => startEdit(session), 500);
                      const cancel = () => clearTimeout(timer);
                      const el = document.querySelector(`[data-tab-id="${id}"]`) as HTMLElement | null;
                      el?.addEventListener("touchend", cancel, { once: true });
                      el?.addEventListener("touchmove", cancel, { once: true });
                    }}
                    title={`${title} — 双击重命名`}
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      flex: 1,
                      minWidth: 0,
                      fontStyle: session.transient && !session.name && !session.firstMessage ? "italic" : undefined,
                      color: session.transient && !session.name && !session.firstMessage ? "var(--text-dim)" : undefined,
                      userSelect: "none",
                    }}
                  >
                    {displayTitle}
                  </span>
                  {session.transient ? null : isConfirming ? (
                    <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                          onDelete(session.id);
                        }}
                        title={t("sidebar.delete")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 20,
                          height: 20,
                          padding: 0,
                          background: "#ef4444",
                          border: "none",
                          borderRadius: 4,
                          color: "#fff",
                          cursor: "pointer",
                          fontSize: 10,
                        }}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                        }}
                        title={t("sidebar.cancel")}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 20,
                          height: 20,
                          padding: 0,
                          background: "var(--bg)",
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          color: "var(--text-muted)",
                          cursor: "pointer",
                          fontSize: 10,
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(null);
                        setConfirmDeleteId(session.id);
                      }}
                      title={t("sidebar.delete")}
                      aria-label={t("sidebar.delete")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 18,
                        height: 18,
                        padding: 0,
                        background: "none",
                        border: "none",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.1)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <line x1="2" y1="2" x2="8" y2="8" />
                        <line x1="8" y1="2" x2="2" y2="8" />
                      </svg>
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
