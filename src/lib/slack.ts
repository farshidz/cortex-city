import { readFileSync } from "fs";
import path from "path";
import { deleteSecret, listSecrets, readSecretValue, setSecret } from "./secret-store";
import { normalizeChannel } from "./routine-store";

/**
 * Cortex City's own Slack connection. The bot token is stored as a system
 * secret and is never given to agents: routines ask Cortex City to send
 * messages through their structured report instead.
 */

export const SLACK_TOKEN_SECRET = "SLACK_BOT_TOKEN";
const SLACK_API = "https://slack.com/api";
// Slack calls run inside the worker poll; never let one hang it.
const SLACK_API_TIMEOUT_MS = 30_000;
const SLACK_UPLOAD_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackError";
  }
}

export interface SlackConnection {
  connected: boolean;
  description?: string;
  updated_at?: string;
}

export function getSlackConnection(): SlackConnection {
  const secret = listSecrets({ kind: "system" }).find((entry) => entry.name === SLACK_TOKEN_SECRET);
  if (!secret) return { connected: false };
  return { connected: true, description: secret.description, updated_at: secret.updated_at };
}

export function getSlackToken(): string | undefined {
  return readSecretValue({ kind: "system" }, SLACK_TOKEN_SECRET);
}

async function callSlack(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  body: Record<string, unknown> | URLSearchParams,
  { form = false }: { form?: boolean } = {}
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: form ? (body as URLSearchParams).toString() : JSON.stringify(body),
    signal: AbortSignal.timeout(SLACK_API_TIMEOUT_MS),
  });
  if (!response.ok) throw new SlackError(`Slack ${method} failed with HTTP ${response.status}`);
  const json = (await response.json()) as Record<string, unknown>;
  if (json.ok !== true) {
    const needed = typeof json.needed === "string" ? ` (the bot needs the ${json.needed} scope)` : "";
    throw new SlackError(`Slack ${method} failed: ${String(json.error ?? "unknown_error")}${needed}`);
  }
  return json;
}

export async function connectSlack(token: string, fetchImpl: FetchLike = fetch): Promise<SlackConnection> {
  const trimmed = token.trim();
  if (!trimmed.startsWith("xoxb-")) {
    throw new SlackError("Use a Slack bot token (it starts with xoxb-).");
  }
  const auth = await callSlack(fetchImpl, trimmed, "auth.test", {});
  const user = typeof auth.user === "string" ? auth.user : "bot";
  const team = typeof auth.team === "string" ? auth.team : "Slack";
  const meta = await setSecret(
    { kind: "system" },
    { name: SLACK_TOKEN_SECRET, value: trimmed, description: `Connected as @${user} in ${team}`, kind: "env" }
  );
  return { connected: true, description: meta.description, updated_at: meta.updated_at };
}

export async function disconnectSlack(): Promise<void> {
  await deleteSecret({ kind: "system" }, SLACK_TOKEN_SECRET);
}

const channelCache = new Map<string, { id: string; at: number }>();
const CHANNEL_CACHE_MS = 10 * 60 * 1000;

export async function resolveChannelId(
  token: string,
  channel: string,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const normalized = normalizeChannel(channel);
  if (/^[CG][A-Z0-9]{6,}$/.test(normalized)) return normalized;
  const cached = channelCache.get(normalized);
  if (cached && Date.now() - cached.at < CHANNEL_CACHE_MS) return cached.id;
  let cursor = "";
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "1000",
    });
    if (cursor) params.set("cursor", cursor);
    const result = await callSlack(fetchImpl, token, "conversations.list", params, { form: true });
    const channels = Array.isArray(result.channels) ? (result.channels as { id: string; name: string }[]) : [];
    for (const entry of channels) {
      channelCache.set(entry.name.toLowerCase(), { id: entry.id, at: Date.now() });
    }
    const match = channels.find((entry) => entry.name.toLowerCase() === normalized);
    if (match) return match.id;
    const next = (result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
    if (!next) break;
    cursor = next;
  }
  throw new SlackError(`Slack channel #${normalized} not found, or the bot isn't a member of it.`);
}

