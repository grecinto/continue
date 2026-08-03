import { ToolImpl } from ".";
import { formatRangeInFileItems, getLocationArg } from "./ideDiagnosticsShared";

export const gotoTypeDefinitionImpl: ToolImpl = async (args, extras) => {
  const location = await getLocationArg(args, extras);
  const definitions = await extras.ide.gotoTypeDefinition(location);
  return formatRangeInFileItems("Type definition", definitions, extras);
};