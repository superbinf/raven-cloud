# Sentinel 运营平台 Docker 部署

本交付包仅包含运营后台 `admin-web`、云端 API/Worker `api-server` 以及它们依赖的共享包，不包含地端 Portal 和 Edge Server 源码。

## 部署

Linux / macOS：

```bash
./scripts/cloud-docker.sh init
# 编辑 .env.production，替换所有示例值并配置 TLS 证书绝对路径
./scripts/cloud-docker.sh config
./scripts/cloud-docker.sh start
```

Windows PowerShell：

```powershell
.\scripts\cloud-docker.ps1 init
# 编辑 .env.production
.\scripts\cloud-docker.ps1 config
.\scripts\cloud-docker.ps1 start
```

运营后台与 API 使用同一 HTTPS 地址，默认端口为 `8787`。容器包括 PostgreSQL、Redis、迁移任务、API 以及 scheduler、snapshot、io、maintenance 四类 Worker。

## 运维

```bash
./scripts/cloud-docker.sh build
./scripts/cloud-docker.sh status
./scripts/cloud-docker.sh logs
./scripts/cloud-docker.sh restart
./scripts/cloud-docker.sh stop
```

`stop` 不删除 PostgreSQL、Redis 和业务文件数据卷。不得使用 `docker compose down -v`，除非已完成数据销毁审批。
