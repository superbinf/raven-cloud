const jsonSchema = { type: "object", additionalProperties: true };
const jsonResponse = {
  description: "成功",
  content: { "application/json": { schema: jsonSchema } }
};
const errorResponses = {
  400: { description: "请求参数不合法" },
  401: { description: "未认证或凭证无效" },
  403: { description: "权限不足或租户边界不匹配" },
  404: { description: "资源不存在" },
  500: { description: "服务内部错误" }
};

const routes = [
  ["/health", ["get"], "system", "检查 Cloud API 与 PostgreSQL 健康状态", { public: true }],
  ["/api/auth/captcha", ["get"], "auth", "获取登录验证码", { public: true }],
  ["/api/auth/login", ["post"], "auth", "账号密码登录", { public: true, schema: "LoginRequest" }],
  ["/api/auth/login/otp", ["post"], "auth", "完成登录二次验证", { public: true }],
  ["/api/auth/me", ["get"], "auth", "获取当前用户"],
  ["/api/auth/logout", ["post"], "auth", "退出登录", { body: false }],
  ["/api/profile", ["get", "put"], "auth", "查询或更新个人资料"],
  ["/api/profile/change-password", ["post"], "auth", "修改当前用户密码"],
  ["/api/password-policy", ["get", "put"], "auth", "查询或更新密码策略"],
  ["/api/roles", ["get"], "accounts", "查询角色定义"],
  ["/api/users", ["get", "post"], "accounts", "查询或创建用户"],
  ["/api/users/{account}", ["get", "put", "delete"], "accounts", "查询、更新或删除用户"],
  ["/api/users/{account}/reset-password", ["post"], "accounts", "重置用户密码"],
  ["/api/users/{account}/totp/{action}", ["post"], "accounts", "管理用户 TOTP"],
  ["/api/audit-logs", ["get"], "operations", "分页查询审计日志"],

  ["/api/edge/tenants", ["get", "post"], "edge-management", "查询或创建客户租户"],
  ["/api/edge/tenants/{tenantId}", ["put", "delete"], "edge-management", "更新或删除客户租户", { deleteBody: true }],
  ["/api/edge/cloud-tls-certificate", ["get"], "edge-management", "导出 Cloud TLS 公共证书", { binary: true }],
  ["/api/edge/deployments", ["get", "post"], "edge-management", "查询或创建地端部署"],
  ["/api/edge/deployments/{deploymentId}", ["get", "put", "delete"], "edge-management", "查询、更新或删除地端部署", { deleteBody: true }],
  ["/api/edge/deployments/{deploymentId}/rotate-activation", ["post"], "edge-management", "轮换地端激活凭证", { body: false }],
  ["/api/edge/deployments/{deploymentId}/openapi-key", ["post", "put", "delete"], "edge-management", "生成、轮换或注销 OpenAPI Key", { body: false }],
  ["/api/edge/deployments/{deploymentId}/license", ["post", "put", "delete"], "edge-management", "签发、更新或注销地端许可证"],
  ["/api/edge/deployments/{deploymentId}/publish-snapshot", ["post"], "edge-management", "请求发布地端快照", { body: false, status: 202 }],
  ["/api/edge/deployments/{deploymentId}/status", ["get"], "edge-management", "查询地端部署状态"],
  ["/api/edge/snapshot-jobs/{jobId}", ["get"], "edge-management", "查询快照任务状态"],

  ["/edge/v1/license/validate", ["post"], "edge-openapi", "校验地端许可证", { public: true, schema: "LicenseValidationRequest" }],
  ["/edge/v1/config", ["get"], "edge-openapi", "获取地端部署配置", { edge: true }],
  ["/edge/v1/snapshots/latest", ["get"], "edge-openapi", "获取最新快照描述", { edge: true }],
  ["/edge/v1/snapshots/{version}/manifest", ["get"], "edge-openapi", "下载指定版本 Manifest", { edge: true }],
  ["/edge/v1/snapshots/{version}/content", ["get"], "edge-openapi", "下载指定版本加密快照", { edge: true, binary: true }],
  ["/edge/v1/files/{fileId}/content", ["get"], "edge-openapi", "下载快照引用附件", { edge: true, binary: true }],
  ["/edge/v1/sync-status", ["post"], "edge-openapi", "回报地端同步状态", { edge: true, schema: "SyncStatusRequest" }],
  ["/edge-storage/v1/{deploymentId}/{version}/{objectName}", ["get"], "edge-openapi", "通过签名 URL 下载快照对象", { signed: true, binary: true }],

  ["/api/targets", ["get", "post"], "targets", "查询或创建监测对象"],
  ["/api/targets/{targetId}", ["get", "put", "delete"], "targets", "查询、更新或删除监测对象"],
  ["/api/tenant-publication-policies", ["get", "put"], "ingestion", "查询或更新租户发布策略"],
  ["/api/tenant-portal-preview", ["get"], "ingestion", "预览租户 Portal 数据"],
  ["/api/ingestion/article-images", ["post"], "ingestion", "上传情报文章图片", { multipart: true, status: 201 }],
  ["/api/ingestion/sensitive-xlsx", ["post"], "ingestion", "导入敏感信息工作簿", { multipart: true, status: 201 }],
  ["/api/ingestion/assets-xlsx", ["post"], "ingestion", "导入资产工作簿", { multipart: true, status: 201 }],
  ["/api/ingestion/assets-html", ["post"], "ingestion", "导入资产 HTML 报告", { multipart: true, status: 201 }],
  ["/api/ingestion/dark-web", ["post"], "ingestion", "导入暗网交付包", { multipart: true, status: 201 }],
  ["/api/ingestion/dark-web-zip", ["post"], "ingestion", "导入暗网 ZIP 交付包", { multipart: true, status: 201 }],
  ["/api/ingestion/batches", ["get"], "ingestion", "查询录入批次"],
  ["/api/ingestion/batches/{batchId}/archive", ["get"], "ingestion", "下载录入批次原始归档", { binary: true }],
  ["/api/ingestion/records", ["get", "post"], "ingestion", "查询或创建录入记录"],
  ["/api/ingestion/records/bulk-action", ["post"], "ingestion", "批量处理录入记录"],
  ["/api/ingestion/records/publish-all", ["post"], "ingestion", "发布全部待审核记录"],
  ["/api/ingestion/records/{recordType}/{recordId}", ["get", "put", "delete"], "ingestion", "查询、更新或删除录入记录"],
  ["/api/ingestion/records/{recordType}/{recordId}/publish", ["post"], "ingestion", "发布单条录入记录", { body: false }],
  ["/api/ingestion/records/dark-web/{recordId}/files", ["get", "post"], "ingestion", "查询或上传暗网记录附件", { multipart: true }],
  ["/api/ingestion/records/dark-web/{recordId}/files/{fileId}", ["delete"], "ingestion", "删除暗网记录附件", { body: false }],

  ["/api/fingerprint-icons", ["get", "post"], "fingerprints", "查询或创建指纹图标"],
  ["/api/fingerprint-icons/map", ["get"], "fingerprints", "获取指纹图标映射"],
  ["/api/fingerprint-icons/catalog/sync", ["post"], "fingerprints", "同步指纹图标目录", { body: false }],
  ["/api/fingerprint-icons/{iconId}", ["put", "delete"], "fingerprints", "更新或删除指纹图标"],
  ["/api/fingerprint-icons/{iconId}/icon", ["get"], "fingerprints", "下载指纹图标", { binary: true }],
  ["/api/fingerprint-watch-groups", ["get", "post"], "fingerprints", "查询或创建指纹监测组"],
  ["/api/fingerprint-watch-groups/{groupId}", ["put", "delete"], "fingerprints", "更新或删除指纹监测组"],

  ["/api/vulnerabilities", ["get", "post"], "vulnerabilities", "查询或创建漏洞记录"],
  ["/api/vulnerabilities/import", ["post"], "vulnerabilities", "导入漏洞清单", { multipart: true }],
  ["/api/vulnerabilities/bulk-action", ["post"], "vulnerabilities", "批量处理漏洞记录"],
  ["/api/vulnerabilities/bulk-delete", ["post"], "vulnerabilities", "批量删除漏洞记录"],
  ["/api/vulnerabilities/publish-all", ["post"], "vulnerabilities", "发布全部待审核漏洞"],
  ["/api/vulnerabilities/major-event", ["get"], "vulnerabilities", "查询重大漏洞事件"],
  ["/api/vulnerabilities/{vulnerabilityId}", ["get", "put", "delete"], "vulnerabilities", "查询、更新或删除漏洞记录"],
  ["/api/vulnerabilities/{vulnerabilityId}/publish", ["post"], "vulnerabilities", "发布漏洞记录", { body: false }],
  ["/api/vulnerability-alerts", ["get"], "vulnerabilities", "查询资产漏洞告警"],
  ["/api/vulnerability-alerts/{alertId}", ["put"], "vulnerabilities", "更新资产漏洞告警"],
  ["/api/vulnerability-alerts/recompute", ["post"], "vulnerabilities", "重新计算资产漏洞告警", { body: false }],

  ["/api/intelligence", ["get"], "portal", "分页查询情报"],
  ["/api/intelligence/{intelligenceId}", ["get"], "portal", "查询情报详情"],
  ["/api/dashboard/portal", ["get"], "portal", "查询 Portal 仪表盘"],
  ["/api/dashboard/admin", ["get"], "operations", "查询运营仪表盘"],
  ["/api/dark-web/events", ["get"], "portal", "分页查询暗网事件"],
  ["/api/dark-web/events/{eventId}", ["get"], "portal", "查询暗网事件详情"],
  ["/api/dark-web/events/{eventId}/files/{fileId}/content", ["get"], "portal", "下载暗网事件附件", { binary: true }],
  ["/api/dark-web/events/{eventId}/files/{fileId}/preview", ["get"], "portal", "预览暗网事件附件"],
  ["/api/article-images/{name}", ["get"], "portal", "读取情报文章图片", { public: true, binary: true }],
  ["/api/sensitive/records", ["get"], "portal", "分页查询敏感信息"],
  ["/api/assets/records", ["get"], "portal", "分页查询资产记录"],
  ["/api/assets/reports/latest", ["get"], "portal", "查询最新资产报告"],
  ["/api/assets/reports/{reportId}/data", ["get"], "portal", "读取资产报告结构化数据"],
  ["/api/assets/reports/{reportId}/content", ["get"], "portal", "下载资产报告", { binary: true }],
  ["/api/credentials/subscriptions", ["get"], "portal", "查询凭据订阅"],
  ["/api/credentials/results", ["get"], "portal", "分页查询凭据结果"],
  ["/api/credentials/records", ["post"], "ingestion", "创建凭据记录", { status: 201 }],
  ["/api/credentials/records/{recordId}", ["put", "delete"], "ingestion", "更新或删除凭据记录"],
  ["/api/credentials/records/{recordId}/publish", ["post"], "ingestion", "发布凭据记录"],

  ["/api/connections", ["get", "post"], "connectors", "查询或创建连接器"],
  ["/api/connections/test-config", ["post"], "connectors", "测试未保存的连接器配置"],
  ["/api/connections/{connectionId}", ["get", "put", "delete"], "connectors", "查询、更新或删除连接器"],
  ["/api/connections/{connectionId}/{action}", ["post"], "connectors", "测试或同步连接器", { body: false }],
  ["/api/connector-providers", ["get"], "connectors", "查询连接器类型"],
  ["/api/integrations/watchvuln/sync", ["post"], "connectors", "接收 WatchVuln 定向同步通知", { connector: true }],
  ["/api/collection-jobs", ["get", "post"], "operations", "查询或创建采集任务"],
  ["/api/collection-jobs/{jobId}", ["put", "delete"], "operations", "更新或删除采集任务"],
  ["/api/collection-jobs/{jobId}/run", ["post"], "operations", "立即运行采集任务", { body: false, status: 202 }],
  ["/api/collection-runs", ["get"], "operations", "查询采集运行记录"],
  ["/api/worker-nodes", ["get", "post"], "operations", "查询或注册 Worker 节点"],
  ["/api/worker-nodes/{nodeId}", ["put", "delete"], "operations", "更新或清理 Worker 节点"],
  ["/api/background-tasks", ["get"], "operations", "查询后台任务与运行保障指标"],
  ["/api/background-tasks/{taskId}/schedule", ["put"], "operations", "更新后台任务计划"],
  ["/api/background-tasks/{taskId}/run", ["post"], "operations", "立即运行后台任务", { body: false, status: 202 }],
  ["/api/background-runs", ["get"], "operations", "查询后台运行记录"],
  ["/api/background-runs/{runId}", ["get"], "operations", "查询后台运行详情"]
];

