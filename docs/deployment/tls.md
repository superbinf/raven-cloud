# 传输加密

平台服务端使用 Node.js 原生 TLS 1.3，固定密码套件为 `TLS_AES_256_GCM_SHA384`，并启用 X25519/P-256 临时椭圆曲线。每次连接通过 ECDHE 协商新的会话密钥；URL、认证头、JSON、上传和下载都由同一条 TLS 通道保护。快照内容在此基础上继续使用已有的 AES-256-GCM/HKDF 业务层加密。

## 云端

生产启动前准备证书链和私钥，并设置：

```bash
export NODE_ENV=production
export SENTINEL_TLS_CERT_FILE=/etc/sentinel/tls/server.crt
export SENTINEL_TLS_KEY_FILE=/etc/sentinel/tls/server.key
export SENTINEL_PUBLIC_BASE_URL=https://ti.example.com
```

`SENTINEL_TLS_CERT_FILE` 应包含服务端证书和中间证书链；私钥必须只授予运行 API 和 Worker 的系统账号。生产环境缺少证书、私钥不匹配，或 `SENTINEL_PUBLIC_BASE_URL` 使用公网 HTTP 时，服务会拒绝启动。

## 地端

`.env.edge` 中的 `EDGE_TLS_CERT_HOST_PATH` 和 `EDGE_TLS_KEY_HOST_PATH` 指向宿主机证书文件。Compose 以只读方式挂载它们，容器监听 HTTPS，健康检查也使用 HTTPS。证书的 SAN 必须覆盖用户访问地端时使用的主机名；自签名证书应由企业 CA 签发或导入终端信任库。

```bash
curl --cacert /absolute/path/to/ca.crt https://127.0.0.1:8792/health
docker compose --env-file .env.edge -f docker-compose.edge.yml up -d --build
```

浏览器会自动携带 `Secure` 会话 Cookie。`EDGE_SECURE_COOKIES=true` 由 Compose 固定开启，不能通过环境变量关闭。

## 本机开发例外

未设置证书时，非生产模式允许服务使用 HTTP，且只为本机回环、`localhost` 和 `host.docker.internal` 保留此例外，以兼容本地 WatchVuln 控制台。所有公网云端、第三方连接器、对象存储和许可证地址仍必须使用 HTTPS。
