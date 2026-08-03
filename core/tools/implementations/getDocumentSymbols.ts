import { ToolImpl } from ".";
import {
  formatDocumentSymbols,
  resolveTargetFile,
} from "./ideDiagnosticsShared";

export const getDocumentSymbolsImpl: ToolImpl = async (args, extras) => {
  const filepath = await resolveTargetFile(args, extras);
  const symbols = await extras.ide.getDocumentSymbols(filepath);
  return formatDocumentSymbols(filepath, symbols, extras);
};