function requestBody(options) {
  if (options.body === false) return undefined;
  if (options.multipart) {
    return {
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: {
              file: { type: "string", format: "binary" },
              targetId: { type: "string" }
            },
            required: ["file"]
          }
        }
      }
    };
  }
  return {
    required: true,
    content: {
      "application/json": {
        schema: options.schema ? { $ref: `#/components/schemas/${options.schema}` } : jsonSchema
      }
    }
  };
}

function pathParameters(path) {
  return [...path.matchAll(/\{([^}]+)\}/gu)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: match[1] === "version" ? { type: "integer", minimum: 1 } : { type: "string" }
  }));
}

function securityFor(options) {
  if (options.public) return [];
  if (options.edge) return [{ edgeOpenApiKey: [] }];
  if (options.connector) return [{ connectorToken: [] }];
  if (options.signed) return [];
  return [{ cloudBearer: [] }];
}

function operation(path, method, tag, summary, options) {
  const parameters = pathParameters(path);
  if (!options.public && !options.edge && !options.connector && !options.signed && path.startsWith("/api/")) {
    parameters.push({
      name: "X-Sentinel-Tenant-Id",
      in: "header",
      required: false,
      description: "访问租户业务数据时指定当前租户。",
      schema: { type: "string" }
    });
  }
  if (options.signed) {
    parameters.push(
      { name: "expires", in: "query", required: true, schema: { type: "integer" } },
      { name: "signature", in: "query", required: true, schema: { type: "string" } }
    );
  }
  const successStatus = String(options.status || (method === "post" ? 200 : 200));
  const success = options.binary
    ? { description: "二进制内容", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }
    : jsonResponse;
  const value = {
    tags: [tag],
    summary,
    operationId: `${method}_${path.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_|_$/gu, "")}`,
    security: securityFor(options),
    parameters,
    responses: { [successStatus]: success, ...errorResponses }
  };
  if (["post", "put", "patch"].includes(method) || (method === "delete" && options.deleteBody)) {
    const body = requestBody(options);
    if (body) value.requestBody = body;
  }
  return value;
}

