import { NextRequest, NextResponse } from "next/server";
import { deleteSecret, listSecrets, setSecret } from "@/lib/secret-store";
import { globalSecretUsage, notFound, readJsonBody, validationErrorResponse } from "@/lib/routine-api";
import type { SecretKind } from "@/lib/types";

export async function GET() {
  const usage = globalSecretUsage();
  return NextResponse.json(
    listSecrets({ kind: "global" }).map((secret) => ({ ...secret, used_by: usage[secret.name] ?? [] }))
  );
}

export async function PUT(request: NextRequest) {
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  try {
    const secret = await setSecret(
      { kind: "global" },
      {
        name: String(body.name ?? ""),
        value: typeof body.value === "string" ? body.value : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        kind: body.kind as SecretKind | undefined,
      }
    );
    return NextResponse.json(secret);
  } catch (error) {
    return validationErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name") ?? "";
  const removed = await deleteSecret({ kind: "global" }, name);
  if (!removed) return notFound("Secret not found");
  return NextResponse.json({ ok: true, used_by: globalSecretUsage()[name] ?? [] });
}
