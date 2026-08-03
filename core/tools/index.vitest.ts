import { expect, test } from "vitest";
import { BuiltInToolNames } from "./builtIn";
import {
  getBaseToolDefinitions,
  getConfigDependentToolDefinitions,
} from "./index";

test("base tool definitions include IDE diagnostics and navigation tools", () => {
  const toolNames = getBaseToolDefinitions().map((tool) => tool.function.name);

  expect(toolNames).toContain(BuiltInToolNames.GetProblems);
  expect(toolNames).toContain(BuiltInToolNames.GotoDefinition);
  expect(toolNames).toContain(BuiltInToolNames.GotoTypeDefinition);
  expect(toolNames).toContain(BuiltInToolNames.GetReferences);
  expect(toolNames).toContain(BuiltInToolNames.GetDocumentSymbols);
  expect(toolNames).toContain(BuiltInToolNames.GetTerminalContents);
});

test("config-dependent tools still include search web", async () => {
  const tools = await getConfigDependentToolDefinitions({
    rules: [],
    enableExperimentalTools: false,
    isRemote: false,
    modelName: "",
    ide: {} as any,
  });

  const searchWebTool = tools.find(
    (tool) => tool.function.name === BuiltInToolNames.SearchWeb,
  );

  expect(searchWebTool).toBeDefined();
});