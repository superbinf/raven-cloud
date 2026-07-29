param([string]$Action = "start")

$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "_docker-deploy.ps1") `
  -Label "运营平台" `
  -ComposeFileName "docker-compose.cloud.production.yml" `
  -EnvVariableName "SENTINEL_CLOUD_ENV_FILE" `
  -DefaultEnvName ".env.production" `
  -ExampleEnvName ".env.production.example" `
  -EntryName "cloud-docker.ps1" `
  -RequiredKeys @("POSTGRES_PASSWORD", "DATABASE_URL", "REDIS_URL", "SENTINEL_SECRET", "SENTINEL_ADMIN_PASSWORD", "SENTINEL_PORTAL_PASSWORD", "SENTINEL_PUBLIC_BASE_URL", "SENTINEL_TLS_CERT_HOST_PATH", "SENTINEL_TLS_KEY_HOST_PATH") `
  -FileKeys @("SENTINEL_TLS_CERT_HOST_PATH", "SENTINEL_TLS_KEY_HOST_PATH") `
  -HttpsUrlKey "SENTINEL_PUBLIC_BASE_URL" `
  -PublicUrlKey "SENTINEL_PUBLIC_BASE_URL" `
  -UrlPath "/admin" `
  -Action $Action
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
