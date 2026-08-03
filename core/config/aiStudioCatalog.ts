import { ModelRole } from "@continuedev/config-yaml";

import { ContinueConfig, ILLM, LLMOptions } from "../index.js";
import { llmFromProviderAndOptions } from "../llm/llms/index.js";
import { getAIStudioContinueSession } from "../util/aiStudioSession.js";

type AIStudioSupportedModelOption = {
  value?: string;
  label?: string;
};

type AIStudioSupportedModelGroup = {
  label?: string;
  options?: AIStudioSupportedModelOption[];
};

type AIStudioMetadataResponse = {
  control_model?: {
    supported_llms?: AIStudioSupportedModelGroup[];
  };
};

type SupportedDelegatedModel = {
  provider: string;
  model: string;
  label: string;
};

const MODEL_ROLES: ModelRole[] = [
  "chat",
  "apply",
  "edit",
  "summarize",
  "autocomplete",
  "rerank",
  "embed",
  "subagent",
];

function isAIStudioModel(model: ILLM | null | undefined): model is ILLM {
  return !!model && model.providerName === "ai-studio";
}

function getAIStudioKey(model: ILLM): string {
  return [
    model.providerName,
    model.apiBase ?? "",
    model.apiKey ?? "",
    JSON.stringify(model.requestOptions?.headers ?? {}),
  ].join("::");
}

function getMetadataEndpoint(model: ILLM): string {
  const base = model.apiBase ?? "http://127.0.0.1:9090/";
  return new URL("api/continue/metadata", base).toString();
}

function getMetadataHeaders(model: ILLM): Record<string, string> {
  const headers = {
    ...(model.requestOptions?.headers ?? {}),
  } as Record<string, string>;

  if (!headers.Authorization && !headers.authorization) {
    const session = getAIStudioContinueSession();
    if (session?.daemonAccessToken) {
      headers.Authorization = `Bearer ${session.daemonAccessToken}`;
    }
  }

  return headers;
}

async function fetchSupportedDelegatedModels(
  model: ILLM,
): Promise<SupportedDelegatedModel[]> {
  const response = await fetch(getMetadataEndpoint(model), {
    method: "GET",
    headers: getMetadataHeaders(model),
  });

  if (!response.ok) {
    throw new Error(
      `metadata request failed with status ${response.status}`,
    );
  }

  const payload = (await response.json()) as AIStudioMetadataResponse;
  const groups = payload.control_model?.supported_llms;
  if (!Array.isArray(groups)) {
    throw new Error("metadata response did not include supported_llms");
  }

  return groups.flatMap((group) => {
    if (!Array.isArray(group.options)) {
      return [];
    }

    return group.options.flatMap((option) => {
      const value = typeof option.value === "string" ? option.value.trim() : "";
      if (!value || !value.includes(":")) {
        return [];
      }

      const separatorIndex = value.indexOf(":");
      const provider = value.slice(0, separatorIndex).trim().toLowerCase();
      const delegatedModel = value.slice(separatorIndex + 1).trim();
      if (!provider || !delegatedModel) {
        return [];
      }

      return [
        {
          provider,
          model: delegatedModel,
          label:
            (typeof option.label === "string" && option.label.trim()) || value,
        },
      ];
    });
  });
}

function getRequestedDelegatedPair(model: ILLM): string | undefined {
  const provider =
    typeof model.requestOptions?.extraBodyProperties?.provider === "string"
      ? model.requestOptions.extraBodyProperties.provider.trim().toLowerCase()
      : "";
  const delegatedModel = typeof model.model === "string" ? model.model.trim() : "";
  if (!provider || !delegatedModel) {
    return undefined;
  }
  return `${provider}:${delegatedModel}`;
}

function resolveUniqueTitle(label: string, usedTitles: Set<string>): string {
  if (!usedTitles.has(label)) {
    usedTitles.add(label);
    return label;
  }

  const base = `${label} (AI Studio)`;
  if (!usedTitles.has(base)) {
    usedTitles.add(base);
    return base;
  }

  let suffix = 2;
  while (usedTitles.has(`${base} ${suffix}`)) {
    suffix += 1;
  }
  const resolved = `${base} ${suffix}`;
  usedTitles.add(resolved);
  return resolved;
}

