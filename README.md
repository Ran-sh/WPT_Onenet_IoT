# WPT_Onenet_IoT — 无线充电网页控制台

[![Deploy](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020)]()
[![Framework](https://img.shields.io/badge/Framework-Vanilla%20JS-yellow)]()
[![PWA](https://img.shields.io/badge/PWA-Enabled-5A0FC8)]()

WPT 无线充电系统的网页端控制台，部署于 Cloudflare Pages。通过 OneNET HTTP API 直连云平台，实现实时监控与远程控制。

## 访问地址

**https://wptonenet.483763727.workers.dev**

## 功能

- **首页仪表盘**: 动态传感器卡片，根据数据模型自动渲染
- **实时监控**: V/I/F 遥测数据，在线状态指示，自动刷新
- **远程控制**: 启停开关、频率设置、通用控制
- **历史数据**: 折线图展示 V/I/F 趋势
- **设置**: OneNET 凭证配置、数据模型动态管理
- **PWA**: 支持离线访问，可添加到手机主屏幕
- **深色主题**: 自适应系统主题

## 架构

```
网页控制台 ──HTTPS── OneNET API (iot-api.heclouds.com)
                       ├─ GET  /thingmodel/query-device-property
                       └─ POST /thingmodel/set-device-property
```

## 登录

- 账号: `admin`
- 密码: `123456789`

## 部署

推送 `gh-pages` 或 `master` 分支到 GitHub 即可触发 Cloudflare Pages 自动部署。

```bash
git push origin gh-pages
git push origin gh-pages:master
```

## 技术栈

- 原生 HTML/CSS/JS (无框架)
- Tailwind CSS (CDN)
- Chart.js (历史图表)
- Font Awesome (图标)
- Service Worker (PWA 离线支持)

## 项目结构

```
ONENETapp/
├── index.html          # 首页仪表盘
├── monitoring.html     # 实时监控
├── control.html        # 远程控制
├── history.html        # 历史数据
├── settings.html       # 设置
├── login.html          # 登录
├── js/
│   ├── config.js       # OneNET 配置 + 数据模型
│   ├── onenet.js       # OneNET API 服务
│   └── mobile-nav.js   # 移动端导航
├── service-worker.js   # PWA
└── wrangler.jsonc      # Cloudflare 配置
```

## 关联项目

- 主项目: [Ran-sh/WPT_PWM](https://github.com/Ran-sh/WPT_PWM) (分支 `ONENET`)
