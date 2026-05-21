"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MdEditor } from "@/components/md-editor";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Issue } from "@/lib/types";

export default function NewIssuePage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [plan, setPlan] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        plan: plan || undefined,
      }),
    });
    if (!res.ok) {
      setSubmitting(false);
      return;
    }
    const issue = (await res.json()) as Issue;
    router.push(`/issues/${issue.id}`);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">New Issue</h1>
      <Card>
        <CardHeader>
          <CardTitle>Create a new issue</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Login form rejects valid emails..."
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <MdEditor
                value={description}
                onChange={setDescription}
                placeholder="Describe the issue..."
                rows={4}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="plan">
                Plan{" "}
                <span className="text-muted-foreground font-normal">
                  (optional, markdown)
                </span>
              </Label>
              <MdEditor
                value={plan}
                onChange={setPlan}
                placeholder="Implementation plan..."
                rows={6}
              />
            </div>

            <div className="flex gap-2">
              <Button type="submit" disabled={submitting || !title.trim()}>
                {submitting ? "Creating..." : "Create Issue"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/issues")}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
