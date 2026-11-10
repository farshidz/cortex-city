"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  AgentFields,
  agentPayload,
  apiRequest,
  errorMessage,
  ScheduleFields,
  useBrowserTimezone,
  type AgentFormValue,
  type RoutineSummary,
} from "../routine-ui";

export default function NewRoutinePage() {
  const router = useRouter();
  const browserTimezone = useBrowserTimezone();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezoneInput, setTimezone] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentFormValue>({
    agent_runner: "",
    model: "",
    effort: "",
    timeout_minutes: "",
  });
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const timezone = timezoneInput ?? (browserTimezone || "UTC");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const routine = await apiRequest<RoutineSummary>("/api/routines", "POST", {
        name,
        prompt,
        cron,
        timezone,
        enabled,
        ...agentPayload(agent),
      });
      router.push(`/routines/${routine.id}`);
    } catch (err) {
      setError(errorMessage(err, "Couldn't create the routine."));
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
        <Link href="/routines" className="hover:underline">
          Routines
        </Link>{" "}
        / <span aria-current="page">New routine</span>
      </nav>
      <h1 className="text-2xl font-bold">New routine</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>What it does</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="routine-name">Name</Label>
              <Input
                id="routine-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Weekly dependency report"
                maxLength={200}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="routine-prompt">Prompt</Label>
              <Textarea
                id="routine-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={10}
                placeholder="Check our open pull requests and write a short HTML report of the ones waiting longest for review."
                aria-describedby="routine-prompt-help"
                required
              />
              <p id="routine-prompt-help" className="text-xs text-muted-foreground">
                The whole job, in plain text. Cortex City adds where to save files
                and how to report back.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <ScheduleFields
              idPrefix="routine-schedule"
              cron={cron}
              timezone={timezone}
              onCronChange={setCron}
              onTimezoneChange={setTimezone}
              paused={!enabled}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Agent</CardTitle>
          </CardHeader>
          <CardContent>
            <AgentFields idPrefix="routine-agent" value={agent} onChange={setAgent} />
          </CardContent>
        </Card>

        <div className="flex items-center gap-2">
          <Switch
            id="routine-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-labelledby="routine-enabled-label"
          />
          <Label id="routine-enabled-label" htmlFor="routine-enabled">
            Enabled
          </Label>
          <span className="text-xs text-muted-foreground">
            {enabled ? "Runs on its schedule." : "Only runs when you click Run now."}
          </span>
        </div>

        <p className="text-sm text-muted-foreground">
          You can add secrets and Slack channels on the routine&apos;s page after you
          create it.
        </p>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={submitting || !name.trim() || !prompt.trim()}>
            {submitting ? "Creating…" : "Create routine"}
          </Button>
          <Button type="button" variant="outline" onClick={() => router.push("/routines")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
