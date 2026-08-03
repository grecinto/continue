import { streamJSON } from "@continuedev/fetch";

import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { serializeTool } from "../../tools/index.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { BaseLLM } from "../index.js";

type AIStudioStreamEvent = {
  type?: string;
  delta?: string;
  message?: string;
  name?: string;
  args?: unknown;
  id?: string;
  payload?: Record<string, unknown>;
  error?: string | { message?: string };
};

class AIStudio extends BaseLLM {
  static providerName = "ai-studio";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://127.0.0.1:9090/",
    model: "daemon-controller",
  };

  private getEndpoint(path: string): string {
    const base = this.apiBase ?? AIStudio.defaultOptions.apiBase!;
    return new URL(path.replace(/^\//, ""), base).toString();
  }

  private getRequestBodyOverrides(): Record<string, any> {
    return this.requestOptions?.extraBodyProperties ?? {};
  }

  private getSessionID(): string {
    return this.uniqueId && this.uniqueId !== "None"
      ? this.uniqueId
      : `ai-studio-${this.model}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      ...(this.requestOptions?.headers ?? {}),
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    };
  }

  private buildPrompt(messages: ChatMessage[]): string {
    if (
      messages.length === 1 &&
      messages[0].role === "user" &&
      typeof messages[0].content === "string"
    ) {
      return messages[0].content;
    }

    return messages
      .map((message) => `<${message.role}>\n${renderChatMessage(message)}`)
      .join("\n\n");
  }

  private buildRequest(messages: ChatMessage[], options: CompletionOptions) {
    const overrides = this.getRequestBodyOverrides();
    const workspaceRoot =
      typeof overrides.workspace_root === "string"
        ? overrides.workspace_root.trim()
        : "";
    const activeFile =
      typeof overrides.active_file === "string"
        ? overrides.active_file.trim()
        : "";
    const selectedText =
      typeof overrides.selected_text === "string"
        ? overrides.selected_text
        : "";
    const openFiles = Array.isArray(overrides.open_files)
      ? overrides.open_files.filter(
          (value: unknown): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : [];

    const requestBody: Record<string, any> = {
      session_id: this.getSessionID(),
      message: this.buildPrompt(messages),
      model: options.model,
      mode:
        typeof overrides.mode === "string" && overrides.mode.trim().length > 0
          ? overrides.mode.trim()
          : "chat",
      workspace: {
        root: workspaceRoot,
        active_file: activeFile,
      },
      context: {
        open_files: openFiles,
        selected_text: selectedText,
      },
    };

    if (typeof overrides.provider === "string" && overrides.provider.trim()) {
      requestBody.provider = overrides.provider.trim();
    }
    if (this.apiKey) {
      requestBody.api_key = this.apiKey;
    }
    if (typeof overrides.url === "string" && overrides.url.trim()) {
      requestBody.url = overrides.url.trim();
    }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      requestBody.tools = options.tools.map((tool) => serializeTool(tool));
    }
    if (options.toolChoice) {
      requestBody.tool_choice = options.toolChoice;
    }

    return requestBody;
  }

  private buildToolCallChunk(
    event: AIStudioStreamEvent,
    toolCallIndex: number,
  ): ChatMessage | null {
    const payload = event.payload ?? {};
    const toolName =
      (typeof event.name === "string" && event.name.trim()) ||
      (typeof payload.name === "string" && payload.name.trim()) ||
      (typeof payload.tool_name === "string" && payload.tool_name.trim()) ||
      (typeof payload.function === "object" &&
      payload.function !== null &&
      typeof (payload.function as { name?: unknown }).name === "string"
        ? ((payload.function as { name: string }).name || "").trim()
        : "");

    if (!toolName) {
      return null;
    }

    const rawArgs =
      event.args ??
      payload.args ??
      payload.arguments ??
      (typeof payload.function === "object" && payload.function !== null
        ? (payload.function as { arguments?: unknown }).arguments
        : undefined);

    const serializedArgs =
      typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
    const toolCallID =
      (typeof event.id === "string" && event.id.trim()) ||
      (typeof payload.id === "string" && payload.id.trim()) ||
      `ai-studio-tool-call-${toolCallIndex}`;

    return {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallID,
          type: "function",
          function: {
            name: toolName,
            arguments: serializedArgs,
          },
        },
      ],
    };
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const response = await this.fetch(this.getEndpoint("/api/continue/chat"), {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(this.buildRequest(messages, options)),
      signal,
    });

    let toolCallIndex = 0;
    for await (const event of streamJSON(response)) {
      const typedEvent = event as AIStudioStreamEvent;
      if (typedEvent.type === "error") {
        const errorMessage =
          typeof typedEvent.error === "string"
            ? typedEvent.error
            : typedEvent.error?.message || typedEvent.message || "AI Studio request failed";
        throw new Error(errorMessage);
      }
      if (typedEvent.type === "tool_call") {
        toolCallIndex += 1;
        const toolCallChunk = this.buildToolCallChunk(typedEvent, toolCallIndex);
        if (toolCallChunk) {
          yield toolCallChunk;
        }
        continue;
      }
      if (typedEvent.type === "content" && typeof typedEvent.delta === "string") {
        yield { role: "assistant", content: typedEvent.delta };
      }
    }
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      signal,
      options,
    )) {
      yield renderChatMessage(chunk);
    }
  }

  listModels(): Promise<string[]> {
    return Promise.resolve([this.model]);
  }
}

export default AIStudio;