import * as http from "node:http";

import { VsCodeExtension } from "./extension/VsCodeExtension";
import {
  AIStudioExecutionResult,
  parseDelegatedTaskRequest,
  runDelegatedTask,
} from "./aiStudioWorker";

const DEFAULT_PORT = 51920;
const CALLBACK_PATH = "/aiStudioWorker/execute";

let activeServer: http.Server | undefined;
let taskInFlight = false;

function writeNDJSON(res: http.ServerResponse, event: Record<string, unknown>): void {
  res.write(`${JSON.stringify(event)}\n`);
}

async function handleExecuteRequest(
  extension: VsCodeExtension,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  if (taskInFlight) {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    writeNDJSON(res, {
      type: "done",
      result: {
        status: "failed",
        summary: "A delegated task is already running in this IDE session; try again once it finishes.",
      } as AIStudioExecutionResult,
    });
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }

  let parsedBody: any;
  try {
    parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const request = parseDelegatedTaskRequest(parsedBody);
  if (!request.sessionId || !request.task) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "session_id and task are required" }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  taskInFlight = true;
  try {
    const result = await runDelegatedTask(extension, request, (message) => {
      writeNDJSON(res, { type: "progress", message });
    });
    writeNDJSON(res, { type: "done", result });
  } catch (error) {
    writeNDJSON(res, {
      type: "done",
      result: {
        status: "failed",
        summary: error instanceof Error ? error.message : "Delegated task failed",
      } as AIStudioExecutionResult,
    });
  } finally {
    taskInFlight = false;
    res.end();
  }
}

/**
 * Starts the local loopback-only HTTP server that receives delegated task callbacks
 * from the AI Studio daemon (see docs/IDE_COPILOT_CLIENT_INTEGRATION.md). Returns the
 * callback URL to register with the daemon via registerContinueWorker(). Safe to call
 * more than once; subsequent calls reuse the already-running server.
 */
export function startAIStudioWorkerServer(extension: VsCodeExtension): Promise<string> {
  if (activeServer) {
    const address = activeServer.address();
    const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
    return Promise.resolve(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url !== CALLBACK_PATH) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      void handleExecuteRequest(extension, req, res);
    });

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another window/instance already owns the default port; fall back to an
        // ephemeral port so multiple VS Code windows can each run their own worker.
        server.listen(0, "127.0.0.1");
        return;
      }
      reject(err);
    });

    server.listen(DEFAULT_PORT, "127.0.0.1", () => {
      activeServer = server;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
      resolve(`http://127.0.0.1:${port}${CALLBACK_PATH}`);
    });

    server.on("listening", () => {
      activeServer = server;
    });
  });
}

export function stopAIStudioWorkerServer(): void {
  activeServer?.close();
  activeServer = undefined;
}