export interface SlackAttachmentFile {
  filePath: string;
  title: string;
}

/**
 * Sends one message. With attachments, the files are uploaded and shared in
 * a single message carrying the text; otherwise a plain message is posted.
 */
export async function sendSlackMessage(
  token: string,
  message: { channel: string; text: string; files: SlackAttachmentFile[] },
  fetchImpl: FetchLike = fetch
): Promise<void> {
  const channelId = await resolveChannelId(token, message.channel, fetchImpl);
  if (message.files.length === 0) {
    await callSlack(fetchImpl, token, "chat.postMessage", {
      channel: channelId,
      text: message.text,
      unfurl_links: false,
    });
    return;
  }
  const uploaded: { id: string; title: string }[] = [];
  for (const file of message.files) {
    const data = readFileSync(file.filePath);
    const filename = path.basename(file.filePath);
    const ticket = await callSlack(
      fetchImpl,
      token,
      "files.getUploadURLExternal",
      new URLSearchParams({ filename, length: String(data.length) }),
      { form: true }
    );
    const uploadUrl = String(ticket.upload_url ?? "");
    const fileId = String(ticket.file_id ?? "");
    if (!uploadUrl || !fileId) throw new SlackError("Slack did not return an upload URL");
    const upload = await fetchImpl(uploadUrl, {
      method: "POST",
      body: new Uint8Array(data),
      signal: AbortSignal.timeout(SLACK_UPLOAD_TIMEOUT_MS),
    });
    if (!upload.ok) throw new SlackError(`Slack file upload failed with HTTP ${upload.status}`);
    uploaded.push({ id: fileId, title: file.title });
  }
  await callSlack(fetchImpl, token, "files.completeUploadExternal", {
    files: uploaded,
    channel_id: channelId,
    initial_comment: message.text,
  });
}

const USER_ID_PATTERN = /^[UW][A-Z0-9]{6,}$/;

/** Resolves a Slack member ID or a workspace email address to a user ID. */
export async function resolveUserId(
  token: string,
  target: string,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const trimmed = target.trim();
  if (USER_ID_PATTERN.test(trimmed)) return trimmed;
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    throw new SlackError("Enter your Slack email address or member ID (it starts with U).");
  }
  const result = await callSlack(
    fetchImpl,
    token,
    "users.lookupByEmail",
    new URLSearchParams({ email: trimmed }),
    { form: true }
  );
  const id = (result.user as { id?: string } | undefined)?.id;
  if (!id) throw new SlackError(`No Slack user found for ${trimmed}.`);
  return id;
}

/**
 * Sends a direct message from the bot to one person, to check the
 * connection end to end. Opens the DM first (im:write); if that scope is
 * missing, posts to the user ID, which Slack delivers to the app's DM.
 */
export async function sendSlackTestMessage(
  target: string,
  fetchImpl: FetchLike = fetch
): Promise<{ user_id: string }> {
  const token = getSlackToken();
  if (!token) throw new SlackError("Slack isn't connected. Add a bot token first.");
  const userId = await resolveUserId(token, target, fetchImpl);
  let channel = userId;
  try {
    const opened = await callSlack(fetchImpl, token, "conversations.open", { users: userId });
    const id = (opened.channel as { id?: string } | undefined)?.id;
    if (id) channel = id;
  } catch {
    // Without im:write, posting to the user ID still reaches their DM.
  }
  await callSlack(fetchImpl, token, "chat.postMessage", {
    channel,
    text: "This is a test message from Cortex City. Slack is connected, and routines can post messages through this bot.",
  });
  return { user_id: userId };
}

export const __testUtils = {
  clearChannelCache: () => channelCache.clear(),
};
