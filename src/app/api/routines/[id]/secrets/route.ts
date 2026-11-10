import { NextRequest, NextResponse } from "next/server";
import { deleteSecret, listSecrets, setSecret } from "@/lib/secret-store";
import { findRoutine, notFound, readJsonBody, validationErrorResponse } from "@/lib/routine-api";
import type { SecretKind } from "@/lib/types";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!findRoutine(id)) return notFound("Routine not found");
  return NextResponse.json(listSecrets({ kind: "routine", routineId: id }));
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!findRoutine(id)) return notFound("Routine not found");
  const body = await readJsonBody(request);
  if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
  try {
    const secret = await setSecret(
      { kind: "routine", routineId: id },
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

export async function DELETE(request: NextRequest, { params }: Params) {
  const { id } = await params;
  if (!findRoutine(id)) return notFound("Routine not found");
  const name = request.nextUrl.searchParams.get("name") ?? "";
  const removed = await deleteSecret({ kind: "routine", routineId: id }, name);
  if (!removed) return notFound("Secret not found");
  return NextResponse.json({ ok: true });
}
