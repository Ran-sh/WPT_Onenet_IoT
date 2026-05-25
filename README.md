# WPT_Onenet_IoT — 无线充电网页控制台

[![Deploy](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020)]()
[![Framework](https://img.shields.io/badge/Framework-Vanilla%20JS-yellow)]()
[![PWA](https://img.shields.io/badge/PWA-Enabled-5A0FC8)]()
[![Charts](https://img.shields.io/badge/Charts-Chart.js-FF6384)]()
[![CSS](https://img.shields.io/badge/CSS-Tailwind-06B6D4)]()

WPT 无线充电系统的响应式网页端控制台，部署于 Cloudflare Pages。通过 OneNET HTTP API 直连云平台物模型，提供实时监控、远程控制、历史数据、数据模型管理等完整功能。支持 PWA 离线访问，可添加至手机主屏幕。

## 访问地址

**https://wptonenet.483763727.workers.dev**

## 目录

1. [功能总览](#功能总览)
2. [架构](#架构)
3. [页面功能](#页面功能)
4. [登录凭据](#登录凭据)
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
| 🎛️ **远程控制** | 启停开关 toggle, 频率设置, 通用字符串/数值控制 |
| 📉 **历史数据** | Chart.js 折线图展示 V/I/F 趋势, 每分钟自动采样 |
| ⚙️ **数据模型管理** | 传感器/控制器动态增删, 图标/颜色/单位/范围自定义 |
| 📱 **PWA** | Service Worker 离线缓存, 可添加到手机主屏幕 |
| 🌗 **深色模式** | 自适应系统主题, 全局 CSS 变量 |
| 🔐 **登录保护** | 简单登录页, 防未经授权访问 |

---

## 架构

```
┌─────────────────────────────┐
│     Cloudflare Pages        │
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

全屏居中登录表单, 输入账号密码后存入 `localStorage`, 其他页面检查登录状态。未登录自动跳转登录页。

### 仪表盘 (`index.html`)

根据用户在设置页配置的**数据模型**动态渲染传感器卡和控制卡。首次加载时自动从 OneNET 拉取最新数据, 每 5 秒自动刷新。点击同步按钮立即更新。连接状态指示器显示设备在线/离线。

### 实时监控 (`monitoring.html`)

独立传感器只读页面, 更大字号显示, 带 `#` 分隔线。每 10 秒刷新一次。适合全屏显示器或平板横屏查看。

### 远程控制 (`control.html`)

控制卡列表, 每张卡包含:
- **布尔控制器 (Switch)**: toggle 开关, 动画过渡, 乐观 UI 更新
- **数值控制器 (SetFreq)**: 输入框 + 发送按钮, `toCloud` 自动转换 (kHz → Hz)
- **字符串控制器**: 输入框 + 发送

每 60 秒自动同步状态, 手动点击同步按钮立即更新。下发指令后 3 秒乐观锁保护, 防止云端旧值回弹。

### 历史数据 (`history.html`)

- 自适应 Y 轴折线图 (Chart.js), 每分钟自动采样一条记录
- 最高存储 24 小时 (1440 条) 数据
- 响应式表格展示最近数据
- 在线/离线状态徽章

### 设置 (`settings.html`)

两个 Tab:
- **OneNET 配置**: 产品 ID、设备名、Token, 存入 `localStorage`
- **数据模型管理**: 增/删/改传感器和控制器, 实时生效。传感器支持: 名称、图标 (FontAwesome)、颜色、单位、云端映射键、数据类型 (float/int32)、最小值/最大值、步进、`fromCloud` 转换函数。控制器支持: 同上, 外加 `toCloud` 转换函数 (如 `v => v * 1000`)。

---

## 登录凭据

| 字段 | 值 |
|:---|:---|
| 账号 | `admin` |
| 密码 | `123456789` |

登录状态存储在 `localStorage`, 关闭浏览器后需重新登录。

---

## 技术栈

| 层级 | 技术 |
|:---|:---|
| HTML | 原生 HTML5, 语义标签 |
| CSS | Tailwind CSS (CDN), 自定义全局变量 |
| JS | 原生 ES6 (无框架), async/await, fetch API |
| 图表 | Chart.js v4 (CDN, 仅历史页加载) |
| 图标 | Font Awesome Free (CDN) |
| PWA | Service Worker + manifest.json |
| 存储 | `localStorage` (配置 + 缓存 + 锁) |
| 部署 | Cloudflare Pages (Git 自动部署) |

---

## 数据流

### 读取数据

```
fetchAll() 每 5~10s:
  GET /thingmodel/query-device-property
  → JSON: {code:0, data:[{identifier:"V", value:"12.5", time:...}]}
  → config.js fromCloud 转换 (如 F/1000 → kHz)
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

### Cloudflare Pages

1. 关联 GitHub 仓库 `Ran-sh/WPT_Onenet_IoT`
2. 监听分支: `gh-pages` + `master`
3. 构建命令: 无 (纯静态)
4. 输出目录: `/` (根目录)
5. SPA 路由: 启用 (404 → index.html)

### 手动推送

```bash
cd ONENETapp
git add -A && git commit -m "..."
git push origin gh-pages
git push origin gh-pages:master   # Cloudflare 同时监听 master
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
├── js/
│   ├── config.js       # OneNET 配置 + 数据模型 CRUD + 工具函数
│   ├── onenet.js       # OneNetService 类 (数据拉取 + 属性设置)
│   └── mobile-nav.js   # 移动端底部导航栏 (自动注入)
├── service-worker.js   # PWA 离线支持
├── manifest.json       # PWA 清单
└── wrangler.jsonc      # Cloudflare Pages 配置
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
| fromCloud | 数据转换 (云端→前端) | `v => Math.floor(v/1000)` |
| toCloud | 数据转换 (前端→云端) | `v => v * 1000` |

默认模型包含 3 个传感器 (`voltage`, `current`, `freq`) 和 2 个控制器 (`switch`, `setfreq`)。

---

## 常见问题

| 问题 | 原因 | 解决 |
|:---|:---|:---|
| 所有卡片显示 `--` | 未配置 OneNET 凭证 | 进设置页填写产品 ID / 设备名 / Token |
| 设置页改了但仪表盘没变 | 页面缓存 | 切换页面或刷新, 仪表盘监听 `visibilitychange` |
| 下发指令无效 | ESP8266 固件版本旧 | V5.1 修复了 SetFreq/Switch 遥测覆盖问题 |
| 历史图表为空 | 数据量不足 | 至少等 1 分钟 (每分钟采样 1 条) |
| PWA 安装无效 | 浏览器不支持 | Chrome/Edge iOS 不支持 PWA 安装, 用 Safari "添加到主屏幕" |
| `net::ERR_FAILED` | CORS 被浏览器拦截 | OneNET API 不应有 CORS 问题, 检查 Token 是否正确 |

---

## 关联项目

- 主项目: [Ran-sh/WPT_PWM](https://github.com/Ran-sh/WPT_PWM) (分支 `ONENET`)
- 微信小程序: 主项目 `安卓app/` 目录
- Railway 桥接 (历史): [Ran-sh/WPT_Railway](https://github.com/Ran-sh/WPT_Railway)

## 作者

**Rssss**

## 许可

MIT
