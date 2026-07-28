# WPT_Onenet_IoT — 无线充电网页控制台

[![Deploy](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020)]()
[![Framework](https://img.shields.io/badge/Framework-Vanilla%20JS-yellow)]()
[![PWA](https://img.shields.io/badge/PWA-Enabled-5A0FC8)]()
[![Charts](https://img.shields.io/badge/Charts-Chart.js-FF6384)]()
[![CSS](https://img.shields.io/badge/CSS-Tailwind-06B6D4)]()
[![Version](https://img.shields.io/badge/Version-V5.1.3-brightgreen)]()

WPT 无线充电系统 V5.1.3 的响应式网页端控制台，部署于 Cloudflare Workers 静态资源服务。通过 OneNET HTTP API 直连云平台物模型，提供实时监控、远程控制、历史数据、数据模型管理与统一登录守卫。支持 PWA 离线访问，可添加至手机主屏幕。

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
10. [数据模型管理](#数据模型管理)
11. [常见问题](#常见问题)

---

## 功能总览

| 功能 | 说明 |
|:---|:---|
| 📊 **仪表盘** | 动态传感器卡 + 控制卡, 可根据数据模型自动渲染 |
| 📈 **实时监控** | V/I/F 遥测数据实时刷新, 在线状态指示, 自动同步 |
| 🖥️ **工业界面** | 深色侧栏、紧凑数据卡、状态总览，电脑端与手机端自适应 |
| 🎛️ **远程控制** | 启停开关 toggle, 频率设置, 通用字符串/数值控制 |
| 📉 **历史数据** | Chart.js 折线图展示 V/I/F 趋势, 每分钟自动采样 |
| ⚙️ **数据模型管理** | 传感器/控制器动态增删, 图标/颜色/单位/范围自定义 |
| 📱 **PWA** | Service Worker 离线缓存, 可添加到手机主屏幕 |
| 🔐 **本地访问门控** | 前端登录页只用于界面门控，真正设备鉴权仍由 OneNET Token 完成 |
| 🧭 **状态语义** | 根据 `Switch` 与实际频率区分待机、扫频和运行，预览数据不冒充在线 |

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
│  │   settings.html       │  │  ← 数据模型 + OneNET 配置
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

根据用户在设置页配置的**数据模型**动态渲染传感器卡和控制卡。首次加载时自动从 OneNET 拉取最新数据, 每 5 秒自动刷新。点击同步按钮立即更新。连接状态指示器显示设备在线/离线。

### 实时监控 (`monitoring.html`)

独立传感器只读页面, 更大字号显示, 带 `#` 分隔线。每 10 秒刷新一次。适合全屏显示器或平板横屏查看。

### 远程控制 (`control.html`)

控制卡列表, 每张卡包含:
- **布尔控制器 (Switch)**: toggle 开关, 动画过渡, 乐观 UI 更新
- **数值控制器 (SetFreq)**: 输入框 + 发送按钮, `toCloud` 自动转换 (kHz → Hz)
- **字符串控制器**: 输入框 + 发送

每5秒自动同步状态，页面隐藏后停止轮询，恢复可见时重新同步。手动点击同步按钮可立即更新。下发指令后有3秒乐观锁保护，防止云端旧值回弹。频率输入严格执行20.0–99.9kHz/0.1kHz与100–200kHz/1kHz两档步进。

### 历史数据 (`history.html`)

- 自适应 Y 轴折线图 (Chart.js), 每分钟自动采样一条记录
- 最高存储 24 小时 (1440 条) 数据
- 响应式表格展示最近数据
- 在线/离线状态徽章

### 设置 (`settings.html`)

设置页集中管理：

- **OneNET配置**：产品ID、设备名、Token，保存在当前浏览器的 `localStorage`。
- **数据模型**：增、删、改传感器和控制器；缓存内容会经过标识符、图标、类型、长度和数量校验。
- **固件核心项**：电压、电流、频率、启停和设频不可删除；5A上限及20–200kHz边界不可被旧缓存覆盖。
- **本机数据**：系统名称、报警声音、历史与缓存清理。

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

### 读取数据

```
fetchAll() 每 5~10s:
  GET /thingmodel/query-device-property
  → JSON: {code:0, data:[{identifier:"V", value:"12.5", time:...}]}
  → config.js fromCloud 转换 (Hz → 保留1位小数的kHz)
  → 渲染 UI
  → 存入 localStorage 缓存
  → 历史数据采样 (每分钟一条)
```

### 下发控制

```
setProperty({setfreq: 108}):
  → config.js toCloud 转换 (108 * 1000 = 108000)
  → reverseMap: setfreq → SetFreq (云端键)
  → POST /thingmodel/set-device-property
     body: {"product_id":"...","device_name":"...","params":{"SetFreq":108000}}
  → 乐观更新 localStorage 缓存
  → 3 秒锁防止云端旧值覆盖
```

### 乐观锁机制

每次下发控制指令后, 在 `localStorage` 记录时间戳。读取数据时, 如果某属性在 3 秒内有下发记录, 忽略云端旧值, 保持 UI 显示最新下发的值。避免"设频率→下一秒旧数据覆盖显示→用户看到跳回旧值"。

---

## 部署

### Cloudflare Workers

1. 在 Workers & Pages 中关联 GitHub 仓库 `Ran-sh/WPT_Onenet_IoT`。
2. 生产分支使用 `master`；`gh-pages` 保持为完全相同的发布镜像。
3. 项目由 `wrangler.jsonc` 声明根目录静态资源和SPA回退，无需前端构建命令。
4. 在 Cloudflare Zero Trust 中为 `wptonenet.483763727.workers.dev` 配置 Access 策略，避免仅依赖前端门控。
5. 部署完成后访问 `https://wptonenet.483763727.workers.dev/`，用无痕窗口验证登录、受保护页面、OneNET连接和V5.1.3版本元数据。

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
├── index.html          # 首页仪表盘 (动态渲染)
├── monitoring.html     # 实时监控 (只读, 大字号)
├── control.html        # 远程控制 (开关/频率/通用)
├── history.html        # 历史数据 (Chart.js 图表)
├── settings.html       # 设置 (OneNET 凭证 + 数据模型)
├── login.html          # 登录页
├── css/
│   └── dashboard-v5.css # 全站工业仪表盘视觉系统
├── js/
│   ├── config.js       # OneNET 配置 + 数据模型 CRUD + 工具函数
│   ├── onenet.js       # OneNetService 类 (数据拉取 + 属性设置)
│   ├── auth-guard.js   # 统一登录守卫（必须先于业务脚本加载）
│   └── mobile-nav.js   # 移动端底部导航栏 (自动注入)
├── service-worker.js   # PWA 离线支持
├── manifest.json       # PWA 清单
├── icon.svg            # PWA普通/Maskable图标
├── tests/
│   └── ui-contract.test.cjs # UI、登录、PWA和脚本语法契约
└── wrangler.jsonc      # Cloudflare Workers 静态资源配置
```

---

## OneNET 配置

首次使用需在设置页填入 OneNET 凭证:

| 字段 | 示例值 | 说明 |
|:---|:---|:---|
| 产品 ID | `1iS397oJFL` | OneNET Studio 产品 ID |
| 设备名称 | `20260001` | 设备名称 |
| Token | `version=2018-10-31&res=...&sign=...` | 设备密钥 (注意复数 `devices`) |

Token 格式: `version=2018-10-31&res=products%2F{产品ID}%2Fdevices%2F{设备名}&et={过期时间戳}&method=md5&sign={签名}`

> ⚠️ Token 中 `res` 字段必须用 **复数 `devices`**, 写成 `device` 会报 `authentication failed: invalid res`。

---

## 数据模型管理

设置页支持动态定义传感器的属性:

| 属性 | 说明 | 示例 |
|:---|:---|:---|
| ID | 内部标识符 | `voltage`, `freq` |
| 名称 | 显示名称 | `电压`, `频率` |
| 图标 | FontAwesome 图标 | `fa-bolt`, `fa-wave-square` |
| 颜色 | 主题色 | `cyan`, `blue`, `yellow` |
| 单位 | 显示单位 | `V`, `kHz` |
| 云端键 | OneNET 属性标识符 | `V`, `F` |
| 数据类型 | `float` / `int32` / `bool` / `string` | `float` |
| 最小/最大值 | 数值范围 | `0` ~ `50` |
| 步进 | 数值精度 | `0.01` |
| fromCloud | 数据转换 (云端→前端) | `Math.round(v / 100) / 10` |
| toCloud | 数据转换 (前端→云端) | `Math.round(v * 1000)` |

默认模型包含 3 个传感器 (`voltage`, `current`, `freq`) 和 2 个控制器 (`switch`, `setfreq`)。电流安全上限为5A；频率范围20–200kHz，20.0–99.9kHz步进0.1kHz，100–200kHz步进1kHz。旧版本地模型会在读取时自动迁移并恢复频率换算函数。

---

## 常见问题

| 问题 | 原因 | 解决 |
|:---|:---|:---|
| 所有卡片显示 `--` | 未配置 OneNET 凭证 | 进设置页填写产品 ID / 设备名 / Token |
| 设置页改了但仪表盘没变 | 页面缓存 | 切换页面或刷新, 仪表盘监听 `visibilitychange` |
| 下发指令无效 | ESP8266 固件版本或频率步进不匹配 | 使用V5.1.3固件，并确认频率在20–200kHz合法步进上 |
| 历史图表为空 | 数据量不足 | 至少等 1 分钟 (每分钟采样 1 条) |
| 页面显示“预览” | 未配置OneNET | 预览值不是实时设备数据，进入设置页配置云平台 |
| PWA 安装无效 | 浏览器或部署条件不满足 | 确认使用HTTPS并检查清单、Service Worker与图标请求 |
| `net::ERR_FAILED` | 网络、CORS或Token配置异常 | 检查浏览器网络日志、Token有效期和OneNET接口可达性 |

---

## 关联项目

- 主项目: [Ran-sh/WPT_PWM](https://github.com/Ran-sh/WPT_PWM)（分支 `5.0`）
- 微信小程序: 主项目 `安卓app/` 目录
- Railway 桥接 (历史): [Ran-sh/WPT_Railway](https://github.com/Ran-sh/WPT_Railway)

## 作者

**Rssss**

## 许可

MIT
