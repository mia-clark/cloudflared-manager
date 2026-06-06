# PR-02 pkg/ 清理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 在 PR-01 重命名基础上，把 `pkg/` 下纯 frp 业务相关的子包清理掉：(1) `pkg/consts/state.go` 中的 `ConfigState` 部分**搬迁**到新包 `pkg/cfdstate/`（去掉 `ProxyState`、改 package 名、更新注释）；(2) **删除** `pkg/consts/` 整个目录（含 `config.go` 的 frp 专有常量与已搬迁的 `state.go`）；(3) **删除** `pkg/sec/`（SHA1 弱哈希工具，0 调用）；(4) **删除** `pkg/util/misc.go::PruneByTag` 函数（reflect-based tag filter，0 业务调用）。同步更新唯一 2 个引用点 `internal/manager/{manager,instance}.go`。

**Architecture:** 拆三件事：rename（`pkg/consts` → `pkg/cfdstate`，仅保留 ConfigState）、delete（pkg/consts 残余 + pkg/sec + PruneByTag）、re-wire（manager 2 个文件的 import + 符号）。完成后 `go vet` / `go test` / `go build` 全绿，二进制行为不变（manager 的状态机使用的是 ConfigState 类型与 4 个枚举值，只换包名/类型限定符）。

**Tech Stack:** Go 1.25 std lib only。无新依赖。

---

## 文件结构总览

| 路径 | 动作 | 说明 |
|---|---|---|
| `pkg/cfdstate/state.go` | **Create** | 新 package；只含 ConfigState 类型 + 5 个枚举（沿用现有 iota 值不变以保持二进制行为一致）；注释从 "FRP daemon" 改 "cloudflared instance" |
| `pkg/consts/state.go` | **Delete** | 内容已搬迁 |
| `pkg/consts/config.go` | **Delete** | frp 专有常量（Protocols/ProxyTypes/PluginTypes/AuthToken/STUN/Bandwidth/LogLevel），grep 全仓 0 业务引用 |
| `pkg/consts/` 目录 | **Delete** | 整个删空 |
| `pkg/sec/passwd.go` | **Delete** | SHA1+Base64，0 调用 |
| `pkg/sec/passwd_test.go` | **Delete** | 跟随 |
| `pkg/sec/` 目录 | **Delete** | 整个删空 |
| `pkg/util/misc.go` | **Modify** | 删 `PruneByTag` 函数 + 内部 `prune` 辅助 + `import "reflect"`；保留 `GetMapWithoutPrefix` / `MoveSlice` / `ByteCountIEC` |
| `pkg/util/misc_test.go` | **Modify** | 删 `tagTest` 结构 + `TestPruneByTag` 函数；如该测试是文件唯一内容则整文件删除 |
| `internal/manager/manager.go` | **Modify** | import 路径 `pkg/consts` → `pkg/cfdstate`；3 处 `consts.ConfigStateStarted` → `cfdstate.ConfigStateStarted` |
| `internal/manager/instance.go` | **Modify** | import + 19 处 `consts.ConfigState*` 符号引用替换为 `cfdstate.ConfigState*` |

**绝不动**：`pkg/config/server.go`（PR-03）、`pkg/version`、`pkg/util/file.go / file_filtered.go / strings.go`、`internal/api/*`、`web/*`、`Makefile / Dockerfile / .goreleaser.yml / workflows`、`services/frps.go`、`fatedier/frp` 依赖。

---

## Task 1：基线校验

**Files:** 无修改

- [ ] **Step 1.1 确认当前在 feature 分支 + 工作树干净**

```bash
cd /d/Github_Codes_mia-clark/cloudflared-manager
git branch --show-current
git status
```

Expected: 分支 `feature/pr01-bootstrap-rename`，working tree clean。

> 注意：PR-02 在同一分支上做（不另开分支），因为 PR-01 还没合 main。如果 PR-01 已合 main，应当 `git checkout main && git pull && git checkout -b feature/pr02-pkg-cleanup`。当前场景沿用 feature/pr01 分支继续叠加 commit。

- [ ] **Step 1.2 基线 vet+test+build 全绿**

```bash
go vet ./... && go test ./... && go build -o /tmp/baseline-cfdmgrd ./cmd/cfdmgrd && rm -f /tmp/baseline-cfdmgrd
```

Expected: 三命令依次 exit 0。失败 → BLOCKED。

