import { ToolImpl } from ".";
import { formatRangeInFileItems, getLocationArg } from "./ideDiagnosticsShared";

export const gotoDefinitionImpl: ToolImpl = async (args, extras) => {
  const location = await getLocationArg(args, extras);
  const definitions = await extras.ide.gotoDefinition(location);
  return formatRangeInFileItems("Definition", definitions, extras);
};