import { useEffect, useRef, useState } from "react";
import styled from "styled-components";

import {
  AIStudioHQLoginDialogRequest,
  AIStudioHQLoginDialogResponse,
} from "core/util/aiStudioSession";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { Button } from "../ui/Button";
import TextDialog from ".";

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
`;

const Label = styled.label`
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
`;

const Input = styled.input`
  width: 100%;
  border: 1px solid var(--vscode-input-border, #3c3c3c);
  background: var(--vscode-input-background, #1e1e1e);
  color: var(--vscode-input-foreground, inherit);
  border-radius: 6px;
  padding: 9px 10px;
`;

const ErrorText = styled.p`
  margin: 0;
  color: var(--vscode-errorForeground, #f48771);
  font-size: 12px;
`;

type PendingDialogState = AIStudioHQLoginDialogRequest & {
  resolve: (value: AIStudioHQLoginDialogResponse | undefined) => void;
};

export function AIStudioHQLoginDialog() {
  const [pendingDialog, setPendingDialog] = useState<PendingDialogState | null>(null);
  const [hqBaseUrl, setHqBaseUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const firstInputRef = useRef<HTMLInputElement>(null);

  useWebviewListener(
    "sop/requestHQLogin",
    async (data) => {
      return await new Promise<AIStudioHQLoginDialogResponse | undefined>((resolve) => {
        setPendingDialog({ ...data, resolve });
        setHqBaseUrl(data.hqBaseUrl ?? "");
        setUsername(data.username ?? "");
        setPassword("");
      });
    },
    [],
  );

  useEffect(() => {
    if (pendingDialog) {
      window.setTimeout(() => firstInputRef.current?.focus(), 0);
    }
  }, [pendingDialog]);

  const closeDialog = () => {
    pendingDialog?.resolve({ cancelled: true });
    setPendingDialog(null);
    setPassword("");
  };

  const submitDialog = (event: React.FormEvent) => {
    event.preventDefault();
    pendingDialog?.resolve({
      cancelled: false,
      hqBaseUrl,
      username,
      password,
    });
    setPendingDialog(null);
    setPassword("");
  };

  const dialogBody = pendingDialog ? (
    <Form onSubmit={submitDialog}>
      <div>
        <h2 className="m-0 text-base font-semibold">Sign In To HQ</h2>
        <p className="mb-0 mt-2 text-xs text-gray-400">
          {pendingDialog.status === 403
            ? "The daemon rejected the current session. Sign in again to continue using AI Studio from Continue."
            : "Your daemon renewal expired. Sign in to HQ here so Continue can renew the local daemon session."}
        </p>
      </div>

      <Label>
        HQ Base URL
        <Input
          ref={firstInputRef}
          type="url"
          value={hqBaseUrl}
          onChange={(event) => setHqBaseUrl(event.target.value)}
          placeholder="https://northstar.example.com"
          autoComplete="url"
          required
        />
      </Label>

      <Label>
        Username
        <Input
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          required
        />
      </Label>

      <Label>
        Password
        <Input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </Label>

      {pendingDialog.errorMessage ? (
        <ErrorText>{pendingDialog.errorMessage}</ErrorText>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" onClick={closeDialog}>
          Cancel
        </Button>
        <Button type="submit">Sign In</Button>
      </div>
    </Form>
  ) : undefined;

  return (
    <TextDialog
      showDialog={Boolean(pendingDialog)}
      onClose={closeDialog}
      onEnter={() => undefined}
      message={dialogBody}
    />
  );
}