- [ ] **Step 1.3 记录基线 grep 数字（用于后续对账）**

```bash
grep -rln 'pkg/consts' --include='*.go' . | wc -l    # 期望 2（manager + instance）
grep -rln 'pkg/sec' --include='*.go' . | wc -l       # 期望 0
grep -rln 'PruneByTag' --include='*.go' . | wc -l    # 期望 2（misc.go + misc_test.go）
grep -rn 'consts\.' --include='*.go' internal/manager/ | wc -l    # 期望 23
```

---

## Task 2：创建 pkg/cfdstate

**Files:**
- Create: `pkg/cfdstate/state.go`

- [ ] **Step 2.1 创建目录与文件**

```bash
mkdir -p pkg/cfdstate
```

将以下完整内容写入 `pkg/cfdstate/state.go`：

```go
// Package cfdstate defines the lifecycle states used by the manager for
// each cloudflared instance.
//
// The iota values are intentionally preserved from the previous
// pkg/consts.ConfigState typedef so that any persisted snapshot or
// existing log/event payload (which only ever emits the string form via
// the manager) continues to round-trip unambiguously across this rename.
package cfdstate

// ConfigState is the lifecycle state of a single cloudflared instance.
// The zero value (ConfigStateUnknown) is reserved for "not yet observed"
// and should not appear in normal operation.
type ConfigState int

const (
	ConfigStateUnknown ConfigState = iota
	ConfigStateStarted
	ConfigStateStopped
	ConfigStateStarting
	ConfigStateStopping
)
```

- [ ] **Step 2.2 单包 vet**

```bash
go vet ./pkg/cfdstate/...
```

Expected: exit 0，无输出。

- [ ] **Step 2.3 确认 ConfigState 5 个枚举值的整数值与旧版一致**

```bash
go run -v ./pkg/cfdstate 2>&1 || true
cat pkg/cfdstate/state.go | grep -E '^\s*ConfigState'
```

人工核对：5 行常量；iota 从 ConfigStateUnknown=0 开始递增到 ConfigStateStopping=4。

---

## Task 3：替换 manager 引用

**Files:**
- Modify: `internal/manager/instance.go`
- Modify: `internal/manager/manager.go`

- [ ] **Step 3.1 用 sed 一次性替换 import 路径 + 符号引用**

```bash
sed -i \
  -e 's|"github.com/mia-clark/cloudflared-manager/pkg/consts"|"github.com/mia-clark/cloudflared-manager/pkg/cfdstate"|g' \
  -e 's|consts\.ConfigState|cfdstate.ConfigState|g' \
  internal/manager/instance.go internal/manager/manager.go
```

- [ ] **Step 3.2 对账：旧符号必须 0 命中**

```bash
grep -n 'consts\.' internal/manager/instance.go internal/manager/manager.go
```

Expected: 无输出（exit 1）。

```bash
grep -n 'pkg/consts' internal/manager/instance.go internal/manager/manager.go
```

Expected: 无输出。

```bash
grep -cn 'cfdstate\.ConfigState' internal/manager/instance.go internal/manager/manager.go
```

Expected stdout：
```
internal/manager/instance.go:20
internal/manager/manager.go:3
```

（即 instance.go 20 处、manager.go 3 处；总数 23，对账基线 Step 1.3 数字）

- [ ] **Step 3.3 vet 验证**

```bash
go vet ./internal/manager/...
```

Expected: exit 0。

---

## Task 4：删 pkg/consts

**Files:**
- Delete: `pkg/consts/state.go`
- Delete: `pkg/consts/config.go`
- Delete: `pkg/consts/` 目录

- [ ] **Step 4.1 git 删除两文件 + 移除空目录**

```bash
git rm pkg/consts/state.go pkg/consts/config.go
rmdir pkg/consts
ls -la pkg/ | grep -v 'consts'
```

Expected: `pkg/` 下不再有 `consts/` 子目录。

- [ ] **Step 4.2 全仓对账：pkg/consts 0 命中**

```bash
grep -rn 'pkg/consts' --include='*.go' .
```

Expected: 无输出。

```bash
grep -rn 'consts\.' --include='*.go' .
```

Expected: 无输出。

> 如果有残留 → 这些是漏改的引用点。停下来用 Edit 工具按上下文修。

---

## Task 5：删 pkg/sec

