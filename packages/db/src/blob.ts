import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * S3-compatible blob storage for the raw ingest event log (the replayable source of
 * truth) and, later, multimodal media + exports. MinIO locally; S3/R2/GCS in prod.
 */
let s3: S3Client | undefined;

export function blob(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      endpoint: process.env.BLOB_ENDPOINT ?? "http://localhost:9000",
      region: process.env.BLOB_REGION ?? "us-east-1",
      forcePathStyle: process.env.BLOB_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: process.env.BLOB_ACCESS_KEY_ID ?? "memoturn",
        secretAccessKey: process.env.BLOB_SECRET_ACCESS_KEY ?? "memoturn123",
      },
    });
  }
  return s3;
}

export const BLOB_BUCKET = process.env.BLOB_BUCKET ?? "memoturn";

/** Store a raw ingest batch. Key: events/<projectId>/<YYYY-MM-DD>/<batchId>.json */
export async function putRawBatch(projectId: string, batchId: string, payload: unknown): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const key = `events/${projectId}/${date}/${batchId}.json`;
  await blob().send(
    new PutObjectCommand({
      Bucket: BLOB_BUCKET,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
    }),
  );
  return key;
}

export async function getRawBatch(key: string): Promise<string> {
  const res = await blob().send(new GetObjectCommand({ Bucket: BLOB_BUCKET, Key: key }));
  return (await res.Body?.transformToString()) ?? "";
}

/** Store an arbitrary object at a chosen key (used by scheduled exports, media, …). */
export async function putBlobObject(
  key: string,
  body: string,
  contentType = "application/octet-stream",
): Promise<string> {
  await blob().send(new PutObjectCommand({ Bucket: BLOB_BUCKET, Key: key, Body: body, ContentType: contentType }));
  return key;
}

/** Store raw bytes (multimodal media attachments). */
export async function putBlobBytes(key: string, bytes: Uint8Array, contentType: string): Promise<string> {
  await blob().send(new PutObjectCommand({ Bucket: BLOB_BUCKET, Key: key, Body: bytes, ContentType: contentType }));
  return key;
}

/**
 * Delete every object under `prefix` last modified before `cutoff`; returns the count removed.
 * Used by data retention to reach the blob store — the raw event log (written pre-masking),
 * offloaded payloads, and media are otherwise never deleted, so "retention" and PII masking
 * wouldn't actually erase anything there. Filters on S3 `LastModified` so it works for both
 * date-partitioned keys (events/, payloads/) and hash-only keys (media/). Paginates the
 * listing and batches deletes (S3 caps DeleteObjects at 1000 keys per call).
 */
export async function deleteBlobPrefixOlderThan(prefix: string, cutoff: Date): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const list = await blob().send(
      new ListObjectsV2Command({ Bucket: BLOB_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    const expired = (list.Contents ?? [])
      .filter((o) => o.Key && o.LastModified && o.LastModified < cutoff)
      .map((o) => ({ Key: o.Key as string }));
    for (let i = 0; i < expired.length; i += 1000) {
      const chunk = expired.slice(i, i + 1000);
      await blob().send(new DeleteObjectsCommand({ Bucket: BLOB_BUCKET, Delete: { Objects: chunk, Quiet: true } }));
      deleted += chunk.length;
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

/** Fetch raw bytes + content type for a key, or null if missing. */
export async function getBlobBytes(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
  try {
    const res = await blob().send(new GetObjectCommand({ Bucket: BLOB_BUCKET, Key: key }));
    const body = await res.Body?.transformToByteArray();
    if (!body) return null;
    return { body, contentType: res.ContentType ?? "application/octet-stream" };
  } catch {
    return null;
  }
}
