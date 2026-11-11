"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SlackConnection {
  connected: boolean;
  description?: string;
  updated_at?: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Shown in the setup help so the bot can be created in one step.
export const SLACK_APP_MANIFEST = `display_information:
  name: Cortex City
features:
  bot_user:
    display_name: Cortex City
    always_online: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - files:write
      - channels:read
      - groups:read
      - im:write
      - users:read
      - users:read.email
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

const TEST_TARGET_STORAGE_KEY = "cortex-city.slack-test-target";

function readStoredTarget(): string {
  try {
    return window.localStorage.getItem(TEST_TARGET_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeTarget(target: string): void {
  try {
    window.localStorage.setItem(TEST_TARGET_STORAGE_KEY, target);
  } catch {
    // Remembering the address is a convenience only.
  }
}

function SlackSetupHelp() {
  const [copied, setCopied] = useState<"" | "copied" | "failed">("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(SLACK_APP_MANIFEST);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <details className="rounded-md border bg-muted/30 p-3 text-sm">
      <summary className="cursor-pointer font-medium">How to create the Slack bot</summary>
      <ol className="mt-3 list-decimal space-y-1 pl-5">
        <li>
          Go to{" "}
          <a
            href="https://api.slack.com/apps"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            api.slack.com/apps
          </a>
          , click <strong>Create New App</strong>, choose <strong>From a manifest</strong> and
          pick your workspace.
        </li>
        <li>Paste the manifest below and click <strong>Create</strong>.</li>
        <li>
          Click <strong>Install to Workspace</strong>. A workspace admin may need to approve it.
        </li>
        <li>
          Under <strong>OAuth &amp; Permissions</strong>, copy the <strong>Bot User OAuth
          Token</strong> (it starts with xoxb-) and paste it above.
        </li>
        <li>
          In each channel a routine posts to, run <code className="font-mono">/invite @Cortex City</code>.
        </li>
      </ol>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">App manifest (YAML)</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          {copied === "copied" ? "Copied" : "Copy manifest"}
        </Button>
      </div>
      <pre
        aria-label="Slack app manifest"
        className="mt-2 max-h-72 overflow-auto rounded-md border bg-background p-3 font-mono text-xs"
      >
        {SLACK_APP_MANIFEST}
      </pre>
      {copied === "failed" && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          Couldn&apos;t copy automatically. Select the text and copy it instead.
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Token rotation stays off: rotated tokens expire after 12 hours and Cortex City
        doesn&apos;t refresh them. The im:write and users:read scopes are only used for the
        test message.
      </p>
    </details>
  );
}

function SlackTestMessage() {
  const [target, setTarget] = useState("");
  // Read after mount so server and client render the same initial markup.
  useEffect(() => {
    const stored = readStoredTarget();
    if (stored) setTarget((current) => current || stored);
  }, []);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const value = target.trim();
    if (!value) return;
    setSending(true);
    setResult(null);
    try {
      const response = await fetch("/api/integrations/slack/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
      storeTarget(value);
      setResult({ ok: true, message: "Sent. Check your Slack direct messages from the bot." });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Couldn't send the test message." });
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={send} className="space-y-2 border-t pt-3">
      <Label htmlFor="slack-test-target">Send a test message to</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="slack-test-target"
          className="min-w-0 flex-1 basis-56"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="you@company.com or member ID (U…)"
          autoComplete="email"
          spellCheck={false}
        />
        <Button type="submit" variant="outline" disabled={sending || !target.trim()}>
          {sending ? "Sending…" : "Send test message"}
        </Button>
      </div>
      {result && (
        <p
          role={result.ok ? "status" : "alert"}
          className={`text-sm ${result.ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}
        >
          {result.message}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        The bot sends you a direct message. Your member ID is in your Slack profile under
        ⋯ → Copy member ID.
      </p>
    </form>
  );
}

async function request(method: string, body?: unknown): Promise<SlackConnection> {
  const response = await fetch("/api/integrations/slack", {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return data;
}

export function IntegrationsSection() {
  const { data: slack, mutate } = useSWR<SlackConnection>("/api/integrations/slack", fetcher);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<SlackConnection>) {
    setBusy(true);
    setError("");
    try {
      const updated = await action();
      await mutate(updated, { revalidate: false });
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update Slack.");
    } finally {
      setBusy(false);
    }
  }

  function connect(event: React.FormEvent) {
    event.preventDefault();
    if (!token.trim()) return;
    void run(() => request("PUT", { token: token.trim() }));
  }

  function disconnect() {
    if (!confirm("Disconnect Slack? Routines won't be able to post messages until you connect it again.")) {
      return;
    }
    void run(() => request("DELETE"));
  }

  const connected = slack?.connected === true;

  return (
    <section aria-labelledby="slack-heading" className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="slack-heading" className="text-base font-semibold">
          Slack
        </h3>
        {connected && (
          <Button size="sm" variant="destructive" onClick={disconnect} disabled={busy}>
            Disconnect
          </Button>
        )}
      </div>
      <p role="status" className="text-sm">
        {!slack ? (
          <span className="text-muted-foreground">Checking connection…</span>
        ) : connected ? (
          <>
            <span className="font-medium text-green-700 dark:text-green-400">Connected</span>
            {slack.description ? ` · ${slack.description}` : ""}
            {slack.updated_at ? (
              <span className="text-muted-foreground">
                {` · since ${new Date(slack.updated_at).toLocaleDateString()}`}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">Not connected</span>
        )}
      </p>
      <form onSubmit={connect} className="space-y-2">
        <Label htmlFor="slack-token">{connected ? "New bot token" : "Bot token"}</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="slack-token"
            type="password"
            className="min-w-0 flex-1 basis-56 font-mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="xoxb-…"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={busy || !token.trim()}>
            {busy ? "Saving…" : connected ? "Replace bot token" : "Connect"}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {connected && <SlackTestMessage />}
      <p className="text-xs text-muted-foreground">
        Cortex City uses this bot to send routine messages. It&apos;s never given to
        agents, and it must be invited to each channel a routine posts to.
      </p>
      <SlackSetupHelp />
    </section>
  );
}
