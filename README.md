# dsh-lan-gateway

> ## ⚠️ 免责声明（使用前必读）
>
> **本插件不提供任何身份认证、访问控制或传输加密。**
>
> 它做的仅仅是：在指定地址上开一个端口，把请求转发给本机的 DSH。**谁能连上这个端口，
> 谁就能完整操作你的 DSH** —— 包括读写文件、执行命令、访问会话与凭据。
>
> 因此：
>
> - 请**只在完全可信的网络**中启用（例如纯家庭内网、仅本人持有的虚拟局域网）
> - 不要在公共 Wi-Fi、公司网络、共享热点或任何你不确定有谁的网段上启用
> - 暴露面越小越安全：**优先用地址白名单只监听指定网卡，而不是 `0.0.0.0`**
> - 需要跨不可信网络访问时，请在外层自行加 HTTPS 反向代理与认证，不要直接暴露本插件
>
> **⚠️ 不建议在内网穿透场景下使用。** 通过 NAT 穿透、端口映射、隧道服务或公网反向代理
> （如 frp、ngrok、Cloudflare Tunnel 等）把本端口暴露到公网，等同于把本机 DSH 的完整
> 控制权直接挂上互联网，**暴露风险极高**。若确需此类用法，必须自行在外层实现
> **传输加密（TLS/HTTPS）**与**身份认证与访问控制**（例如反向代理的 HTTP 基本认证、
> OAuth 2.0 / OIDC、mTLS 客户端证书，或先接入 VPN 再访问），**否则后果自负**。
>
> **使用本插件即表示你理解并自行承担由此产生的全部风险与后果**（包括但不限于
> 本机被他人控制、数据泄露、被用作跳板等）。作者不对任何直接或间接损失负责。
>
> 详见文末 [说明与限制](#说明与限制)。

把 DSH 的 Web 界面开放给局域网内的其他设备（手机、平板、另一台电脑），
同时保持 DSH 本体只监听本机回环地址不变。

```
手机 / 平板                    DSH 本体
http://<局域网IP>:3081  ──►  127.0.0.1:3080
      （本插件）              （不对外暴露）
```

## 为什么需要它

DSH 的 `webserver` 只接受**一个具体网卡 IP**，并显式拒绝通配地址 `0.0.0.0`
（避免把本机的执行能力暴露给整个网络）。

而 `127.0.0.1` 和局域网 IP 属于**不同网卡**，一次 `listen` 只能绑一个：

- 绑 `127.0.0.1` → 本机可用，手机访问不到
- 绑局域网 IP → 手机可用，本机 `localhost` 失效

本插件补上这个缺口：自己监听 `0.0.0.0:3081`，把请求反向代理给
`127.0.0.1:3080`，两个入口同时可用。

## 工作原理

### 端口分工

| 地址 | 监听者 | 用途 |
| --- | --- | --- |
| `http://127.0.0.1:3080` | DSH 本体 | 本机浏览器、桌面端内嵌窗口 |
| `http://<局域网IP>:3081` | 本插件 | 手机、局域网内其他设备 |

插件默认监听 `0.0.0.0`（所有网卡），也可通过 `listenHosts` 精确指定要开放的地址：

```yaml
listenHosts:
  - 10.x.x.x        # 虚拟局域网
  - 192.168.0.x     # 家庭局域网
```

两个地址会**同时**生效，其他网卡（访客网络、公共 Wi-Fi）则完全不可达。
详见 [监听多个网段（推荐）](#监听多个网段推荐)。

### 请求头改写

DSH 对每个请求做来源校验：`Origin` 必须与 `Host` 是同一个地址。
插件转发时统一做三件事：

1. **Host** 改写为 `127.0.0.1:3080`，让请求通过 DSH 的绑定地址校验
2. **Origin / Referer** 若与原始 Host 同源，一并改写为同一地址，保证同源判定成立
3. **第三方来源**（真正的外部站点）保持原样并仍被拒绝，不伪造信任

`X-Forwarded-For / Host / Proto` 一律剥除，避免来源被伪造。

### 响应压缩

DSH 的客户端 bundle 路由**不压缩**：首页一次要拉约 11.8 MB 原始 JS。
经带宽受限的内网穿透隧道传输时，这么大量很容易传到一半就断开，
表现是手机"加载一阵子后隧道掉线"。

插件在转发时对文本类响应补一层 gzip，实测把首页资源压到约 4.3 MB（省 63%）：

| 资源组 | 原始 | gzip 后 |
| --- | --- | --- |
| 客户端主包 | 8,962 KB | 3,850 KB |
| 客户端副包 | 3,118 KB | 575 KB |
| 模块入口 | 45 KB | 12 KB |
| **合计** | **11.84 MB** | **4.33 MB** |

只压缩 `text/*`、`application/javascript|json|xml|wasm`、`image/svg+xml`；
已带 `Content-Encoding` 的响应、SSE 流、以及未声明 `Accept-Encoding: gzip`
的客户端一律原样透传。

### 认证

DSH 的浏览器会话 cookie 绑定访问地址（cookie 名由 `Host` 计算，校验时还要
比对地址）。外部设备第一次访问时没有对应 cookie，DSH 会返回 401。

插件的处理：

- 检测到页面请求返回 401 时，通过 DSH 的 `connection` 服务取到本次启动的
  token，返回一次 `303` 跳转到 `/?token=...`
- DSH 收到后按当前地址签发 cookie，此后请求自然通过
- 已带 token 仍被拒时**原样透传**，不重复跳转，避免死循环
- `/api` 的 401 不介入，交回前端处理

用户侧无感：打开地址即可，不需要手动传递任何链接。

### WebSocket

DSH 的远程流走 HTTP upgrade。插件原样透传 `Upgrade` / `Connection` 头与首个数据包，
并同样改写 `Host` 与 `Origin`，长连接与普通请求行为一致。

### 生命周期

- **随 DSH 启动**：Cordis 挂载插件时调用 `server.listen()`
- **随 DSH 关闭**：卸载钩子执行 `agent.destroy()` → `closeAllConnections()` →
  `server.close()`，端口立即释放
- 没有独立进程、没有定时器、没有子进程，不存在"DSH 关了插件还活着"的情况

## 安装

### 前置要求

- DSH 桌面端或 `dsh` CLI
- Node.js 18 以上

### 方式一：从 npm 安装

> 包尚未发布到 npm，以下命令在发布后可用；现在请用方式二。

```bash
dsh plugin --profile <profile> add dsh-lan-gateway
```

`<profile>` 换成你的 profile 名，例如 `desktop` 或 `web`。

### 方式二：从 Git 仓库一键安装（推荐）

插件不依赖宿主额外安装 Schemastery；依赖和配置 schema 均随仓库提供。使用 DSH 插件管理器安装 Git 地址：

```bash
dsh plugin --profile <profile> add github:KylinCloud-sys/dsh-lan-gateway
```

也可以先 clone 后以本地 link 安装：

```bash
git clone https://github.com/KylinCloud-sys/dsh-lan-gateway.git
dsh plugin --profile <profile> add link:./dsh-lan-gateway
```

### 方式三：手动登记（profile 被应用独占管理时）

DSH 桌面端的 profile 由 Electron 托管，`dsh plugin` 会拒绝写入。
此时手动完成两步：

**1. 让 Node 能解析到包**

```powershell
# Windows：软链接到 profile 的 node_modules
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-lan-gateway" "D:\dsh-plugins\dsh-lan-gateway"
```

**2. 在 profile 里登记依赖与 bundle**

编辑 `~/.dsh/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": {
    "dsh-lan-gateway": "link:D:/dsh-plugins/dsh-lan-gateway"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...现有 bundle...
        "dsh-lan-gateway"
      ]
    }
  }
}
```

Bundles 的顺序即加载顺序，放在列表末尾即可。**重启 DSH 后生效。**

### 安装后确认

```powershell
Get-NetTCPConnection -LocalPort 3081 -State Listen
```

看到 `0.0.0.0  3081`（默认）或你配置的每个具体地址各一行，即表示插件已加载。

设置页里出现「局域网网关」，且能增删改监听行，即表示配置界面正常工作。
两者都不需要额外安装依赖——仓库自带一个零依赖自检脚本：

```powershell
node test/schema.test.mjs
```

## 配置

### 在设置页里改（推荐）

DSH 的「设置 → 局域网网关」可以直接增删改监听地址与端口，保存后立即生效（不必重启）：

- 一行 = 一个入口，`0.0.0.0` 表示所有网卡
- 保存时校验：地址非空且不带协议/路径、端口为 1–65535 整数、同端口不能重复或与 `0.0.0.0` 冲突
- **`3080` 不能作为监听端口**（它是 DSH 本体端口），填了会被拒绝
- 列表清空并保存 = 关掉网关，DSH 本体照常运行

### 在 profile 里改（等价写法）

写入 profile 的 `cordis.patch.yml`：

```yaml
- id: lan-gateway
  config:
    listeners:
      - host: 0.0.0.0        # 或具体网卡地址（更安全，见下）
        port: 3081
      - host: 192.168.0.x
        port: 3082
```

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `listeners` | `{host, port}[]` | `[{host: 0.0.0.0, port: 3081}]` | 监听入口列表，可在设置页里实时增删改；空数组即关闭网关 |
| `listeners[].host` | string | — | IP 或主机名，**不带 `http://`、路径和端口**；`0.0.0.0` 表示所有网卡 |
| `listeners[].port` | number | — | 1–65535，且不能是 `3080` |

**终点地址是固定的**：插件永远把请求转发到 `127.0.0.1:3080`，不能通过配置改。
如果想换出口端口，请改这里的 `listeners`，不要试图改终点——
`upstreamHost` / `upstreamPort` 一旦写成其他值会直接校验失败。

兼容旧写法：`listenHosts: [...]` + `listenPort: 3081` 仍然有效，启动时会自动映射成
等价的 `listeners`；`listenHost: 10.x.x.x`（单个字符串）也仍然有效。

### 监听多个网段（推荐）

同一端口绑定不同 IP 互不冲突，因此可以精确指定入口，而不是对所有网卡开放
（设置页里一行行填，或写成 YAML）：

```yaml
- id: lan-gateway
  config:
    listeners:
      - host: 10.x.x.x        # 虚拟局域网：手机/Pad
        port: 3081
      - host: 192.168.0.x     # 家庭局域网：笔记本
        port: 3081
```

这样只有这两个地址可达，家里连了访客 Wi-Fi、或者你在咖啡厅连了公共网络时，
**都不会意外暴露**。这是比 `0.0.0.0` 更安全的用法。

**单个地址失败不影响其他地址**：网卡未插、VPN 未连接时该地址会报
`EADDRNOTAVAIL`，插件只记录一条错误日志，其余地址照常工作，DSH 也不受影响。

先查本机有哪些地址：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress
```

> 代价：地址会在网络切换后变化（尤其虚拟局域网），需要同步改配置。
> 完全固定的环境下建议用白名单；地址经常变且网络可信时，用 `0.0.0.0` 更省心。

### 与 DSH 本体配置的对应关系

插件把请求转发到固定的 `127.0.0.1:3080`，它要求 DSH 本体就监听在这个地址上：

```yaml
# profile 的 cordis.patch.yml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3080
```

如果 DSH 本体换了端口，插件就会 502；此时不要把 `upstreamPort` 写成新端口
（它被固定为 `3080`，写了会校验失败），而是把 DSH 本体的 `webserver.port`
改回 `3080`，或者 fork 本仓库修改常量后自行安装。

### 安全建议：越窄越好

| 做法 | 暴露面 | 维护成本 |
| --- | --- | --- |
| `listeners: [{host: 10.x.x.x}, {host: 192.168.0.x}]` | 仅指定网段 | IP 变了要改配置 |
| `listeners: [{host: 10.x.x.x}]` | 仅虚拟局域网 | IP 变了要改配置 |
| `listeners: [{host: 0.0.0.0}]`（默认） | 所有网卡，任何接入的网络 | 零维护 |

**能写白名单就不要用 `0.0.0.0`** —— 默认值只是为了开箱可用，
不等于推荐配置。本插件没有认证，端口通即等于 DSH 完全可控（见文首免责声明）。

## 排障

按顺序排查，能快速定位问题出在哪一层。

### 1. 插件有没有加载

```powershell
Get-NetTCPConnection -LocalPort 3081 -State Listen
```

| 结果 | 含义 |
| --- | --- |
| `0.0.0.0  3081` | 默认配置，已加载所有网卡，继续第 2 步 |
| 若干具体地址 + `3081` | 白名单配置，已按配置监听，继续第 2 步 |
| 只有部分地址 | 某个网卡不可用（如 VPN 未连接），看启动日志里的 `EADDRNOTAVAIL` |
| 无输出 | 插件未加载，检查 profile 的 `package.json` 是否登记了 bundle，然后重启 DSH |

### 2. 网关本身通不通（用配置里的地址测）

```powershell
# 把 <已监听地址> 换成上面查到的地址；用 0.0.0.0 配置时可用 127.0.0.1
curl.exe -s -o NUL -w "%{http_code}`n" http://<已监听地址>:3081/
```

- `303` / `200` → 网关正常
- `502` → 转发目标不对，检查 `upstreamHost` / `upstreamPort` 与 DSH `webserver` 是否一致
- 连不上 → 插件未启动、端口被占用，或该地址不在 `listenHosts` 里

### 3. 局域网入口通不通

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://<局域网IP>:3081/
```

本机通、这里不通 → 通常是**防火墙**或网卡问题：

```powershell
# 查看防火墙对该程序的入站规则
Get-NetFirewallRule -DisplayName "*deepseek*" | Select-Object DisplayName,Enabled,Direction,Action
```

需要放行该程序的 TCP 入站。另外确认虚拟局域网/局域网本身可达
（能 ping 通对方）。

### 4. 页面能打开但卡在 "Failed to load plugins"

说明请求能到 DSH，但 **`POST` 被来源校验拦下**。用这条区分：

```powershell
# 应返回 401（放到认证层）。返回 403 说明被来源校验拦截
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://<局域网IP>:3081/api/x -H "Origin: http://<局域网IP>:3081" -d "{}"
```

- **401** → 来源校验通过，正常
- **403** → 插件版本过旧（未处理 `Origin`），更新到最新版后重启 DSH

### 5. 一直要求认证（401 页面）

```
dsh web authentication required; reopen the URL printed by dsh web.
```

- 首次访问会自动跳转换取 cookie，**刷新一次**即可
- 反复出现 → 检查是否用了无痕模式（cookie 不保存），或浏览器禁用了 cookie
- cookie 有效期 30 天，过期后重新打开地址会自动续期

### 6. 端口被占用

DSH 启动时报 `EADDRINUSE` 表示 `listenPort` 已被其他程序占用：

```powershell
Get-NetTCPConnection -LocalPort 3081 -State Listen | Select-Object OwningProcess
Get-Process -Id <上面查到的PID>
```

关掉占用程序，或换一个 `listenPort`。

## 说明与限制

> 本节是文首免责声明的补充，请一并阅读。

**没有认证，也没有保护机制。** 本插件不实现登录、token 校验、IP 白名单过滤、
限流、加密或审计。端口一旦可达，访问者等同于坐在你的电脑前操作 DSH。

因此使用者必须自行确认：

- 网络环境是否可信（家庭内网、仅本人持有的虚拟局域网）
- 是否已经把 `listenHosts` 收窄到最小范围，而不是留在 `0.0.0.0`
- 是否存在不该访问该端口的设备（访客设备、共享打印、他人手机、公司网络）
- **是否正在通过内网穿透对外暴露**——若是，本插件自带的全部风险会被放大到公网范围

**因网络环境不安全、配置范围过大或他人访问造成的任何后果，由使用者自行承担。**

其它限制：

- **不建议在内网穿透场景下使用。** 借助 NAT 穿透、端口映射、隧道服务或公网反向代理
  （frp、ngrok、Cloudflare Tunnel 等）把端口暴露到公网，风险极高；确需如此时，
  必须自行在外层补齐**传输加密（TLS/HTTPS）**与**身份认证与访问控制**
  （HTTP 基本认证、OAuth 2.0 / OIDC、mTLS 客户端证书，或先接入 VPN），否则后果自负
- 只做转发与请求头规范化，不提供访问控制或加密；需要加密或认证时，
  请在外层自行部署 HTTPS 反向代理与鉴权
- 某个监听地址不可用（网卡未插、VPN 未连）时该地址静默不可达，只留一条错误日志；
  IP 变化后需手动更新 `listenHosts`
- DSH 升级若改变 `webserver` 或 `connection` 的内部约定，插件可能需要同步更新

## License

MIT
