import { createHash, createHmac } from "node:crypto";
import { assertEncryptedHttpUrl } from "@sentinel/transport-security";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function hmac(key, value, encoding) { return createHmac("sha256", key).update(value).digest(encoding); }
function amzDate(date) { return date.toISOString().replace(/[:-]|\.\d{3}/g, ""); }
function encodePath(path) { return path.split("/").map((part) => encodeURIComponent(part)).join("/"); }
function encodeQuery(value) { return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`); }
function signingKey(secret, date, region) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

export function createS3SnapshotStorage({ endpoint, bucket, region = "us-east-1", accessKeyId, secretAccessKey, prefix = "sentinel-edge" }) {
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error("对象存储配置不完整");
  const base = assertEncryptedHttpUrl(endpoint, { label: "对象存储地址" });
  const objectUrl = (key) => {
    const url = new URL(base);
    url.pathname = `${base.pathname.replace(/\/$/, "")}/${encodePath(bucket)}/${encodePath(key)}`;
    return url;
  };

  async function putObject(key, content, contentType) {
    const url = objectUrl(key);
    const now = new Date();
    const timestamp = amzDate(now);
    const shortDate = timestamp.slice(0, 8);
    const payloadHash = sha256(content);
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = `PUT\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${shortDate}/${region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = hmac(signingKey(secretAccessKey, shortDate, region), stringToSign, "hex");
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "Content-Type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": timestamp
      },
      body: content
    });
    if (!response.ok) throw new Error(`对象存储写入失败 (${response.status})`);
  }

  async function deleteObject(key) {
    const url = objectUrl(key);
    const timestamp = amzDate(new Date());
    const shortDate = timestamp.slice(0, 8);
    const payloadHash = sha256("");
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = `DELETE\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${shortDate}/${region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = hmac(signingKey(secretAccessKey, shortDate, region), stringToSign, "hex");
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": timestamp
      }
    });
    if (!response.ok && response.status !== 404) throw new Error(`对象存储删除失败 (${response.status})`);
  }

  function presignObject(key, expiresAt) {
    const url = objectUrl(key);
    const now = new Date();
    const timestamp = amzDate(now);
    const shortDate = timestamp.slice(0, 8);
    const scope = `${shortDate}/${region}/s3/aws4_request`;
    const expires = Math.max(1, Math.min(3600, Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1000)));
    const params = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${accessKeyId}/${scope}`,
      "X-Amz-Date": timestamp,
      "X-Amz-Expires": String(expires),
      "X-Amz-SignedHeaders": "host"
    };
    const canonicalQuery = Object.entries(params).sort(([left], [right]) => left.localeCompare(right)).map(([keyName, value]) => `${encodeQuery(keyName)}=${encodeQuery(value)}`).join("&");
    const canonicalRequest = `GET\n${url.pathname}\n${canonicalQuery}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
    const signature = hmac(signingKey(secretAccessKey, shortDate, region), stringToSign, "hex");
    url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return url.toString();
  }

  return {
    kind: "s3",
    async put({ deploymentId, version, manifest, content }) {
      const objectKey = `${prefix.replace(/^\/+|\/+$/g, "")}/${deploymentId}/${version}`;
      try {
        await putObject(`${objectKey}/content.bin`, content, "application/octet-stream");
        await putObject(`${objectKey}/manifest.json`, Buffer.from(JSON.stringify(manifest)), "application/json");
        return { objectKey };
      } catch (error) {
        await Promise.allSettled([
          deleteObject(`${objectKey}/content.bin`),
          deleteObject(`${objectKey}/manifest.json`)
        ]);
        throw error;
      }
    },
    async deleteSnapshot(snapshot) {
      if (!snapshot.objectKey) return;
      await deleteObject(`${snapshot.objectKey}/content.bin`);
      await deleteObject(`${snapshot.objectKey}/manifest.json`);
    },
    async deleteDeployment(_deploymentId, snapshots = []) {
      for (const snapshot of snapshots) {
        await this.deleteSnapshot(snapshot);
      }
    },
    presign(snapshot, name, expiresAt) {
      return presignObject(`${snapshot.objectKey}/${name}`, expiresAt);
    }
  };
}
