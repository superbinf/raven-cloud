#!/usr/bin/env bash
set -euo pipefail

docker_deploy() {
  local action="${1:-start}"
  local root_dir env_file example_file compose_file entry_name
  local key value candidate port
  local -a required_keys file_keys missing placeholders

  : "${DEPLOY_LABEL:?}"
  : "${DEPLOY_COMPOSE_FILE:?}"
  : "${DEPLOY_ENV_POINTER:?}"
  : "${DEPLOY_ENV_DEFAULT:?}"
  : "${DEPLOY_ENV_EXAMPLE:?}"
  : "${DEPLOY_REQUIRED_KEYS:?}"
  : "${DEPLOY_ENTRY_NAME:?}"

  root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
  env_file="${!DEPLOY_ENV_POINTER:-$root_dir/$DEPLOY_ENV_DEFAULT}"
  example_file="$root_dir/$DEPLOY_ENV_EXAMPLE"
  compose_file="$root_dir/$DEPLOY_COMPOSE_FILE"
  entry_name="$DEPLOY_ENTRY_NAME"
  read -r -a required_keys <<< "$DEPLOY_REQUIRED_KEYS"
  read -r -a file_keys <<< "${DEPLOY_FILE_KEYS:-}"

  usage() {
    cat <<EOF
Sentinel ${DEPLOY_LABEL} Docker 快捷部署

用法：$entry_name [init|build|start|restart|stop|status|logs|config]

  init     创建生产配置模板，不覆盖已有配置
  build    校验配置并构建 Docker 镜像，不启动容器
  start    校验配置、构建镜像并启动服务
  restart  重新构建镜像并强制重建容器
  stop     停止并删除容器，保留所有数据卷
  status   查看容器状态
  logs     持续查看最近 200 行日志
  config   校验生产配置和 Compose 文件
EOF
  }

  env_value() {
    local env_key="$1"
    awk -v key="$env_key" '
      $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
        line=$0
        sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "", line)
        sub("\\r$", "", line)
        value=line
      }
      END {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        if ((value ~ /^\".*\"$/) || (value ~ /^\047.*\047$/)) value=substr(value, 2, length(value)-2)
        print value
      }
    ' "$env_file"
  }

  compose() {
    export "$DEPLOY_ENV_POINTER=$env_file"
    docker compose --env-file "$env_file" -f "$compose_file" "$@"
  }

  require_config() {
    if [ ! -f "$env_file" ]; then
      echo "未找到${DEPLOY_LABEL}配置：$env_file" >&2
      echo "请先运行 $entry_name init，填写配置后再启动。" >&2
      exit 2
    fi
  }

  validate_config() {
    require_config
    missing=()
    placeholders=()
    for key in "${required_keys[@]}"; do
      value="$(env_value "$key")"
      if [ -z "$value" ]; then
        missing+=("$key")
      elif [[ "$value" =~ replace-with|example\.com|absolute/path ]]; then
        placeholders+=("$key")
      fi
    done
    if [ "${#missing[@]}" -gt 0 ]; then
      echo "配置缺少必填项：${missing[*]}" >&2
      exit 2
    fi
    if [ "${#placeholders[@]}" -gt 0 ]; then
      echo "配置仍包含示例值：${placeholders[*]}" >&2
      exit 2
    fi
    if [ -n "${DEPLOY_HTTPS_URL_KEY:-}" ] && [[ "$(env_value "$DEPLOY_HTTPS_URL_KEY")" != https://* ]]; then
      echo "$DEPLOY_HTTPS_URL_KEY 必须使用 HTTPS。" >&2
      exit 2
    fi
    for key in "${file_keys[@]}"; do
      value="$(env_value "$key")"
      if [[ "$value" = /* ]]; then candidate="$value"; else candidate="$root_dir/$value"; fi
      if [ ! -f "$candidate" ]; then
        echo "$key 指向的文件不存在：$candidate" >&2
        exit 2
      fi
    done
    compose config --quiet
  }

  show_url() {
    if [ -n "${DEPLOY_PUBLIC_URL_KEY:-}" ]; then
      value="$(env_value "$DEPLOY_PUBLIC_URL_KEY")"
      echo "${DEPLOY_LABEL}已启动：${value%/}${DEPLOY_URL_PATH:-}"
    else
      port="$(env_value "$DEPLOY_PORT_KEY")"
      echo "${DEPLOY_LABEL}已启动：https://127.0.0.1:${port:-${DEPLOY_DEFAULT_PORT}}${DEPLOY_URL_PATH:-}"
    fi
  }

  case "$action" in
    help|-h|--help) usage ;;
    init)
      if [ -e "$env_file" ]; then
        echo "配置已存在，未覆盖：$env_file"
      else
        cp "$example_file" "$env_file"
        chmod 600 "$env_file"
        echo "已创建配置：$env_file"
        echo "请替换密码、随机密钥、域名和 TLS 证书路径，然后运行 $entry_name start。"
      fi
      ;;
    build|start|restart|stop|status|logs|config)
      command -v docker >/dev/null 2>&1 || { echo "未安装 Docker。" >&2; exit 127; }
      docker compose version >/dev/null
      if [ "$action" = "build" ] || [ "$action" = "start" ] || [ "$action" = "restart" ] || [ "$action" = "config" ]; then validate_config; else require_config; fi
      case "$action" in
        build) compose build --pull; echo "${DEPLOY_LABEL} Docker 镜像构建完成。" ;;
        start) compose build --pull; compose up -d --remove-orphans --wait --wait-timeout 240; show_url ;;
        restart) compose build --pull; compose up -d --force-recreate --remove-orphans --wait --wait-timeout 240; show_url ;;
        stop) compose down --remove-orphans; echo "${DEPLOY_LABEL}已停止，数据卷已保留。" ;;
        status) compose ps ;;
        logs) compose logs --tail 200 --follow ;;
        config) echo "${DEPLOY_LABEL} Docker 配置校验通过。" ;;
      esac
      ;;
    *) usage >&2; exit 2 ;;
  esac
}
