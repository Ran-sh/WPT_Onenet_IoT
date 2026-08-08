# WPT_Onenet_IoT — 无线充电网页控制台

[![Deploy](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020)]()
[![Framework](https://img.shields.io/badge/Framework-Vanilla%20JS-yellow)]()
[![PWA](https://img.shields.io/badge/PWA-Enabled-5A0FC8)]()
[![Charts](https://img.shields.io/badge/Charts-Chart.js-FF6384)]()
[![CSS](https://img.shields.io/badge/CSS-Tailwind-06B6D4)]()
[![Version](https://img.shields.io/badge/Version-V6.0.0-brightgreen)]()

WPT 无线充电系统 V6.0.0 的响应式双端网页控制台，部署于 Cloudflare Workers 静态资源服务。页面通过 OneNET HTTP API 分别连接发射端与接收端物模型，提供 TX/RX 首页切换、实时监测、安全门控控制、云端历史、时间对齐、事件化告警、双设备配置和统一登录守卫。支持 PWA，可添加至手机主屏幕。

V6.0.0 已在本地完成 `20260001`（TX）与 `RX_001`（RX）的独立配置、看板、控制、历史和告警实现，并通过契约测试及桌面/手机 Edge 模拟验收。真实 OneNET 上线部署、长期运行和危险控制仍须在功率关闭的受控环境逐项验收；HTTP 成功、MQTT 在线或 BLE 写入均不能替代设备实际执行确认。实施边界见 `docs/dual-device-roadmap.md`。

## 访问地址

**https://wptonenet.483763727.workers.dev**

## 目录

1. [功能总览](#功能总览)
2. [架构](#架构)
3. [页面功能](#页面功能)
4. [登录说明](#登录说明)
5. [技术栈](#技术栈)
6. [数据流](#数据流)
7. [部署](#部署)
8. [项目结构](#项目结构)
9. [OneNET 配置](#onenet-配置)
10. [固定数据模型](#固定数据模型)
11. [TX/RX 双设备实现](#txrx-双设备实现)
12. [常见问题](#常见问题)

---

## 功能总览

| 功能 | 说明 |
|:---|:---|
| 📊 **双端首页** | TX/RX 切换、两端状态常驻摘要、实时值和告警摘要 |
| 📈 **实时监控** | TX/RX 独立状态、测量与健康矩阵，源时间趋势和自动同步 |
| 🖥️ **工业界面** | 深色侧栏、紧凑数据卡、状态总览，电脑端与手机端自适应 |
| 🎛️ **安全控制** | TX 启停/设频与 RX 白名单命令，最终门控、确认对话框和审计结果 |
| 📉 **云端历史** | OneNET 属性历史查询、TX/RX ±5 秒一对一对齐、未配对标记和 CSV 导出 |
| 🚨 **事件化告警** | 8 条 TX/RX 规则、确认与恢复分离、离线不误恢复、持久化水位防重触发 |
| ⚙️ **双端设置** | TX/RX 凭据隔离、固定安全数据模型、本机运行数据精确清理 |
| 📱 **PWA** | Service Worker 离线缓存, 可添加到手机主屏幕 |
| 🔐 **本地访问门控** | 前端登录页只用于界面门控，真正设备鉴权仍由 OneNET Token 完成 |
| 🧭 **状态语义** | TX 使用 `S=0/1/2/3`，RX 分离网关、MQTT、BLE、新鲜度、有效性和安全门控 |

---

## 架构

```
┌─────────────────────────────┐
│    Cloudflare Workers       │
│  ┌───────────────────────┐  │
│  │   index.html          │  │  ← 仪表盘 (首页)
│  │   monitoring.html     │  │  ← 实时监控
│  │   control.html        │  │  ← 远程控制
│  │   history.html        │  │  ← 历史数据
│  │   alerts.html         │  │  ← 事件化告警
│  │   settings.html       │  │  ← TX/RX OneNET 配置
│  │   login.html          │  │  ← 登录
│  └───────────────────────┘  │
└──────────┬──────────────────┘
           │ HTTPS (fetch)
           ▼
┌─────────────────────────────┐
│      OneNET Studio API      │
│  iot-api.heclouds.com       │
│  ┌───────────────────────┐  │
│  │ GET  query-device-    │  │  ← 读取属性
│  │      property         │  │
│  │ POST set-device-      │  │  ← 下发指令
│  │      property         │  │
│  │ GET  device/detail    │  │  ← 在线状态
│  └───────────────────────┘  │
└─────────────────────────────┘
```

---

## 页面功能

### 登录页 (`login.html`)

全屏登录表单。普通登录写入 `sessionStorage`，浏览器会话结束后失效；勾选保持登录时保存签发时间和失效时间，最长7天。连续失败5次会暂停30秒。6个业务页面在业务脚本前加载 `js/auth-guard.js`，未登录时自动跳转登录页并保留安全的站内回跳地址。

### 仪表盘 (`index.html`)

首页使用始终可见的 TX/RX 切换按钮，只展开一个端点详情，但两端仍并行轮询并更新按钮状态。选择会保存在本机；键盘支持左右方向键、Home 和 End。只有本次设备详情明确在线且属性源时间新鲜时显示实时值，页面同时展示事件化告警摘要。

### 实时监控 (`monitoring.html`)

双端只读驾驶舱每 5 秒同步一次。TX 显示电压、电流、频率与 `S` 状态；RX 显示测量值和 BLE、MQTT、网关、WiFi、遥测新鲜度、有效性及启动门控。各 RX 健康项按自己的 OneNET 属性源时间判定，整体端点离线不会把旧值继续显示成实时数据。趋势图使用 OneNET 源时间并保留负值。

### 远程控制 (`control.html`)

控制页按端点分区：

- **TX**：`ON`、`OFF` 与设频。`ON` 和设频要求本次 TX 快照在线、有效且状态允许；`OFF` 保留故障安全语义。频率严格执行 20.0–99.9kHz/0.1kHz 与 100–200kHz/1kHz 两档步进。
- **RX**：`START`、`STOP`、`STATUS`、`ZERO`、`RATE=<ms>`。`START` 必须同时满足 RX 在线、BLE 连接、遥测新鲜、测量有效、无故障且 `RX_Safe=true`；`STOP` 保留故障安全语义。

危险操作使用可访问确认对话框，确认后会再次读取最终门控，再发送一次请求。页面只把 OneNET 返回的设备终态确认记为成功，并保存有界操作审计；HTTP 接受或写入 BLE 不会被伪装成硬件已执行。

### 历史数据 (`history.html`)

- 直接查询 OneNET 属性历史，不从本地遥测缓存伪造长期历史
- 支持 TX、RX 单端模式和 TX/RX 对比模式
- TX 指标固定为 V/I/F/S；RX 可选择数值型测量属性
- 对比模式按 OneNET 源时间做 ±5 秒最近点一对一配对，显式保留 TX/RX 未配对点
- 请求竞态、单端失败、重复时间戳、乱序、负值与空结果均有明确处理
- 图表与表格共用源时间，CSV 对字段、换行、公式前缀和双引号做安全转义

### 报警 (`alerts.html`)

告警引擎只评估设备详情明确在线且对应属性在 15 秒窗口内新鲜的数据。规则包括 TX 故障、TX 5A 过流，以及 RX 故障位、限流、测量无效、BLE 断开、未连接和遥测过期。确认只表示人工知晓，不会解除活动告警；只有更新的 OneNET 源时间携带安全值才能恢复。离线、过期、接口错误和非法值均保持现有状态，不会误恢复。已恢复记录可单独清理，规则水位继续保留以阻止旧数据复活。

### 设置 (`settings.html`)

设置页集中管理：

- **双端 OneNET 配置**：TX 与 RX 的 Product ID、Device Name 和 Token 分开保存、测试和清除；Token 不回填到表单。
- **固定安全模型**：展示 TX/RX 属性摘要，不允许本地缓存改写 5A、20–200kHz、RX 类型与云端键等协议边界。
- **本机数据**：可按端点清理运行缓存，也可清理全部运行数据；不会使用 `localStorage.clear()` 误删登录、凭据或其他站点偏好。

---

## 登录说明

当前默认账号为 `admin`，默认密码为 `admin123`。

该账号只用于前端本地门控，哈希与验证程序都会随静态网页下发，不能抵御主动绕过，也不能视为真正的公网身份认证。正式部署必须在 Cloudflare 中启用 Access 或接入服务端账号体系。OneNET Token 应按设备隔离、设置有效期并定期轮换，不应在共享电脑上保存。

---

## 技术栈

| 层级 | 技术 |
|:---|:---|
| HTML | 原生 HTML5, 语义标签 |
| CSS | Tailwind CSS (CDN), 自定义全局变量 |
| JS | 原生 ES6 (无框架), async/await, fetch API |
| 图表 | Chart.js 4.4.7（CDN，监测页与历史页） |
| 图标 | Font Awesome Free (CDN) |
| PWA | Service Worker + manifest.json + SVG Maskable图标 |
| 存储 | `localStorage` (配置 + 缓存 + 锁) |
| 部署 | Cloudflare Workers 静态资源（Git 自动部署） |

---

## 数据流

### 实时读取

```
双端生命周期轮询器每 5s:
  → 并行 GET /device/detail（TX、RX）
  → GET /thingmodel/query-device-property
  → 严格校验 identifier、类型、范围、数量和 OneNET 源时间
  → 只有详情明确 status=1 才标记在线
  → 只有必需字段逐项新鲜才标记实时并写短期趋势缓存
  → 双端独立渲染；单端失败不覆盖另一端
  → 告警引擎每轮在两端请求 settled 后只评估一次
```

### 下发控制

```
TX SETFREQ 108kHz:
  → 本地范围/步进校验与实时状态门控
  → 用户确认后重新读取最终门控
  → POST /thingmodel/set-device-property
     body: {"product_id":"...","device_name":"...","params":{"SetFreq":108000}}
  → 解析 OneNET 设备回复，只在 confirmed=true 时记成功
  → 写入按设备隔离的有界操作审计
```

### 云端历史

历史页按用户选择的时间范围和指标调用 OneNET 属性历史接口。单端结果按源时间排序并对重复时间戳保留最后值；双端对比采用 ±5000ms 最近点一对一匹配，未匹配行不会被丢弃。CSV 仅导出本次查询结果，不读取旧本地缓存补齐缺失字段。

---

## 部署

### Cloudflare Workers

1. 在 Workers & Pages 中关联 GitHub 仓库 `Ran-sh/WPT_Onenet_IoT`。
2. 生产分支使用 `master`；`gh-pages` 保持为完全相同的发布镜像。
3. 项目由 `wrangler.jsonc` 声明根目录静态资源和SPA回退，无需前端构建命令。
4. 在 Cloudflare Zero Trust 中为 `wptonenet.483763727.workers.dev` 配置 Access 策略，避免仅依赖前端门控。
5. 部署完成后访问 `https://wptonenet.483763727.workers.dev/`，用无痕窗口验证登录、受保护页面、OneNET连接和V6.0.0版本元数据。

### 手动推送

```bash
cd ONENETapp
git add -A && git commit -m "..."
git push origin master
git switch gh-pages
git merge --ff-only master
git push origin gh-pages
git switch master
```

部署后约 1~2 分钟生效。

---

## 项目结构

```
ONENETapp/
├── index.html          # TX/RX 首页切换与双端摘要
├── monitoring.html     # 双端实时驾驶舱
├── control.html        # TX/RX 安全门控控制
├── history.html        # OneNET 云历史、双端对齐和 CSV
├── alerts.html         # 事件化告警、确认、恢复与筛选
├── settings.html       # TX/RX 独立凭据与本机数据维护
├── login.html          # 登录页
├── css/
│   └── dashboard.css   # 全站工业仪表盘视觉系统
├── js/
│   ├── config.js       # 双端配置、固定安全模型与迁移
│   ├── onenet.js       # 实时/历史读取、属性设置与严格解析
│   ├── ui-common.js    # 生命周期轮询、状态、新鲜度和趋势工具
│   ├── index-page.js / monitoring-page.js
│   ├── control-core.js / control-page.js
│   ├── history-core.js / history-page.js
│   ├── alert-engine.js / alerts-page.js
│   ├── auth-guard.js   # 统一登录守卫（必须先于业务脚本加载）
│   └── mobile-nav.js   # 移动端底部导航栏 (自动注入)
├── service-worker.js   # PWA 离线支持
├── manifest.json       # PWA 清单
├── icon.svg            # PWA普通/Maskable图标
├── tests/
│   └── ui-contract.test.cjs # UI、登录、PWA和脚本语法契约
├── docs/
│   └── dual-device-roadmap.md # ESP32接收端与TX/RX双设备演进规划
└── wrangler.jsonc      # Cloudflare Workers 静态资源配置
```

---

## OneNET 配置

首次使用需在设置页分别填入 TX 与 RX 的 OneNET 凭证：

| 端点 | 产品 ID | 设备名称 | Token |
|:---|:---|:---|:---|
| TX | 用户的 TX Product ID | `20260001` | 绑定 TX 设备资源的 Token |
| RX | 用户的 RX Product ID | `RX_001` | 绑定 RX 设备资源的 Token |

Token 格式: `version=2018-10-31&res=products%2F{产品ID}%2Fdevices%2F{设备名}&et={过期时间戳}&method=md5&sign={签名}`

> ⚠️ Token 中 `res` 字段必须用 **复数 `devices`**, 写成 `device` 会报 `authentication failed: invalid res`。

---

## 固定数据模型

TX 固定模型包含 V、I、F、S、Switch 和 SetFreq；电流边界为 5A，频率范围为 20–200kHz，20.0–99.9kHz 步进 0.1kHz，100–200kHz 步进 1kHz。RX 固定模型覆盖测量值、BLE/MQTT/网关/WiFi、新鲜度、有效性、刺激、故障、启动门控及命令审计。旧缓存只做受限迁移，不能覆盖固定云端键、类型和安全边界。

## TX/RX 双设备实现

V6.0.0 已将 `tx` 与 `rx` 的凭据、请求状态、缓存、历史、控制审计和告警状态分开。首页和监测始终并行获取两端；RX `START` 的本地门控与 TX 危险操作的最终确认已经实现；历史按 OneNET 源时间对齐，不按数组下标拼接。

接收端刺激电流不等于无线接收功率。当前没有真实接收功率或整流输出电流的同步测量，因此页面不计算也不展示传输效率。完整字段、已完成项、未完成实机项和验收边界见 `docs/dual-device-roadmap.md`。

---

## 常见问题

| 问题 | 原因 | 解决 |
|:---|:---|:---|
| 所有卡片显示 `--` | 未配置 OneNET 凭证 | 进设置页填写产品 ID / 设备名 / Token |
| 设置页改了但仪表盘没变 | 页面缓存 | 切换页面或刷新, 仪表盘监听 `visibilitychange` |
| 下发指令无效 | 网页与设备固件分支或频率步进不匹配 | 使用与当前部署匹配的固件，并确认频率在20–200kHz合法步进上 |
| 历史图表为空 | 时间范围内无 OneNET 属性历史或凭据无权访问 | 调整时间范围并检查两端配置与 Token 权限 |
| 页面显示“预览” | 未配置OneNET | 预览值不是实时设备数据，进入设置页配置云平台 |
| PWA 安装无效 | 浏览器或部署条件不满足 | 确认使用HTTPS并检查清单、Service Worker与图标请求 |
| `net::ERR_FAILED` | 网络、CORS或Token配置异常 | 检查浏览器网络日志、Token有效期和OneNET接口可达性 |

---

## 关联项目

- 主项目: [Ran-sh/WPT_TX](https://github.com/Ran-sh/WPT_TX)（V6.0.0 `main`；V5.1.3 稳定版 `5.0`）
- 微信小程序: 主项目 `WeChat_MiniProgram/` 目录
- Railway 桥接 (历史): [Ran-sh/WPT_Railway](https://github.com/Ran-sh/WPT_Railway)

## 作者

**Rssss**

## 许可

MIT
