# dsh-plugin-selfcheck

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的**终端优先**自检插件。

每次启动，它会在**你启动 dsh 的那个控制台窗口里**打出整棵插件树的每一行——已挂载 / 已禁用 / **失败并附异常内容**——然后跑四项安装级检查，然后闭嘴。

[English](README.md) | 中文

## 为什么需要它

cordis 本来就有这个功能：`Loader.showLog()` 会在每次挂载时打 `apply plugin <名字>`。但有两点把它废掉了：

1. **默认关着。** 它被 `entry.parent.tree.enableLogs` 挡着，而 `dsh web --help` 里**没有任何对应参数**。
2. **它的输出通道是看不见的。** 它写的是 `ctx.root.logger`，而在 dsh CLI 下，cordis logger **既到不了控制台窗口，也不进 `dsh-run.log`**（那个窗口重定向的目标文件）。

所以打开开关也只是把沉默换个地方。要让人真看到，只能从宿主进程里用 `console` 打——这就是本插件的全部工作。

## 输出长什么样

```
[selfcheck] plugin self-check
[selfcheck]  ok   dshmarket                                   include:dsh-market
[selfcheck]  skip @deepseek-ai/cordis-plugin-hmr  51ad9c62    (disabled)
[selfcheck]  ok   @liustack/modlens                           include:modlens
[selfcheck]  ---- plugins: 148 mounted, 28 disabled, 0 failed
[selfcheck]  ---- install checks:
[selfcheck]  ok   deps.version-drift    all 9 plugins declaring dsh.engines.dsh accept 0.1.2-rc.1
[selfcheck]  ok   config.files          ~/.dsh/profiles/web (3 files checked)
[selfcheck]  ok   http.port             http://127.0.0.1:3080/ answered 200 in 3ms
[selfcheck]  ok   tools.registered      34 model-facing tools registered
[selfcheck]  ---- selfcheck OK - 148 mounted, 0 failed, checks 4 ok / 0 warn / 0 fail (742ms)
```

行状态只有三种，**`skip` 不是故障**——你主动禁用的行就是该这样：

| 状态 | 含义 |
| --- | --- |
| `ok` | 已挂载 |
| `skip` | 被禁用（行尾带 `(disabled)`） |
| `FAIL` | 没挂上（走 stderr） |

行数远多于你的 bundle 数，因为**递归枚举**：一个 `@linxin666/dsh-web-all` 就展开成二十多行。

### 出错时

```
[selfcheck]  ---- problems:
[selfcheck]  FAIL dsh-open-file  include:open-file
[selfcheck]  ---- error details:
[selfcheck]  ! loader fibers failed
[selfcheck]    failed to apply loader entry include:open-file (dsh-open-file): Cannot find module 'x'
```

嵌套错误会**一路拆到底**（`AggregateError` → `cause` 链），你看到的是最内层的根因，不是最外层那句没用的废话。

## 四项安装级检查

| 检查 | 回答什么问题 | 怎么做到 |
| --- | --- | --- |
| `deps.version-drift` | 我装的插件还认这个 dsh 版本吗？ | 读每行 `package.json` 的 `dsh.engines.dsh`，和已安装的 `@deepseek-ai/dsh` 版本比对。区间求值支持 `>=` `>` `<=` `<` `=` `^` `~` `\|\|` 和预发布版本。**解析不了的区间报告为"无法判定"，绝不当通过。** |
| `config.files` | 我的 profile 配置文件合法吗？ | 解析 `cordis.yml` / `cordis.patch.yml` / `package.json`，并断言 loader 要求的形状（顶层数组、`dsh.profile.bundles` 存在）。拿不到 YAML 库时降级为结构检查。 |
| `http.port` | 宿主真的在提供服务吗？ | 对 `webServer` 报告的端口做 loopback `GET /`。端口被占但拒绝连接 = 有陈旧进程攥着 socket。 |
| `tools.registered` | 这一堆东西给模型贡献了什么？ | `ctx.tools.schemas()` —— 数量、名字、重名检测。 |

## 一切都是运行时推导的

没有任何东西写死成作者那台机器：

- 插件行来自 `ctx.loader.entries()`，所以它报告的是**你自己装了什么**；
- profile 目录来自 loader context 的 `baseUrl`，不是猜 `~/.dsh/profiles/<name>`；
- 包清单靠从运行进程入口向上走找，dsh 装在别处也能用。

**装一个插件、重启，它就出现在列表里。** 不需要配置、不需要白名单、不需要注册。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-selfcheck
```

本地源码：

```sh
dsh plugin --profile web add link:/path/to/dsh-plugin-selfcheck
```

> **跨盘注意**：profile 在 `C:`、源码在别的盘时，pnpm 建不了符号链接，会装出空目录并报 `declares no dsh.bundle`。手动补 junction 再 reconcile：
>
> ```sh
> node -e "require('fs').symlinkSync('<源码绝对路径>','<profile>/node_modules/dsh-plugin-selfcheck','junction')"
> dsh plugin --profile web install
> ```

**装完必须重启 dsh**——bundle 行在启动时加载。

## 输出落在哪

| 位置 | 内容 |
| --- | --- |
| 控制台窗口 | 启动时实时 |
| `$DSH_HOME/dsh-plugin-selfcheck.log` | 同一份报告的文本版（默认 `~/.dsh`） |
| `$DSH_HOME/dsh-plugin-selfcheck.json` | 同一份报告的 JSON 版 |
| 工具 `selfcheck_status` | 模型可以自己问，并解释哪里坏了 |

## 设计铁律

这些是承重的，不是风格偏好。

- **`inject` 是空的。** 一个"因为服务缺失就拒绝挂载"的诊断工具，无法报告"服务缺失"。
- **自检自己绝不抛错。** 每个探针独立守卫；失败记成 `warn`，绝不传播。
- **失败不中断挂载。** 大声记日志 + 进报告，插件保持可用。
- **绝不对 loader 调 `await()`。** `EntryTree.await()` 会等**每一个** entry **包括调用者自己**，从插件内部调会死锁。改成轮询 `entries()` 数量直到稳定，错误探测放到之后并加 4 秒超时——所以卡住最多只损失错误详情，绝不影响报告。
- **console 优先，logger 其次。** 见上文"为什么需要它"。
- **没有真 loader 就不写文件。** 裸进程（测试）没有树，让它覆盖真实报告就是污染。

## 测试

```sh
npm test
```

四个文件：`smoke`（挂载与容错、报告形状、落盘与护栏）、`roster`（三种状态、组过滤、嵌套异常展开、超时护栏）、`checks`（逐条 semver 区间、配置文件好坏、工具、端口、恶意 context 下四项全存活）、`host-resolution`（用**已安装 dsh 的真实 `defineTool`** 校验工具与输出 schema —— 值 schema DSL 的限制只有这里能暴露）。

无 dsh 安装时 `host-resolution.mjs` 会干净跳过。

## 与 `@linxin666/dsh-doctor` 的关系

那个插件已经在插件健康领域做得很深，本插件**刻意不与它竞争**：没有 supervisor、没有救援舱、没有回滚、没有 Web 控制台、没有客户端半边。差异点是**终端优先**——浏览器还没打开，你就能在已经在看的那个窗口里看到整个安装的状态，而且没有任何需要常驻的服务。

两者可以并存。

## 许可证

MIT
