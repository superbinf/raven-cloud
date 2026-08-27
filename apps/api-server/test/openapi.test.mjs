import assert from "node:assert/strict";
import test from "node:test";

import { cloudOpenApiRouteCatalog, cloudSwaggerHtml, createCloudOpenApiDocument } from "../src/app/openapi.mjs";

test("Cloud OpenAPI 描述管理接口和云地机器接口", () => {
  const document = createCloudOpenApiDocument({ serverUrl: "https://cloud.example.test" });

  assert.equal(document.openapi, "3.1.0");
  assert.equal(document.info.title, "Sentinel Cloud API");
  assert.deepEqual(document.servers, [{ url: "https://cloud.example.test" }]);
  assert.ok(cloudOpenApiRouteCatalog.length >= 80);
  assert.ok(document.paths["/api/ingestion/assets-html"].post);
  assert.ok(document.paths["/api/edge/deployments/{deploymentId}"].put);
  assert.ok(document.paths["/edge/v1/snapshots/{version}/content"].get);
  assert.deepEqual(document.paths["/edge/v1/config"].get.security, [{ edgeOpenApiKey: [] }]);
  assert.deepEqual(document.paths["/api/targets"].get.security, [{ cloudBearer: [] }]);
  assert.deepEqual(document.paths["/api/auth/login"].post.security, []);
  assert.equal(
    document.paths["/api/ingestion/assets-html"].post.requestBody.content["multipart/form-data"].schema.properties.file.format,
    "binary"
  );
  assert.equal(document.components.securitySchemes.edgeOpenApiKey.bearerFormat, "sentinel-edge-v2");
});

test("Cloud Swagger UI 从同源 OpenAPI 文档加载并支持授权保持", () => {
  const html = cloudSwaggerHtml();
  assert.match(html, /Swagger UI/u);
  assert.ok(html.includes('url:"/openapi.json"'));
  assert.match(html, /persistAuthorization:true/u);
  assert.match(html, /swagger-ui-dist@5/u);
});
