/**
 * This is the entry point for the extension.
 */

import { setupCa } from "core/util/ca";
import * as vscode from "vscode";

export { default as buildTimestamp } from "./.buildTimestamp";

declare global {
  var __continueAuthHandler:
    | ((url: string, status: number) => Promise<boolean | void> | boolean | void)
    | undefined;
}

function registerSOPAuthHandler() {
  if ((globalThis as typeof globalThis & { __continueAuthHandler?: unknown }).__continueAuthHandler) {
    return;
  }

  (globalThis as typeof globalThis & { __continueAuthHandler?: (url: string, status: number) => Promise<boolean | void> | boolean | void }).__continueAuthHandler = async (
    url: string,
    status: number,
  ) => {
    const parsedUrl = new URL(url);
    if (!["localhost", "127.0.0.1"].includes(parsedUrl.hostname)) {
      return false;
    }

    const signInUrl = new URL("/login", parsedUrl.origin);
    signInUrl.searchParams.set("return", "/app");

    const selection = await vscode.window.showWarningMessage(
      status === 403
        ? "Your SOP session was denied. Sign in again to continue."
        : "Your SOP session expired. Sign in again to continue.",
      "Sign in",
    );

    if (selection === "Sign in") {
      await vscode.env.openExternal(vscode.Uri.parse(signInUrl.toString()));
      return true;
    }

    return false;
  };
}

registerSOPAuthHandler();

async function dynamicImportAndActivate(context: vscode.ExtensionContext) {
  await setupCa();
  const { activateExtension } = await import("./activation/activate");
  return await activateExtension(context);
}

export function activate(context: vscode.ExtensionContext) {
  return dynamicImportAndActivate(context).catch((e) => {
    console.log("Error activating extension: ", e);
    vscode.window
      .showWarningMessage(
        "Error activating the Continue extension.",
        "View Logs",
        "Retry",
      )
      .then((selection) => {
        if (selection === "View Logs") {
          vscode.commands.executeCommand("continue.viewLogs");
        } else if (selection === "Retry") {
          // Reload VS Code window
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
  });
}

export function deactivate() {}
