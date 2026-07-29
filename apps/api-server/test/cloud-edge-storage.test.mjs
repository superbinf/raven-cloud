import assert from "node:assert/strict";
import test from "node:test";
import { createS3SnapshotStorage } from "../src/modules/cloud-edge/storage/s3.mjs";

test("S3 适配器写入私有对象并只向地端暴露短期签名 URL", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(null, { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const storage = createS3SnapshotStorage({
    endpoint: "https://objects.example.test",
    bucket: "private-bucket",
    region: "cn-test-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    prefix: "sentinel-edge"
  });
  const result = await storage.put({ deploymentId: "EDGE-01", version: 7, manifest: { version: 7 }, content: Buffer.from("encrypted") });
  assert.equal(result.objectKey, "sentinel-edge/EDGE-01/7");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.method, "PUT");
    assert.match(request.options.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.doesNotMatch(request.options.headers.Authorization, /test-secret-key/);
    assert.match(request.url, /^https:\/\/objects\.example\.test\/private-bucket\/sentinel-edge\/EDGE-01\/7\//);
  }
  const signed = new URL(storage.presign({ objectKey: result.objectKey }, "content.bin", new Date(Date.now() + 10 * 60_000).toISOString()));
  assert.equal(signed.origin, "https://objects.example.test");
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(signed.searchParams.get("X-Amz-Credential")?.startsWith("test-access-key/"), true);
  assert.ok(Number(signed.searchParams.get("X-Amz-Expires")) <= 600);
  assert.match(signed.searchParams.get("X-Amz-Signature") || "", /^[a-f0-9]{64}$/);
  await storage.deleteDeployment("EDGE-01", [{ objectKey: result.objectKey }]);
  assert.equal(requests.length, 4);
  for (const request of requests.slice(2)) {
    assert.equal(request.options.method, "DELETE");
    assert.match(request.options.headers.Authorization, /^AWS4-HMAC-SHA256 /);
    assert.match(request.url, /^https:\/\/objects\.example\.test\/private-bucket\/sentinel-edge\/EDGE-01\/7\/(content\.bin|manifest\.json)$/);
  }
});

test("S3 快照部分写入失败时清理已创建对象", async (t) => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  let puts = 0;
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method);
    if (options.method === "PUT" && ++puts === 2) return new Response(null, { status: 503 });
    return new Response(null, { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const storage = createS3SnapshotStorage({ endpoint: "https://objects.example.test", bucket: "private-bucket", accessKeyId: "key", secretAccessKey: "secret" });
  await assert.rejects(() => storage.put({ deploymentId: "EDGE-FAIL", version: 1, manifest: {}, content: Buffer.from("partial") }), /对象存储写入失败/);
  assert.deepEqual(methods, ["PUT", "PUT", "DELETE", "DELETE"]);
});
