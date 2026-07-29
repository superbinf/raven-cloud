import assert from "node:assert/strict";
import test from "node:test";
import { createPublicErrorResponse } from "../src/app/error-response.mjs";

test("system errors are replaced with the public error contract", () => {
  const response = createPublicErrorResponse(new Error("password authentication failed for user sentinel"), "REQ-test");
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    code: "INTERNAL_ERROR",
    message: "服务暂时不可用，请稍后重试",
    requestId: "REQ-test"
  });
  assert.doesNotMatch(JSON.stringify(response), /password|sentinel/i);
});

test("upstream 5xx errors cannot expose their details", () => {
  const error = Object.assign(new Error("upstream host 10.0.0.8 returned SQLSTATE 08006"), { statusCode: 502 });
  const response = createPublicErrorResponse(error, "REQ-upstream");
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.message, "服务暂时不可用，请稍后重试");
  assert.doesNotMatch(JSON.stringify(response), /10\.0\.0\.8|SQLSTATE/);
});

test("non-public upstream client errors are still hidden", () => {
  const error = Object.assign(new Error("upstream account admin rejected by 10.0.0.8"), { statusCode: 401, expose: false });
  const response = createPublicErrorResponse(error, "REQ-private-upstream");
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.message, "服务暂时不可用，请稍后重试");
  assert.doesNotMatch(JSON.stringify(response), /admin|10\.0\.0\.8/);
});

test("explicit client errors keep actionable business messages", () => {
  const error = Object.assign(new Error("情报标签不能超过 8 个"), { statusCode: 400 });
  assert.deepEqual(createPublicErrorResponse(error, "REQ-client"), {
    statusCode: 400,
    body: { code: "REQUEST_ERROR", message: "情报标签不能超过 8 个", requestId: "REQ-client" }
  });
});
