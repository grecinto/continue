import { describe, expect, test, vi } from "vitest";

import AIStudio from "./AIStudio.js";

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

    const mockFetch = vi.fn().mockResolvedValue(
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
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0];
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