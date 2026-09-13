import { streamJSON } from "@continuedev/fetch";

import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { serializeTool } from "../../tools/index.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { getAIStudioContinueSession } from "../../util/aiStudioSession.js";
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

type AIStudioSupportedModelGroup = {
  label?: string;
  options?: Array<{
    value?: string;
    label?: string;
  }>;
};

type AIStudioMetadataResponse = {
  control_model?: {
    supported_llms?: AIStudioSupportedModelGroup[];
  };
};

class AIStudio extends BaseLLM {
  static providerName = "ai-studio";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://127.0.0.1:9090/",
    model: "daemon-controller",
  };

  get underlyingProviderName(): string {
    const rawProvider = this.requestOptions?.extraBodyProperties?.provider;
    return typeof rawProvider === "string" && rawProvider.trim().length > 0
      ? rawProvider.trim().toLowerCase()
      : this.providerName;
  }

  private getEndpoint(path: string): string {
    const base = this.apiBase ?? AIStudio.defaultOptions.apiBase!;
    return new URL(path.replace(/^\//, ""), base).toString();
  }

  private getRequestBodyOverrides(): Record<string, any> {
    return this.requestOptions?.extraBodyProperties ?? {};
  }

  private resolveDelegatedProvider(overrides: Record<string, any>): string | undefined {
    const rawProvider =
      typeof overrides.provider === "string" ? overrides.provider.trim() : "";
    if (!rawProvider) {
      return undefined;
    }

    return rawProvider.toLowerCase();
  }

  private getRequestedModel(options: CompletionOptions): string {
    return typeof options.model === "string" && options.model.trim()
      ? options.model.trim()
      : this.model;
  }

  private getStringOverride(overrides: Record<string, any>, key: string): string | undefined {
    const value = overrides[key];
    if (typeof value !== "string") {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  private getStringArrayOverride(overrides: Record<string, any>, key: string): string[] | undefined {
    const value = overrides[key];
    if (!Array.isArray(value)) {
      return undefined;
    }

    const entries = value
      .filter((item: unknown): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return entries.length > 0 ? entries : undefined;
  }

  private getSupportedModelsEndpoint(): string {
    return this.getEndpoint("/api/continue/metadata");
  }

  private async validateDelegatedModelAgainstCatalog(
    delegatedProvider: string,
    delegatedModel: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await this.fetch(this.getSupportedModelsEndpoint(), {
      method: "GET",
      headers: this.getHeaders(),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `AI Studio metadata request failed with status ${response.status}`,
      );
    }

    const metadata = (await response.json()) as AIStudioMetadataResponse;
    const supportedGroups = metadata.control_model?.supported_llms;
    if (!Array.isArray(supportedGroups)) {
      throw new Error(
        "AI Studio metadata does not advertise supported LLMs for Continue routing",
      );
    }

    const requestedPair = `${delegatedProvider}:${delegatedModel}`;
    const supportedValues = new Set(
      supportedGroups.flatMap((group) =>
        Array.isArray(group.options)
          ? group.options
              .map((option) =>
                typeof option.value === "string" ? option.value.trim() : "",
              )
              .filter((value) => value.length > 0)
          : [],
      ),
    );

    if (!supportedValues.has(requestedPair)) {
      throw new Error(
        `AI Studio daemon does not advertise support for ${requestedPair}`,
      );
    }
  }

  private getSessionID(): string {
    return this.uniqueId && this.uniqueId !== "None"
      ? this.uniqueId
      : `ai-studio-${this.model}`;
  }

  private getHeaders(): Record<string, string> {
    const headers = {
      ...(this.requestOptions?.headers ?? {}),
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    } as Record<string, string>;
    if (!headers.Authorization && !headers.authorization) {
      const session = getAIStudioContinueSession();
      if (session?.daemonAccessToken) {
        headers.Authorization = `Bearer ${session.daemonAccessToken}`;
      }
    }
    return headers;
  }

  private buildPrompt(messages: ChatMessage[]): string {
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");

    if (latestUserMessage) {
      return renderChatMessage(latestUserMessage);
    }

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
    const session = getAIStudioContinueSession();
    const delegatedProvider = this.resolveDelegatedProvider(overrides);
    const delegatedModel = this.getRequestedModel(options);
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
      model: delegatedModel,
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

    if (delegatedProvider) {
      requestBody.provider = delegatedProvider;
    }
    const requestID = this.getStringOverride(overrides, "request_id");
    if (requestID) {
      requestBody.request_id = requestID;
    }
    const rootRequestID = this.getStringOverride(overrides, "root_request_id");
    if (rootRequestID) {
      requestBody.root_request_id = rootRequestID;
    }
    const requestedPhase = this.getStringOverride(overrides, "requested_phase");
    if (requestedPhase) {
      requestBody.requested_phase = requestedPhase;
    }
    const workflowProfile = this.getStringOverride(overrides, "workflow_profile");
    if (workflowProfile) {
      requestBody.workflow_profile = workflowProfile;
    }
    const taskType = this.getStringOverride(overrides, "task_type");
    if (taskType) {
      requestBody.task_type = taskType;
    }
    const allowedTools = this.getStringArrayOverride(overrides, "allowed_tools");
    if (allowedTools) {
      requestBody.allowed_tools = allowedTools;
    }
    if (overrides.result_contract && typeof overrides.result_contract === "object") {
      requestBody.result_contract = overrides.result_contract;
    }
    if (overrides.guidance && typeof overrides.guidance === "object") {
      requestBody.guidance = overrides.guidance;
    }
    if (this.apiKey) {
      requestBody.api_key = this.apiKey;
    }
    if (typeof overrides.url === "string" && overrides.url.trim()) {
      requestBody.url = overrides.url.trim();
    }
    if (session?.hqAccessToken) {
      requestBody.auth = {
        access_token: session.hqAccessToken,
        refresh_token: session.hqRefreshToken,
      };
    }
    if (session?.hqBaseUrl || session?.hqUserID || session?.hqSessionID) {
      requestBody.hq = {
        base_url: session.hqBaseUrl,
        user_id: session.hqUserID,
        session_id: session.hqSessionID,
      };
    }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      requestBody.tools = options.tools.map((tool) => serializeTool(tool));
    }
    if (options.toolChoice) {
      requestBody.tool_choice = options.toolChoice;
    }

    return requestBody;
  }

  private async fetchChatResponse(
    requestBody: Record<string, any>,
    signal: AbortSignal,
    retryAttempt = 0,
  ): Promise<Response> {
    if (
      typeof requestBody.provider === "string" &&
      typeof requestBody.model === "string"
    ) {
      await this.validateDelegatedModelAgainstCatalog(
        requestBody.provider,
        requestBody.model,
        signal,
      );
    }

    const endpoint = this.getEndpoint("/api/continue/chat");
    const response = await this.fetch(endpoint, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(requestBody),
      signal,
    });

    const authHandler = (globalThis as typeof globalThis & {
      __continueAuthHandler?: (url: string, status: number) => Promise<boolean | void> | boolean | void;
    }).__continueAuthHandler;
    if (
      retryAttempt === 0 &&
      authHandler &&
      [401, 403].includes(response.status)
    ) {
      const shouldRetry = (await authHandler(endpoint, response.status)) ?? false;
      if (shouldRetry) {
        return this.fetchChatResponse(requestBody, signal, retryAttempt + 1);
      }
    }

    if (!response.ok) {
      let message = `AI Studio request failed with status ${response.status}`;
      try {
        const body = await response.text();
        if (body.trim()) {
          message = body;
        }
      } catch {
        // Ignore body parsing failure and fall back to status message.
      }
      throw new Error(message);
    }

    return response;
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

  private buildExecutionResultChunk(event: AIStudioStreamEvent): ChatMessage | null {
    const payload = event.payload ?? {};
    const result = payload.result as Record<string, unknown> | undefined;
    if (!result) {
      return null;
    }

    const summary =
      (typeof result.summary === "string" && result.summary.trim()) ||
      (typeof event.message === "string" && event.message.trim()) ||
      "";

    const modifiedFiles = Array.isArray(result.modified_files)
      ? result.modified_files.filter((file): file is Record<string, unknown> => !!file && typeof file === "object")
      : [];
    const fileLines = modifiedFiles.map((file) => {
      const filePath = typeof file.file_path === "string" ? file.file_path.trim() : "";
      const diffSummary = typeof file.diff_summary === "string" ? file.diff_summary.trim() : "";
      const changeId = typeof file.change_id === "string" ? file.change_id.trim() : "";
      const undoRef = typeof file.undo_ref === "string" ? file.undo_ref.trim() : "";
      const parts = [filePath || "modified file"];
      if (diffSummary) {
        parts.push(diffSummary);
      }
      if (changeId) {
        parts.push(`change=${changeId}`);
      }
      if (undoRef) {
        parts.push(`undo=${undoRef}`);
      }
      return parts.join(" • ");
    });

    const artifactLines = Array.isArray(result.artifacts)
      ? result.artifacts
          .map((artifact) => {
            if (!artifact || typeof artifact !== "object") {
              return "";
            }
            const entry = artifact as Record<string, unknown>;
            const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
            const path = typeof entry.path === "string" ? entry.path.trim() : "";
            return kind || path ? `${kind || "artifact"}${path ? `: ${path}` : ""}` : "";
          })
          .filter((line) => line.length > 0)
      : [];

    const sections: string[] = [];
    if (summary) {
      sections.push(summary);
    }
    if (fileLines.length > 0) {
      sections.push(`Modified files:\n${fileLines.map((line) => `- ${line}`).join("\n")}`);
    }
    if (artifactLines.length > 0) {
      sections.push(`Artifacts:\n${artifactLines.map((line) => `- ${line}`).join("\n")}`);
    }
    if (sections.length === 0) {
      return null;
    }

    return {
      role: "assistant",
      content: sections.join("\n\n"),
    };
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    const response = await this.fetchChatResponse(
      this.buildRequest(messages, options),
      signal,
    );

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
      if (typedEvent.type === "continue_progress" && typeof typedEvent.message === "string") {
        const message = typedEvent.message.trim();
        if (message) {
          yield { role: "assistant", content: message };
        }
        continue;
      }
      if (typedEvent.type === "continue_modified_file") {
        const payload = typedEvent.payload ?? {};
        const file = payload.file as Record<string, unknown> | undefined;
        const summary =
          (file && typeof file.diff_summary === "string" && file.diff_summary.trim()) ||
          (typeof typedEvent.message === "string" && typedEvent.message.trim()) ||
          "";
        if (summary) {
          const filePath = file && typeof file.file_path === "string" ? file.file_path.trim() : "";
          const changeId = file && typeof file.change_id === "string" ? file.change_id.trim() : "";
          const undoRef = file && typeof file.undo_ref === "string" ? file.undo_ref.trim() : "";
          const parts = [summary];
          if (filePath) {
            parts.unshift(filePath);
          }
          if (changeId) {
            parts.push(`change=${changeId}`);
          }
          if (undoRef) {
            parts.push(`undo=${undoRef}`);
          }
          yield { role: "assistant", content: parts.join(" • ") };
        }
        continue;
      }
      if (typedEvent.type === "done") {
        const executionResultChunk = this.buildExecutionResultChunk(typedEvent);
        if (executionResultChunk) {
          yield executionResultChunk;
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