**Files:**
- Delete: `pkg/sec/passwd.go`
- Delete: `pkg/sec/passwd_test.go`
- Delete: `pkg/sec/` 目录

- [ ] **Step 5.1 git 删两文件 + 移除空目录**

```bash
git rm pkg/sec/passwd.go pkg/sec/passwd_test.go
rmdir pkg/sec
ls -la pkg/ | grep -v 'sec'
```

Expected: `pkg/` 下不再有 `sec/` 子目录。

- [ ] **Step 5.2 全仓对账：pkg/sec 0 命中**

```bash
grep -rn 'pkg/sec' --include='*.go' .
grep -rn 'sec\.EncryptPassword' --include='*.go' .
```

Expected: 两条均无输出。

---

## Task 6：删 pkg/util.PruneByTag

**Files:**
- Modify: `pkg/util/misc.go`（删 `PruneByTag` + `prune` 内部 + `import "reflect"`）
- Modify: `pkg/util/misc_test.go`（删 `tagTest` + `TestPruneByTag`；本测试是文件唯一内容 → 整文件删除）

- [ ] **Step 6.1 用以下完整内容**整体覆盖** `pkg/util/misc.go`

```go
package util

import (
	"fmt"
	"strings"
)

func GetMapWithoutPrefix(set map[string]string, prefix string) map[string]string {
	m := make(map[string]string)

	for key, value := range set {
		if strings.HasPrefix(key, prefix) {
			m[strings.TrimPrefix(key, prefix)] = value
		}
	}

	if len(m) == 0 {
		return nil
	}

	return m
}

// MoveSlice moves the element s[i] to index j in s.
func MoveSlice[S ~[]E, E any](s S, i, j int) {
	x := s[i]
	if i < j {
		copy(s[i:j], s[i+1:j+1])
	} else if i > j {
		copy(s[j+1:i+1], s[j:i])
	}
	s[j] = x
}

// ByteCountIEC converts a size in bytes to a human-readable string in IEC (binary) format.
func ByteCountIEC(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB",
		float64(b)/float64(div), "KMGTPE"[exp])
}
```

- [ ] **Step 6.2 删除 `pkg/util/misc_test.go`（仅 PruneByTag 一个测试）**

```bash
git rm pkg/util/misc_test.go
```

> 注意：misc_test.go 只包含 `tagTest` 结构 + `TestPruneByTag` 函数。删 PruneByTag 后没有其它需要保留的内容，整文件删除是干净选择。其它 misc.go 函数（GetMapWithoutPrefix、MoveSlice、ByteCountIEC）的测试不在这个文件里。

- [ ] **Step 6.3 残留对账**

```bash
grep -rn 'PruneByTag' --include='*.go' .
grep -rn '"reflect"' --include='*.go' pkg/util/
```

Expected: 两条均无输出。

- [ ] **Step 6.4 单包 vet + test**

```bash
go vet ./pkg/util/...
go test ./pkg/util/...
```

Expected: 两命令 exit 0；test 应有 `file_test.go` / `file_filtered_test.go` / `strings_test.go` 仍 PASS。

---

## Task 7：全量验证

**Files:** 无修改

- [ ] **Step 7.1 跑 `go mod tidy`**

```bash
go mod tidy
```

Expected: exit 0。（无新依赖也无去除，go.sum 可能不动。）

- [ ] **Step 7.2 全量 vet**

```bash
go vet ./...
```

Expected: exit 0，无输出。

- [ ] **Step 7.3 全量 test**

```bash
go test ./...
```

Expected: 所有包 PASS 或 `[no test files]`。

> 注意：`pkg/sec` 已删 → 其测试也已删；`pkg/consts` 已删 → 无测试；`pkg/util/misc_test.go` 已删。剩余 test 来自 file_test/file_filtered_test/strings_test/manager_test/logs_test/metrics_test 等，应全 PASS。

- [ ] **Step 7.4 build**

```bash
go build -o bin/cfdmgrd ./cmd/cfdmgrd
ls -la bin/cfdmgrd
```

Expected: 二进制 ~22MB。

- [ ] **Step 7.5 smoke version + help**

```bash
./bin/cfdmgrd version
./bin/cfdmgrd help 2>&1 | head -10
```

Expected: 同 PR-01：`cfdmgrd dev (built ...)` + cfdmgrd 标题。

- [ ] **Step 7.6 启动 daemon 5 秒后探活，确认状态机仍可用**

