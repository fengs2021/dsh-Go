# local-patches — 与随包 loader 源码的本地差异

这两个文件记录了 dsh-Go 鸿蒙构建相对 `source-pins.json` 所钉 loader 源码
（deepseek-ai/dsh-node-addon-require-builtin @ a58d3599）的唯一本地修改。
`source-pins.json` 的 `localPatches` 数组里登记了同一个文件的 sha256。

## require-builtin-posix-symbol-table.diff

**为什么**：鸿蒙的 napi 宿主以局部作用域装载原生模块。`libnode.so` 是作为 addon 的
`DT_NEEDED` 被带进进程的，不会进入 `dlsym(RTLD_DEFAULT)` 搜索的全局作用域，于是
`LookupPlatformProcessSymbol()` 查不到 V8 的私有 ABI 符号
（`_ZN2v87Isolate10GetCurrentEv` 等），运行时报：

```
dsh: host preparation failed: node-addon-require-builtin unsupported:
Unsupported/no-context (required V8 current-context symbols were not found)
```

**怎么改**：`LookupPlatformProcessSymbol()` 先维持 `dlsym(RTLD_DEFAULT)`，失败后查一张
静态表；表项地址来自 `asm` 标号声明的直接引用，由动态链接器按 `DT_NEEDED libnode.so`
绑定。注意 `_ZN2v87Context33GetAlignedPointerFromEmbedderDataEit` 与
`_ZN2v87Context37SlowGetAlignedPointerFromEmbedderDataEit` 在 Node 24.22.1 的
`libnode.so` 里并不存在（见 `source-pins.json` 的 `unusedTaggedSymbolsOnNode24`），
不能进表，否则 `-Wl,-z,defs` 链接失败；上游源码对它们的缺失有回退分支。

**怎么用**：在 `runtime/ohos/native/build-hap-libs.py` 之前，把补丁应用到解包后的
loader 源码根目录：

```bash
cd /path/to/dsh-node-addon-require-builtin-a58d3599
patch -p1 < <repo>/runtime/ohos/native/loader/local-patches/require-builtin-posix-symbol-table.diff
sha256sum packages/native/src/runtime_probe/posix.cc   # 应等于 source-pins.json 里 localPatches 的 sha256
```

`build-hap-libs.py` 的 `--loader-source` 指向的就是这个目录。
