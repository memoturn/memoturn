import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

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
