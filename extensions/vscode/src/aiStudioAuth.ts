import {
  getAIStudioContinueSession,
  setAIStudioContinueSession,
  AIStudioContinueSession,
  AIStudioHQLoginDialogRequest,
  AIStudioHQLoginDialogResponse,
} from "core/util/aiStudioSession";
import * as vscode from "vscode";

import { VsCodeExtension } from "./extension/VsCodeExtension";
import { AI_STUDIO_DEFAULT_SESSION_ID, registerContinueWorker } from "./aiStudioWorker";
import { startAIStudioWorkerServer } from "./aiStudioWorkerServer";

const AI_STUDIO_SESSION_SECRET_KEY = "ai-studio.continue.session";

const DAEMON_ENDPOINT_PREFIXES = [
  "/api/continue/",
  "/api/daemon/",
  "/api/ask",
  "/api/execute",
  "/api/handoff",
];

type LoginResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: {
    username?: string;
  };
  error?: string;
  message?: string;
};

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function isDaemonEndpoint(url: URL): boolean {
  return DAEMON_ENDPOINT_PREFIXES.some((prefix) =>
    url.pathname.startsWith(prefix),
  );
}

async function readJSONBody(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function postJSON<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await readJSONBody(response)) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || `Request failed with status ${response.status}`);
  }
  return payload;
}

function withDaemonBaseUrl(
  session: AIStudioContinueSession | undefined,
  daemonBaseUrl: string,
): AIStudioContinueSession {
  return {
    ...(session ?? {}),
    daemonBaseUrl: normalizeBaseUrl(daemonBaseUrl),
  };
}

function shouldRefreshDaemonSession(session: AIStudioContinueSession | undefined): boolean {
  if (!session?.daemonBaseUrl) {
    return false;
  }
  if (!session.daemonAccessToken) {
    return true;
  }
  if (typeof session.daemonTokenExpiry === "number") {
    return session.daemonTokenExpiry <= Date.now();
  }
  return false;
}

async function persistSession(
  extension: VsCodeExtension,
  session: AIStudioContinueSession | undefined,
): Promise<void> {
  setAIStudioContinueSession(session);
  if (session) {
    await extension.writeSecret(
      AI_STUDIO_SESSION_SECRET_KEY,
      JSON.stringify(session),
    );
    // Best-effort, non-blocking: re-registering on every persisted session covers
    // initial sign-in, token refresh, and HQ handoff without extra call sites.
    // Failures are swallowed since worker delegation is optional/advisory today.
    void ensureContinueWorkerRegistered(extension, session);
    return;
  }
  await extension.deleteSecret(AI_STUDIO_SESSION_SECRET_KEY);
}

async function ensureContinueWorkerRegistered(
  extension: VsCodeExtension,
  session: AIStudioContinueSession,
): Promise<void> {
  if (!session.daemonBaseUrl || !session.daemonAccessToken) {
    return;
  }
  try {
    const callbackUrl = await startAIStudioWorkerServer(extension);
    await registerContinueWorker(AI_STUDIO_DEFAULT_SESSION_ID, callbackUrl, session);
  } catch {
    // Non-fatal: chat/delegation via /api/continue/chat still works without a
    // registered worker; the daemon simply falls back to its own coding tools.
  }
}

async function tryRefreshDaemonSession(
  extension: VsCodeExtension,
  session: AIStudioContinueSession | undefined,
): Promise<boolean> {
  if (!session?.daemonBaseUrl || !session.daemonRefreshToken) {
    return false;
  }

  try {
    const payload = await postJSON<LoginResponse>(
      `${normalizeBaseUrl(session.daemonBaseUrl)}/api/daemon/refresh`,
      { refresh_token: session.daemonRefreshToken },
    );
    await persistSession(extension, {
      ...session,
      daemonAccessToken: payload.access_token,
      daemonRefreshToken: payload.refresh_token || session.daemonRefreshToken,
      daemonTokenExpiry:
        typeof payload.expires_in === "number"
          ? Date.now() + payload.expires_in * 1000
          : session.daemonTokenExpiry,
    });
    return true;
  } catch {
    return false;
  }
}

async function tryRefreshHQSession(
  extension: VsCodeExtension,
  session: AIStudioContinueSession | undefined,
): Promise<AIStudioContinueSession | undefined> {
  if (!session?.hqBaseUrl || !session.hqRefreshToken) {
    return undefined;
  }

  try {
    const payload = await postJSON<LoginResponse>(
      `${normalizeBaseUrl(session.hqBaseUrl)}/api/auth/refresh`,
      { refresh_token: session.hqRefreshToken },
    );
    const updated = {
      ...session,
      hqAccessToken: payload.access_token,
      hqRefreshToken: payload.refresh_token || session.hqRefreshToken,
    };
    await persistSession(extension, updated);
    return updated;
  } catch {
    return undefined;
  }
}

async function exchangeDaemonSession(
  extension: VsCodeExtension,
  session: AIStudioContinueSession,
): Promise<AIStudioContinueSession> {
  if (!session.daemonBaseUrl || !session.hqAccessToken) {
    throw new Error("HQ session is incomplete");
  }

  const payload = await postJSON<LoginResponse>(
    `${normalizeBaseUrl(session.daemonBaseUrl)}/api/daemon/hq-auth`,
    { access_token: session.hqAccessToken },
  );

  const updated = {
    ...session,
    daemonAccessToken: payload.access_token,
    daemonRefreshToken: payload.refresh_token,
    daemonTokenExpiry:
      typeof payload.expires_in === "number"
        ? Date.now() + payload.expires_in * 1000
        : session.daemonTokenExpiry,
  };
  await persistSession(extension, updated);
  return updated;
}

