import { createHash } from "node:crypto";
import { getBlobBytes, putBlobBytes } from "@memoturn/db/blob";

/**
 * Multimodal media: image/audio/file attachments referenced in trace/observation
 * input/output. Inline base64 data URIs are offloaded to blob at ingest time (so they
 * don't bloat the telemetry store) and replaced with a `memoturn-media://<key>` reference; the
 * console fetches them back through GET /v1/media/<key>.
 */
const DATA_URI = /^data:([^;,]+);base64,([\s\S]+)$/;
export const MEDIA_PREFIX = "memoturn-media://";

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "application/pdf": "pdf",
};
const extOf = (mime: string) => EXT[mime] ?? "bin";

/** MIME types accepted for storage. Anything else is declined (never offloaded/served). */
export const ALLOWED_MEDIA_TYPES = new Set(Object.keys(EXT));

/** Raster image types safe to serve with their real content-type (render inline in <img>). */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

/**
 * Content-type to serve a stored blob with. Inline-safe raster images keep their real type;
 * everything else (svg, pdf, audio, and any legacy/unknown stored type) is downgraded to
 * `application/octet-stream` so a same-origin `data:text/html`/`image/svg+xml` payload can't
 * execute script when the URL is opened directly.
 */
export function safeServeContentType(mime: string): string {
  return INLINE_IMAGE_TYPES.has(mime) ? mime : "application/octet-stream";
}

export interface StoredMedia {
  key: string;
  mimeType: string;
}

export async function storeMediaBytes(projectId: string, bytes: Uint8Array, contentType: string): Promise<StoredMedia> {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const key = `media/${projectId}/${hash}.${extOf(contentType)}`;
  await putBlobBytes(key, bytes, contentType);
  return { key, mimeType: contentType };
}

/** Store a `data:<mime>;base64,<data>` URI, returning its blob key. Null if not a data URI. */
export async function storeDataUri(projectId: string, dataUri: string): Promise<StoredMedia | null> {
  const m = DATA_URI.exec(dataUri);
  if (!m) return null;
  const mimeType = m[1] as string;
  if (!ALLOWED_MEDIA_TYPES.has(mimeType)) return null;
  const bytes = new Uint8Array(Buffer.from(m[2] as string, "base64"));
  return storeMediaBytes(projectId, bytes, mimeType);
}

/** Fetch media bytes, scoped to the project (keys are `media/<projectId>/…`). */
export async function getMedia(
  projectId: string,
  key: string,
): Promise<{ body: Uint8Array; contentType: string } | null> {
  if (!key.startsWith(`media/${projectId}/`)) return null;
  return getBlobBytes(key);
}

/** True for a base64 `data:<mime>;base64,…` URI string. */
export function isDataUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:") && DATA_URI.test(value);
}

/**
 * Deep-walk a JSON value; any base64 data URI string is offloaded to blob and replaced
 * with a `memoturn-media://<key>` reference. Returns the transformed value. The `store`
 * is injectable for testing (defaults to the real blob writer).
 */
export async function offloadMedia(
  projectId: string,
  value: unknown,
  store: (projectId: string, dataUri: string) => Promise<StoredMedia | null> = storeDataUri,
): Promise<unknown> {
  if (typeof value === "string") {
    if (isDataUri(value)) {
      const stored = await store(projectId, value);
      return stored ? `${MEDIA_PREFIX}${stored.key}` : value;
    }
    return value;
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => offloadMedia(projectId, v, store)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await offloadMedia(projectId, v, store);
    return out;
  }
  return value;
}
