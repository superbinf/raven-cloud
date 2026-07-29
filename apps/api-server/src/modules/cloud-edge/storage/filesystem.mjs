import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

function signature(secret, path, expires) {
  return createHmac("sha256", secret).update(`${path}\n${expires}`).digest("hex");
}

export function createFilesystemSnapshotStorage({ rootDir, signingSecret, publicBaseUrl }) {
  return {
    kind: "filesystem",
    async put({ deploymentId, version, manifest, content }) {
      const directory = join(rootDir, deploymentId, String(version));
      try {
        await mkdir(directory, { recursive: true });
        const contentPath = join(directory, "content.bin");
        await Promise.all([
          writeFile(contentPath, content, { mode: 0o600 }),
          writeFile(join(directory, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 })
        ]);
        return { contentPath, objectKey: `${deploymentId}/${version}` };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    async readContent(snapshot) { return readFile(snapshot.contentPath); },
    async readManifest(snapshot) { return snapshot.manifest; },
    async deleteSnapshot(snapshot) { await rm(join(rootDir, snapshot.deploymentId, String(snapshot.version)), { recursive: true, force: true }); },
    async deleteDeployment(deploymentId) { await rm(join(rootDir, deploymentId), { recursive: true, force: true }); },
    presign(snapshot, name, expiresAt) {
      const pathname = `/edge-storage/v1/${encodeURIComponent(snapshot.deploymentId)}/${snapshot.version}/${name}`;
      const expires = Math.floor(new Date(expiresAt).getTime() / 1000);
      const sig = signature(signingSecret, pathname, expires);
      return `${publicBaseUrl}${pathname}?expires=${expires}&signature=${sig}`;
    },
    verifySignedPath(pathname, expires, suppliedSignature) {
      if (!Number.isInteger(expires) || expires * 1000 <= Date.now() || !suppliedSignature) return false;
      const actual = Buffer.from(signature(signingSecret, pathname, expires), "hex");
      const supplied = Buffer.from(String(suppliedSignature), "hex");
      return actual.length === supplied.length && timingSafeEqual(actual, supplied);
    }
  };
}
