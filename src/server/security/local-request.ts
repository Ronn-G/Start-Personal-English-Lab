const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;

export const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;
export const JSON_BODY_READ_TIMEOUT_MS = 5_000;

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type LocalAuthority = {
  hostname: string;
  host: string;
};

function parseLocalAuthority(rawHost: string | null): LocalAuthority {
  if (!rawHost || rawHost.includes(",") || /[\r\n]/.test(rawHost)) {
    throw new ApiRequestError("LOCAL_HOST_REQUIRED", 403, "Request host is not allowed.");
  }
  try {
    const parsed = new URL(`http://${rawHost}`);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !LOCAL_HOSTNAMES.has(hostname)
    ) {
      throw new Error("not local");
    }
    if (parsed.port) {
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("bad port");
    }
    return { hostname, host: parsed.host.toLowerCase() };
  } catch {
    throw new ApiRequestError("LOCAL_HOST_REQUIRED", 403, "Request host is not allowed.");
  }
}

export function assertLocalMutationRequest(request: Request): void {
  const authority = parseLocalAuthority(request.headers.get("host"));
  const rawOrigin = request.headers.get("origin");
  if (!rawOrigin) return;

  try {
    const origin = new URL(rawOrigin);
    const originHostname = origin.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      origin.protocol !== "http:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !LOCAL_HOSTNAMES.has(originHostname) ||
      origin.host.toLowerCase() !== authority.host
    ) {
      throw new Error("cross origin");
    }
  } catch {
    throw new ApiRequestError(
      "CROSS_ORIGIN_MUTATION_REJECTED",
      403,
      "Cross-origin changes are not allowed.",
    );
  }
}

async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Invalid JSON body limit.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new ApiRequestError("INVALID_CONTENT_LENGTH", 400, "Content-Length is invalid.");
    }
    if (Number(declared) > maxBytes) {
      throw new ApiRequestError("REQUEST_BODY_TOO_LARGE", 413, "Request body is too large.");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const readAll = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          throw new ApiRequestError("REQUEST_BODY_TOO_LARGE", 413, "Request body is too large.");
        }
        chunks.push(value);
      }
    };
    await Promise.race([
      readAll(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new ApiRequestError("REQUEST_BODY_TIMEOUT", 408, "Request body timed out.")),
          JSON_BODY_READ_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readBoundedJsonBody(
  request: Request,
  maxBytes = DEFAULT_JSON_BODY_LIMIT,
): Promise<unknown> {
  assertLocalMutationRequest(request);
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!JSON_CONTENT_TYPE.test(contentType)) {
    throw new ApiRequestError("UNSUPPORTED_MEDIA_TYPE", 415, "Request must use application/json.");
  }
  const raw = await readBodyBytes(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
  } catch {
    throw new ApiRequestError("MALFORMED_JSON", 400, "JSON body is invalid.");
  }
}
