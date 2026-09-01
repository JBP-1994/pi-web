import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

const execFileAsync = promisify(execFile);

function pickEditorCommand(): string[] {
  return ["cursor", "code"];
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { path?: unknown; isDir?: unknown };
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!rawPath) return NextResponse.json({ error: "Path is required" }, { status: 400 });
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(rawPath, allowedRoots)) return NextResponse.json({ error: "Path not allowed" }, { status: 403 });

    const candidates = pickEditorCommand();
    let lastError: unknown = null;
    for (const cmd of candidates) {
      try {
        // Use --goto for files to support line, plain for dirs
        await execFileAsync(cmd, [rawPath]);
        return NextResponse.json({ success: true, command: cmd });
      } catch (e: unknown) {
        const msg = String((e as { message?: string })?.message ?? e);
        // ENOENT means command not found, try next
        if (msg.includes("ENOENT") || msg.includes("not found")) {
          lastError = e;
          continue;
        }
        // Other errors (e.g., file not found) still try next?
        lastError = e;
        continue;
      }
    }
    // Try open as last resort (macOS)
    try {
      await execFileAsync("open", [rawPath]);
      return NextResponse.json({ success: true, command: "open" });
    } catch (e) {
      lastError = e;
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError ?? "Failed to open");
    const isNotFound = msg.includes("ENOENT") || msg.toLowerCase().includes("not found");
    return NextResponse.json({ error: isNotFound ? "未找到 Cursor/Code，请安装或配置 PATH" : msg }, { status: 500 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
