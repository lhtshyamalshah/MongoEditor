import { NextRequest, NextResponse } from "next/server";
import { AppError, collections, connect, databases, disconnect, documents, mutate, object, profileNames, publicError, schema, sessionFor } from "@/lib/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verifyRequest(request: NextRequest) {
  const host = request.headers.get("host") || "";
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new AppError("This database browser only accepts local requests.", 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) throw new AppError("Cross-origin requests are not allowed.", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("Cross-site requests are not allowed.", 403);
  if (request.method === "POST" && (request.headers.get("x-mongo-browser") !== "1" || !request.headers.get("content-type")?.startsWith("application/json"))) throw new AppError("Invalid request.", 403);
}

function respond(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  try { verifyRequest(request); return respond({ profiles: profileNames() }); }
  catch (error) { const result = publicError(error); return respond({ error: result.message }, result.status); }
}

export async function POST(request: NextRequest) {
  try {
    verifyRequest(request);
    if (Number(request.headers.get("content-length")) > 2_100_000) throw new AppError("Request is too large.", 413);
    let input;
    try { const body = await request.text(); if (body.length > 2_100_000) throw new AppError("Request is too large.", 413); input = object(JSON.parse(body), "Request"); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError("Invalid JSON request."); }
    const token = request.headers.get("x-connection-token");
    if (input.action === "connect") {
      const result = await connect(input);
      await disconnect(token).catch(() => {});
      return respond(result);
    }
    if (input.action === "disconnect") { await disconnect(token); return respond({ disconnected: true }); }
    const session = sessionFor(token);
    if (input.action === "databases") return respond(await databases(session));
    if (input.action === "collections") return respond(await collections(session, input));
    if (input.action === "schema") return respond(await schema(session, input));
    if (input.action === "documents") return respond(await documents(session, input));
    if (input.action === "update" || input.action === "delete") return respond(await mutate(session, input, input.action));
    throw new AppError("Unknown action.");
  } catch (error) {
    const result = publicError(error);
    return respond({ error: result.message }, result.status);
  }
}
