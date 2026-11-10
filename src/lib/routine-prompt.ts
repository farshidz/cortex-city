import type { ResolvedSecret } from "./secret-store";
import type { Routine } from "./types";

/** Structured report every routine run ends with (strict for Codex). */
export const ROUTINE_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "artifacts", "slack_messages"],
  properties: {
    status: {
      type: "string",
      enum: ["completed", "needs_attention", "failed"],
      description:
        "completed: the job is done. needs_attention: done, but something needs a human's attention. failed: the job could not be done.",
    },
    summary: {
      type: "string",
      description: "A few sentences on what this run found or did.",
    },
    artifacts: {
      type: "array",
      description:
        "Files you saved in the output directory, with a human title. Mark at most one as the main report.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "title", "main"],
        properties: {
          path: { type: "string", description: "Path relative to the output directory" },
          title: { type: "string" },
          main: { type: "boolean" },
        },
      },
    },
    slack_messages: {
      type: "array",
      description:
        "Slack messages for Cortex City to send after the run. Leave empty unless the job asks for a message.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "text", "attachments"],
        properties: {
          channel: { type: "string", description: "Channel name such as #eng" },
          text: { type: "string", description: "Message text (Slack mrkdwn)" },
          attachments: {
            type: "array",
            description: "Artifact paths (relative to the output directory) to attach",
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export interface ParsedRoutineReport {
  status: "completed" | "needs_attention" | "failed";
  summary: string;
  artifacts: { path: string; title: string; main: boolean }[];
  slack_messages: { channel: string; text: string; attachments: string[] }[];
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to a fenced or embedded object.
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Fall through.
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Validates a structured report (object or JSON text). Lenient on extras. */
export function parseRoutineReport(value: unknown): ParsedRoutineReport | undefined {
  const raw = typeof value === "string" ? extractJsonObject(value) : value;
  if (!raw || typeof raw !== "object") return undefined;
  const report = raw as Record<string, unknown>;
  const status = report.status;
  if (status !== "completed" && status !== "needs_attention" && status !== "failed") {
    return undefined;
  }
  if (typeof report.summary !== "string") return undefined;
  const artifacts = Array.isArray(report.artifacts)
    ? report.artifacts.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.path !== "string" || !entry.path.trim()) return [];
        return [
          {
            path: entry.path.trim(),
            title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : entry.path.trim(),
            main: entry.main === true,
          },
        ];
      })
    : [];
  const slack_messages = Array.isArray(report.slack_messages)
    ? report.slack_messages.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.channel !== "string" || typeof entry.text !== "string") return [];
        if (!entry.channel.trim() || !entry.text.trim()) return [];
        return [
          {
            channel: entry.channel.trim(),
            text: entry.text,
            attachments: Array.isArray(entry.attachments)
              ? entry.attachments.filter((path): path is string => typeof path === "string" && Boolean(path.trim()))
              : [],
          },
        ];
      })
    : [];
  return { status, summary: report.summary, artifacts, slack_messages };
}

function describeSecrets(secrets: ResolvedSecret[]): string {
  if (secrets.length === 0) return "No secrets are configured for this routine.";
  return secrets
    .map((secret) => {
      const description = secret.description ? ` — ${secret.description}` : "";
      const kind =
        secret.kind === "file"
          ? " (a file: the variable holds the path to a file containing the value)"
          : "";
      return `- \`${secret.name}\`${kind}${description}`;
    })
    .join("\n");
}

export function buildRoutinePrompt(
  routine: Pick<Routine, "name" | "prompt" | "slack">,
  options: { outputDir: string; secrets: ResolvedSecret[]; runNumber: number; now?: Date }
): string {
  const now = options.now ?? new Date();
  const channels = routine.slack.allowed_channels.length
    ? routine.slack.allowed_channels.map((c) => (/^[CG][A-Z0-9]{6,}$/.test(c) ? c : `#${c}`)).join(", ")
    : "none";
  return `You are running a scheduled Cortex City routine named "${routine.name}" (run #${options.runNumber}, started ${now.toISOString()}). Nobody is watching this run, so do not ask questions: make reasonable assumptions and note them in your summary.

## Where to put your output
Save every deliverable (HTML reports, CSV, images, Markdown and so on) in the output directory:
${options.outputDir}
The path is also in the CORTEX_OUTPUT_DIR environment variable. Files saved anywhere else are discarded when the run ends. HTML reports must be fully self-contained: inline all CSS, JavaScript, data, images (as data: URIs) and fonts. Reports are viewed with all network access blocked, so anything loaded from a URL (CDN scripts, web fonts, remote images) will not appear.

## Secrets
These environment variables are available. Use them, but never print, log or write their values anywhere, including your output files and messages.
${describeSecrets(options.secrets)}

## Slack
Do not call Slack yourself. To send a message, add it to slack_messages in your final report and Cortex City sends it after the run. Allowed channels: ${channels}. Messages to any other channel are refused.

## Finishing
End with the structured report: status, a short summary, the artifacts you saved (with a title each; mark the main report with main=true), and any Slack messages.

## The job
${routine.prompt}
`;
}
