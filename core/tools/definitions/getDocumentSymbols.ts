import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const getDocumentSymbolsTool: Tool = {
  type: "function",
  displayTitle: "Get Document Symbols",
  wouldLikeTo:
    "inspect document symbols{{#filepath}} in {{{ filepath }}}{{/filepath}}",
  isCurrently:
    "inspecting document symbols{{#filepath}} in {{{ filepath }}}{{/filepath}}",
  hasAlready:
    "inspected document symbols{{#filepath}} in {{{ filepath }}}{{/filepath}}",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GetDocumentSymbols,
    description:
      "List the IDE document symbols for a file. If filepath is omitted, uses the currently open file.",
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
    prefix: `To inspect document symbols for a file, use the ${BuiltInToolNames.GetDocumentSymbols} tool. If you omit filepath, it will use the current file.`,
    exampleArgs: [["filepath", "src/app.ts"]],
  },
  defaultToolPolicy: "allowedWithPermission",
  toolCallIcon: "ListBulletIcon",
};