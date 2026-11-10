"use client";

import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { SECRET_KIND_LABELS, SecretForm, type SecretFormValues } from "@/components/secret-form";
import type { SecretMetadata } from "@/lib/types";
import styles from "./settings.module.css";

interface GlobalSecret extends SecretMetadata {
  used_by: { id: string; name: string; overridden: boolean }[];
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

async function request(url: string, method: string, body?: unknown) {
  const response = await fetch(url, {
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

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function SecretsSection() {
  const { data, error: loadError, mutate } = useSWR<GlobalSecret[]>("/api/secrets", fetcher);
  const secrets = Array.isArray(data) ? data : undefined;
  const [replacing, setReplacing] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function save(values: SecretFormValues) {
    await request("/api/secrets", "PUT", values);
    setReplacing(null);
    await mutate();
  }

  async function remove(secret: GlobalSecret) {
    const usedBy = secret.used_by.map((routine) => routine.name);
    const warning = usedBy.length
      ? `\n\nThese routines use it and won't get it anymore: ${usedBy.join(", ")}.`
      : "";
    if (!confirm(`Delete the global secret ${secret.name}?${warning}`)) return;
    setError("");
    try {
      await request(`/api/secrets?name=${encodeURIComponent(secret.name)}`, "DELETE");
      await mutate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete the secret.");
    }
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          Couldn&apos;t load secrets.
        </p>
      )}
      <div className={styles.tableScroll}>
        <table className={styles.tiers}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th>Type</th>
              <th>Used by</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {secrets?.map((secret) => (
              <tr key={secret.name}>
                <td className="font-mono">{secret.name}</td>
                <td>{secret.description || <span className="text-muted-foreground">—</span>}</td>
                <td>{SECRET_KIND_LABELS[secret.kind] ?? secret.kind}</td>
                <td>
                  {secret.used_by.length === 0 ? (
                    <span className="text-muted-foreground">Not used</span>
                  ) : (
                    <span title={secret.used_by.map((routine) => routine.name).join(", ")}>
                      {secret.used_by.length === 1 ? "1 routine" : `${secret.used_by.length} routines`}
                      <span className="sr-only">
                        : {secret.used_by.map((routine) => routine.name).join(", ")}
                      </span>
                    </span>
                  )}
                </td>
                <td>{formatUpdated(secret.updated_at)}</td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      aria-expanded={replacing === secret.name}
                      onClick={() => setReplacing(replacing === secret.name ? null : secret.name)}
                    >
                      Replace<span className="sr-only"> {secret.name}</span>
                    </Button>
                    <Button size="xs" variant="destructive" onClick={() => remove(secret)}>
                      Delete<span className="sr-only"> {secret.name}</span>
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {secrets && secrets.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-muted-foreground">
                  No global secrets yet.
                </td>
              </tr>
            )}
            {!secrets && !loadError && (
              <tr>
                <td colSpan={6} className="text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {secrets
        ?.filter((secret) => secret.name === replacing)
        .map((secret) => (
          <SecretForm
            key={secret.name}
            idPrefix="global-secret-replace"
            existing={secret}
            submitLabel={`Save ${secret.name}`}
            onSave={save}
            onCancel={() => setReplacing(null)}
          />
        ))}
      <div>
        <h3 className={styles.subheading}>Add a global secret</h3>
        <SecretForm idPrefix="global-secret-new" submitLabel="Add secret" onSave={save} />
      </div>
      <p className={styles.footnote}>
        Encrypted on disk, kept out of .cortex backups, and can&apos;t be viewed after
        saving. Routines only get the global secrets they tick. Secrets save as soon
        as you add them.
      </p>
    </div>
  );
}
