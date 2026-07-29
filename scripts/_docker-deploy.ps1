param(
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$ComposeFileName,
  [Parameter(Mandatory = $true)][string]$EnvVariableName,
  [Parameter(Mandatory = $true)][string]$DefaultEnvName,
  [Parameter(Mandatory = $true)][string]$ExampleEnvName,
  [Parameter(Mandatory = $true)][string]$EntryName,
  [Parameter(Mandatory = $true)][string[]]$RequiredKeys,
  [string[]]$FileKeys = @(),
  [string]$HttpsUrlKey = "",
  [string]$PublicUrlKey = "",
  [string]$PortKey = "",
  [string]$DefaultPort = "",
  [string]$UrlPath = "",
  [ValidateSet("init", "build", "start", "restart", "stop", "status", "logs", "config", "help")][string]$Action = "start"
)

$ErrorActionPreference = "Stop"
$RootDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ComposeFile = Join-Path $RootDir $ComposeFileName
$configuredEnvFile = [Environment]::GetEnvironmentVariable($EnvVariableName, "Process")
$EnvFile = if ($configuredEnvFile) { $configuredEnvFile } else { Join-Path $RootDir $DefaultEnvName }
$ExampleFile = Join-Path $RootDir $ExampleEnvName

function Show-Usage {
  Write-Host "Sentinel $Label Docker 快捷部署"
  Write-Host ""
  Write-Host "用法：$EntryName [init|build|start|restart|stop|status|logs|config]"
  Write-Host "  init     创建生产配置模板，不覆盖已有配置"
  Write-Host "  build    校验配置并构建 Docker 镜像，不启动容器"
  Write-Host "  start    校验配置、构建镜像并启动服务"
  Write-Host "  restart  重新构建镜像并强制重建容器"
  Write-Host "  stop     停止并删除容器，保留所有数据卷"
  Write-Host "  status   查看容器状态"
  Write-Host "  logs     持续查看最近 200 行日志"
  Write-Host "  config   校验生产配置和 Compose 文件"
}

function Get-EnvValues {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
      $value = $Matches[2]
      if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
      $values[$Matches[1]] = $value
    }
  }
  return $values
}

function Require-Config {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "未找到${Label}配置：$EnvFile。请先运行 init，填写配置后再启动。" }
}

function Invoke-Compose([string[]]$ComposeArgs) {
  [Environment]::SetEnvironmentVariable($EnvVariableName, $EnvFile, "Process")
  & docker compose --env-file $EnvFile -f $ComposeFile @ComposeArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Test-Config {
  Require-Config
  $values = Get-EnvValues
  $missing = @($RequiredKeys | Where-Object { -not $values.ContainsKey($_) -or [string]::IsNullOrWhiteSpace($values[$_]) })
  $placeholders = @($RequiredKeys | Where-Object { $values.ContainsKey($_) -and $values[$_] -match 'replace-with|example\.com|absolute[/\\]path' })
  if ($missing.Count -gt 0) { throw "配置缺少必填项：$($missing -join ', ')" }
  if ($placeholders.Count -gt 0) { throw "配置仍包含示例值：$($placeholders -join ', ')" }
  if ($HttpsUrlKey -and -not $values[$HttpsUrlKey].StartsWith("https://")) { throw "$HttpsUrlKey 必须使用 HTTPS。" }
  foreach ($key in $FileKeys) {
    $candidate = if ([IO.Path]::IsPathRooted($values[$key])) { $values[$key] } else { Join-Path $RootDir $values[$key] }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "$key 指向的文件不存在：$candidate" }
  }
  Invoke-Compose @("config", "--quiet")
  return $values
}

if ($Action -eq "help") { Show-Usage; exit 0 }
if ($Action -eq "init") {
  if (Test-Path -LiteralPath $EnvFile) { Write-Host "配置已存在，未覆盖：$EnvFile" }
  else {
    Copy-Item -LiteralPath $ExampleFile -Destination $EnvFile
    Write-Host "已创建配置：$EnvFile"
    Write-Host "请替换密码、随机密钥、域名和 TLS 证书路径，然后运行 start。"
  }
  exit 0
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "未安装 Docker。" }
& docker compose version *> $null
if ($LASTEXITCODE -ne 0) { throw "当前 Docker 不支持 docker compose。" }

$values = $null
if ($Action -in @("build", "start", "restart", "config")) { $values = Test-Config } else { Require-Config }
switch ($Action) {
  "build" { Invoke-Compose @("build", "--pull"); Write-Host "$Label Docker 镜像构建完成。" }
  "start" { Invoke-Compose @("build", "--pull"); Invoke-Compose @("up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "240") }
  "restart" { Invoke-Compose @("build", "--pull"); Invoke-Compose @("up", "-d", "--force-recreate", "--remove-orphans", "--wait", "--wait-timeout", "240") }
  "stop" { Invoke-Compose @("down", "--remove-orphans"); Write-Host "${Label}已停止，数据卷已保留。" }
  "status" { Invoke-Compose @("ps") }
  "logs" { Invoke-Compose @("logs", "--tail", "200", "--follow") }
  "config" { Write-Host "$Label Docker 配置校验通过。" }
}

if ($Action -in @("start", "restart")) {
  if ($PublicUrlKey) { Write-Host "$Label 已启动：$($values[$PublicUrlKey].TrimEnd('/'))$UrlPath" }
  else {
    $port = if ($values.ContainsKey($PortKey) -and $values[$PortKey]) { $values[$PortKey] } else { $DefaultPort }
    Write-Host "$Label 已启动：https://127.0.0.1:$port$UrlPath"
  }
}
