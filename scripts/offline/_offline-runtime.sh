#!/usr/bin/env bash
set -euo pipefail

offline_usage() {
  cat <<EOF
Sentinel ${OFFLINE_LABEL} ${OFFLINE_ARCH} 完整离线部署

用法：
  ./${OFFLINE_ENTRY_NAME} install <访问域名或IPv4> [HTTPS端口]
  ./${OFFLINE_ENTRY_NAME} init <访问域名或IPv4> [HTTPS端口]
  ./${OFFLINE_ENTRY_NAME} load
  ./${OFFLINE_ENTRY_NAME} start
  ./${OFFLINE_ENTRY_NAME} restart
  ./${OFFLINE_ENTRY_NAME} stop
  ./${OFFLINE_ENTRY_NAME} status
  ./${OFFLINE_ENTRY_NAME} logs
  ./${OFFLINE_ENTRY_NAME} config

install 会校验离线包、加载镜像、生成首次部署配置和自签名 TLS 证书，然后启动服务。
stop 只停止容器并保留数据卷。本脚本不会执行 docker compose down -v。
EOF
}

offline_require_runtime() {
  command -v docker >/dev/null 2>&1 || { echo "未安装 Docker。" >&2; exit 127; }
  command -v openssl >/dev/null 2>&1 || { echo "未安装 OpenSSL。" >&2; exit 127; }
  command -v sha256sum >/dev/null 2>&1 || { echo "未安装 sha256sum。" >&2; exit 127; }
  docker compose version >/dev/null 2>&1 || { echo "当前 Docker 不支持 docker compose。" >&2; exit 127; }
  docker info >/dev/null 2>&1 || { echo "Docker 服务未运行或当前用户无访问权限。" >&2; exit 1; }

  local machine
  machine="$(uname -m)"
  case "$OFFLINE_ARCH:$machine" in
    amd64:x86_64|amd64:amd64|arm64:aarch64|arm64:arm64) ;;
    *) echo "离线包架构为 ${OFFLINE_ARCH}，当前主机架构为 ${machine}。" >&2; exit 2 ;;
  esac
}

offline_compose() {
  export "$OFFLINE_ENV_POINTER=$OFFLINE_ENV_FILE"
  docker compose --env-file "$OFFLINE_ENV_FILE" -f "$OFFLINE_COMPOSE_FILE" "$@"
}

offline_env_value() {
  local key="$1"
  awk -v key="$key" '
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      line=$0
      sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", line)
      sub("\\r$", "", line)
      value=line
    }
    END {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((value ~ /^".*"$/) || (value ~ /^\047.*\047$/)) value=substr(value, 2, length(value)-2)
      print value
    }
  ' "$OFFLINE_ENV_FILE"
}

