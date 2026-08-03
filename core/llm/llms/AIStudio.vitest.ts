import { describe, expect, test, vi } from "vitest";

import AIStudio from "./AIStudio.js";
import { getAIStudioContinueSession, setAIStudioContinueSession } from "../../util/aiStudioSession.js";

const editFileTool = {
  displayTitle: "Edit File",
  function: {
    name: "edit_file",
    description: "Edit an existing file",
    parameters: {
      type: "object",
      required: ["filepath", "changes"],
      properties: {
        filepath: { type: "string" },
        changes: { type: "string" },
      },
    },
  },
  type: "function" as const,
  wouldLikeTo: "edit a file",
  isCurrently: "editing a file",
  hasAlready: "edited a file",
  readonly: false,
  group: "AI Studio Workflows",
};

function createMockNdjsonBody(lines: unknown[]) {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function createMetadataBody(values: string[]) {
  return JSON.stringify({
    control_model: {
      supported_llms: [
        {
          label: "Supported",
          options: values.map((value) => ({
            value,
            label: value,
          })),
        },
      ],
    },
  });
}

function setupReadableStreamPolyfill() {
  // @ts-ignore
  const originalFrom = ReadableStream.from;
  // @ts-ignore
  ReadableStream.from = (body) => {
    if (body?.source) {
      return body;
    }
    return originalFrom(body);
  };
}

describe("AIStudio", () => {
  test.each([
    ["openai", "gpt-5.4"],
    ["anthropic", "claude-sonnet-4-5"],
    ["gemini", "gemini-2.5-pro"],
  ])(
    "streamChat should send the user-selected daemon-supported model for %s",
    async (provider, selectedModel) => {
      const llm = new AIStudio({
        uniqueId: `ai-studio-supported-${provider}`,
        model: selectedModel,
        apiBase: "http://127.0.0.1:9090/",
        requestOptions: {
          headers: {
            Authorization: "Bearer daemon-jwt",
          },
          extraBodyProperties: {
            provider,
          },
        },
      });

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(createMetadataBody([`${provider}:${selectedModel}`]), {
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(createMockNdjsonBody([{ type: "done" }]), {
            headers: { "Content-Type": "application/x-ndjson" },
          }),
        );

      setupReadableStreamPolyfill();
      (llm as any).fetch = mockFetch;

      for await (const _chunk of llm.streamChat(
        [{ role: "user", content: `route to ${provider}` }],
        new AbortController().signal,
        {
          model: selectedModel,
        },
      )) {
        // no-op
      }

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(String(mockFetch.mock.calls[0][0])).toBe(
        "http://127.0.0.1:9090/api/continue/metadata",
      );

      const [, init] = mockFetch.mock.calls[1];
      const body = JSON.parse(init.body as string);
      expect(body.provider).toBe(provider);
      expect(body.model).toBe(selectedModel);
    },
  );

  test("streamChat should reject models that are missing from the daemon catalog", async () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-unsupported-model",
      model: "gpt-5.4-mini",
      apiBase: "http://127.0.0.1:9090/",
      requestOptions: {
        headers: {
          Authorization: "Bearer daemon-jwt",
        },
        extraBodyProperties: {
          provider: "openai",
        },
      },
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(createMetadataBody(["openai:gpt-5.4"]), {
        headers: { "Content-Type": "application/json" },
      }),
    );

    setupReadableStreamPolyfill();
    (llm as any).fetch = mockFetch;

    await expect(async () => {
      for await (const _chunk of llm.streamChat(
        [{ role: "user", content: "route to openai mini" }],
        new AbortController().signal,
        {
          model: "gpt-5.4-mini",
        },
      )) {
        // no-op
      }
    }).rejects.toThrow(
      "AI Studio daemon does not advertise support for openai:gpt-5.4-mini",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(
      "http://127.0.0.1:9090/api/continue/metadata",
    );
  });

  test("underlyingProviderName should reflect the delegated provider override", () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-provider-name",
      model: "claude-sonnet-4-5",
      requestOptions: {
        extraBodyProperties: {
          provider: "anthropic",
        },
      },
    });

    expect(llm.underlyingProviderName).toBe("anthropic");
  });

  test("streamChat should delegate only the latest user turn so Continue history is not the source of daemon memory", async () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-subtask-memory",
      model: "gpt-5.4",
      apiBase: "http://127.0.0.1:9090/",
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(createMetadataBody(["openai:gpt-5.4"]), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(createMockNdjsonBody([{ type: "done" }]), {
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );

    setupReadableStreamPolyfill();
    (llm as any).fetch = mockFetch;

    for await (const _chunk of llm.streamChat(
      [
        { role: "user", content: "Earlier request from the main chat" },
        { role: "assistant", content: "Earlier assistant reply" },
        { role: "user", content: "Current IDE coding subtask" },
      ],
      new AbortController().signal,
    )) {
      // no-op
    }

    const [, init] = mockFetch.mock.calls[1];
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("Current IDE coding subtask");
    expect(body.message).not.toContain("Earlier request");
  });

  test("streamChat should use stored SOP session tokens for daemon auth and HQ handoff", async () => {
    setAIStudioContinueSession({
      daemonAccessToken: "daemon-session-token",
      hqBaseUrl: "https://hq.example.com",
      hqAccessToken: "hq-access-token",
      hqRefreshToken: "hq-refresh-token",
      hqUserID: "user-42",
      hqSessionID: "hq-session-42",
    });

    const llm = new AIStudio({
      uniqueId: "ai-studio-session-0",
      model: "gpt-5.4",
      apiBase: "http://127.0.0.1:9090/",
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(createMockNdjsonBody([{ type: "done" }]), {
        headers: { "Content-Type": "application/x-ndjson" },
      }),
    );

    setupReadableStreamPolyfill();
    (llm as any).fetch = mockFetch;

    for await (const _chunk of llm.streamChat(
      [{ role: "user", content: "hello daemon" }],
      new AbortController().signal,
    )) {
      // no-op
    }

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer daemon-session-token" }),
    );
    expect(JSON.parse(init.body as string)).toEqual(
      expect.objectContaining({
        auth: {
          access_token: "hq-access-token",
          refresh_token: "hq-refresh-token",
        },
        hq: {
          base_url: "https://hq.example.com",
          user_id: "user-42",
          session_id: "hq-session-42",
        },
      }),
    );

    setAIStudioContinueSession(undefined);
    expect(getAIStudioContinueSession()).toBeUndefined();
  });

  test("streamChat should retry once after SOP auth recovery for 401 responses", async () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-session-retry",
      model: "gpt-5.4",
      apiBase: "http://127.0.0.1:9090/",
    });

    const authHandler = vi.fn().mockResolvedValue(true);
    (globalThis as typeof globalThis & { __continueAuthHandler?: unknown }).__continueAuthHandler = authHandler;

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("unauthorized", { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(createMockNdjsonBody([{ type: "content", delta: "Recovered" }, { type: "done" }]), {
          headers: { "Content-Type": "application/x-ndjson" },
        }),
      );

    setupReadableStreamPolyfill();
    (llm as any).fetch = mockFetch;

    const chunks: string[] = [];
    for await (const chunk of llm.streamChat(
      [{ role: "user", content: "retry please" }],
      new AbortController().signal,
    )) {
      chunks.push(String(chunk.content));
    }

    expect(chunks).toEqual(["Recovered"]);
    expect(authHandler).toHaveBeenCalledWith(
      "http://127.0.0.1:9090/api/continue/chat",
      401,
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);

    delete (globalThis as typeof globalThis & { __continueAuthHandler?: unknown }).__continueAuthHandler;
  });

  test("streamChat should reject delegated provider/model pairs missing from the daemon catalog", async () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-session-unsupported",
      model: "llama3.1",
      apiBase: "http://127.0.0.1:9090/",
      requestOptions: {
        headers: {
          Authorization: "Bearer daemon-jwt",
        },
        extraBodyProperties: {
          provider: "ollama",
        },
      },
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(createMetadataBody(["openai:gpt-5.4"]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    (llm as any).fetch = mockFetch;

    await expect(async () => {
      for await (const _chunk of llm.streamChat(
        [{ role: "user", content: "hello daemon" }],
        new AbortController().signal,
      )) {
        // no-op
      }
    }).rejects.toThrow(
      "AI Studio daemon does not advertise support for ollama:llama3.1",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("streamChat should send native continue chat requests to the daemon", async () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-session-1",
      model: "gpt-5.4",
      apiBase: "http://127.0.0.1:9090/",
      apiKey: "continue-llm-key",
      requestOptions: {
        headers: {
          Authorization: "Bearer daemon-jwt",
        },
        extraBodyProperties: {
          provider: "openai",
          url: "https://api.openai.com",
          workspace_root: "/workspace/repo",
          active_file: "src/main.ts",
          open_files: ["src/main.ts", "src/main.test.ts"],
          selected_text: "const current = true;",
          mode: "edit",
        },
      },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(createMetadataBody(["openai:gpt-5.4"]), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          createMockNdjsonBody([
            { type: "content", delta: "Hello" },
            { type: "content", delta: " world" },
            { type: "done" },
          ]),
          {
            headers: {
              "Content-Type": "application/x-ndjson",
            },
          },
        ),
      );

    setupReadableStreamPolyfill();
    (llm as any).fetch = mockFetch;

    const chunks: string[] = [];
    for await (const chunk of llm.streamChat(
      [{ role: "user", content: "hello daemon" }],
      new AbortController().signal,
    )) {
      chunks.push(String(chunk.content));
    }

    expect(chunks).toEqual(["Hello", " world"]);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [url, init] = mockFetch.mock.calls[1];
    expect(String(url)).toBe("http://127.0.0.1:9090/api/continue/chat");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer daemon-jwt",
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      }),
    );

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      session_id: "ai-studio-session-1",
      message: "hello daemon",
      provider: "openai",
      model: "gpt-5.4",
      api_key: "continue-llm-key",
      url: "https://api.openai.com",
      mode: "edit",
      workspace: {
        root: "/workspace/repo",
        active_file: "src/main.ts",
      },
      context: {
        open_files: ["src/main.ts", "src/main.test.ts"],
        selected_text: "const current = true;",
      },
    });
    setAIStudioContinueSession(undefined);
  });

  test("streamChat should forward Continue tools and emit native tool calls from AI Studio events", async () => {
    const llm = new AIStudio({
      uniqueId: "ai-studio-session-2",
      model: "gpt-5.4",
      apiBase: "http://127.0.0.1:9090/",
      requestOptions: {
        headers: {
          Authorization: "Bearer daemon-jwt",
        },
      },
    });

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        createMockNdjsonBody([
          {
            type: "tool_call",
            name: "edit_file",
            args: {
              filepath: "src/main.ts",
              changes: "// ... existing code ...\nconst enabled = true;",
            },
          },
          { type: "done" },
        ]),
        {
          headers: {
            "Content-Type": "application/x-ndjson",
          },
        },
      ),
    );

    setupReadableStreamPolyfill();
    (llm as any).fetch = mockFetch;

    const chunks = [] as any[];
    for await (const chunk of llm.streamChat(
      [{ role: "user", content: "Update the active file" }],
      new AbortController().signal,
      {
        tools: [editFileTool],
        toolChoice: { type: "function", function: { name: "edit_file" } },
      },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "ai-studio-tool-call-1",
          type: "function",
          function: {
            name: "edit_file",
            arguments: JSON.stringify({
              filepath: "src/main.ts",
              changes: "// ... existing code ...\nconst enabled = true;",
            }),
          },
        },
      ],
    });

    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([
      {
        displayTitle: "Edit File",
        function: {
          name: "edit_file",
          description: "Edit an existing file",
          parameters: {
            type: "object",
            required: ["filepath", "changes"],
            properties: {
              filepath: { type: "string" },
              changes: { type: "string" },
            },
          },
        },
        type: "function",
        wouldLikeTo: "edit a file",
        isCurrently: "editing a file",
        hasAlready: "edited a file",
        readonly: false,
        group: "AI Studio Workflows",
      },
    ]);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "edit_file" },
    });
  });
});