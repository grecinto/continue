import { ToolImpl } from ".";
import { formatProblems, resolveTargetFile } from "./ideDiagnosticsShared";

export const getProblemsImpl: ToolImpl = async (args, extras) => {
  const filepath = await resolveTargetFile(args, extras);
  const problems = await extras.ide.getProblems(filepath);
  return formatProblems(problems, extras);
};