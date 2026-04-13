import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin';
const MINIO_REGION = 'us-east-1';

export const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: MINIO_REGION,
  credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
  forcePathStyle: true,
});

export async function ensureBucket(bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`[minio] created bucket: ${bucket}`);
  }
}

export async function uploadStream(
  bucket: string,
  key: string,
  body: ReadableStream | Buffer | Uint8Array,
  contentType: string,
  onProgress?: (loaded: number) => void,
) {
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: body, ContentType: contentType },
    queueSize: 1,
    partSize: 5 * 1024 * 1024,
  });

  if (onProgress) {
    upload.on('httpUploadProgress', (p) => {
      if (p.loaded) onProgress(p.loaded);
    });
  }

  await upload.done();
}
