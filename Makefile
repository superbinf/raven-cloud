.DEFAULT_GOAL := help

.PHONY: help dev dev-init dev-install dev-status dev-logs dev-down offline-amd64 offline-arm64 offline-plan offline-test

help:
	@echo "Raven Cloud 本机开发命令"
	@echo ""
	@echo "  make dev          启动云端及开发基础设施"
	@echo "  make dev-init     生成或显示本地开发配置"
	@echo "  make dev-install  按 lockfile 安装 Cloud workspace 依赖"
	@echo "  make dev-status   查看 PostgreSQL、Redis 和本地服务状态"
	@echo "  make dev-logs     查看 PostgreSQL、Redis 日志"
	@echo "  make dev-down     停止开发基础设施（保留数据卷）"
	@echo ""
	@echo "Raven Cloud 离线交付命令"
	@echo ""
	@echo "  make offline-amd64 VERSION=0.3.1  构建 Linux AMD64 完整离线包"
	@echo "  make offline-arm64 VERSION=0.3.1  构建 Linux ARM64 完整离线包"
	@echo "  make offline-plan VERSION=0.3.1   预览离线构建，不调用 Docker"
	@echo "  make offline-test                  测试离线打包逻辑"

dev:
	@node scripts/dev.mjs start

dev-init:
	@node scripts/dev.mjs config

dev-install:
	@node scripts/dev.mjs install

dev-status:
	@node scripts/dev.mjs status

dev-logs:
	@node scripts/dev.mjs logs

dev-down:
	@node scripts/dev.mjs down

offline-amd64:
	@test -n "$(VERSION)" || { echo "缺少 VERSION，例如：make offline-amd64 VERSION=0.3.1" >&2; exit 2; }
	@node scripts/build-offline.mjs --version "$(VERSION)" --arch amd64 $(if $(filter 1 true yes,$(ALLOW_DIRTY)),--allow-dirty,) $(if $(filter 1 true yes,$(NO_CACHE)),--no-cache,)

offline-arm64:
	@test -n "$(VERSION)" || { echo "缺少 VERSION，例如：make offline-arm64 VERSION=0.3.1" >&2; exit 2; }
	@node scripts/build-offline.mjs --version "$(VERSION)" --arch arm64 $(if $(filter 1 true yes,$(ALLOW_DIRTY)),--allow-dirty,) $(if $(filter 1 true yes,$(NO_CACHE)),--no-cache,)

offline-plan:
	@test -n "$(VERSION)" || { echo "缺少 VERSION，例如：make offline-plan VERSION=0.3.1" >&2; exit 2; }
	@node scripts/build-offline.mjs --version "$(VERSION)" --arch amd64 --dry-run

offline-test:
	@node --test scripts/build-offline.test.mjs