async function signInToHQ(
  extension: VsCodeExtension,
  daemonBaseUrl: string,
  creds: AIStudioHQLoginDialogResponse,
): Promise<void> {
  const hqBaseUrl = normalizeBaseUrl(creds.hqBaseUrl || "");
  if (!hqBaseUrl) {
    throw new Error("HQ base URL is required.");
  }
  if (!creds.username?.trim() || !creds.password) {
    throw new Error("Username and password are required.");
  }

  const payload = await postJSON<LoginResponse>(`${hqBaseUrl}/api/auth/login`, {
    username: creds.username.trim(),
    password: creds.password,
  });

  const session: AIStudioContinueSession = {
    daemonBaseUrl: normalizeBaseUrl(daemonBaseUrl),
    hqBaseUrl,
    hqAccessToken: payload.access_token,
    hqRefreshToken: payload.refresh_token,
    hqUserID: payload.user?.username || creds.username.trim(),
  };
  await persistSession(extension, session);
  await exchangeDaemonSession(extension, session);
}

async function requestHQLogin(
  extension: VsCodeExtension,
  request: AIStudioHQLoginDialogRequest,
): Promise<AIStudioHQLoginDialogResponse | undefined> {
  await extension.focusContinueView();
  return extension.requestHQLogin(request);
}

async function recoverStoredAIStudioAuth(
  extension: VsCodeExtension,
  session: AIStudioContinueSession | undefined,
): Promise<void> {
  if (!session?.daemonBaseUrl) {
    return;
  }

  if (shouldRefreshDaemonSession(session)) {
    if (await tryRefreshDaemonSession(extension, session)) {
      return;
    }
  }

  if (session.hqBaseUrl && session.hqRefreshToken) {
    const refreshedHQ = await tryRefreshHQSession(extension, session);
    if (refreshedHQ) {
      try {
        await exchangeDaemonSession(extension, {
          ...refreshedHQ,
          daemonBaseUrl: session.daemonBaseUrl,
        });
      } catch {
        // Ignore startup handshake failures and rely on later user-driven recovery.
      }
    }
  }
}

async function recoverAIStudioAuth(
  extension: VsCodeExtension,
  failedUrl: string,
  status: number,
): Promise<boolean> {
  const parsed = new URL(failedUrl);
  let session = withDaemonBaseUrl(getAIStudioContinueSession(), parsed.origin);
  await persistSession(extension, session);

  if (await tryRefreshDaemonSession(extension, session)) {
    await extension.reloadContinueConfig("AI Studio daemon session refreshed");
    return true;
  }

  const refreshedHQ = await tryRefreshHQSession(extension, session);
  if (refreshedHQ) {
    session = withDaemonBaseUrl(refreshedHQ, parsed.origin);
    try {
      await exchangeDaemonSession(extension, session);
      await extension.reloadContinueConfig("AI Studio HQ session refreshed");
      return true;
    } catch {
      // Fall through to interactive login.
    }
  }

  let errorMessage: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const creds = await requestHQLogin(extension, {
      daemonBaseUrl: parsed.origin,
      hqBaseUrl: session.hqBaseUrl,
      username: session.hqUserID,
      errorMessage,
      status,
    });
    if (!creds || creds.cancelled) {
      return false;
    }

    try {
      await signInToHQ(extension, parsed.origin, creds);
      await extension.reloadContinueConfig("AI Studio HQ sign-in completed");
      await extension.showToast(
        "info",
        "Signed in to HQ and renewed the local daemon session.",
      );
      return true;
    } catch (error) {
      errorMessage =
        error instanceof Error ? error.message : "Unable to sign in to HQ.";
    }
  }

  await extension.showToast(
    "error",
    "Unable to renew the AI Studio session from Continue.",
  );
  return false;
}

export async function initializeAIStudioAuth(
  extension: VsCodeExtension,
): Promise<void> {
  let session: AIStudioContinueSession | undefined;
  const stored = await extension.readSecret(AI_STUDIO_SESSION_SECRET_KEY);
  if (stored) {
    try {
      session = JSON.parse(stored) as AIStudioContinueSession;
      setAIStudioContinueSession(session);
    } catch {
      await extension.deleteSecret(AI_STUDIO_SESSION_SECRET_KEY);
      setAIStudioContinueSession(undefined);
    }
  }

  if (session) {
    await recoverStoredAIStudioAuth(extension, session);
  }

  (globalThis as typeof globalThis & {
    __continueAuthHandler?: (url: string, status: number) => Promise<boolean | void> | boolean | void;
  }).__continueAuthHandler = async (url: string, status: number) => {
    if (![401, 403].includes(status)) {
      return false;
    }

    const parsedUrl = new URL(url);
    if (!["localhost", "127.0.0.1"].includes(parsedUrl.hostname)) {
      return false;
    }
    if (!isDaemonEndpoint(parsedUrl)) {
      return false;
    }

    return recoverAIStudioAuth(extension, url, status);
  };
}
