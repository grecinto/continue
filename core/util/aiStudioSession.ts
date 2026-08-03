export interface AIStudioContinueSession {
  daemonBaseUrl?: string;
  daemonAccessToken?: string;
  daemonRefreshToken?: string;
  daemonTokenExpiry?: number;
  hqBaseUrl?: string;
  hqAccessToken?: string;
  hqRefreshToken?: string;
  hqUserID?: string;
  hqSessionID?: string;
}

export interface AIStudioHQLoginDialogRequest {
  daemonBaseUrl: string;
  hqBaseUrl?: string;
  username?: string;
  errorMessage?: string;
  status?: number;
}

export interface AIStudioHQLoginDialogResponse {
  cancelled?: boolean;
  hqBaseUrl?: string;
  username?: string;
  password?: string;
}

declare global {
  var __aiStudioContinueSession: AIStudioContinueSession | undefined;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

export function getAIStudioContinueSession(): AIStudioContinueSession | undefined {
  return globalThis.__aiStudioContinueSession;
}

export function setAIStudioContinueSession(
  session: AIStudioContinueSession | undefined,
): void {
  if (!session) {
    globalThis.__aiStudioContinueSession = undefined;
    return;
  }

  globalThis.__aiStudioContinueSession = {
    ...session,
    daemonBaseUrl: normalizeUrl(session.daemonBaseUrl),
    hqBaseUrl: normalizeUrl(session.hqBaseUrl),
  };
}
