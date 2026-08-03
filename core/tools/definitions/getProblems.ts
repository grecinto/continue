import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const getProblemsTool: Tool = {
  type: "function",
  displayTitle: "Get Problems",
  wouldLikeTo: "inspect IDE problems{{#filepath}} in {{{ filepath }}}{{/filepath}}",
  isCurrently: "inspecting IDE problems{{#filepath}} in {{{ filepath }}}{{/filepath}}",
  hasAlready: "inspected IDE problems{{#filepath}} in {{{ filepath }}}{{/filepath}}",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GetProblems,
    description:
      "Get IDE diagnostics for a file. If filepath is omitted, uses the currently open file.",
    parameters: {
      type: "object",
      properties: {
        filepath: {
          type: "string",
          description:
            "Optional file path. Can be relative to the workspace, absolute, tilde-based, or a file:// URI.",
        },
      },
    },
  },
  systemMessageDescription: {
    prefix: `To inspect IDE diagnostics for a file, use the ${BuiltInToolNames.GetProblems} tool. If you omit filepath, it will use the current file.`,
    exampleArgs: [["filepath", "src/app.ts"]],
  },
  defaultToolPolicy: "allowedWithPermission",
  toolCallIcon: "ExclamationTriangleIcon",
};