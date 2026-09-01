import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const projectKey = url.searchParams.get("projectKey") ?? url.searchParams.get("project");
    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    let sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    // ADR 0004: one-layer project filter (exact projectKey match, no recursion)
    if (projectKey) sessions = sessions.filter((s) => s.projectKey === projectKey);
    return NextResponse.json(
      {
        sessions,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
