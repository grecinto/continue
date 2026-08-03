import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { initializeAIStudioAuth } from "./aiStudioAuth";
import { getAIStudioContinueSession, setAIStudioContinueSession } from "core/util/aiStudioSession";

describe("initializeAIStudioAuth", () => {
  beforeEach(() => {
    setAIStudioContinueSession(undefined);
    delete (globalThis as typeof globalThis & { __continueAuthHandler?: unknown }).__continueAuthHandler;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setAIStudioContinueSession(undefined);
  });

  test("refreshes an expired daemon session from persisted secrets on startup", async () => {
    const storedSession = {
      daemonBaseUrl: "http://127.0.0.1:9090",
      daemonAccessToken: "expired-daemon-token",
      daemonRefreshToken: "daemon-refresh-token",
      daemonTokenExpiry: Date.now() - 60_000,
      hqBaseUrl: "https://hq.example.com",
      hqAccessToken: "hq-access-token",
      hqRefreshToken: "hq-refresh-token",
      hqUserID: "user-42",
    };

    const extension = {
      readSecret: vi.fn().mockResolvedValue(JSON.stringify(storedSession)),
      writeSecret: vi.fn().mockResolvedValue(undefined),
      deleteSecret: vi.fn().mockResolvedValue(undefined),
      reloadContinueConfig: vi.fn().mockResolvedValue(undefined),
      showToast: vi.fn().mockResolvedValue(undefined),
      requestHQLogin: vi.fn(),
      focusContinueView: vi.fn(),
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          access_token: "refreshed-daemon-token",
          refresh_token: "refreshed-daemon-refresh-token",
          expires_in: 60,
        }),
      ),
    });

    vi.stubGlobal("fetch", fetchMock);

    await initializeAIStudioAuth(extension as any);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9090/api/daemon/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      }),
    );
    expect(getAIStudioContinueSession()?.daemonAccessToken).toBe("refreshed-daemon-token");
    expect(getAIStudioContinueSession()?.daemonRefreshToken).toBe("refreshed-daemon-refresh-token");
    expect(extension.writeSecret).toHaveBeenCalledWith(
      "ai-studio.continue.session",
      expect.stringContaining("refreshed-daemon-token"),
    );
  });
});
