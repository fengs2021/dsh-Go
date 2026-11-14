#!/usr/bin/env bash
# 同步版本号：app/pubspec.yaml + 用户手册的 `> dsh-go <版本>` 行（guide_sync.py 要求二者一致）
set -euo pipefail
[ $# -eq 1 ] || { echo "用法: $0 <1.0.N+N>"; exit 2; }
ver=$1
repo=$(cd "$(dirname "$0")/../.." && pwd)
sed -i "s/^version: .*/version: $ver/" "$repo/app/pubspec.yaml"
plain=${ver%%+*}
for f in docs/guide/README.md docs/guide/harmony/README.md app/assets/skills/dsh-go-guide/README.md app/assets/skills/dsh-go-guide/harmony-README.md; do
  sed -i "s/^> dsh-go .*/> dsh-go $plain/" "$repo/$f"
done
python3 "$repo/app/tool/guide_sync.py" >/dev/null
echo "pubspec: $(grep -n '^version:' "$repo/app/pubspec.yaml")"
grep -rn "^> dsh-go" "$repo/docs/guide" "$repo/app/assets/skills/dsh-go-guide"
