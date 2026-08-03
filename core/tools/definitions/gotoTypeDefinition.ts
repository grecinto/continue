import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const gotoTypeDefinitionTool: Tool = {
  type: "function",
  displayTitle: "Go To Type Definition",
  wouldLikeTo:
    "go to the type definition at {{{ filepath }}}:{{{ line }}}:{{{ character }}}",
  isCurrently:
    "going to the type definition at {{{ filepath }}}:{{{ line }}}:{{{ character }}}",
  hasAlready:
    "went to the type definition at {{{ filepath }}}:{{{ line }}}:{{{ character }}}",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GotoTypeDefinition,
    description:
      "Resolve type definitions from an IDE location. Line and character are zero-based.",
    parameters: {
      type: "object",
      required: ["filepath", "line", "character"],
      properties: {
        filepath: {
          type: "string",
          description:
            "The file containing the symbol reference. Supports relative, absolute, tilde, or file:// paths.",
        },
        line: {
          type: "number",
          description: "Zero-based line number of the symbol reference.",
        },
        character: {
          type: "number",
          description: "Zero-based character offset of the symbol reference.",
        },
      },
    },
  },
  systemMessageDescription: {
    prefix: `To resolve symbol type definitions, use the ${BuiltInToolNames.GotoTypeDefinition} tool with a zero-based source location.`,
    exampleArgs: [
      ["filepath", "src/app.ts"],
      ["line", 12],
      ["character", 8],
    ],
  },
  defaultToolPolicy: "allowedWithPermission",
  toolCallIcon: "ArrowTopRightOnSquareIcon",
};