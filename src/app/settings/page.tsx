"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { OrchestratorConfig } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function SettingsPage() {
  const { data: config, mutate } = useSWR<OrchestratorConfig>(
    "/api/config",
    fetcher
  );
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<OrchestratorConfig | null>(null);

  useEffect(() => {
    if (config && !form) setForm(config);
  }, [config, form]);

  async function saveConfig() {
    if (!form) return;
    setSaving(true);
    await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    mutate();
    setSaving(false);
  }

  if (!form) return <div className="text-muted-foreground">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Orchestrator Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Orchestrator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Max Parallel Sessions</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={form.max_parallel_sessions}
              onChange={(e) =>
                setForm({
                  ...form,
                  max_parallel_sessions: parseInt(e.target.value) || 1,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Poll Interval (seconds)</Label>
            <Input
              type="number"
              min={10}
              max={600}
              value={form.poll_interval_seconds}
              onChange={(e) =>
                setForm({
                  ...form,
                  poll_interval_seconds: parseInt(e.target.value) || 30,
                })
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Permission Mode</Label>
            <Select
              value={form.permission_mode}
              onValueChange={(v) => v && setForm({ ...form, permission_mode: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bypassPermissions">
                  Bypass Permissions (fully autonomous)
                </SelectItem>
                <SelectItem value="acceptEdits">
                  Accept Edits (auto-approve edits, prompt for bash)
                </SelectItem>
                <SelectItem value="default">
                  Default (prompt for everything)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <Button onClick={saveConfig} disabled={saving}>
        {saving ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
