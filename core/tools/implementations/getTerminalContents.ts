import { ToolImpl } from ".";

export const getTerminalContentsImpl: ToolImpl = async (_, extras) => {
  const content = await extras.ide.getTerminalContents();
  return [
    {
      name: "Terminal",
      description: "Current terminal contents",
      content: content || "The terminal is empty.",
    },
  ];
};