```bash
rm -rf ./tmp/data; mkdir -p ./tmp/data
CFDM_API_TOKEN=dev CFDM_DATA_DIR=./tmp/data ./bin/cfdmgrd serve > /tmp/cfdmgrd-pr02.log 2>&1 &
SERVE_PID=$!
sleep 2
curl -fsS http://127.0.0.1:8080/api/v1/health
echo
curl -fsS -H "Authorization: Bearer dev" http://127.0.0.1:8080/api/v1/configs
echo
kill $SERVE_PID 2>/dev/null
sleep 1
rm -rf ./tmp/data /tmp/cfdmgrd-pr02.log
```

Expected: `/health` → `{"status":"ok",...}`；`/configs` → `{"items":[]}` 或 `[]`。
后台进程无 panic / fatal 退出（log 中无 "PANIC" / "fatal" 字面）。

---

## Task 8：commit

**Files:** git stage + commit（在主线由 controller 执行）

- [ ] **Step 8.1 stage + status**

```bash
git add -A
git status
git diff --cached --stat | tail -5
```

Expected: 改动文件清单（约 6-8 个）：
- modified: `internal/manager/instance.go`, `internal/manager/manager.go`, `pkg/util/misc.go`
- new file: `pkg/cfdstate/state.go`
- deleted: `pkg/consts/state.go`, `pkg/consts/config.go`, `pkg/sec/passwd.go`, `pkg/sec/passwd_test.go`, `pkg/util/misc_test.go`

- [ ] **Step 8.2 commit（由 controller 主线执行）**

```bash
git commit -m "$(cat <<'EOF'
chore(cleanup): PR-02 移除 frp 专属基础设施 / 重组状态机包

- 新增 pkg/cfdstate：从 pkg/consts/state.go 搬迁 ConfigState 与 5 个枚举
  （iota 整数值保持不变以兼容已有 snapshot 行为），删除 ProxyState
- 删除 pkg/consts/（含 config.go 中 frp 专有 Protocols/ProxyTypes/PluginTypes/
  AuthToken/STUN/Bandwidth/LogLevel 等常量，全仓 0 业务引用）
- 删除 pkg/sec/passwd.go + passwd_test.go（SHA1+Base64 弱哈希，0 调用）
- 删除 pkg/util/misc.go::PruneByTag + 内部 prune + reflect import（reflect-based
  tag filter，0 业务调用）以及对应 misc_test.go

内部管理器 import 与符号同步迁移：
- internal/manager/instance.go：20 处 consts.ConfigState* → cfdstate.ConfigState*
- internal/manager/manager.go：3 处同上

依据 docs/superpowers/specs/2026-06-06-cloudflared-manager-design.md
执行计划 docs/superpowers/plans/2026-06-06-pr02-pkg-cleanup.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
```

Expected: 新 commit；working tree clean。

---

## Self-Review

✅ **Spec 覆盖**（spec §10.1.6 PR-02 列出的 4 项）：
- pkg/cfdstate 重命名 → Task 2 + Task 3 + Task 4
- pkg/consts/config.go 删除 → Task 4
- pkg/sec 删除 → Task 5
- pkg/util.PruneByTag 删除 → Task 6

✅ **类型一致性**：
- `cfdstate.ConfigState` 类型签名与旧 `consts.ConfigState` 完全相同（5 个 iota 枚举，同顺序，同基础类型 int）
- `internal/manager` 的 instance.go state 字段类型只从限定符前缀换包名，行为 0 改变
- snapshot / event payload 由 manager 层转字符串输出（`stateString()`）—— iota 值守恒确保跨重启行为一致

✅ **占位符扫描**：
- 无 TBD / TODO / FIXME 残留
- 每个 step 含可直接执行命令 + 期望输出

✅ **风险与回滚**：
- 风险：sed 替换 `consts\.ConfigState` 是精确 prefix，无误伤可能（pkg/consts 包内符号都是 ConfigState* / ProxyState*；ProxyState 在 manager 0 引用，所以 sed `consts\.ConfigState` 不会扫到 ProxyState）。
- 回滚：单 commit 撤销即 `git reset --hard HEAD~1`。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-06-pr02-pkg-cleanup.md`. 用 subagent-driven-development 执行，单 batch（Task 1-7 一个 implementer，Task 8 commit 由 controller 跑）。
