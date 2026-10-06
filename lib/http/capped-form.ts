import "server-only";
import type { NextRequest } from "next/server";

/**
 * Reads at most `max` bytes of the body and parses it as multipart form data. Refuses early on a declared
 * Content-Length over the cap and stops reading a chunked body as soon as it passes the cap, so an oversized upload
 * is never buffered whole. The caller supplies its own errors, so each endpoint can word them for its users.
 */
export async function readCappedForm(
  request: NextRequest,
  max: number,
  errors: { tooLarge: () => Error; invalid: (reason: "type" | "missing" | "unreadable") => Error },
): Promise<FormData> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) throw errors.invalid("type");
  const declared = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) throw errors.tooLarge();
  if (!request.body) throw errors.invalid("missing");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw errors.tooLarge();
    }
    chunks.push(value);
  }
  try {
    return await new Response(new Blob(chunks as BlobPart[]), { headers: { "content-type": contentType } }).formData();
  } catch {
    throw errors.invalid("unreadable");
  }
}