function cloneAIStudioModel(
  baseModel: ILLM,
  delegated: SupportedDelegatedModel,
  title: string,
): ILLM {
  const requestOptions = {
    ...(baseModel.requestOptions ?? {}),
    extraBodyProperties: {
      ...(baseModel.requestOptions?.extraBodyProperties ?? {}),
      provider: delegated.provider,
    },
  };

  const options: LLMOptions = {
    uniqueId: `${baseModel.uniqueId}::${delegated.provider}:${delegated.model}`,
    title,
    model: delegated.model,
    apiKey: baseModel.apiKey,
    apiBase: baseModel.apiBase,
    contextLength: baseModel.contextLength,
    maxStopWords: baseModel.maxStopWords,
    template: baseModel.template,
    completionOptions: {
      ...baseModel.completionOptions,
      model: delegated.model,
    },
    requestOptions,
    promptTemplates: baseModel.promptTemplates,
    cacheBehavior: baseModel.cacheBehavior,
    capabilities: baseModel.capabilities,
    roles: baseModel.roles,
    baseAgentSystemMessage: baseModel.baseAgentSystemMessage,
    basePlanSystemMessage: baseModel.basePlanSystemMessage,
    baseChatSystemMessage: baseModel.baseChatSystemMessage,
    apiKeyLocation: baseModel.apiKeyLocation,
    envSecretLocations: baseModel.envSecretLocations,
    onPremProxyUrl: baseModel.onPremProxyUrl,
    deployment: baseModel.deployment,
    apiVersion: baseModel.apiVersion,
    apiType: baseModel.apiType,
    region: baseModel.region,
    projectId: baseModel.projectId,
    accountId: baseModel.accountId,
    aiGatewaySlug: baseModel.aiGatewaySlug,
    profile: baseModel.profile,
    accessKeyId: baseModel.accessKeyId,
    secretAccessKey: baseModel.secretAccessKey,
    deploymentId: baseModel.deploymentId,
    sourceFile: baseModel.sourceFile,
    isFromAutoDetect: baseModel.isFromAutoDetect,
    toolOverrides: baseModel.toolOverrides,
  };

  return llmFromProviderAndOptions("ai-studio", options);
}

export async function syncAIStudioModelsWithDaemonCatalog(
  config: ContinueConfig,
): Promise<string[]> {
  const baseModels = new Map<string, ILLM>();
  for (const role of MODEL_ROLES) {
    for (const model of config.modelsByRole[role] ?? []) {
      if (isAIStudioModel(model)) {
        baseModels.set(getAIStudioKey(model), model);
      }
    }
  }

  if (baseModels.size === 0) {
    return [];
  }

  const delegatedModelsByKey = new Map<string, SupportedDelegatedModel[]>();
  const warnings: string[] = [];

  await Promise.all(
    Array.from(baseModels.entries()).map(async ([key, model]) => {
      try {
        const delegatedModels = await fetchSupportedDelegatedModels(model);
        if (delegatedModels.length === 0) {
          warnings.push(
            "AI Studio metadata returned no supported_llms entries; using configured AI Studio models as-is.",
          );
          return;
        }
        delegatedModelsByKey.set(key, delegatedModels);
      } catch (error) {
        warnings.push(
          `AI Studio model catalog unavailable (${error instanceof Error ? error.message : "unknown error"}); using configured AI Studio models as-is.`,
        );
      }
    }),
  );

  if (delegatedModelsByKey.size === 0) {
    return warnings;
  }

  for (const role of MODEL_ROLES) {
    const roleModels = config.modelsByRole[role] ?? [];
    const usedTitles = new Set<string>();
    const nextModels: ILLM[] = [];

    for (const model of roleModels) {
      if (!isAIStudioModel(model)) {
        usedTitles.add(model.title ?? model.model);
        nextModels.push(model);
        continue;
      }

      const delegatedModels = delegatedModelsByKey.get(getAIStudioKey(model));
      if (!delegatedModels?.length) {
        usedTitles.add(model.title ?? model.model);
        nextModels.push(model);
        continue;
      }

      const replacements = delegatedModels.map((delegated) =>
        cloneAIStudioModel(
          model,
          delegated,
          resolveUniqueTitle(delegated.label, usedTitles),
        ),
      );

      nextModels.push(...replacements);

      const selectedModel = config.selectedModelByRole[role];
      if (selectedModel === model) {
        const requestedPair = getRequestedDelegatedPair(selectedModel);
        config.selectedModelByRole[role] =
          replacements.find(
            (replacement) => getRequestedDelegatedPair(replacement) === requestedPair,
          ) ?? replacements[0] ?? selectedModel;
      }
    }

    config.modelsByRole[role] = nextModels;
  }

  return warnings;
}