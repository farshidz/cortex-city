"use client";

import { useState } from "react";
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
      <p className="text-xs text-muted-foreground">
        Cortex City uses this bot to send routine messages. It&apos;s never given to
        agents. The bot needs chat:write, files:write, channels:read and groups:read,
        and must be invited to each channel.
      </p>
    </section>
  );
}
