import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { ensureCortexDir } from "./store";
import type { SecretKind, SecretMetadata } from "./types";

/**
 * Encrypted, write-only secret storage for routines.
 *
 * Values are encrypted with AES-256-GCM. The key comes from
 * CORTEX_SECRETS_KEY when set; otherwise a random key is generated once in a
 * 0600 file outside the app directory (default
 * ~/.config/cortex-city/secrets.key), so the `.cortex` git snapshots never
 * contain anything that can decrypt the values. Callers outside the runtime
 * only ever see metadata: there is no API that returns a stored value.
 */

export type SecretScope = { kind: "global" } | { kind: "routine"; routineId: string } | { kind: "system" };

interface StoredSecret {
  description: string;
  kind: SecretKind;
  updated_at: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface SecretFile {
  version: 1;
  secrets: Record<string, StoredSecret>;
}

export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const RESERVED_SECRET_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
]);
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_DESCRIPTION_LENGTH = 500;
const ROUTINE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class SecretValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretValidationError";
  }
}

export function validateSecretName(name: string): string | undefined {
  if (!SECRET_NAME_PATTERN.test(name)) {
    return "Secret names must be upper-case environment variable names (A-Z, 0-9, _).";
  }
  if (RESERVED_SECRET_NAMES.has(name) || name.startsWith("CORTEX_")) {
    return `${name} is reserved and cannot be used as a secret name.`;
  }
  return undefined;
}

function secretsDir(): string {
  ensureCortexDir();
  return path.join(process.cwd(), ".cortex", "secrets");
}

export function secretFilePath(scope: SecretScope): string {
  if (scope.kind === "global") return path.join(secretsDir(), "global.json");
  if (scope.kind === "system") return path.join(secretsDir(), "system.json");
  if (!ROUTINE_ID_PATTERN.test(scope.routineId)) {
    throw new SecretValidationError("Invalid routine id");
  }
  return path.join(secretsDir(), "routines", `${scope.routineId}.json`);
}

function keyFilePath(): string {
  const configured = process.env.CORTEX_SECRETS_KEY_FILE?.trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".config", "cortex-city", "secrets.key");
}

let cachedKey: { source: string; key: Buffer } | undefined;

export function resolveSecretsKey(): Buffer {
  const fromEnv = process.env.CORTEX_SECRETS_KEY?.trim();
  if (fromEnv) {
    const source = `env:${fromEnv}`;
    if (cachedKey?.source !== source) {
      cachedKey = { source, key: createHash("sha256").update(fromEnv).digest() };
    }
    return cachedKey.key;
  }

  const file = keyFilePath();
  const source = `file:${file}`;
  if (cachedKey?.source === source) return cachedKey.key;
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      // Another process created it first; fall through and read theirs.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const raw = readFileSync(file, "utf-8").trim();
  const decoded = Buffer.from(raw, "base64");
  const key =
    decoded.length === 32 ? decoded : createHash("sha256").update(raw).digest();
  cachedKey = { source, key };
  return key;
}

function encrypt(value: string): Pick<StoredSecret, "iv" | "tag" | "ciphertext"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveSecretsKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(secret: StoredSecret): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    resolveSecretsKey(),
    Buffer.from(secret.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf-8");
}

function readSecretFile(scope: SecretScope): SecretFile {
  const file = secretFilePath(scope);
  if (!existsSync(file)) return { version: 1, secrets: {} };
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<SecretFile>;
  return {
    version: 1,
    secrets:
      parsed.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {},
  };
}

function writeSecretFile(scope: SecretScope, data: SecretFile): void {
  const file = secretFilePath(scope);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

let writeLock: Promise<unknown> = Promise.resolve();
function withSecretLock<T>(fn: () => T): Promise<T> {
  const result = writeLock.then(fn);
  writeLock = result.catch(() => undefined);
  return result;
}

export function listSecrets(scope: SecretScope): SecretMetadata[] {
  const data = readSecretFile(scope);
  return Object.entries(data.secrets)
    .map(([name, secret]) => ({
      name,
      description: secret.description,
      kind: secret.kind,
      updated_at: secret.updated_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SecretInput {
  name: string;
  // Omitted when only the description or kind changes on an existing secret.
  value?: string;
  description?: string;
  kind?: SecretKind;
}

export function setSecret(scope: SecretScope, input: SecretInput): Promise<SecretMetadata> {
  return withSecretLock(() => {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const nameError = validateSecretName(name);
    if (nameError) throw new SecretValidationError(nameError);
    if (input.kind !== undefined && input.kind !== "env" && input.kind !== "file") {
      throw new SecretValidationError("kind must be \"env\" or \"file\"");
    }
    const description = (input.description ?? "").toString().trim();
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new SecretValidationError(
        `Descriptions are limited to ${MAX_DESCRIPTION_LENGTH} characters.`
      );
    }
    const data = readSecretFile(scope);
    const existing = data.secrets[name];
    if (input.value === undefined || input.value === null) {
      if (!existing) throw new SecretValidationError("A value is required for a new secret.");
    } else {
      if (typeof input.value !== "string" || input.value.length === 0) {
        throw new SecretValidationError("A value is required.");
      }
      if (Buffer.byteLength(input.value) > MAX_SECRET_BYTES) {
        throw new SecretValidationError("Secret values are limited to 64 KB.");
      }
    }
    const updated: StoredSecret = {
      description:
        input.description === undefined && existing ? existing.description : description,
      kind: input.kind ?? existing?.kind ?? "env",
      updated_at: new Date().toISOString(),
      ...(input.value !== undefined && input.value !== null
        ? encrypt(input.value)
        : {
            iv: existing!.iv,
            tag: existing!.tag,
            ciphertext: existing!.ciphertext,
          }),
    };
    data.secrets[name] = updated;
    writeSecretFile(scope, data);
    return {
      name,
      description: updated.description,
      kind: updated.kind,
      updated_at: updated.updated_at,
    };
  });
}

export function deleteSecret(scope: SecretScope, name: string): Promise<boolean> {
  return withSecretLock(() => {
    const data = readSecretFile(scope);
    if (!data.secrets[name]) return false;
    delete data.secrets[name];
    writeSecretFile(scope, data);
    return true;
  });
}

export function deleteSecretScope(scope: SecretScope): Promise<void> {
  return withSecretLock(() => {
    rmSync(secretFilePath(scope), { force: true });
  });
}

export interface ResolvedSecret {
  name: string;
  value: string;
  kind: SecretKind;
  description: string;
}

/** Runtime-only: decrypts the named secrets in a scope. Never expose via API. */
export function readSecretValues(scope: SecretScope, names?: string[]): ResolvedSecret[] {
  const data = readSecretFile(scope);
  const wanted = names ?? Object.keys(data.secrets);
  const resolved: ResolvedSecret[] = [];
  for (const name of wanted) {
    const secret = data.secrets[name];
    if (!secret) continue;
    resolved.push({
      name,
      value: decrypt(secret),
      kind: secret.kind,
      description: secret.description,
    });
  }
  return resolved;
}

export function readSecretValue(scope: SecretScope, name: string): string | undefined {
  return readSecretValues(scope, [name])[0]?.value;
}

export const __testUtils = {
  resetKeyCache: () => {
    cachedKey = undefined;
  },
};
