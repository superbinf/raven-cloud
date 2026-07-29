import assert from "node:assert/strict";
import test from "node:test";
import { assertConnectorEndpoint } from "../src/modules/connectors/service.mjs";

test("connector endpoints keep local WatchVuln HTTP but reject public HTTP", () => {
  assert.equal(assertConnectorEndpoint("http://127.0.0.1:18080"), "http://127.0.0.1:18080");
  assert.equal(assertConnectorEndpoint("https://feed.example/api"), "https://feed.example/api");
  assert.throws(() => assertConnectorEndpoint("http://feed.example/api"), /必须使用 HTTPS/);
  assert.throws(() => assertConnectorEndpoint("https://user:password@feed.example"), /账号密码/);
});
