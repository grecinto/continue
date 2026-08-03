import { ContextItem, DocumentSymbol, Location, Range, RangeInFile } from "../..";
import { throwIfFileIsSecurityConcern } from "../../indexing/ignore";
import { getNumberArg, getOptionalStringArg, getStringArg } from "../parseArgs";
import { resolveInputPath } from "../../util/pathResolver";
import { getUriDescription, getUriPathBasename } from "../../util/uri";
import { ToolImpl } from ".";

const SYMBOL_KIND_LABELS = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
];

function formatLineAndCharacter(range: Range) {
  return `${range.start.line + 1}:${range.start.character + 1}`;
}

function getSnippet(content: string, range: Range) {
  const lines = content.split("\n");
  const startLine = Math.max(0, range.start.line - 1);
  const endLine = Math.min(lines.length, range.end.line + 2);
  return lines.slice(startLine, endLine).join("\n");
}

async function readSnippet(filepath: string, range: Range, extras: Parameters<ToolImpl>[1]) {
  throwIfFileIsSecurityConcern(filepath);
  const content = await extras.ide.readFile(filepath);
  return getSnippet(content, range);
}

async function resolveTargetFile(
  args: Record<string, unknown>,
  extras: Parameters<ToolImpl>[1],
) {
  const requestedPath = getOptionalStringArg(args, "filepath");
  if (requestedPath) {
    const resolvedPath = await resolveInputPath(extras.ide, requestedPath);
    if (!resolvedPath) {
      throw new Error(`File \"${requestedPath}\" does not exist or is not accessible.`);
    }
    return resolvedPath.uri;
  }

  const currentFile = await extras.ide.getCurrentFile();
  if (!currentFile) {
    throw new Error("No current file is open in the IDE.");
  }
  return currentFile.path;
}

export async function getLocationArg(
  args: Record<string, unknown>,
  extras: Parameters<ToolImpl>[1],
): Promise<Location> {
  const filepath = getStringArg(args, "filepath");
  const resolvedPath = await resolveInputPath(extras.ide, filepath);
  if (!resolvedPath) {
    throw new Error(`File \"${filepath}\" does not exist or is not accessible.`);
  }

  return {
    filepath: resolvedPath.uri,
    position: {
      line: getNumberArg(args, "line"),
      character: getNumberArg(args, "character"),
    },
  };
}

export async function formatRangeInFileItems(
  title: string,
  ranges: RangeInFile[],
  extras: Parameters<ToolImpl>[1],
): Promise<ContextItem[]> {
  if (ranges.length === 0) {
    return [
      {
        name: `${title}: no matches`,
        description: "",
        content: `No results returned for ${title.toLowerCase()}.`,
      },
    ];
  }

  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  return Promise.all(
    ranges.map(async (entry, index) => {
      const { relativePathOrBasename } = getUriDescription(
        entry.filepath,
        workspaceDirs,
      );
      const snippet = await readSnippet(entry.filepath, entry.range, extras);
      const location = formatLineAndCharacter(entry.range);
      return {
        name: `${title} ${index + 1}: ${getUriPathBasename(entry.filepath)}`,
        description: `${relativePathOrBasename}:${location}`,
        content: `\`\`\`${relativePathOrBasename}\n${snippet}\n\`\`\``,
        uri: {
          type: "file" as const,
          value: entry.filepath,
        },
      };
    }),
  );
}

export async function formatProblems(
  problems: { filepath: string; range: Range; message: string }[],
  extras: Parameters<ToolImpl>[1],
): Promise<ContextItem[]> {
  if (problems.length === 0) {
    return [
      {
        name: "No Problems Found",
        description: "",
        content: "There are no IDE diagnostics for the requested file.",
      },
    ];
  }

  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  return Promise.all(
    problems.map(async (problem, index) => {
      const { relativePathOrBasename } = getUriDescription(
        problem.filepath,
        workspaceDirs,
      );
      const snippet = await readSnippet(problem.filepath, problem.range, extras);
      const location = formatLineAndCharacter(problem.range);
      return {
        name: `Problem ${index + 1}: ${getUriPathBasename(problem.filepath)}`,
        description: `${relativePathOrBasename}:${location}`,
        content: `${problem.message}\n\n\`\`\`${relativePathOrBasename}\n${snippet}\n\`\`\``,
        uri: {
          type: "file" as const,
          value: problem.filepath,
        },
      };
    }),
  );
}

function formatDocumentSymbol(symbol: DocumentSymbol, depth: number): string[] {
  const indent = "  ".repeat(depth);
  const kind = SYMBOL_KIND_LABELS[symbol.kind] ?? `Kind ${symbol.kind}`;
  const suffix = symbol.detail ? ` - ${symbol.detail}` : "";
  const lines = [
    `${indent}- ${symbol.name} (${kind}) ${symbol.range.start.line + 1}:${symbol.range.start.character + 1}${suffix}`,
  ];

  for (const child of symbol.children ?? []) {
    lines.push(...formatDocumentSymbol(child, depth + 1));
  }

  return lines;
}

export async function formatDocumentSymbols(
  filepath: string,
  symbols: DocumentSymbol[],
  extras: Parameters<ToolImpl>[1],
): Promise<ContextItem[]> {
  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  const { relativePathOrBasename, last2Parts, baseName } = getUriDescription(
    filepath,
    workspaceDirs,
  );

  if (symbols.length === 0) {
    return [
      {
        name: `Symbols: ${baseName}`,
        description: last2Parts,
        content: `No document symbols were returned for ${relativePathOrBasename}.`,
        uri: {
          type: "file" as const,
          value: filepath,
        },
      },
    ];
  }

  const content = formatDocumentSymbol({
    name: baseName,
    kind: 0,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    selectionRange: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    children: symbols,
  }, 0).join("\n");

  return [
    {
      name: `Symbols: ${baseName}`,
      description: last2Parts,
      content,
      uri: {
        type: "file" as const,
        value: filepath,
      },
    },
  ];
}

export { resolveTargetFile };