export function createCloudOpenApiDocument({ serverUrl = "/" } = {}) {
  const paths = {};
  for (const [path, methods, tag, summary, options = {}] of routes) {
    paths[path] ||= {};
    for (const method of methods) paths[path][method] = operation(path, method, tag, summary, options);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Sentinel Cloud API",
      version: "0.1.0",
      description: "Sentinel 云端运营、采集、发布以及云地同步接口。管理接口使用 Bearer 会话令牌；地端接口使用部署级 OpenAPI Key。"
    },
    servers: [{ url: serverUrl }],
    tags: [
      ["system", "系统健康检查"], ["auth", "登录、会话与安全设置"], ["accounts", "账号与权限"],
      ["edge-management", "地端部署、许可证和快照管理"], ["edge-openapi", "地端机器访问接口"],
      ["targets", "监测对象"], ["ingestion", "数据录入与审核"], ["fingerprints", "指纹和图标"],
      ["vulnerabilities", "漏洞数据与资产告警"], ["portal", "租户 Portal 查询"],
      ["connectors", "第三方连接器"], ["operations", "任务调度与运行保障"]
    ].map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        cloudBearer: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "Cloud 登录接口返回的会话令牌。" },
        edgeOpenApiKey: { type: "http", scheme: "bearer", bearerFormat: "sentinel-edge-v2", description: "地端部署生成的完整 OpenAPI Key。" },
        connectorToken: { type: "http", scheme: "bearer", bearerFormat: "opaque", description: "连接器专用推送令牌。" }
      },
      schemas: {
        LoginRequest: {
          type: "object",
          required: ["account", "password", "captchaId", "captchaCode"],
          properties: {
            account: { type: "string" }, password: { type: "string", format: "password" },
            captchaId: { type: "string" }, captchaCode: { type: "string" }
          }
        },
        LicenseValidationRequest: {
          type: "object",
          required: ["licenseKey"],
          properties: { licenseKey: { type: "string", format: "password" } }
        },
        SyncStatusRequest: {
          type: "object",
          required: ["deploymentId", "tenantId", "status"],
          properties: {
            deploymentId: { type: "string" }, tenantId: { type: "string" }, version: { type: "integer" },
            status: { type: "string" }, message: { type: "string" }
          }
        }
      }
    }
  };
}

export function cloudSwaggerHtml({ openApiUrl = "/openapi.json" } = {}) {
  const encodedUrl = JSON.stringify(openApiUrl).replace(/</gu, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sentinel Cloud API - Swagger UI</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head><body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.ui=SwaggerUIBundle({url:${encodedUrl},dom_id:'#swagger-ui',deepLinking:true,displayRequestDuration:true,persistAuthorization:true,filter:true});</script>
</body></html>`;
}

export const cloudOpenApiRouteCatalog = routes;
