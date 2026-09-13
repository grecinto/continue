import { VsCodeExtension } from "./extension/VsCodeExtension";
import {
  AIStudioContinueSession,
  getAIStudioContinueSession,
} from "core/util/aiStudioSession";

/**
 * Mirrors the daemon-side ideworker.ExecutionResult / ModifiedFile contract
 * (lib/sop/ai/agent/domains/ideworker/result.go) so the callback receiver in
 * aiStudioWorkerServer.ts can emit a payload AI Studio already knows how to
 * parse for undo/history tracking.
 */
export interface AIStudioModifiedFile {
  file_path?: string;
  crud_operation?: string;
  diff_summary?: string;
  diff_delta?: string;
  diff_format?: string;
  metadata?: Record<string, unknown>;
}

export interface AIStudioExecutionResult {
  status?: string;
  summary?: string;
  modified_files?: AIStudioModifiedFile[];
  metadata?: Record<string, unknown>;
}

/**
 * Mirrors the daemon-side continueAgentExecuteRequest JSON shape
 * (lib/sop/cmd/sop-daemon/client_bridge.go) that the daemon POSTs to a
 * registered worker's callback_url.
 */
export interface DelegatedTaskRequest {
  requestId?: string;
  sessionId: string;
  task: string;
  mode?: string;
  requestedPhase?: string;
  allowedTools?: string[];
  toolChoice?: string;
  workspaceRoot?: string;
  activeFile?: string;
  selectedText?: string;
  openFiles?: string[];
  guidance?: {
    team_practices?: string[];
    success_criteria?: string[];
    constraints?: string[];
    implementation_notes?: string[];
  };
}

export function parseDelegatedTaskRequest(raw: any): DelegatedTaskRequest {
  const context = raw?.context ?? {};
  return {
    requestId: typeof raw?.request_id === "string" ? raw.request_id : undefined,
    sessionId: typeof raw?.session_id === "string" ? raw.session_id : "",
    task: typeof raw?.task === "string" ? raw.task : "",
    mode: typeof raw?.mode === "string" ? raw.mode : undefined,
    requestedPhase:
      typeof raw?.requested_phase === "string" ? raw.requested_phase : undefined,
    allowedTools: Array.isArray(raw?.allowed_tools) ? raw.allowed_tools : undefined,
    toolChoice: typeof raw?.tool_choice === "string" ? raw.tool_choice : undefined,
    workspaceRoot:
      typeof context.workspace_root === "string" ? context.workspace_root : undefined,
    activeFile: typeof context.active_file === "string" ? context.active_file : undefined,
    selectedText:
      typeof context.selected_text === "string" ? context.selected_text : undefined,
    openFiles: Array.isArray(context.open_files) ? context.open_files : undefined,
    guidance: raw?.guidance,
  };
}

function buildPromptFromRequest(request: DelegatedTaskRequest): string {
  const sections = [request.task.trim()];
  const guidance = request.guidance;
  if (guidance?.success_criteria?.length) {
    sections.push(`Success criteria:\n${guidance.success_criteria.map((s) => `- ${s}`).join("\n")}`);
  }
  if (guidance?.constraints?.length) {
    sections.push(`Constraints:\n${guidance.constraints.map((s) => `- ${s}`).join("\n")}`);
  }
  if (guidance?.implementation_notes?.length) {
    sections.push(
      `Implementation notes:\n${guidance.implementation_notes.map((s) => `- ${s}`).join("\n")}`,
    );
  }
  if (request.activeFile) {
    sections.push(`Primary file: ${request.activeFile}`);
  }
  return sections.join("\n\n");
}

/** Extracts `diff --git a/<path> b/<path>` file paths and per-file diff bodies from `git diff` output. */
export function parseUnifiedDiffIntoModifiedFiles(diffChunks: string[]): AIStudioModifiedFile[] {
  const files: AIStudioModifiedFile[] = [];
  for (const chunk of diffChunks) {
    if (!chunk || !chunk.trim()) {
      continue;
    }
    const fileBlocks = chunk.split(/^diff --git /m).filter((block) => block.trim().length > 0);
    for (const block of fileBlocks) {
      const headerMatch = block.match(/^a\/(\S+) b\/(\S+)/);
      const filePath = headerMatch ? headerMatch[2] : undefined;
      if (!filePath) {
        continue;
      }
      const isNewFile = /\nnew file mode/.test(block);
      const isDeleted = /\ndeleted file mode/.test(block);
      files.push({
        file_path: filePath,
        crud_operation: isNewFile ? "create" : isDeleted ? "delete" : "update",
        diff_delta: `diff --git ${block}`.slice(0, 16 * 1024),
        diff_format: "unified",
      });
    }
  }
  return files;
}

