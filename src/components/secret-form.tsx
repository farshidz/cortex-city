"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SecretKind, SecretMetadata } from "@/lib/types";

export interface SecretFormValues {
  name: string;
  kind: SecretKind;
  description: string;
  // Blank when replacing only the description or type of an existing secret.
  value?: string;
}

export const SECRET_KIND_LABELS: Record<SecretKind, string> = {
  env: "Env var",
  file: "File",
};

/**
 * Add or replace a write-only secret. With `existing`, the name is fixed and
 * a blank value keeps the stored one.
 */
export function SecretForm({
  idPrefix,
  existing,
  submitLabel,
  onSave,
  onCancel,
}: {
  idPrefix: string;
  existing?: SecretMetadata;
  submitLabel: string;
  onSave: (values: SecretFormValues) => Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<SecretKind>(existing?.kind ?? "env");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        kind,
        description,
        ...(value ? { value } : {}),
      });
      if (!existing) {
        setName("");
        setKind("env");
        setDescription("");
      }
      setValue("");
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't save the secret.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-lg border p-3"
      aria-label={existing ? `Replace ${existing.name}` : submitLabel}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem]">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name (env var)</Label>
          <Input
            id={`${idPrefix}-name`}
            className="font-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="GITHUB_TOKEN"
            spellCheck={false}
            autoComplete="off"
            readOnly={Boolean(existing)}
            aria-describedby={`${idPrefix}-name-help`}
            required
          />
          <p id={`${idPrefix}-name-help`} className="text-xs text-muted-foreground">
            Uppercase letters, digits and underscores.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-kind`}>Type</Label>
          <Select
            value={kind}
            onValueChange={(next) => next && setKind(next === "file" ? "file" : "env")}
          >
            <SelectTrigger id={`${idPrefix}-kind`} className="w-full">
              <SelectValue>{SECRET_KIND_LABELS[kind]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="env">{SECRET_KIND_LABELS.env}</SelectItem>
              <SelectItem value="file">{SECRET_KIND_LABELS.file}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-description`}>Description (shown to the agent)</Label>
        <Input
          id={`${idPrefix}-description`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Read-only token for the acme/widget repository"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-value`}>Value</Label>
        <Input
          id={`${idPrefix}-value`}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={existing ? "Leave blank to keep the current value" : ""}
          required={!existing}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving || !name.trim() || (!existing && !value)}>
          {saving ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
