import { join } from "node:path";
import { createCloudEdgeRepository } from "./repository.mjs";
import { createCloudEdgeRoutes } from "./routes.mjs";
import { createCloudEdgeService } from "./service.mjs";
import { createFilesystemSnapshotStorage } from "./storage/filesystem.mjs";
import { createS3SnapshotStorage } from "./storage/s3.mjs";

export function createCloudEdgeModule({ db, dataDir, legacyDataDir, masterSecret, encryptSecret, decryptSecret, publicBaseUrl, tlsCertificate, readJson, requirePermission, readFileObject, snapshotJobs, repository: providedRepository, env = process.env }) {
  const repository = providedRepository || createCloudEdgeRepository(db);
  const localStorage = createFilesystemSnapshotStorage({
    rootDir: env.SENTINEL_SNAPSHOT_DIR || join(dataDir, "edge-snapshots"),
    signingSecret: masterSecret,
    publicBaseUrl
  });
  const objectStorage = env.SENTINEL_S3_ENDPOINT ? createS3SnapshotStorage({
    endpoint: env.SENTINEL_S3_ENDPOINT,
    bucket: env.SENTINEL_S3_BUCKET,
    region: env.SENTINEL_S3_REGION || "us-east-1",
    accessKeyId: env.SENTINEL_S3_ACCESS_KEY_ID,
    secretAccessKey: env.SENTINEL_S3_SECRET_ACCESS_KEY,
    prefix: env.SENTINEL_S3_PREFIX || "sentinel-edge"
  }) : null;
  const articleImagesDir = join(dataDir, "upload/images");
  const articleImagesDirs = [articleImagesDir, legacyDataDir && join(legacyDataDir, "upload/images")].filter(Boolean);
  const service = createCloudEdgeService({ db, repository, masterSecret, encryptSecret, decryptSecret, localStorage, objectStorage, publicBaseUrl, readFileObject, snapshotJobs, articleImagesDir, articleImagesDirs });
  return {
    repository,
    service,
    localStorage,
    objectStorage,
    handle: createCloudEdgeRoutes({ service, repository, localStorage, tlsCertificate, readJson, requirePermission })
  };
}