offline_random_hex() {
  local bytes="${1:-24}"
  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

offline_generated_password() {
  printf 'Aa1!%s' "$(offline_random_hex 16)"
}

offline_generate_certificate() {
  local certificate_name="$1" hostname="$2"
  local tls_dir="$OFFLINE_ROOT/tls"
  local config_file="$tls_dir/${certificate_name}-openssl.cnf"
  local san="DNS:$hostname"
  if [[ "$hostname" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then san="IP:$hostname"; fi

  mkdir -p "$tls_dir"
  chmod 700 "$tls_dir"
  cat > "$config_file" <<EOF
[req]
distinguished_name = subject
x509_extensions = server
prompt = no

[subject]
CN = $hostname

[server]
subjectAltName = $san
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
EOF
  OFFLINE_GENERATED_CERT_PATH="$tls_dir/${certificate_name}.crt"
  OFFLINE_GENERATED_KEY_PATH="$tls_dir/${certificate_name}.key"
  openssl req -x509 -nodes -newkey rsa:3072 -sha256 -days 825 \
    -config "$config_file" \
    -keyout "$OFFLINE_GENERATED_KEY_PATH" \
    -out "$OFFLINE_GENERATED_CERT_PATH" >/dev/null 2>&1
  chmod 600 "$OFFLINE_GENERATED_KEY_PATH"
  chmod 644 "$OFFLINE_GENERATED_CERT_PATH"
}

offline_assert_fresh_install() {
  local volume found=0
  for volume in $OFFLINE_VOLUMES; do
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      echo "检测到已有数据卷：$volume" >&2
      found=1
    fi
  done
  if [ "$found" -eq 1 ]; then
    echo "当前目录缺少原生产配置，不能用新密钥接管已有数据卷。" >&2
    echo "请恢复原配置，或在完成备份和销毁审批后处理旧数据卷。" >&2
    exit 2
  fi
}

offline_verify_package() {
  echo "校验离线包完整性..."
  (cd "$OFFLINE_ROOT" && sha256sum -c SHA256SUMS)
}

offline_load_images() {
  local archive image architecture
  offline_verify_package
  echo "加载 ${OFFLINE_LABEL} 离线镜像..."
  for archive in $OFFLINE_IMAGE_ARCHIVES; do
    [ -f "$OFFLINE_ROOT/$archive" ] || { echo "镜像归档不存在：$archive" >&2; exit 2; }
    docker load -i "$OFFLINE_ROOT/$archive"
  done
  for image in $OFFLINE_REQUIRED_IMAGES; do
    architecture="$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null)" || {
      echo "镜像加载后不存在：$image" >&2
      exit 2
    }
    [ "$architecture" = "$OFFLINE_ARCH" ] || {
      echo "镜像架构不匹配：$image 为 $architecture，需要 $OFFLINE_ARCH。" >&2
      exit 2
    }
  done
  echo "离线镜像加载完成。"
}

offline_require_config() {
  [ -f "$OFFLINE_ENV_FILE" ] || {
    echo "缺少生产配置：$OFFLINE_ENV_FILE" >&2
    echo "请先执行 ./${OFFLINE_ENTRY_NAME} init <访问地址> [端口]。" >&2
    exit 2
  }
}

offline_validate_config() {
  local key value candidate
  offline_require_config
  for key in $OFFLINE_REQUIRED_KEYS; do
    value="$(offline_env_value "$key")"
    [ -n "$value" ] || { echo "配置缺少必填项：$key" >&2; exit 2; }
    if [[ "$value" =~ replace-with|example\.com|absolute/path ]]; then
      echo "配置仍包含示例值：$key" >&2
      exit 2
    fi
  done
  if [ -n "${OFFLINE_HTTPS_URL_KEY:-}" ] && [[ "$(offline_env_value "$OFFLINE_HTTPS_URL_KEY")" != https://* ]]; then
    echo "$OFFLINE_HTTPS_URL_KEY 必须使用 HTTPS。" >&2
    exit 2
  fi
  for key in $OFFLINE_FILE_KEYS; do
    value="$(offline_env_value "$key")"
    if [[ "$value" = /* ]]; then candidate="$value"; else candidate="$OFFLINE_ROOT/$value"; fi
    [ -f "$candidate" ] || { echo "$key 指向的文件不存在：$candidate" >&2; exit 2; }
  done
  offline_compose config --quiet
}

offline_start() {
  offline_validate_config
  offline_compose up -d --no-build --remove-orphans --wait --wait-timeout 240
  offline_show_url
}

offline_restart() {
  offline_validate_config
  offline_compose up -d --no-build --force-recreate --remove-orphans --wait --wait-timeout 240
  offline_show_url
}

offline_main() {
  local action="${1:-help}" hostname="${2:-}" port="${3:-$OFFLINE_DEFAULT_PORT}"
  case "$action" in help|-h|--help) offline_usage; exit 0 ;; esac
  offline_require_runtime
  case "$action" in
    install)
      if [ ! -f "$OFFLINE_ENV_FILE" ]; then
        [ -n "$hostname" ] || { offline_usage >&2; exit 2; }
        offline_assert_fresh_install
      fi
      offline_load_images
      if [ ! -f "$OFFLINE_ENV_FILE" ]; then offline_initialize_config "$hostname" "$port"; fi
      offline_start
      ;;
    init)
      [ -n "$hostname" ] || { offline_usage >&2; exit 2; }
      if [ -f "$OFFLINE_ENV_FILE" ]; then
        echo "配置已存在，未覆盖：$OFFLINE_ENV_FILE"
      else
        offline_assert_fresh_install
        offline_initialize_config "$hostname" "$port"
      fi
      ;;
    load) offline_load_images ;;
    start) offline_start ;;
    restart) offline_restart ;;
    stop)
      offline_require_config
      offline_compose down --remove-orphans
      echo "${OFFLINE_LABEL}已停止，所有数据卷均已保留。"
      ;;
    status)
      offline_require_config
      echo "离线包版本：$OFFLINE_VERSION"
      echo "应用镜像：$OFFLINE_APP_IMAGE:$OFFLINE_IMAGE_TAG"
      offline_compose ps
      ;;
    logs)
      offline_require_config
      offline_compose logs --tail 200 --follow
      ;;
    config)
      offline_validate_config
      echo "${OFFLINE_LABEL}离线部署配置校验通过。"
      ;;
    *) offline_usage >&2; exit 2 ;;
  esac
}
