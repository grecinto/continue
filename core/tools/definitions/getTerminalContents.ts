import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const getTerminalContentsTool: Tool = {
  type: "function",
  displayTitle: "Get Terminal Contents",
  wouldLikeTo: "inspect the current terminal contents",
  isCurrently: "inspecting the current terminal contents",
  hasAlready: "inspected the current terminal contents",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GetTerminalContents,
    description: "Read the visible contents of the current integrated terminal.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  systemMessageDescription: {
    prefix: `To inspect the current terminal contents, use the ${BuiltInToolNames.GetTerminalContents} tool.`,
  },
  defaultToolPolicy: "allowedWithPermission",
  toolCallIcon: "CommandLineIcon",
};