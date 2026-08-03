import { Tool } from "../..";
import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const getReferencesTool: Tool = {
  type: "function",
  displayTitle: "Get References",
  wouldLikeTo:
    "find references from {{{ filepath }}}:{{{ line }}}:{{{ character }}}",
  isCurrently:
    "finding references from {{{ filepath }}}:{{{ line }}}:{{{ character }}}",
  hasAlready:
    "found references from {{{ filepath }}}:{{{ line }}}:{{{ character }}}",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.GetReferences,
    description:
      "Find references for a symbol from an IDE location. Line and character are zero-based.",
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
    prefix: `To find references for a symbol, use the ${BuiltInToolNames.GetReferences} tool with a zero-based source location.`,
    exampleArgs: [
      ["filepath", "src/app.ts"],
      ["line", 12],
      ["character", 8],
    ],
  },
  defaultToolPolicy: "allowedWithPermission",
  toolCallIcon: "MagnifyingGlassIcon",
};