async function waitForDiffToStabilize(
  extension: VsCodeExtension,
  onProgress: (message: string) => void,
  options: { pollIntervalMs?: number; stableChecksRequired?: number; timeoutMs?: number } = {},
): Promise<string[]> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const stableChecksRequired = options.stableChecksRequired ?? 3;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  const start = Date.now();
  let lastDiff = "";
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const diffLines = await extension.getWorkspaceDiff(true);
    const currentDiff = diffLines.join("\n");
    if (currentDiff === lastDiff) {
      stableCount += 1;
      if (currentDiff.trim().length > 0 && stableCount >= stableChecksRequired) {
        onProgress("Detected no further workspace changes; treating task as complete.");
        return diffLines;
      }
    } else {
      stableCount = 0;
      lastDiff = currentDiff;
      onProgress("Workspace changes detected, continuing to watch for completion.");
    }
  }
  onProgress("Timed out waiting for changes to stabilize; returning current diff state.");
  return lastDiff ? lastDiff.split("\n") : [];
}

/**
 * Runs one delegated coding task by injecting it into Continue's own chat pipeline
 * (forcing Agent mode via VsCodeExtension.runDelegatedPrompt) and then watching the
 * workspace git diff until it stabilizes.
 *
 * KNOWN LIMITATION: diff-stabilization is a heuristic completion signal, not a
 * precise "turn finished" event from Continue's core. A precise signal would
 * require a new webview->IDE completion message fired from
 * gui/src/redux/thunks/streamThunkWrapper.tsx (the true top-level point where a
 * full agent turn, including all recursive tool calls, has finished) — tracked
 * as follow-up work in docs/IDE_COPILOT_CLIENT_INTEGRATION.md.
 */
export async function runDelegatedTask(
  extension: VsCodeExtension,
  request: DelegatedTaskRequest,
  onProgress: (message: string) => void,
): Promise<AIStudioExecutionResult> {
  const beforeDiff = (await extension.getWorkspaceDiff(true)).join("\n");
  onProgress(`Starting delegated task: ${request.task.slice(0, 200)}`);

  try {
    await extension.runDelegatedPrompt(buildPromptFromRequest(request));
  } catch (error) {
    return {
      status: "failed",
      summary: error instanceof Error ? error.message : "Failed to start delegated task in Continue",
    };
  }

  const afterDiffLines = await waitForDiffToStabilize(extension, onProgress);
  const afterDiff = afterDiffLines.join("\n");
  if (afterDiff === beforeDiff) {
    return {
      status: "completed",
      summary: "Task completed with no detected file changes.",
      modified_files: [],
    };
  }

  const modifiedFiles = parseUnifiedDiffIntoModifiedFiles(afterDiffLines);
  return {
    status: "completed",
    summary: `Applied changes to ${modifiedFiles.length} file(s).`,
    modified_files: modifiedFiles,
  };
}

/**
 * Capabilities this worker currently advertises. Deliberately does NOT include
 * "apply_patch" yet — see the Implementation Tracker in
 * docs/IDE_COPILOT_CLIENT_INTEGRATION.md: that flag forces AI Studio to hide its own
 * patch tools, so it must not be advertised until completion detection here is
 * validated as reliable end to end.
 */
export const AI_STUDIO_WORKER_CAPABILITIES = ["read_context", "edit_code", "diff_review", "plan_changes"];

async function postJSONSimple(url: string, body: Record<string, unknown>, accessToken?: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`worker registration failed with status ${response.status}: ${text}`);
  }
}

/**
 * Registers this IDE instance as a delegation worker for the current AI Studio
 * session so the daemon's delegate_continue_task tool can call back into
 * runDelegatedTask via the local callback server.
 */
export async function registerContinueWorker(
  sessionId: string,
  callbackUrl: string,
  session?: AIStudioContinueSession,
): Promise<void> {
  const activeSession = session ?? getAIStudioContinueSession();
  if (!activeSession?.daemonBaseUrl || !sessionId) {
    return;
  }
  const registerUrl = `${activeSession.daemonBaseUrl}/api/continue/worker/register`;
  await postJSONSimple(
    registerUrl,
    {
      session_id: sessionId,
      callback_url: callbackUrl,
      capabilities: AI_STUDIO_WORKER_CAPABILITIES,
      ide: "vscode",
    },
    activeSession.daemonAccessToken,
  );
}

/**
 * Mirrors AIStudio.ts's `getSessionID()` fallback (`ai-studio-<model>`) for the
 * default single-model-entry case, so a chat request and a worker registration
 * naturally land on the same daemon-side session_id without extra plumbing.
 * KNOWN LIMITATION: this does not cover multiple concurrent AI Studio model
 * entries/uniqueId values in the same workspace — each would need its own
 * registration, which is not implemented yet.
 */
export const AI_STUDIO_DEFAULT_SESSION_ID = "ai-studio-daemon-controller";
