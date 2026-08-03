import { ToolImpl } from ".";
import { formatRangeInFileItems, getLocationArg } from "./ideDiagnosticsShared";

export const getReferencesImpl: ToolImpl = async (args, extras) => {
  const location = await getLocationArg(args, extras);
  const references = await extras.ide.getReferences(location);
  return formatRangeInFileItems("Reference", references, extras);
};