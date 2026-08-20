import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { constants as zlibConstants, gzip } from "node:zlib";
import { deploymentCredentials } from "./auth.mjs";

const gzipAsync = promisify(gzip);
const compressibleMediaType = /^(?:text\/[^;]+|application\/(?:json|xml|javascript))(?:;|$)/i;

function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function writeBuffer(res, body) {
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

async function writeFileBuffer(req, res, file) {
  const useGzip = file.content.length >= 4_096
    && compressibleMediaType.test(file.mediaType || "")
    && /(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(String(req.headers["accept-encoding"] || ""));
  const body = useGzip ? await gzipAsync(file.content, { level: zlibConstants.Z_BEST_SPEED }) : file.content;
  res.writeHead(200, {
    "Content-Type": file.mediaType || "application/octet-stream",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Content-SHA256": file.sha256,
    ...(useGzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {})
  });
  res.end(body);
}

export function createCloudEdgeRoutes({ service, repository, localStorage, tlsCertificate, readJson, requirePermission }) {
  async function admin(req, res) {
    return requirePermission(req, res, "operations:manage");
  }
  async function edge(req, options) {
    const credentials = deploymentCredentials(req);
    return service.authenticate(credentials.deploymentId, credentials.secret, options);
  }

  return async function handleCloudEdgeRoute(req, res, url) {
    const adminPath = url.pathname.startsWith("/api/edge/");
    const edgePath = url.pathname.startsWith("/edge/v1/");
    const storageMatch = url.pathname.match(/^\/edge-storage\/v1\/([^/]+)\/(\d+)\/(manifest\.json|content\.bin)$/);
    if (!adminPath && !edgePath && !storageMatch) return false;

    if (storageMatch && req.method === "GET") {
      const expires = Number(url.searchParams.get("expires"));
      if (!localStorage.verifySignedPath(url.pathname, expires, url.searchParams.get("signature"))) {
        writeJson(res, 403, { message: "对象下载链接无效或已过期" }); return true;
      }
      const snapshot = await repository.getSnapshot(decodeURIComponent(storageMatch[1]), Number(storageMatch[2]), { includeStorage: true });
      if (!snapshot) { writeJson(res, 404, { message: "快照不存在" }); return true; }
      if (storageMatch[3] === "manifest.json") writeJson(res, 200, snapshot.manifest, { "Cache-Control": "private, max-age=60" });
      else writeBuffer(res, await localStorage.readContent(snapshot));
      return true;
    }

    if (adminPath) {
      if (req.method === "GET" && url.pathname === "/api/edge/tenants") {
        if (!await requirePermission(req, res, "targets:read")) return true;
        writeJson(res, 200, await service.listTenants()); return true;
      }
      if (req.method === "POST" && url.pathname === "/api/edge/tenants") {
        if (!await requirePermission(req, res, "targets:manage")) return true;
        writeJson(res, 201, await service.createTenant(await readJson(req))); return true;
      }
      const tenantMatch = url.pathname.match(/^\/api\/edge\/tenants\/([^/]+)$/);
      if (tenantMatch && req.method === "PUT") {
        if (!await requirePermission(req, res, "targets:manage")) return true;
        writeJson(res, 200, await service.updateTenant(decodeURIComponent(tenantMatch[1]), await readJson(req))); return true;
      }
      if (tenantMatch && req.method === "DELETE") {
        if (!await requirePermission(req, res, "targets:manage")) return true;
        writeJson(res, 200, await service.deleteTenant(decodeURIComponent(tenantMatch[1]), await readJson(req))); return true;
      }
      if (!await admin(req, res)) return true;
      if (req.method === "GET" && url.pathname === "/api/edge/cloud-tls-certificate") {
        if (!tlsCertificate) { writeJson(res, 409, { message: "云端当前未启用 TLS 证书，无法导出" }); return true; }
        const content = Buffer.isBuffer(tlsCertificate) ? tlsCertificate : Buffer.from(tlsCertificate);
        await writeFileBuffer(req, res, {
          content,
          name: "sentinel-cloud-tls.crt",
          mediaType: "application/x-pem-file",
          sha256: createHash("sha256").update(content).digest("hex")
        });
        return true;
      }
      const snapshotJobMatch = url.pathname.match(/^\/api\/edge\/snapshot-jobs\/([^/]+)$/);
      if (snapshotJobMatch && req.method === "GET") { writeJson(res, 200, await service.snapshotJob(snapshotJobMatch[1])); return true; }
      if (req.method === "GET" && url.pathname === "/api/edge/deployments") { writeJson(res, 200, await service.listDeployments()); return true; }
      if (req.method === "POST" && url.pathname === "/api/edge/deployments") { writeJson(res, 201, await service.createDeployment(await readJson(req)), { "Cache-Control": "no-store" }); return true; }
      const deploymentMatch = url.pathname.match(/^\/api\/edge\/deployments\/([^/]+)$/);
      if (deploymentMatch && req.method === "GET") { writeJson(res, 200, await service.getDeployment(deploymentMatch[1])); return true; }
      if (deploymentMatch && req.method === "PUT") { writeJson(res, 200, await service.updateDeployment(deploymentMatch[1], await readJson(req))); return true; }
      if (deploymentMatch && req.method === "DELETE") { writeJson(res, 200, await service.deleteDeployment(deploymentMatch[1], await readJson(req))); return true; }
      const actionMatch = url.pathname.match(/^\/api\/edge\/deployments\/([^/]+)\/(rotate-activation|publish-snapshot|status)$/);
      if (actionMatch && req.method === "POST" && actionMatch[2] === "rotate-activation") { writeJson(res, 200, await service.rotateActivation(actionMatch[1]), { "Cache-Control": "no-store" }); return true; }
      if (actionMatch && req.method === "POST" && actionMatch[2] === "publish-snapshot") {
        const force = url.searchParams.get("force") === "1";
        writeJson(res, 202, await service.requestSnapshot(actionMatch[1], { force, triggerType: "manual" }));
        return true;
      }
      if (actionMatch && req.method === "GET" && actionMatch[2] === "status") { writeJson(res, 200, await service.status(actionMatch[1])); return true; }
      const apiKeyMatch = url.pathname.match(/^\/api\/edge\/deployments\/([^/]+)\/openapi-key$/);
      if (apiKeyMatch && ["POST", "PUT"].includes(req.method)) { writeJson(res, 200, await service.rotateActivation(apiKeyMatch[1]), { "Cache-Control": "no-store" }); return true; }
      if (apiKeyMatch && req.method === "DELETE") { writeJson(res, 200, await service.revokeApiKey(apiKeyMatch[1])); return true; }
      const licenseMatch = url.pathname.match(/^\/api\/edge\/deployments\/([^/]+)\/license$/);
      if (licenseMatch && req.method === "POST") { writeJson(res, 201, await service.issueLicense(licenseMatch[1], await readJson(req)), { "Cache-Control": "no-store" }); return true; }
      if (licenseMatch && req.method === "PUT") { writeJson(res, 200, await service.updateLicense(licenseMatch[1], await readJson(req))); return true; }
      if (licenseMatch && req.method === "DELETE") { writeJson(res, 200, await service.revokeLicense(licenseMatch[1])); return true; }
      writeJson(res, 404, { message: "云地管理接口不存在" }); return true;
    }

    if (req.method === "POST" && url.pathname === "/edge/v1/license/validate") { writeJson(res, 200, await service.validateLicense(await readJson(req)), { "Cache-Control": "no-store" }); return true; }
    if (req.method === "GET" && url.pathname === "/edge/v1/config") {
      const deployment = await edge(req, { controlPlane: true });
      writeJson(res, 200, service.config(deployment), { "Cache-Control": "no-store" }); return true;
    }
    const deployment = await edge(req);
    if (req.method === "GET" && url.pathname === "/edge/v1/snapshots/latest") {
      const descriptor = await service.latestDescriptor(deployment);
      const etag = `\"snapshot-${descriptor.version}\"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { ETag: etag, "Cache-Control": "no-store" }); res.end(); return true; }
      writeJson(res, 200, descriptor, { ETag: etag, "Cache-Control": "no-store" }); return true;
    }
    const snapshotMatch = url.pathname.match(/^\/edge\/v1\/snapshots\/(\d+)\/(manifest|content)$/);
    if (snapshotMatch && req.method === "GET") {
      const snapshot = await service.snapshot(deployment, Number(snapshotMatch[1]));
      if (snapshotMatch[2] === "manifest") writeJson(res, 200, snapshot.manifest, { "Cache-Control": "no-store" });
      else writeBuffer(res, await localStorage.readContent(snapshot));
      return true;
    }
    const fileMatch = url.pathname.match(/^\/edge\/v1\/files\/([^/]+)\/content$/);
    if (fileMatch && req.method === "GET") {
      await writeFileBuffer(req, res, await service.fileObject(deployment, decodeURIComponent(fileMatch[1])));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/edge/v1/sync-status") { writeJson(res, 200, await service.reportSync(deployment, await readJson(req))); return true; }
    writeJson(res, 404, { message: "地端控制接口不存在" }); return true;
  };
}
