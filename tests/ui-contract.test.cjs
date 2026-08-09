const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const pages = ['index', 'monitoring', 'control', 'history', 'alerts', 'settings', 'login'];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/* 提取源码中从签名开始、括号配平的函数片段，用于在 VM 中做行为验证 */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `未找到函数签名: ${signature}`);
  let depth = 0;
  let i = start;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { i += 1; break; }
    }
  }
  assert.equal(depth, 0, `函数片段括号未配平: ${signature}`);
  return source.slice(start, i);
}

/* 构建 handleControl 的最小运行环境：伪 DOM、可注入的发送实现与定时器桩 */
function buildHandleControlContext(checkbox, sendImpl) {
  const context = {
    document: {
      getElementById: (id) => id === 'toggle-switch' ? checkbox : null
    },
    updateToggleUI: () => {},
    setTimeout: (fn, ms) => { context.__timeoutCalls.push({ fn, ms }); return 1; },
    clearTimeout: () => {},
    __sendCalls: [],
    __timeoutCalls: []
  };
  context.sendControlCommand = async (id, value) => {
    context.__sendCalls.push({ id, value });
    return sendImpl(id, value);
  };
  return context;
}

function loadWebModules(initialStorage = {}, fetchImpl, options = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const realDate = Date;
  const fakeNow = () => (options.nowMs !== undefined ? options.nowMs : realDate.now());
  const fakeDate = function FakeDate(...args) {
    if (args.length === 0) return new realDate(fakeNow());
    return new realDate(...args);
  };
  fakeDate.now = fakeNow;
  const context = {
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    document: { createElement: () => ({ textContent: '', innerHTML: '' }) },
    fetch: fetchImpl,
    AbortController: options.AbortController || AbortController,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    Date: fakeDate,
    Promise, Set, Object, Array, JSON, Math, Number, String
  };
  vm.createContext(context);
  vm.runInContext(read('js/config.js') + '\n' + read('js/onenet.js') +
    '\n;globalThis.__web = { OneNetService, validateControlParams, normalizeCloudValue, getDataModel,' +
    ' DATA_MODEL_VERSION: typeof DATA_MODEL_VERSION !== "undefined" ? DATA_MODEL_VERSION : undefined,' +
    ' DEFAULT_DEVICE_MODELS: typeof DEFAULT_DEVICE_MODELS !== "undefined" ? DEFAULT_DEVICE_MODELS : undefined,' +
    ' getOneNetConfig: typeof getOneNetConfig === "function" ? getOneNetConfig : undefined,' +
    ' saveOneNetDeviceConfig: typeof saveOneNetDeviceConfig === "function" ? saveOneNetDeviceConfig : undefined,' +
    ' deviceStorageKey: typeof deviceStorageKey === "function" ? deviceStorageKey : undefined,' +
    ' isReceiverStartAllowed: typeof isReceiverStartAllowed === "function" ? isReceiverStartAllowed : undefined,' +
    ' getReceiverCommandOutcome: typeof getReceiverCommandOutcome === "function" ? getReceiverCommandOutcome : undefined,' +
    ' alignHistoriesByTimestamp: typeof alignHistoriesByTimestamp === "function" ? alignHistoriesByTimestamp : undefined,' +
    ' isValidReceiverCommand: typeof isValidReceiverCommand === "function" ? isValidReceiverCommand : undefined,' +
    ' validateOneNetDeviceConfig: typeof validateOneNetDeviceConfig === "function" ? validateOneNetDeviceConfig : undefined,' +
    ' clearOneNetDeviceConfig: typeof clearOneNetDeviceConfig === "function" ? clearOneNetDeviceConfig : undefined,' +
    ' clearDeviceRuntimeData: typeof clearDeviceRuntimeData === "function" ? clearDeviceRuntimeData : undefined,' +
    ' clearAllRuntimeData: typeof clearAllRuntimeData === "function" ? clearAllRuntimeData : undefined,' +
    ' TELEMETRY_FRESH_MS: typeof TELEMETRY_FRESH_MS !== "undefined" ? TELEMETRY_FRESH_MS : undefined };', context);
  return { api: context.__web, storage };
}

test('所有页面使用统一的工业仪表盘视觉系统', () => {
  for (const page of pages) {
    const html = read(`${page}.html`);
    assert.match(html, /css\/dashboard\.css/, `${page}.html 缺少统一样式`);
    assert.doesNotMatch(html, /dashboard-v5/, `${page}.html 仍引用旧CSS入口`);
    assert.match(html, new RegExp(`data-page=["']${page}["']`), `${page}.html 缺少页面标识`);
  }
});

test('实时监测页提供状态总览、响应式数据网格和更新时间', () => {
  const html = read('monitoring.html');
  assert.match(html, /class=["'][^"']*monitor-overview/);
  assert.match(html, /data-endpoint-summary=["']tx["']/);
  assert.match(html, /data-endpoint-summary=["']rx["']/);
  assert.match(html, /id=["']lastUpdateText["']/);
  assert.match(html, /id=["']trendChart["']/);
});

test('移动导航由共享样式控制并标记当前页面', () => {
  const script = read('js/mobile-nav.js');
  assert.match(script, /app-mobile-nav/);
  assert.match(script, /aria-current/);
  assert.match(script, /path === '\/index'/);
  assert.doesNotMatch(script, /nav\.style\.cssText/);
});

test('视觉系统覆盖移动端、可访问焦点和减少动画偏好', () => {
  const css = read('css/dashboard.css');
  assert.match(css, /@media\s*\(max-width:\s*1023px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /--wpt-accent/);
});

test('所有受保护页面在业务脚本前加载统一登录守卫', () => {
  for (const page of pages.filter((name) => name !== 'login')) {
    const html = read(`${page}.html`);
    const guardAt = html.indexOf('js/auth-guard.js');
    const configAt = html.indexOf('js/config.js');
    assert.ok(guardAt > 0, `${page}.html 缺少登录守卫`);
    assert.ok(configAt < 0 || guardAt < configAt, `${page}.html 登录守卫加载过晚`);
  }

  assert.ok(fs.existsSync(path.join(root, 'js', 'auth-guard.js')), '缺少统一登录守卫脚本');
  const guard = read('js/auth-guard.js');
  assert.match(guard, /sessionStorage/);
  assert.match(guard, /lastLoginTime/);
  assert.match(guard, /login\.html/);
  assert.match(read('login.html'), /sessionStorage\.setItem/);
});

test('网页活动资源统一标记V6.0.0', () => {
  for (const page of pages) {
    assert.match(read(`${page}.html`), /name=["']wpt-version["'][^>]*V6\.0\.0/);
  }
  for (const page of ['index', 'monitoring', 'control', 'history', 'alerts', 'settings']) {
    assert.match(read(`${page}.html`), /WPT Monitor V6\.0\.0/);
  }
  assert.match(read('js/auth-guard.js'), /V6\.0\.0/);
  assert.match(read('js/config.js'), /V6\.0\.0/);
  assert.match(read('js/onenet.js'), /V6\.0\.0/);
  assert.match(read('js/ui-common.js'), /V6\.0\.0/);
  assert.match(read('js/index-page.js'), /V6\.0\.0/);
  assert.match(read('js/monitoring-page.js'), /V6\.0\.0/);
  assert.match(read('js/mobile-nav.js'), /V6\.0\.0/);
  assert.match(read('css/dashboard.css'), /V6\.0\.0/);
  assert.match(read('service-worker.js'), /WPT Monitor V6\.0\.0/);
  assert.match(read('service-worker.js'), /wpt-v6-0-0-web-9/);
  assert.match(read('README.md'), /V6\.0\.0/);
});

test('所有页面允许缩放并提供一致的PWA入口', () => {
  for (const page of pages) {
    const html = read(`${page}.html`);
    assert.match(html, /viewport-fit=cover/, `${page}.html 未适配安全区域`);
    assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/, `${page}.html 禁止了用户缩放`);
    assert.match(html, /rel=["']manifest["']/, `${page}.html 缺少PWA清单`);
    assert.match(html, /name=["']theme-color["']/, `${page}.html 缺少主题色`);
  }

  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, 'V6.0.0');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, icon.src.replace(/^\//, ''))), `PWA图标不存在: ${icon.src}`);
  }
});

test('CSS统一入口为dashboard.css且Service Worker预缓存同步升级', () => {
  assert.ok(fs.existsSync(path.join(root, 'css', 'dashboard.css')), '缺少统一样式入口');
  assert.equal(fs.existsSync(path.join(root, 'css', 'dashboard-v5.css')), false, '旧CSS入口必须删除');
  const worker = read('service-worker.js');
  assert.match(worker, /BASE \+ '\/css\/dashboard\.css'/);
  assert.doesNotMatch(worker, /dashboard-v5/);
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
});

test('R65 生产页面使用本地预编译 Tailwind', () => {
  for (const page of pages) {
    const html = read(`${page}.html`);
    assert.doesNotMatch(html, /cdn\.tailwindcss\.com/, `${page}.html 仍在生产环境运行 Tailwind CDN`);
    const tailwindIndex = html.indexOf('href="css/tailwind.css"');
    const dashboardIndex = html.indexOf('href="css/dashboard.css"');
    assert.ok(tailwindIndex >= 0, `${page}.html 缺少本地 css/tailwind.css`);
    assert.ok(dashboardIndex >= 0, `${page}.html 缺少 css/dashboard.css`);
    assert.ok(tailwindIndex < dashboardIndex, `${page}.html 本地 tailwind.css 必须位于 dashboard.css 之前`);
  }
});

test('R66 Service Worker 缓存本地 Tailwind', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-10'/, 'SW 缓存版本必须升级为 web-10');
  assert.match(worker, /BASE \+ '\/css\/tailwind\.css'/, 'SW 必须预缓存本地 css/tailwind.css');
  assert.doesNotMatch(worker, /cdn\.tailwindcss\.com/, 'SW CDN_HOSTS 不得再包含 cdn.tailwindcss.com');
  assert.match(worker, /cdnjs\.cloudflare\.com/, 'SW CDN_HOSTS 必须保留 cdnjs.cloudflare.com');
  assert.match(worker, /cdn\.jsdelivr\.net/, 'SW CDN_HOSTS 必须保留 cdn.jsdelivr.net');
});

test('R67 Tailwind CSS 构建输入输出可复现', () => {
  assert.ok(fs.existsSync(path.join(root, 'css', 'tailwind-input.css')), '缺少 css/tailwind-input.css 输入文件');
  assert.ok(fs.existsSync(path.join(root, 'css', 'tailwind.css')), '缺少 css/tailwind.css 生成输出');
  const input = read('css/tailwind-input.css').replace(/\r\n/g, '\n').trim();
  assert.equal(input, '@tailwind base;\n@tailwind components;\n@tailwind utilities;');
  const output = read('css/tailwind.css');
  assert.ok(output.length >= 5000, 'tailwind.css 输出过短，疑似未完整生成');
  assert.match(output, /\.hidden\{display:none\}/);
  assert.match(output, /@media \(min-width:1024px\)/);
  const readme = read('README.md');
  assert.match(readme, /Tailwind CSS 3\.4\.17/, 'README 必须固定 Tailwind CSS 3.4.17');
  assert.match(readme, /本地预编译/, 'README 必须说明本地预编译');
  assert.match(readme, /npx[\s\S]{0,200}tailwindcss@3\.4\.17[\s\S]{0,400}(?:--minify[\s\S]{0,200}--content|--content[\s\S]{0,200}--minify)[\s\S]{0,300}\.\/\*\.html[\s\S]{0,300}\.\/js\/\*\.js/, 'README 必须含 pinned 3.4.17 minify 生成命令');
});

test('登录门控具备失败限速、完整有效期和安全回跳', () => {
  const login = read('login.html');
  const guard = read('js/auth-guard.js');
  const expectedHash = crypto.createHash('sha256').update('admin:admin123').digest('hex');
  assert.match(login, new RegExp(expectedHash));
  assert.match(login, /wpt_login_attempts/);
  assert.match(login, /lockedUntil/);
  assert.match(login, /wpt_persistent_auth/);
  assert.match(login, /getSafeNextPath/);
  assert.match(guard, /legacyAge\s*>=\s*0/);
  assert.match(guard, /expiresAt/);
});

test('预览数据明确离线且控制值符合固件边界', () => {
  const service = read('js/onenet.js');
  assert.match(service, /_isMock:\s*true,\s*_isOnline:\s*false/);
  assert.match(service, /c\.id === 'setfreq'\) mockData\[c\.id\] = 100/);
  assert.match(service, /只有设备详情接口明确确认在线/);

  const { api } = loadWebModules();
  const mock = api.OneNetService.getMockData();
  assert.equal(mock._isMock, true);
  assert.equal(mock._isOnline, false);
  assert.equal(mock.setfreq, 100);
  assert.ok(mock.freq >= 20 && mock.freq <= 200);

  const model = api.getDataModel();
  assert.equal(api.validateControlParams(model, { setfreq: 99.9 }), true);
  assert.equal(api.validateControlParams(model, { setfreq: 100 }), true);
  assert.equal(api.validateControlParams(model, { setfreq: 100.1 }), false);
  assert.equal(api.validateControlParams(model, { setfreq: 200.1 }), false);
  const freq = model.sensors.find((item) => item.id === 'freq');
  assert.equal(api.normalizeCloudValue(freq, '99900'), 99.9);
  assert.equal(api.normalizeCloudValue(freq, 'not-a-number'), undefined);
  assert.equal(api.normalizeCloudValue(freq, null), undefined);
  assert.equal(api.normalizeCloudValue(freq, '   '), undefined);
});

test('真实在线数据写入缓存时清除旧预览和错误标记', async () => {
  const initialStorage = {
    iot_onenet_config: JSON.stringify(LEGACY_CFG),
    iot_latest_data: JSON.stringify({ _isMock: true, _error: 'preview', voltage: 1 })
  };
  const fetchImpl = async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: [{ identifier: 'V', value: '12.5' }] })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, data: { status: 1 } })
    };
  };
  const { api, storage } = loadWebModules(initialStorage, fetchImpl);
  const latest = await api.OneNetService.getLatestData();
  const cached = JSON.parse(storage.get('iot_latest_data_tx'));
  assert.equal(latest._isOnline, true);
  assert.equal(cached._isOnline, true);
  assert.equal(cached._isMock, undefined);
  assert.equal(cached._error, undefined);
});

test('网页云端部分属性响应不会把旧缓存字段写成新的实时历史', async () => {
  const now = Date.now();
  const initialStorage = {
    iot_onenet_config: JSON.stringify(LEGACY_CFG),
    iot_latest_data: JSON.stringify({ voltage: 48, _isOnline: true, hasOwnProperty: null }),
    iot_control_locks: JSON.stringify({})
  };
  const fetchImpl = async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ identifier: 'I', value: 1.25, data_type: 'float', time: now - 1000 }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
  };
  const { api, storage } = loadWebModules(initialStorage, fetchImpl);
  await api.OneNetService.getLatestData();
  const latest = JSON.parse(storage.get('iot_latest_data_tx'));
  assert.equal(latest.voltage, undefined);
  assert.equal(latest.current, 1.25);
  /* 部分属性响应缺少必需遥测字段：不得写历史，也不得把旧缓存字段补回 */
  assert.equal(storage.has('iot_history_data_tx'), false);
});

test('网页控制页仅在实时在线状态确认后开放下发', () => {
  const core = read('js/control-core.js');
  const page = read('js/control-page.js');
  assert.match(core, /getTxPermissions/);
  assert.match(core, /getRxPermissions/);
  assert.match(core, /isReceiverStartAllowed/);
  assert.match(page, /getTxPermissions/);
  assert.match(page, /getRxPermissions/);
  assert.doesNotMatch(page, /iot_latest_data/);
  assert.doesNotMatch(page, /data\._isOnline\s*===\s*true[\s\S]{0,300}innerText\s*=\s*'在线'/);
});

test('网页首页和监测页在请求失败时立即遮蔽实时值', () => {
  const indexPage = read('js/index-page.js');
  const monitoringPage = read('js/monitoring-page.js');
  assert.match(indexPage, /Promise\.allSettled/);
  assert.match(monitoringPage, /Promise\.allSettled/);
  assert.match(indexPage, /status === 'rejected'/);
  assert.match(monitoringPage, /status === 'rejected'/);
  assert.match(indexPage, /WptUi\.classifyEndpoint/);
  assert.match(monitoringPage, /WptUi\.classifyEndpoint/);
});

test('网页首页和监测页启动时不会把持久化缓存显示成实时在线数据', () => {
  const indexPage = read('js/index-page.js');
  const monitoringPage = read('js/monitoring-page.js');
  assert.doesNotMatch(indexPage, /iot_latest_data/);
  assert.doesNotMatch(monitoringPage, /iot_latest_data/);
  assert.match(indexPage, /'--'/);
  assert.match(monitoringPage, /'--'/);
});

test('网页历史CSV防公式注入时仍保留合法负数', () => {
  /* 行为断言：toCsvCell 保留合法负数/纯数字，对公式前缀加单引号，双引号双写。 */
  const { api } = loadHistoryCore();
  const cell = api.WptHistoryCore.toCsvCell;
  assert.equal(cell(-1.25), '-1.25');
  assert.equal(cell(1), '1');
  assert.equal(cell('1.'), '1.');
  assert.equal(cell('.5'), '.5');
  assert.equal(cell('=cmd'), '"\'=cmd"');
  assert.equal(cell('+cmd'), '"\'+cmd"');
  assert.equal(cell('-cmd'), "\"'-cmd\"");
  assert.equal(cell('@cmd'), '"\'@cmd"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell(null), '');
  assert.equal(cell(undefined), '');
});

test('数据模型会过滤异常缓存并保留固件安全边界', () => {
  const config = read('js/config.js');
  assert.match(config, /DATA_MODEL_VERSION\s*=\s*4/);
  assert.match(config, /MAX_MODEL_ITEMS/);
  assert.match(config, /sanitizeModelItem/);
  assert.match(config, /merged\.id === 'current'\) merged\.max = 5/);
  assert.match(config, /merged\.min = 20/);
  assert.match(config, /merged\.max = 200/);
  assert.match(config, /getWptState/);

  const malicious = JSON.stringify({
    sensors: [
      { id: 'bad id', name: '非法标识', icon: 'fa-bolt', cloudKey: 'bad' },
      { id: 'safe_id', name: '<img src=x onerror=alert(1)>', icon: 'x\" onclick=alert(1)', cloudKey: '../x' }
    ],
    controls: []
  });
  const { api } = loadWebModules({ iot_data_model: malicious });
  const model = api.getDataModel();
  assert.equal(model.sensors.some((item) => item.id === 'bad id'), false);
  assert.equal(model.sensors.some((item) => item.icon.includes('onclick')), false);
  const sanitized = model.sensors.find((item) => item.id === 'safe_id');
  assert.ok(sanitized);
  assert.equal(sanitized.name.includes('<'), false);
  assert.equal(sanitized.cloudKey, 'safe_id');
});

test('轮询页面在隐藏或离开时停止定时器', () => {
  const control = read('control.html');
  const history = read('history.html');
  assert.doesNotMatch(control, /_stopControlSync/);
  assert.doesNotMatch(control, /visibilitychange/);
  assert.doesNotMatch(control, /pagehide/);
  assert.doesNotMatch(history, /stopHistoryPolling/);
  assert.doesNotMatch(history, /visibilitychange/);
  assert.doesNotMatch(history, /pagehide/);

  /* 控制页轮询由 WptUi 生命周期轮询统一管理 */
  const uiCommon = read('js/ui-common.js');
  assert.match(uiCommon, /visibilitychange/);
  assert.match(uiCommon, /pagehide/);
  assert.match(uiCommon, /beforeunload/);
  assert.match(read('js/control-page.js'), /createLifecyclePoller/);
  assert.match(read('js/index-page.js'), /createLifecyclePoller/);
  assert.match(read('js/monitoring-page.js'), /createLifecyclePoller/);
  assert.match(read('js/history-page.js'), /createLifecyclePoller/);
});

test('所有内联脚本均可被JavaScript解析', () => {
  for (const page of pages) {
    const html = read(`${page}.html`);
    const scripts = html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi);
    for (const match of scripts) {
      const source = match[1].trim();
      if (source) assert.doesNotThrow(() => new Function(source), `${page}.html 存在脚本语法错误`);
    }
  }
});

test('Service Worker采用同源全网络优先并立即接管新版本', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /networkFirst/);
  assert.match(worker, /url\.origin === self\.location\.origin/);
  assert.match(worker, /Response\.error\(\)/);
  assert.match(worker, /skipWaiting/);
  assert.match(worker, /clients\.claim/);
  assert.match(worker, /icon\.svg/);
});

test('控制页命令同端一次一条、finally 解锁且无 2s 延时伪装成功', () => {
  const page = read('js/control-page.js');
  assert.doesNotMatch(page, /_switchPending/);
  assert.doesNotMatch(page, /setTimeout\(/);
  assert.match(page, /pending\.tx/);
  assert.match(page, /pending\.rx/);
  assert.match(page, /finally/);
});

test('控制页轮询由 WptUi 生命周期轮询统一管理且无旧句柄', () => {
  const page = read('js/control-page.js');
  assert.doesNotMatch(page, /_controlInitTimer/);
  assert.doesNotMatch(page, /_controlRetryTimer|_ctrlSyncTimer|_stopControlSync/);
  assert.match(page, /createLifecyclePoller/);
  assert.match(page, /poller\.runNow\(\)/);
  const uiCommon = read('js/ui-common.js');
  assert.match(uiCommon, /runNow\(\)/);
  assert.match(uiCommon, /startTimer\(\)/);
});

test('轮询生命周期保留 interval/retry 清理与 pagehide/visibilitychange 行为', () => {
  const controlPage = read('js/control-page.js');
  assert.doesNotMatch(controlPage, /_controlRetryTimer|_ctrlSyncTimer|_stopControlSync/);
  assert.match(controlPage, /createLifecyclePoller/);
  const uiCommon = read('js/ui-common.js');
  assert.match(uiCommon, /clearInterval/);
  assert.match(uiCommon, /visibilitychange/);
  assert.match(uiCommon, /pagehide/);
  assert.match(uiCommon, /beforeunload/);
});

/* ========== R1-R8 双设备核心 API 契约 ========== */

function makePropertyFetch(propertyData, status = 1) {
  return async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: propertyData }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status } }) };
  };
}

const DUAL_CONFIG = JSON.stringify({
  version: 1,
  tx: { productId: 'txp', deviceName: 'txd', token: 'version=2026-08-08&res=products%2Ftx&et=1800&method=sha1&sign=tx' },
  rx: { productId: 'rxp', deviceName: 'rxd', token: 'version=2026-08-08&res=products%2Frx&et=1800&method=sha1&sign=rx' }
});

/* 通过 R2 严格校验的测试 Token / 旧单设备配置种子。 */
const VALID_TOKEN = 'version=2026-08-08&res=products%2F1&et=1800&method=sha1&sign=abc';
const LEGACY_CFG = { productId: 'p', deviceName: 'd', token: VALID_TOKEN };

/* 完整 TX 遥测：V/I/F/S，times 可显式指定（缺省为 now-1000*(i+1)）。 */
function fullTxItems(now, times) {
  const t = (i) => (Array.isArray(times) ? times[i] : now - 1000 * (i + 1));
  return [
    { identifier: 'V', value: 12.5, data_type: 'float', time: t(0) },
    { identifier: 'I', value: 1.25, data_type: 'float', time: t(1) },
    { identifier: 'F', value: 100000, data_type: 'int32', time: t(2) },
    { identifier: 'S', value: 2, data_type: 'int32', time: t(3) }
  ];
}

/* 完整 RX 遥测：12 项必需字段 + RX_TelemetryFresh；times 缺省为 now-1000*(i+1)。 */
function fullRxItems(now, times, telemetryFresh = true, freshTime) {
  const t = (i) => (Array.isArray(times) ? times[i] : now - 1000 * (i + 1));
  return [
    { identifier: 'RX_IMon', value: 1.234, data_type: 'double', time: t(0) },
    { identifier: 'RX_Current_uA', value: 250, data_type: 'double', time: t(1) },
    { identifier: 'RX_BoneP', value: 1.1, data_type: 'double', time: t(2) },
    { identifier: 'RX_BoneN', value: 1.2, data_type: 'double', time: t(3) },
    { identifier: 'RX_BoneV', value: 1.3, data_type: 'double', time: t(4) },
    { identifier: 'RX_Resistance', value: 5000, data_type: 'int32', time: t(5) },
    { identifier: 'RX_Vout', value: 12.0, data_type: 'double', time: t(6) },
    { identifier: 'RX_Limit', value: false, data_type: 'bool', time: t(7) },
    { identifier: 'RX_Stim', value: false, data_type: 'bool', time: t(8) },
    { identifier: 'RX_Connected', value: true, data_type: 'bool', time: t(9) },
    { identifier: 'RX_Valid', value: true, data_type: 'bool', time: t(10) },
    { identifier: 'RX_FaultFlags', value: 0, data_type: 'int32', time: t(11) },
    { identifier: 'RX_TelemetryFresh', value: telemetryFresh, data_type: 'bool', time: freshTime !== undefined ? freshTime : t(12) }
  ];
}

test('R1 配置迁移只到 TX，RX 独立保存且互不影响', () => {
  const { api, storage } = loadWebModules({
    iot_onenet_config: JSON.stringify({ productId: 'txp', deviceName: 'txd', token: VALID_TOKEN })
  }, async () => { throw new Error('不应发起请求'); });

  const tx = api.getOneNetConfig('tx');
  assert.equal(tx.PRODUCT_ID, 'txp');
  assert.equal(tx.DEVICE_NAME, 'txd');
  assert.equal(tx.TOKEN, VALID_TOKEN);
  const rx = api.getOneNetConfig('rx');
  assert.equal(rx.TOKEN, '');
  /* 迁移成功后旧键移除，防复活 */
  assert.equal(storage.has('iot_onenet_config'), false);

  const store = JSON.parse(storage.get('iot_onenet_devices_v1'));
  assert.equal(store.version, 1);
  assert.deepEqual(store.tx, { productId: 'txp', deviceName: 'txd', token: VALID_TOKEN });
  assert.deepEqual(store.rx, {});
  assert.notEqual(store.tx, store.rx);

  assert.equal(api.saveOneNetDeviceConfig('rx', { productId: 'rxp', deviceName: 'rxd', token: 'res=r&et=1&sign=r' }), true);
  const store2 = JSON.parse(storage.get('iot_onenet_devices_v1'));
  assert.deepEqual(store2.tx, { productId: 'txp', deviceName: 'txd', token: VALID_TOKEN });
  assert.deepEqual(store2.rx, { productId: 'rxp', deviceName: 'rxd', token: 'res=r&et=1&sign=r' });

  assert.equal(api.saveOneNetDeviceConfig('bad', { productId: 'x', deviceName: 'y', token: 'z' }), false);
  assert.equal(api.getOneNetConfig('bad').TOKEN, '');

  /* 重复迁移不覆盖新存储 */
  storage.set('iot_onenet_config', JSON.stringify({ productId: 'other', deviceName: 'other', token: 'other' }));
  assert.equal(api.getOneNetConfig('tx').PRODUCT_ID, 'txp');
});

test('R2 数据模型 V4：TX 兼容保留，RX 固定范围与云端键不可被本地覆盖', () => {
  const { api } = loadWebModules({});
  assert.equal(api.DATA_MODEL_VERSION, 4);

  const tx = api.getDataModel();
  assert.equal(tx.version, 4);
  assert.ok(tx.sensors.some((s) => s.id === 'voltage' && s.cloudKey === 'V'));
  assert.ok(tx.sensors.some((s) => s.id === 'current' && s.max === 5));
  assert.ok(tx.sensors.some((s) => s.id === 'freq' && s.min === 20 && s.max === 200 && s.step === 0.1));
  assert.ok(tx.controls.some((c) => c.id === 'switch' && c.cloudKey === 'Switch'));
  assert.ok(tx.controls.some((c) => c.id === 'setfreq' && c.cloudKey === 'SetFreq'));
  const state = tx.sensors.find((s) => s.id === 'state');
  assert.deepEqual(
    { cloudKey: state.cloudKey, dataType: state.dataType, min: state.min, max: state.max, step: state.step },
    { cloudKey: 'S', dataType: 'int32', min: 0, max: 3, step: 1 }
  );

  const rx = api.getDataModel('rx');
  assert.equal(rx.version, 4);
  const fieldChecks = {
    rx_imon: ['RX_IMon', 'double', -3.3, 3.3, 0.001],
    rx_current_ua: ['RX_Current_uA', 'double', -1000, 1000, 0.1],
    rx_bonep: ['RX_BoneP', 'double', 0, 3.3, 0.001],
    rx_bonen: ['RX_BoneN', 'double', 0, 3.3, 0.001],
    rx_bonev: ['RX_BoneV', 'double', -3.3, 3.3, 0.001],
    rx_resistance: ['RX_Resistance', 'int32', -10000000, 10000000, 1],
    rx_vout: ['RX_Vout', 'double', 0, 36.3, 0.01],
    rx_fault_flags: ['RX_FaultFlags', 'int32', 0, 511, 1],
    rx_fault_reason: ['RX_FaultReason', 'string'],
    rx_state: ['RX_State', 'int32', 0, 5, 1],
    rx_telemetry_fresh: ['RX_TelemetryFresh', 'bool'],
    rx_safe: ['RX_Safe', 'bool'],
    rx_command: ['RX_Command', 'string'],
    rx_command_result: ['RX_CommandResult', 'string'],
    rx_command_sequence: ['RX_CommandSequence', 'int32', 0, 2147483647, 1]
  };
  for (const [id, [cloudKey, dataType, min, max, step]] of Object.entries(fieldChecks)) {
    const item = rx.sensors.find((s) => s.id === id);
    assert.ok(item, `缺少 RX 字段 ${id}`);
    assert.equal(item.cloudKey, cloudKey);
    assert.equal(item.dataType, dataType);
    if (min !== undefined) assert.equal(item.min, min);
    if (max !== undefined) assert.equal(item.max, max);
    if (step !== undefined) assert.equal(item.step, step);
  }
  for (const id of ['rx_limit', 'rx_stim', 'rx_connected', 'rx_valid', 'rx_ble_online', 'rx_mqtt_online', 'rx_gateway_online', 'rx_wifi_online']) {
    assert.equal(rx.sensors.find((s) => s.id === id).dataType, 'bool');
  }
  const command = rx.controls.find((c) => c.id === 'command');
  assert.deepEqual({ cloudKey: command.cloudKey, dataType: command.dataType }, { cloudKey: 'RX_Command', dataType: 'string' });

  /* RX 模型不被 localStorage 放宽；旧 iot_data_model 只作为 TX 输入 */
  const malicious = {
    iot_data_model: JSON.stringify({
      sensors: [
        { id: 'rx_safe', max: 999, dataType: 'string' },
        { id: 'rx_fault_flags', max: 999999 },
        { id: 'state', max: 99 }
      ]
    })
  };
  const { api: api2 } = loadWebModules(malicious);
  const rxFixed = api2.getDataModel('rx');
  assert.equal(rxFixed.sensors.find((s) => s.id === 'rx_safe').dataType, 'bool');
  assert.equal(rxFixed.sensors.find((s) => s.id === 'rx_safe').max, undefined);
  assert.equal(rxFixed.sensors.find((s) => s.id === 'rx_fault_flags').max, 511);
  const tx2 = api2.getDataModel('tx');
  assert.equal(tx2.sensors.find((s) => s.id === 'freq').min, 20);
  assert.equal(tx2.sensors.find((s) => s.id === 'state').max, 3);
});

test('R3 data.list 与 data 数组都解析，按源时间计算新鲜度', async () => {
  const now = Date.now();
  const t1 = now - 1000;
  const { api } = loadWebModules({ iot_onenet_devices_v1: DUAL_CONFIG }, makePropertyFetch({
    list: [
      { identifier: 'RX_IMon', value: 1.234, data_type: 'float', time: t1 },
      { identifier: 'RX_Current_uA', value: 250, data_type: 'float', time: t1 - 200 },
      { identifier: 'RX_BoneP', value: 1.1, data_type: 'float', time: t1 },
      { identifier: 'RX_BoneN', value: 1.2, data_type: 'float', time: t1 },
      { identifier: 'RX_BoneV', value: 1.3, data_type: 'float', time: t1 },
      { identifier: 'RX_Resistance', value: 5000, data_type: 'int32', time: t1 },
      { identifier: 'RX_Vout', value: 12.0, data_type: 'float', time: t1 },
      { identifier: 'RX_State', value: 2, data_type: 'int32', time: t1 },
      { identifier: 'RX_TelemetryFresh', value: true, data_type: 'bool', time: t1 },
      { identifier: 'RX_Connected', value: true, data_type: 'bool', time: t1 },
      { identifier: 'RX_Valid', value: true, data_type: 'bool', time: t1 },
      { identifier: 'RX_Safe', value: true, data_type: 'bool', time: t1 },
      { identifier: 'RX_Limit', value: false, data_type: 'bool', time: t1 },
      { identifier: 'RX_Stim', value: false, data_type: 'bool', time: t1 },
      { identifier: 'RX_FaultFlags', value: 0, data_type: 'int32', time: t1 }
    ]
  }, 1));
  const rx = await api.OneNetService.getLatestData('rx');
  assert.equal(rx._isOnline, true);
  assert.equal(rx._isFresh, true);
  assert.equal(rx.rx_imon, 1.234);
  assert.equal(rx.rx_current_ua, 250);
  assert.equal(rx.rx_state, 2);
  assert.equal(rx.rx_telemetry_fresh, true);
  assert.equal(rx.rx_safe, true);
  assert.equal(rx.rx_fault_flags, 0);
  /* 完整遥测时间戳取必需字段最小值（RX_Current_uA 最老） */
  assert.equal(rx._telemetryTimestamp, t1 - 200);
  assert.equal(rx._propertyTimes.RX_IMon, t1);
  assert.ok(rx._ageMs <= 15000);
});

test('R3 data 数组兼容、过期时间不新鲜、未来超限时间不新鲜', async () => {
  const now = Date.now();
  const fresh1 = now - 2000;
  const fresh2 = now - 5000;
  const fresh3 = now - 8000;
  const expired = now - 20000;
  const futureTooFar = now + 120000;
  /* 全部字段新鲜但时间不同 -> live，_telemetryTimestamp 取最小值 */
  const { api } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(fullTxItems(now, [fresh1, fresh2, fresh3, now - 11000]), 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx._isOnline, true);
  assert.equal(tx._isFresh, true);
  assert.equal(tx.voltage, 12.5);
  assert.equal(tx.freq, 100);
  assert.equal(tx._telemetryTimestamp, now - 11000);
  assert.ok(tx._ageMs <= 15000);

  /* 全部字段过期 -> 结构完整但不新鲜 */
  const { api: api2 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(fullTxItems(now, [expired, expired - 1000, expired - 2000, expired - 3000]), 1)
  );
  const tx2 = await api2.OneNetService.getLatestData('tx');
  assert.equal(tx2._isOnline, true);
  assert.equal(tx2._isFresh, false);
  assert.ok(tx2._ageMs > 15000);

  /* 未来超过 60s 的时间被拒绝，telemetry 无有效源时间 */
  const { api: api3 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch([{ identifier: 'V', value: 12.5, data_type: 'float', time: futureTooFar }], 1)
  );
  const tx3 = await api3.OneNetService.getLatestData('tx');
  assert.equal(tx3.voltage, 12.5);
  assert.equal(tx3._telemetryTimestamp, null);
  assert.equal(tx3._isFresh, false);
  assert.equal(Object.keys(tx3._propertyTimes).length, 0);
});

test('R3 TX F 按实际 Hz 校验，不套用设置目标的双档步进', async () => {
  const now = Date.now();
  const t = now - 1000;
  const { api } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch([
      { identifier: 'V', value: 12.5, data_type: 'float', time: t },
      { identifier: 'I', value: 1.25, data_type: 'float', time: t },
      { identifier: 'F', value: 20050, data_type: 'int32', time: t },
      { identifier: 'S', value: 1, data_type: 'int32', time: t }
    ], 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx.voltage, 12.5);
  assert.equal(tx.freq, 20.1);
  assert.equal(tx.state, 1);
  assert.equal(tx._isFresh, true);

  /* 低于 20kHz 且非协议 0：拒绝 */
  const { api: api2 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch([
      { identifier: 'V', value: 12.5, data_type: 'float', time: t },
      { identifier: 'I', value: 1.25, data_type: 'float', time: t },
      { identifier: 'F', value: 19950, data_type: 'int32', time: t },
      { identifier: 'S', value: 2, data_type: 'int32', time: t }
    ], 1)
  );
  const tx2 = await api2.OneNetService.getLatestData('tx');
  assert.equal(tx2.freq, undefined);

  /* 非整数 Hz：拒绝 */
  const { api: api3 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch([
      { identifier: 'V', value: 12.5, data_type: 'float', time: t },
      { identifier: 'I', value: 1.25, data_type: 'float', time: t },
      { identifier: 'F', value: 20050.5, data_type: 'int32', time: t },
      { identifier: 'S', value: 2, data_type: 'int32', time: t }
    ], 1)
  );
  const tx3 = await api3.OneNetService.getLatestData('tx');
  assert.equal(tx3.freq, undefined);

  /* IDLE/FAULT 按协议允许 F=0 */
  const { api: api4 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch([
      { identifier: 'V', value: 12.5, data_type: 'float', time: t },
      { identifier: 'I', value: 1.25, data_type: 'float', time: t },
      { identifier: 'F', value: 0, data_type: 'int32', time: t },
      { identifier: 'S', value: 0, data_type: 'int32', time: t }
    ], 1)
  );
  const tx4 = await api4.OneNetService.getLatestData('tx');
  assert.equal(tx4.voltage, 12.5);
  assert.equal(tx4.freq, 0);
  assert.equal(tx4._isFresh, true);
});

test('R3 类型、范围、步进不合法字段被拒绝', async () => {
  const now = Date.now();
  const t = now - 1000;
  const { api } = loadWebModules(
    { iot_onenet_devices_v1: DUAL_CONFIG },
    makePropertyFetch({
      list: [
        { identifier: 'RX_IMon', value: '12.5', data_type: 'string', time: t },
        { identifier: 'RX_Vout', value: 40, data_type: 'float', time: t },
        { identifier: 'RX_Resistance', value: 1.5, data_type: 'int32', time: t },
        { identifier: 'RX_Current_uA', value: 1.2345, data_type: 'float', time: t },
        { identifier: 'RX_FaultFlags', value: 999, data_type: 'int32', time: t }
      ]
    }, 1)
  );
  const rx = await api.OneNetService.getLatestData('rx');
  assert.equal(rx.rx_imon, undefined);
  assert.equal(rx.rx_vout, undefined);
  assert.equal(rx.rx_resistance, undefined);
  assert.equal(rx.rx_current_ua, undefined);
  assert.equal(rx.rx_fault_flags, undefined);
  assert.equal(rx._isOnline, true);
  assert.equal(rx._telemetryTimestamp, null);
  assert.equal(rx._isFresh, false);
});

test('R10 RX_FaultReason 只读 string 模型与解析覆盖', async () => {
  const { api } = loadWebModules({});
  const reason = api.getDataModel('rx').sensors.find((s) => s.id === 'rx_fault_reason');
  assert.ok(reason, '缺少 RX_FaultReason 模型字段');
  assert.equal(reason.cloudKey, 'RX_FaultReason');
  assert.equal(reason.dataType, 'string');
  assert.equal(reason.name, '故障说明');

  const now = Date.now();
  const t = now - 1000;
  const { api: api2 } = loadWebModules(
    { iot_onenet_devices_v1: DUAL_CONFIG },
    makePropertyFetch({
      list: [
        { identifier: 'RX_FaultReason', value: '0x0004', data_type: 'string', time: t },
        { identifier: 'RX_IMon', value: 1.0, data_type: 'double', time: t },
        { identifier: 'RX_TelemetryFresh', value: true, data_type: 'bool', time: t }
      ]
    }, 1)
  );
  const data = await api2.OneNetService.getLatestData('rx');
  assert.equal(data.rx_fault_reason, '0x0004');
  assert.equal(data._propertyTimes.RX_FaultReason, t);
  assert.equal(data._isOnline, true);
});

test('R3 详情失败本次 _isOnline=false，属性成功也不标在线/新鲜', async () => {
  const now = Date.now();
  const t = now - 1000;
  const fetchImpl = async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ identifier: 'V', value: 12.5, data_type: 'float', time: t }] }) };
    }
    throw new Error('detail down');
  };
  const { api } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx._isOnline, false);
  assert.equal(tx._isFresh, false);
  assert.equal(tx.voltage, 12.5);
});

test('R1 设备详情仅数值 1 且未禁用才在线', async () => {
  const now = Date.now();
  const detailFetch = (detail) => async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: fullTxItems(now) }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: detail }) };
  };
  const cases = [
    [{ status: 2 }, false],
    [{ status: '在线' }, false],
    [{ status: '1' }, false],
    [{ status: 1, enable_status: false }, false],
    [{ status: 1, enable_status: true }, true],
    [{ status: 1 }, true]
  ];
  for (const [detail, expected] of cases) {
    const { api } = loadWebModules(
      { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
      detailFetch(detail)
    );
    const tx = await api.OneNetService.getLatestData('tx');
    assert.equal(tx._isOnline, expected, JSON.stringify(detail));
  }
});

test('R3 非法设备键不发请求', async () => {
  let fetched = false;
  const { api } = loadWebModules({}, async () => { fetched = true; throw new Error('no'); });
  await assert.rejects(api.OneNetService.getLatestData('bad'));
  assert.equal(fetched, false);
});

test('R4 双设备缓存/锁/历史完全隔离且部分响应不补旧值', async () => {
  const fakeNow = 1749999970000;
  const t1 = fakeNow - 12000;   /* 上一分钟且新鲜 */
  const t2 = fakeNow - 6000;    /* 当前分钟且新鲜 */
  const t3 = fakeNow - 1000;    /* 当前分钟且新鲜 */
  let call = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      call++;
      if (call === 1) return { ok: true, status: 200, json: async () => ({ code: 0, data: fullTxItems(fakeNow, [t1, t1, t1, t1]) }) };
      if (call === 2) return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: fullRxItems(fakeNow, [t2, t2, t2, t2, t2, t2, t2, t2, t2, t2, t2, t2, t2]) } }) };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ identifier: 'I', value: 1.25, data_type: 'float', time: t3 }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
  };
  const { api, storage } = loadWebModules({ iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl, { nowMs: fakeNow });

  await api.OneNetService.getLatestData('tx');
  await api.OneNetService.getLatestData('rx');
  await api.OneNetService.getLatestData('tx');

  const txCache = JSON.parse(storage.get('iot_latest_data_tx'));
  assert.equal(txCache.voltage, undefined);
  assert.equal(txCache.current, 1.25);
  assert.equal(txCache._isOnline, true);
  const rxCache = JSON.parse(storage.get('iot_latest_data_rx'));
  assert.equal(rxCache.rx_imon, 1.234);
  assert.equal(rxCache.voltage, undefined);
  assert.equal(rxCache.rx_telemetry_fresh, true);

  const txHistory = JSON.parse(storage.get('iot_history_data_tx'));
  assert.equal(txHistory.length, 1);
  assert.equal(txHistory[0].deviceKey, 'tx');
  assert.equal(txHistory[0].timeSource, 'onenet');
  assert.equal(txHistory[0].timestamp, t1);
  assert.equal(txHistory[0].data.voltage, 12.5);

  const rxHistory = JSON.parse(storage.get('iot_history_data_rx'));
  assert.equal(rxHistory.length, 1);
  assert.equal(rxHistory[0].deviceKey, 'rx');
  assert.equal(rxHistory[0].timestamp, t2);
  assert.equal(rxHistory[0].data.rx_imon, 1.234);

  assert.equal(storage.has('iot_history_data'), false);
  assert.equal(storage.has('iot_latest_data'), false);
});

test('R4 同源分钟历史去重', async () => {
  const fakeNow = 1749999970000;
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      calls++;
      const voltage = calls === 1 ? 12.5 : 12.6;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [
        { identifier: 'V', value: voltage, data_type: 'float', time: fakeNow - 1000 },
        { identifier: 'I', value: 1.25, data_type: 'float', time: fakeNow - 2000 },
        { identifier: 'F', value: 100000, data_type: 'int32', time: fakeNow - 3000 },
        { identifier: 'S', value: 2, data_type: 'int32', time: fakeNow - 4000 }
      ] }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
  };
  const { api, storage } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl, { nowMs: fakeNow });
  await api.OneNetService.getLatestData('tx');
  await api.OneNetService.getLatestData('tx');
  const history = JSON.parse(storage.get('iot_history_data_tx'));
  assert.equal(history.length, 1);
  assert.equal(history[0].data.voltage, 12.5);
});

test('R4 缺 time 的响应不写历史', async () => {
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch([
      { identifier: 'V', value: 12.5, data_type: 'float' },
      { identifier: 'I', value: 1.25, data_type: 'float' },
      { identifier: 'F', value: 100000, data_type: 'int32' },
      { identifier: 'S', value: 2, data_type: 'int32' }
    ], 1)
  );
  await api.OneNetService.getLatestData('tx');
  assert.equal(storage.has('iot_history_data_tx'), false);
});

test('R5 sendProperty 单次 POST：confirmed 才写缓存与锁', async () => {
  let postCount = 0;
  let lastBody = null;
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      postCount++;
      lastBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 'x', code: 0, msg: 'success' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
  };
  const { api, storage } = loadWebModules({ iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);

  const txOutcome = await api.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(txOutcome.accepted, true);
  assert.equal(txOutcome.confirmed, true);
  assert.equal(txOutcome.deviceCode, 0);
  assert.ok(txOutcome.requestId);
  assert.equal(lastBody.params.Switch, true);
  assert.equal(postCount, 1);
  const txCache = JSON.parse(storage.get('iot_latest_data_tx'));
  const txLocks = JSON.parse(storage.get('iot_control_locks_tx'));
  assert.equal(txCache.switch, true);
  assert.ok(txLocks.switch > 0);

  const rxOutcome = await api.OneNetService.sendProperty('rx', { command: 'START' });
  assert.equal(rxOutcome.confirmed, true);
  assert.equal(lastBody.params.RX_Command, 'START');
  const rxCache = JSON.parse(storage.get('iot_latest_data_rx'));
  const rxLocks = JSON.parse(storage.get('iot_control_locks_rx'));
  assert.equal(rxCache.command, 'START');
  assert.ok(rxLocks.command > 0);
  assert.equal(txLocks.command, undefined);
  assert.equal(rxLocks.switch, undefined);
});

test('R5 外层成功但无设备回复只 accepted，不写乐观缓存', async () => {
  let postCount = 0;
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      postCount++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: {} }) };
    }
    throw new Error('no get');
  };
  const { api, storage } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  const outcome = await api.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.deviceCode, null);
  assert.equal(postCount, 1);
  assert.equal(storage.has('iot_latest_data_tx'), false);
  assert.equal(storage.has('iot_control_locks_tx'), false);
  const bool = await api.OneNetService.setProperty({ switch: true });
  assert.equal(bool, false);
});

test('R5 设备拒绝码 confirmed=false 且不写缓存', async () => {
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 500, msg: 'rejected' } }) };
    }
    throw new Error('no get');
  };
  const { api, storage } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  const outcome = await api.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.deviceCode, 500);
  assert.equal(storage.has('iot_latest_data_tx'), false);
});

test('R5 设备成功码 200 也 confirmed', async () => {
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 200, msg: 'ok' } }) };
    }
    throw new Error('no get');
  };
  const { api, storage } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  const outcome = await api.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.deviceCode, 200);
  assert.equal(JSON.parse(storage.get('iot_latest_data_tx')).switch, true);
});

test('R5 传输超时不重试：fetch 只调用一次', async () => {
  let fetchCalls = 0;
  const abortListeners = [];
  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false, addEventListener: (type, fn) => { if (type === 'abort') abortListeners.push(fn); } };
    }
    abort() { this.signal.aborted = true; abortListeners.forEach((fn) => fn()); }
  }
  const fetchImpl = (url, options) => {
    fetchCalls++;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    });
  };
  const timers = [];
  const fakeSetTimeout = (fn) => { timers.push(fn); return timers.length; };
  const fakeClearTimeout = () => {};
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    fetchImpl,
    { AbortController: FakeAbortController, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout }
  );
  const promise = api.OneNetService.sendProperty('tx', { switch: true });
  await Promise.resolve();
  assert.equal(fetchCalls, 1);
  timers.forEach((fn) => fn());
  const outcome = await promise;
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.requestId, '');
  assert.equal(fetchCalls, 1);
  assert.equal(storage.has('iot_latest_data_tx'), false);
});

test('R11 requestId 只取平台真实标识，message 优先 data.msg', async () => {
  /* 设备拒绝：外层 msg 不遮蔽 data.msg，requestId 取 request_id */
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, msg: 'succ', request_id: 'platform-1', data: { id: 'device-7', code: 500, msg: 'receiver timeout' } }) };
    }
    throw new Error('no get');
  };
  const { api } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  const rejected = await api.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(rejected.accepted, true);
  assert.equal(rejected.confirmed, false);
  assert.equal(rejected.deviceCode, 500);
  assert.equal(rejected.requestId, 'platform-1');
  assert.equal(rejected.message, 'receiver timeout');

  /* 无 request_id 但有 data.id：取 data.id */
  const fetchImpl2 = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { id: 'device-7', code: 200, msg: 'ok' } }) };
    }
    throw new Error('no get');
  };
  const { api: api2 } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl2);
  const confirmed = await api2.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.requestId, 'device-7');
  assert.equal(confirmed.message, 'ok');

  /* request_id 为数值：合法字符串/数值都接受 */
  const fetchImpl3 = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, request_id: 12345, data: { code: 0, msg: 'ok' } }) };
    }
    throw new Error('no get');
  };
  const { api: api3 } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl3);
  const numeric = await api3.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(numeric.requestId, '12345');

  /* request_id 类型非法时回退 data.id */
  const fetchImpl4 = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, request_id: { x: 1 }, data: { id: 'device-9', code: 0, msg: 'ok' } }) };
    }
    throw new Error('no get');
  };
  const { api: api4 } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl4);
  const fallback = await api4.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(fallback.requestId, 'device-9');

  /* 两者都缺失：requestId 为空；无 data.code 时 message 用外层 msg */
  const fetchImpl5 = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ code: 0, msg: 'accepted-only', data: {} }) };
    }
    throw new Error('no get');
  };
  const { api: api5 } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl5);
  const accepted = await api5.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.confirmed, false);
  assert.equal(accepted.requestId, '');
  assert.equal(accepted.message, 'accepted-only');

  /* 参数非法 / 未配置 / HTTP 非 2xx：requestId 均为空 */
  const badParams = await api5.OneNetService.sendProperty('tx', { switch: 'true' });
  assert.equal(badParams.accepted, false);
  assert.equal(badParams.requestId, '');
  const { api: api6 } = loadWebModules({});
  const unconfigured = await api6.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(unconfigured.requestId, '');
  const fetchImpl6 = async (url, options) => {
    if (options && options.method === 'POST') {
      return { ok: false, status: 500, json: async () => ({}) };
    }
    throw new Error('no get');
  };
  const { api: api7 } = loadWebModules({ iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl6);
  const httpFail = await api7.OneNetService.sendProperty('tx', { switch: true });
  assert.equal(httpFail.accepted, false);
  assert.equal(httpFail.requestId, '');
});

test('R6 RX 命令白名单整帧校验', () => {
  const { api } = loadWebModules({});
  const rx = api.getDataModel('rx');
  for (const valid of ['START', 'STOP', 'STATUS', 'ZERO', 'RATE=100', 'RATE=2500', 'RATE=5000']) {
    assert.equal(api.validateControlParams(rx, { command: valid }, 'rx'), true, valid);
  }
  for (const invalid of ['start', ' START', 'START ', 'STARTX', 'RATE=99', 'RATE=5001', 'RATE=100.5', 'RATE=-100', 'RATE=abc', 'RATE=1e3', '']) {
    assert.equal(api.validateControlParams(rx, { command: invalid }, 'rx'), false, invalid);
  }
  const tx = api.getDataModel('tx');
  assert.equal(api.validateControlParams(tx, { setfreq: 99.9 }), true);
  assert.equal(api.validateControlParams(tx, { setfreq: 100.1 }), false);
});

test('R6 START 安全门控逐项翻转', () => {
  const { api } = loadWebModules({});
  const base = {
    _isOnline: true, _isFresh: true,
    rx_ble_online: true, rx_connected: true, rx_valid: true, rx_safe: true,
    rx_state: 2, rx_limit: false, rx_stim: false, rx_fault_flags: 0
  };
  assert.equal(api.isReceiverStartAllowed(base), true);
  const cases = [
    ['_isOnline', false], ['_isFresh', false],
    ['rx_ble_online', false], ['rx_connected', false], ['rx_valid', false], ['rx_safe', false],
    ['rx_state', 1], ['rx_state', 3], ['rx_state', 2.5],
    ['rx_limit', true], ['rx_stim', true],
    ['rx_fault_flags', 1]
  ];
  for (const [key, value] of cases) {
    assert.equal(api.isReceiverStartAllowed({ ...base, [key]: value }), false, key);
  }
  assert.equal(api.isReceiverStartAllowed({ ...base, _isOnline: 1 }), false);
  assert.equal(api.isReceiverStartAllowed(null), false);
});

test('R6 命令审计终态判定', () => {
  const { api } = loadWebModules({});
  const ok = { rx_command_sequence: 5, rx_command: 'START', rx_command_result: 'success' };
  const shape = (outcome) => JSON.stringify(outcome);
  assert.equal(shape(api.getReceiverCommandOutcome(ok, 4, 'START')), shape({ isNew: true, outcome: 'success', sequence: 5 }));
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_result: 'ACCEPTED' }, 4, 'START')), shape({ isNew: true, outcome: 'pending', sequence: 5 }));
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command: 'STOP' }, 4, 'START')), shape({ isNew: false, outcome: 'pending', sequence: null }));
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_sequence: 4 }, 4, 'START')), shape({ isNew: false, outcome: 'pending', sequence: null }));
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_sequence: 3 }, 4, 'START')), shape({ isNew: false, outcome: 'pending', sequence: null }));
  for (const res of ['START rejected', 'receiver timeout', 'BLE disconnected', 'rejected by receiver']) {
    assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_result: res }, 4, 'START')), shape({ isNew: true, outcome: 'failed', sequence: 5 }), res);
  }
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_result: 'processing' }, 4, 'START')), shape({ isNew: true, outcome: 'pending', sequence: 5 }));
  assert.equal(shape(api.getReceiverCommandOutcome(null, 4, 'START')), shape({ isNew: false, outcome: 'pending', sequence: null }));
  const maxSeq = 2147483647;
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_sequence: 1 }, maxSeq, 'START')), shape({ isNew: true, outcome: 'success', sequence: 1 }));
  assert.equal(shape(api.getReceiverCommandOutcome({ ...ok, rx_command_sequence: 2 }, maxSeq, 'START')), shape({ isNew: false, outcome: 'pending', sequence: null }));
});

test('R7 按时间戳对齐 TX/RX 历史', () => {
  const { api } = loadWebModules({});
  const item = (timestamp, deviceKey) => ({ deviceKey, timestamp, timeSource: 'onenet', data: {} });
  const tx = [item(5000, 'tx'), item(2000, 'tx'), item(1000, 'tx')];
  const rx = [item(1500, 'rx'), item(5100, 'rx'), item(9000, 'rx'), item('bad', 'rx')];
  const aligned = api.alignHistoriesByTimestamp(tx, rx, 1000);
  assert.equal(aligned.length, 4);
  assert.equal(aligned[0].timestamp, 1000);
  assert.equal(aligned[0].tx.timestamp, 1000);
  assert.equal(aligned[0].rx.timestamp, 1500);
  assert.equal(aligned[1].timestamp, 2000);
  assert.equal(aligned[1].tx.timestamp, 2000);
  assert.equal(aligned[1].rx, null);
  assert.equal(aligned[2].timestamp, 5000);
  assert.equal(aligned[2].tx.timestamp, 5000);
  assert.equal(aligned[2].rx.timestamp, 5100);
  assert.equal(aligned[3].timestamp, 9000);
  assert.equal(aligned[3].tx, null);
  assert.equal(aligned[3].rx.timestamp, 9000);
  /* 输入不被修改 */
  assert.equal(tx.length, 3);
  assert.equal(rx.length, 4);
});

test('R8 TX/RX 预览数据独立且明确离线不新鲜', () => {
  const { api } = loadWebModules({});
  const txMock = api.OneNetService.getMockData('tx');
  assert.equal(txMock._isMock, true);
  assert.equal(txMock._isOnline, false);
  assert.equal(txMock._isFresh, false);
  assert.equal(txMock.setfreq, 100);
  assert.equal(txMock.rx_connected, undefined);

  const rxMock = api.OneNetService.getMockData('rx');
  assert.equal(rxMock._isMock, true);
  assert.equal(rxMock._isOnline, false);
  assert.equal(rxMock._isFresh, false);
  for (const id of ['rx_limit', 'rx_stim', 'rx_connected', 'rx_valid', 'rx_ble_online', 'rx_mqtt_online', 'rx_gateway_online', 'rx_wifi_online', 'rx_telemetry_fresh', 'rx_safe']) {
    assert.equal(rxMock[id], false, id);
  }
  assert.equal(rxMock.rx_state, 0);
  assert.equal(rxMock.voltage, undefined);
});

/* ========== P1-P8 双端 UI 层与页面契约 ========== */

function loadUiCommon(options = {}) {
  const context = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    document: options.document || { addEventListener: () => {} },
    window: options.window || { addEventListener: () => {} },
    navigator: options.navigator || {},
    fetch: options.fetch || (async () => { throw new Error('no fetch'); }),
    setInterval: options.setInterval || (() => 0),
    clearInterval: options.clearInterval || (() => {}),
    AbortController, setTimeout, clearTimeout,
    Promise, Set, Object, Array, JSON, Math, Number, String, Date
  };
  vm.createContext(context);
  vm.runInContext(read('js/ui-common.js') + '\n;globalThis.__web = { WptUi };', context);
  return { api: context.__web, context };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDomHarness() {
  const registry = new Map();
  const all = [];
  let activeElement = null;
  function makeEl(tag, id) {
    const el = {
      id: id || '',
      tagName: String(tag || 'div').toUpperCase(),
      _parent: null,
      innerText: '',
      value: '',
      disabled: false,
      href: '',
      style: {},
      dataset: {},
      children: [],
      _attrs: {},
      _listeners: {},
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; on ? this._s.add(c) : this._s.delete(c); return on; },
        contains(c) { return this._s.has(c); }
      },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
      removeAttribute(k) { delete this._attrs[k]; },
      focus() { activeElement = el; },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      dispatch(type, ev) {
        if (type === 'click' || type === 'focus') activeElement = el;
        (this._listeners[type] || []).forEach((fn) => fn.call(el, ev || {}));
      },
      /* 模拟浏览器 select 行为：追加 option 后若当前值无匹配项则自动选中该项。 */
      appendChild(child) {
        this.children.push(child);
        child._parent = this;
        if (child.id) registry.set(child.id, child);
        if (this.tagName === 'SELECT' && child.tagName === 'OPTION') {
          const values = this.children.filter((c) => c.tagName === 'OPTION').map((c) => c.value);
          if (values.indexOf(this.value) === -1) this.value = child.value;
        }
        return child;
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      getContext() { return {}; },
      destroy() {}
    };
    all.push(el);
    if (id) registry.set(id, el);
    let textContentValue = '';
    Object.defineProperty(el, 'textContent', {
      get: () => textContentValue,
      set: (v) => {
        textContentValue = String(v);
        /* 与浏览器一致：textContent 赋值替换全部子节点。 */
        if (textContentValue === '') el.children.length = 0;
      }
    });
    return el;
  }
  function matches(el, sel) {
    function matchPart(node, part) {
      if (part.startsWith('.')) {
        return node.classList.contains(part.slice(1));
      }
      const re = /\[([a-z-]+)(?:="([^"]*)")?\]/g;
      let m;
      let any = false;
      while ((m = re.exec(part)) !== null) {
        any = true;
        const got = node.getAttribute(m[1]);
        if (m[2] === undefined) { if (got === null) return false; }
        else if (got !== m[2]) return false;
      }
      return any;
    }
    const parts = sel.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return false;
    let node = el;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!node || !matchPart(node, parts[i])) return false;
      node = node._parent;
    }
    return true;
  }
  const documentStub = {
    readyState: 'complete',
    visibilityState: 'visible',
    get activeElement() { return activeElement; },
    set activeElement(v) { activeElement = v; },
    _listeners: {},
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => registry.get(id) || null,
    querySelector: (sel) => all.find((el) => matches(el, sel)) || null,
    querySelectorAll: (sel) => all.filter((el) => matches(el, sel)),
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, ev) { (this._listeners[type] || []).forEach((fn) => fn(ev || {})); }
  };
  const windowStub = {
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type) { (this._listeners[type] || []).forEach((fn) => fn()); }
  };
  return { makeEl, registry, all, documentStub, windowStub };
}

function buildIndexDom() {
  const h = createDomHarness();
  const { makeEl } = h;
  const systemSummary = makeEl('span', 'systemSummary');
  const syncBtn = makeEl('button', 'syncBtn');
  const homeAlertSummary = makeEl('a', 'homeAlertSummary');
  homeAlertSummary.href = '/alerts';
  function bindCard(key, binds) {
    const card = makeEl('article');
    card.setAttribute('data-endpoint-card', key);
    const status = makeEl('span');
    status.setAttribute('data-role', 'endpoint-status');
    const name = makeEl('span');
    name.setAttribute('data-role', 'device-name');
    const time = makeEl('span');
    time.setAttribute('data-role', 'source-time');
    const note = makeEl('p');
    note.setAttribute('data-role', 'endpoint-note');
    const settings = makeEl('a');
    settings.href = '/settings';
    const bindEls = binds.map(([bind, kind, decimals, unit]) => {
      const el = makeEl('span');
      el.setAttribute('data-bind', bind);
      if (kind) el.setAttribute('data-kind', kind);
      if (decimals !== undefined) el.setAttribute('data-decimals', String(decimals));
      if (unit !== undefined) el.setAttribute('data-unit', unit);
      return el;
    });
    [status, name, time, note, settings, ...bindEls].forEach((child) => card.appendChild(child));
    return { card, status, name, time, note, settings, bindEls };
  }
  const tx = bindCard('tx', [
    ['tx.voltage', '', 2, 'V'],
    ['tx.current', '', 3, 'A'],
    ['tx.freq', '', 1, 'kHz'],
    ['tx.state', 'tx-state']
  ]);
  const rx = bindCard('rx', [
    ['rx.rx_current_ua', '', 1, 'μA'],
    ['rx.rx_bonev', '', 3, 'V'],
    ['rx.rx_resistance', '', 0, 'Ω'],
    ['rx.rx_vout', '', 2, 'V'],
    ['rx.rx_ble_online', 'rx-health'],
    ['rx.rx_telemetry_fresh', 'rx-health'],
    ['rx.rx_valid', 'rx-health'],
    ['rx.rx_safe', 'rx-health']
  ]);
  tx.card.setAttribute('id', 'txEndpointPanel');
  tx.card.setAttribute('role', 'tabpanel');
  tx.card.setAttribute('aria-labelledby', 'homeTxTab');
  rx.card.setAttribute('id', 'rxEndpointPanel');
  rx.card.setAttribute('role', 'tabpanel');
  rx.card.setAttribute('aria-labelledby', 'homeRxTab');
  rx.card.hidden = true;
  h.registry.set('txEndpointPanel', tx.card);
  h.registry.set('rxEndpointPanel', rx.card);
  const tabs = {
    tx: makeEl('button', 'homeTxTab'),
    rx: makeEl('button', 'homeRxTab')
  };
  tabs.tx.setAttribute('data-endpoint-tab', 'tx');
  tabs.tx.setAttribute('aria-controls', 'txEndpointPanel');
  tabs.tx.setAttribute('aria-selected', 'false');
  tabs.tx.tabIndex = -1;
  tabs.rx.setAttribute('data-endpoint-tab', 'rx');
  tabs.rx.setAttribute('aria-controls', 'rxEndpointPanel');
  tabs.rx.setAttribute('aria-selected', 'false');
  tabs.rx.tabIndex = -1;
  const tabStatuses = {
    tx: makeEl('span'),
    rx: makeEl('span')
  };
  tabStatuses.tx.setAttribute('data-role', 'tab-status');
  tabStatuses.rx.setAttribute('data-role', 'tab-status');
  tabs.tx.appendChild(tabStatuses.tx);
  tabs.rx.appendChild(tabStatuses.rx);
  return { ...h, systemSummary, syncBtn, homeAlertSummary, tx, rx, tabs, tabStatuses };
}

function buildMonitoringDom(ChartClass) {
  const h = createDomHarness();
  const { makeEl } = h;
  h.windowStub.Chart = ChartClass;
  const systemSummary = makeEl('span', 'systemSummary');
  const lastUpdateText = makeEl('strong', 'lastUpdateText');
  const refreshBtn = makeEl('button', 'refreshBtn');
  const trendDeviceSelect = makeEl('select', 'trendDeviceSelect');
  trendDeviceSelect.value = 'rx';
  const trendMetricSelect = makeEl('select', 'trendMetricSelect');
  trendMetricSelect.value = 'rx_imon';
  const trendChart = makeEl('canvas', 'trendChart');
  const trendEmpty = makeEl('div', 'trendEmpty');
  const historyLink = makeEl('a', 'historyLink');
  const monitorAlertSummary = makeEl('a', 'monitorAlertSummary');
  monitorAlertSummary.href = '/alerts';
  function summaryCard(key) {
    const card = makeEl('section');
    card.setAttribute('data-endpoint-summary', key);
    const status = makeEl('span');
    status.setAttribute('data-role', 'endpoint-status');
    const name = makeEl('span');
    name.setAttribute('data-role', 'device-name');
    const time = makeEl('span');
    time.setAttribute('data-role', 'source-time');
    const age = makeEl('span');
    age.setAttribute('data-role', 'data-age');
    [status, name, time, age].forEach((child) => card.appendChild(child));
    return { card, status, name, time, age };
  }
  const txSummary = summaryCard('tx');
  const rxSummary = summaryCard('rx');
  function bindGroup(binds) {
    return binds.map(([bind, kind, decimals, unit]) => {
      const el = makeEl('span');
      el.setAttribute('data-bind', bind);
      if (kind) el.setAttribute('data-kind', kind);
      if (decimals !== undefined) el.setAttribute('data-decimals', String(decimals));
      if (unit !== undefined) el.setAttribute('data-unit', unit);
      return el;
    });
  }
  const txBinds = bindGroup([
    ['tx.voltage', '', 2, 'V'], ['tx.current', '', 3, 'A'], ['tx.freq', '', 1, 'kHz'], ['tx.state', 'tx-state']
  ]);
  const rxMeasureBinds = bindGroup([
    ['rx.rx_imon', '', 3, 'V'], ['rx.rx_current_ua', '', 1, 'μA'], ['rx.rx_bonep', '', 3, 'V'],
    ['rx.rx_bonen', '', 3, 'V'], ['rx.rx_bonev', '', 3, 'V'], ['rx.rx_resistance', '', 0, 'Ω'], ['rx.rx_vout', '', 2, 'V']
  ]);
  const rxHealthBinds = bindGroup([
    ['rx.rx_gateway_online', 'rx-health'], ['rx.rx_wifi_online', 'rx-health'], ['rx.rx_mqtt_online', 'rx-health'],
    ['rx.rx_ble_online', 'rx-health'], ['rx.rx_telemetry_fresh', 'rx-health'], ['rx.rx_safe', 'rx-health'],
    ['rx.rx_state', 'rx-health'], ['rx.rx_connected', 'rx-health'], ['rx.rx_valid', 'rx-health'],
    ['rx.rx_limit', 'rx-health'], ['rx.rx_stim', 'rx-health'], ['rx.rx_fault_flags', 'rx-health'], ['rx.rx_fault_reason', 'rx-health']
  ]);
  return {
    ...h, systemSummary, lastUpdateText, refreshBtn, trendDeviceSelect, trendMetricSelect,
    trendChart, trendEmpty, historyLink, monitorAlertSummary, txSummary, rxSummary, txBinds, rxMeasureBinds, rxHealthBinds
  };
}

function loadPage(pageScript, harness, initialStorage = {}, fetchImpl, preScripts = [], options = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const { documentStub, windowStub } = harness;
  const timers = [];
  let timerId = 0;
  const context = {
    localStorage: options.localStorage || {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: documentStub,
    window: windowStub,
    navigator: {},
    fetch: fetchImpl,
    AbortController, setTimeout, clearTimeout,
    setInterval: (fn, ms) => { timerId++; timers.push({ id: timerId, fn, ms }); return timerId; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    Date, Promise, Set, Object, Array, JSON, Math, Number, String, encodeURIComponent
  };
  vm.createContext(context);
  const scripts = [read('js/config.js'), read('js/onenet.js'), read('js/ui-common.js')]
    .concat(preScripts.map((file) => read(file)))
    .concat([read(pageScript)]);
  vm.runInContext(scripts.join('\n'), context);
  return { storage, timers, context };
}

test('P1 WptUi 端点分类与格式化工具', () => {
  const { api } = loadUiCommon();
  const c = (data, error) => JSON.stringify(api.WptUi.classifyEndpoint(data, error));
  assert.equal(c({ _isOnline: true, _isFresh: true }), JSON.stringify({ state: 'live', label: '实时', isLive: true }));
  assert.equal(c({ _isOnline: true, _isFresh: false }), JSON.stringify({ state: 'stale', label: '数据过期', isLive: false }));
  assert.equal(c({ _isOnline: false }), JSON.stringify({ state: 'offline', label: '离线', isLive: false }));
  assert.equal(c({ _isMock: true }), JSON.stringify({ state: 'preview', label: '预览', isLive: false }));
  assert.equal(c(null, new Error('x')), JSON.stringify({ state: 'error', label: '获取失败', isLive: false }));
  assert.equal(c(null), JSON.stringify({ state: 'error', label: '获取失败', isLive: false }));

  const fixed = 1750000000000;
  const d = new Date(fixed);
  const p = (n) => String(n).padStart(2, '0');
  const expectedTime = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  assert.equal(api.WptUi.formatSourceTime(fixed), expectedTime);
  assert.equal(api.WptUi.formatSourceTime('bad'), '--');
  assert.equal(api.WptUi.formatSourceTime(0), '--');

  assert.equal(api.WptUi.formatAge(500), '刚刚');
  assert.equal(api.WptUi.formatAge(3000), '3秒前');
  assert.equal(api.WptUi.formatAge(120000), '2分钟前');
  assert.equal(api.WptUi.formatAge('x'), '--');

  assert.equal(api.WptUi.formatMetric(12.345, 2, 'V'), '12.35V');
  assert.equal(api.WptUi.formatMetric(-0.5, 1, 'A'), '-0.5A');
  assert.equal(api.WptUi.formatMetric(true, 0, ''), '开启');
  assert.equal(api.WptUi.formatMetric(false, 0, ''), '关闭');
  assert.equal(api.WptUi.formatMetric(undefined, 2, 'V'), '--');
  assert.equal(api.WptUi.formatMetric('abc', 1, 'V'), '--');

  assert.equal(api.WptUi.txStateLabel(0), '待机');
  assert.equal(api.WptUi.txStateLabel(2), '运行');
  assert.equal(api.WptUi.txStateLabel(3), '故障');
  assert.equal(api.WptUi.txStateLabel(9), '未知');
  assert.equal(api.WptUi.rxStateLabel(0), '启动');
  assert.equal(api.WptUi.rxStateLabel(2), '就绪');
  assert.equal(api.WptUi.rxStateLabel(5), 'BLE断开');
  assert.equal(api.WptUi.rxStateLabel(9), '未知');

  assert.equal(api.WptUi.rxHealthText('rx_ble_online', false), 'BLE断开');
  assert.equal(api.WptUi.rxHealthText('rx_telemetry_fresh', false), '遥测过期');
  assert.equal(api.WptUi.rxHealthText('rx_safe', true), '允许START');
  assert.equal(api.WptUi.rxHealthText('rx_connected', false), '未连接');
  assert.equal(api.WptUi.rxHealthText('rx_limit', true), '开启');
  assert.equal(api.WptUi.rxHealthText('rx_stim', false), '关闭');
  assert.equal(api.WptUi.rxHealthText('rx_fault_flags', 4), '0x0004');
  assert.equal(api.WptUi.rxHealthText('rx_fault_reason', '0x0004'), '0x0004');
  assert.equal(api.WptUi.rxHealthText('rx_ble_online', undefined), '未知');
  assert.equal(api.WptUi.rxHealthText('rx_fault_reason', undefined), '未知');
});

test('P1 WptUi.isPropertyCurrent 按属性源时间判定', () => {
  const { api } = loadUiCommon();
  const now = 1750000000000;
  const fresh = now - 1000;
  const stale = now - 20000;
  const data = {
    _isOnline: true,
    _isFresh: false,
    _propertyTimes: { RX_BleOnline: fresh, RX_TelemetryFresh: fresh, RX_Safe: stale }
  };
  assert.equal(api.WptUi.isPropertyCurrent(data, 'RX_BleOnline', now, 15000), true);
  assert.equal(api.WptUi.isPropertyCurrent(data, 'RX_Safe', now, 15000), false);
  assert.equal(api.WptUi.isPropertyCurrent(data, 'RX_Missing', now, 15000), false);
  assert.equal(api.WptUi.isPropertyCurrent({ ...data, _isOnline: false }, 'RX_BleOnline', now, 15000), false);
  assert.equal(api.WptUi.isPropertyCurrent({ ...data, _propertyTimes: {} }, 'RX_BleOnline', now, 15000), false);
  assert.equal(api.WptUi.isPropertyCurrent({ ...data, _propertyTimes: { RX_BleOnline: now + 30000 } }, 'RX_BleOnline', now, 15000), true);
  assert.equal(api.WptUi.isPropertyCurrent({ ...data, _propertyTimes: { RX_BleOnline: now + 61000 } }, 'RX_BleOnline', now, 15000), false);
  assert.equal(api.WptUi.isPropertyCurrent(data, 'RX_BleOnline', now), true);
  assert.equal(api.WptUi.isPropertyCurrent({ ...data, _propertyTimes: { RX_BleOnline: now - 16000 } }, 'RX_BleOnline', now), false);
});

test('P1 WptUi.buildTrendSeries 源时间窗口/负数/去重/排序/不改输入', () => {
  const { api } = loadUiCommon();
  const now = 1750000000000;
  const history = [
    { deviceKey: 'rx', timestamp: now - 2000, timeSource: 'onenet', data: { rx_imon: -1.5 } },
    { deviceKey: 'rx', timestamp: now - 4000, timeSource: 'onenet', data: { rx_imon: 0.5 } },
    { deviceKey: 'rx', timestamp: now - 4000, timeSource: 'onenet', data: { rx_imon: 2.5 } },
    { deviceKey: 'tx', timestamp: now - 3000, timeSource: 'onenet', data: { rx_imon: 9 } },
    { deviceKey: 'rx', timestamp: now - 3000, timeSource: 'local', data: { rx_imon: 7 } },
    { deviceKey: 'rx', timestamp: 'bad', timeSource: 'onenet', data: { rx_imon: 1 } },
    { deviceKey: 'rx', timestamp: now - 2000000, timeSource: 'onenet', data: { rx_imon: 3 } },
    { deviceKey: 'rx', timestamp: now - 1000, timeSource: 'onenet', data: { rx_imon: 'nan' } },
    { deviceKey: 'rx', timestamp: now + 1000, timeSource: 'onenet', data: { rx_imon: 4 } }
  ];
  const original = JSON.stringify(history);
  const points = api.WptUi.buildTrendSeries('rx', 'rx_imon', history, now, 1800000);
  assert.equal(JSON.stringify(points), JSON.stringify([
    { x: now - 4000, y: 2.5 },
    { x: now - 2000, y: -1.5 }
  ]));
  assert.equal(JSON.stringify(history), original);
});

test('P1 WptUi.createLifecyclePoller 防重入与生命周期清理', async () => {
  const timers = [];
  let timerId = 0;
  const listeners = {};
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch: (type) => { (listeners[type] || []).forEach((fn) => fn()); }
  };
  const windowStub = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch: (type) => { (listeners[type] || []).forEach((fn) => fn()); }
  };
  let runs = 0;
  let resolveTask;
  const task = () => {
    runs++;
    return new Promise((res) => { resolveTask = res; });
  };
  const { api } = loadUiCommon({
    document: documentStub,
    window: windowStub,
    setInterval: (fn, ms) => { timerId++; timers.push({ id: timerId, fn, ms }); return timerId; },
    clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
  });
  const poller = api.WptUi.createLifecyclePoller(task, 5000);
  poller.start();
  assert.equal(runs, 1);
  poller.runNow();
  poller.runNow();
  assert.equal(runs, 1);
  assert.equal(timers.length, 1);
  resolveTask();
  await flushAsync();
  poller.runNow();
  assert.equal(runs, 2);
  resolveTask();
  await flushAsync();
  documentStub.visibilityState = 'hidden';
  documentStub.dispatch('visibilitychange');
  assert.equal(timers.length, 0);
  documentStub.visibilityState = 'visible';
  documentStub.dispatch('visibilitychange');
  assert.equal(timers.length, 1);
  await flushAsync();
  assert.equal(runs, 3);
  windowStub.dispatch('pagehide');
  assert.equal(timers.length, 0);
  poller.stop();
});

test('P2 首页双端总览结构契约', () => {
  const html = read('index.html');
  const page = read('js/index-page.js');
  assert.match(html, /WPT 双端监控/);
  assert.match(html, /id=["']systemSummary["'][^>]*aria-live=["']polite["']/);
  assert.match(html, /id=["']syncBtn["']/);
  assert.match(html, /data-endpoint-card=["']tx["']/);
  assert.match(html, /data-endpoint-card=["']rx["']/);
  assert.match(html, /data-role=["']endpoint-status["']/);
  assert.match(html, /data-role=["']source-time["']/);
  assert.match(html, /data-role=["']device-name["']/);
  for (const bind of ['tx.voltage', 'tx.current', 'tx.freq', 'tx.state', 'rx.rx_current_ua', 'rx.rx_bonev', 'rx.rx_resistance', 'rx.rx_vout', 'rx.rx_ble_online', 'rx.rx_telemetry_fresh', 'rx.rx_valid', 'rx.rx_safe']) {
    assert.match(html, new RegExp(`data-bind=["']${bind}["']`), bind);
  }
  assert.match(html, /href=["']\/settings["']/);
  const order = [
    html.indexOf('js/auth-guard.js'), html.indexOf('js/config.js'), html.indexOf('js/onenet.js'),
    html.indexOf('js/ui-common.js'), html.indexOf('js/index-page.js')
  ];
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4]);
  assert.doesNotMatch(html, /getLatestData/);
  assert.doesNotMatch(page, /iot_latest_data/);
});

test('P3 监测页双端驾驶舱结构契约', () => {
  const html = read('monitoring.html');
  const page = read('js/monitoring-page.js');
  assert.match(html, /data-endpoint-summary=["']tx["']/);
  assert.match(html, /data-endpoint-summary=["']rx["']/);
  assert.match(html, /id=["']trendDeviceSelect["']/);
  assert.match(html, /id=["']trendMetricSelect["']/);
  assert.match(html, /id=["']trendChart["']/);
  assert.match(html, /id=["']trendEmpty["']/);
  assert.match(html, /href=["']\/history["']/);
  for (const bind of ['tx.voltage', 'tx.current', 'tx.freq', 'tx.state', 'rx.rx_imon', 'rx.rx_current_ua', 'rx.rx_bonep', 'rx.rx_bonen', 'rx.rx_bonev', 'rx.rx_resistance', 'rx.rx_vout']) {
    assert.match(html, new RegExp(`data-bind=["']${bind}["']`), bind);
  }
  for (const health of ['rx.rx_gateway_online', 'rx.rx_wifi_online', 'rx.rx_mqtt_online', 'rx.rx_ble_online', 'rx.rx_telemetry_fresh', 'rx.rx_safe', 'rx.rx_state', 'rx.rx_connected', 'rx.rx_valid', 'rx.rx_limit', 'rx.rx_stim', 'rx.rx_fault_flags', 'rx.rx_fault_reason']) {
    assert.match(html, new RegExp(`data-bind=["']${health}["']`), health);
  }
  const order = [
    html.indexOf('js/auth-guard.js'), html.indexOf('js/config.js'), html.indexOf('js/onenet.js'),
    html.indexOf('js/ui-common.js'), html.indexOf('js/monitoring-page.js')
  ];
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4]);
  assert.doesNotMatch(html, /getLatestData/);
  assert.doesNotMatch(page, /iot_latest_data/);
  assert.match(page, /beginAtZero:\s*false/);
  assert.doesNotMatch(page, /fill:\s*true/);
  assert.doesNotMatch(page, /gradient/);
  assert.doesNotMatch(page, /Math\.max\(0,/);
});

test('P5 双端独立降级与共享轮询契约', () => {
  const indexPage = read('js/index-page.js');
  const monitoringPage = read('js/monitoring-page.js');
  const uiCommon = read('js/ui-common.js');
  assert.match(indexPage, /Promise\.allSettled/);
  assert.match(monitoringPage, /Promise\.allSettled/);
  assert.match(indexPage, /createLifecyclePoller/);
  assert.match(monitoringPage, /createLifecyclePoller/);
  assert.match(uiCommon, /visibilitychange/);
  assert.match(uiCommon, /pagehide/);
  assert.match(uiCommon, /beforeunload/);
  assert.doesNotMatch(indexPage, /iot_latest_data/);
  assert.doesNotMatch(monitoringPage, /iot_latest_data/);
});

test('P6 工业视觉约束：无渐变、纯色基线、响应式与可访问', () => {
  const css = read('css/dashboard.css');
  assert.doesNotMatch(css, /gradient\(/);
  assert.match(css, /--wpt-radius:\s*12px/);
  assert.match(css, /#edf3f6/);
  assert.match(css, /#102832/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
  assert.match(css, /@media\s*\(max-width:\s*1023px\)/);
  assert.match(css, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /grid-template-columns:\s*1fr/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('P7 PWA 缓存版本升级并预缓存新资源', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
  for (const asset of ['js/ui-common.js', 'js/index-page.js', 'js/monitoring-page.js']) {
    assert.match(worker, new RegExp(asset.replace(/[.]/g, '\\.')), asset);
  }
});

test('P8 新页面脚本与内联脚本均可解析', () => {
  for (const file of ['js/ui-common.js', 'js/index-page.js', 'js/monitoring-page.js']) {
    assert.doesNotThrow(() => new vm.Script(read(file)), file);
  }
  for (const page of ['index', 'monitoring']) {
    const html = read(`${page}.html`);
    const scripts = html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi);
    for (const match of scripts) {
      const source = match[1].trim();
      if (source) assert.doesNotThrow(() => new vm.Script(source), `${page}.html 存在脚本语法错误`);
    }
  }
});

function rxStaleItems(now, bleTime) {
  const oldT = now - 120000;
  return [
    { identifier: 'RX_IMon', value: 1.0, data_type: 'double', time: oldT },
    { identifier: 'RX_Current_uA', value: 250, data_type: 'double', time: oldT },
    { identifier: 'RX_BoneP', value: 1.1, data_type: 'double', time: oldT },
    { identifier: 'RX_BoneN', value: 1.2, data_type: 'double', time: oldT },
    { identifier: 'RX_BoneV', value: 1.3, data_type: 'double', time: oldT },
    { identifier: 'RX_Resistance', value: 5000, data_type: 'int32', time: oldT },
    { identifier: 'RX_Vout', value: 12.0, data_type: 'double', time: oldT },
    { identifier: 'RX_Limit', value: false, data_type: 'bool', time: oldT },
    { identifier: 'RX_Stim', value: false, data_type: 'bool', time: oldT },
    { identifier: 'RX_Connected', value: false, data_type: 'bool', time: oldT },
    { identifier: 'RX_Valid', value: false, data_type: 'bool', time: oldT },
    { identifier: 'RX_FaultFlags', value: 0, data_type: 'int32', time: oldT },
    { identifier: 'RX_State', value: 5, data_type: 'int32', time: bleTime },
    { identifier: 'RX_GatewayOnline', value: true, data_type: 'bool', time: bleTime },
    { identifier: 'RX_WifiOnline', value: true, data_type: 'bool', time: bleTime },
    { identifier: 'RX_MqttOnline', value: true, data_type: 'bool', time: bleTime },
    { identifier: 'RX_BleOnline', value: false, data_type: 'bool', time: bleTime },
    { identifier: 'RX_TelemetryFresh', value: false, data_type: 'bool', time: bleTime },
    { identifier: 'RX_Safe', value: true, data_type: 'bool', time: bleTime },
    { identifier: 'RX_FaultReason', value: '0x0000', data_type: 'string', time: oldT }
  ];
}

function txLiveItems(now) {
  const t = now - 1000;
  return [
    { identifier: 'V', value: 12.5, data_type: 'float', time: t },
    { identifier: 'I', value: 1.25, data_type: 'float', time: t },
    { identifier: 'F', value: 100000, data_type: 'int32', time: t },
    { identifier: 'S', value: 2, data_type: 'int32', time: t }
  ];
}

function dualFetch(rxItems) {
  return async (url) => {
    if (url.includes('/device/detail')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    }
    if (url.includes('device_name=rxd')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxItems } }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: txLiveItems(Date.now()) }) };
  };
}

test('P2/P3 健康逐属性新鲜：stale RX 测量为--，BLE 断开可见，整体仍 stale', async () => {
  const now = Date.now();
  const harness = buildIndexDom();
  loadPage('js/index-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, dualFetch(rxStaleItems(now, now - 1000)));
  await flushAsync();
  assert.equal(harness.tx.bindEls[0].textContent, '12.50V');
  assert.equal(harness.rx.bindEls[0].textContent, '--');
  assert.equal(harness.rx.bindEls[4].textContent, 'BLE断开');
  assert.equal(harness.rx.bindEls[5].textContent, '遥测过期');
  assert.equal(harness.rx.bindEls[6].textContent, '未知');
  assert.equal(harness.rx.bindEls[7].textContent, '允许START');
  assert.equal(harness.rx.status.dataset.state, 'stale');
  assert.equal(harness.rx.status.textContent, '数据过期');
  assert.equal(harness.systemSummary.textContent, '1/2 实时');
});

test('P2/P3 BLE 属性源时间过期后健康显示未知', async () => {
  const now = Date.now();
  const harness = buildIndexDom();
  loadPage('js/index-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, dualFetch(rxStaleItems(now, now - 30000)));
  await flushAsync();
  assert.equal(harness.rx.bindEls[4].textContent, '未知');
  assert.equal(harness.rx.bindEls[5].textContent, '未知');
  assert.equal(harness.rx.bindEls[7].textContent, '未知');
  assert.equal(harness.rx.status.dataset.state, 'stale');
});

test('P3 监测页测量/健康渲染与端点摘要', async () => {
  const now = Date.now();
  const harness = buildMonitoringDom(undefined);
  loadPage('js/monitoring-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, dualFetch(rxStaleItems(now, now - 1000)));
  await flushAsync();
  assert.equal(harness.rxSummary.status.dataset.state, 'stale');
  assert.equal(harness.rxMeasureBinds[0].textContent, '--');
  const healthById = {};
  harness.rxHealthBinds.forEach((el) => { healthById[el.getAttribute('data-bind')] = el; });
  assert.equal(healthById['rx.rx_ble_online'].textContent, 'BLE断开');
  assert.equal(healthById['rx.rx_telemetry_fresh'].textContent, '遥测过期');
  assert.equal(healthById['rx.rx_valid'].textContent, '未知');
  assert.equal(healthById['rx.rx_state'].textContent, 'BLE断开');
  assert.equal(healthById['rx.rx_safe'].textContent, '允许START');
  assert.equal(harness.txSummary.status.textContent, '实时');
  assert.equal(harness.txBinds[0].textContent, '12.50V');
  assert.equal(harness.systemSummary.textContent, '1/2 实时');
});

test('P3/P4 趋势图使用源时间 x、fill=false、beginAtZero=false 且负数保留', async () => {
  const now = Date.now();
  const charts = [];
  function FakeChart(ctx, config) { charts.push(config); this.destroy = () => {}; }
  const initialStorage = {
    iot_onenet_devices_v1: DUAL_CONFIG,
    iot_history_data_rx: JSON.stringify([
      { deviceKey: 'rx', timestamp: now - 60000, timeSource: 'onenet', data: { rx_imon: -1.2 } },
      { deviceKey: 'rx', timestamp: now - 30000, timeSource: 'onenet', data: { rx_imon: 0.4 } },
      { deviceKey: 'tx', timestamp: now - 30000, timeSource: 'onenet', data: { rx_imon: 9 } }
    ])
  };
  const harness = buildMonitoringDom(FakeChart);
  loadPage('js/monitoring-page.js', harness, initialStorage, dualFetch(rxStaleItems(now, now - 1000)));
  await flushAsync();
  assert.ok(charts.length >= 1);
  const cfg = charts[charts.length - 1];
  assert.equal(cfg.type, 'line');
  assert.equal(cfg.data.datasets[0].fill, false);
  assert.equal(cfg.options.scales.y.beginAtZero, false);
  assert.equal(cfg.data.datasets[0].data[0], -1.2);
  assert.equal(cfg.data.datasets[0].data[1], 0.4);
  const { api } = loadUiCommon();
  assert.equal(cfg.data.labels[0], api.WptUi.formatSourceTime(now - 60000));
  assert.equal(cfg.data.labels[1], api.WptUi.formatSourceTime(now - 30000));
});

test('P3 无 Chart 组件时趋势区显示不可用且页面不崩', async () => {
  const now = Date.now();
  const harness = buildMonitoringDom(undefined);
  loadPage('js/monitoring-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, dualFetch(rxStaleItems(now, now - 1000)));
  await flushAsync();
  assert.equal(harness.trendEmpty.textContent, '图表组件不可用');
});

/* ========== R1-R5 完整性/在线/轮询修正 ========== */

test('R2 完整且逐项新鲜的 TX 快照才 live 并写历史', async () => {
  const now = Date.now();
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(fullTxItems(now), 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx._isOnline, true);
  assert.equal(tx._isFresh, true);
  assert.equal(tx.voltage, 12.5);
  assert.equal(tx.current, 1.25);
  assert.equal(tx.freq, 100);
  assert.equal(tx.state, 2);
  const history = JSON.parse(storage.get('iot_history_data_tx'));
  assert.equal(history.length, 1);
  assert.equal(history[0].deviceKey, 'tx');
});

test('R2 任一必需字段缺失不得 live 也不写历史', async () => {
  const now = Date.now();
  const items = fullTxItems(now).filter((item) => item.identifier !== 'S');
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(items, 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx.voltage, 12.5);
  assert.equal(tx._isOnline, true);
  assert.equal(tx._isFresh, false);
  assert.equal(tx._telemetryTimestamp, null);
  assert.equal(storage.has('iot_history_data_tx'), false);
});

test('R2 重复必需键不得 live', async () => {
  const now = Date.now();
  const items = fullTxItems(now).concat([
    { identifier: 'V', value: 12.6, data_type: 'float', time: now - 500 }
  ]);
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(items, 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx._isOnline, true);
  assert.equal(tx._isFresh, false);
  assert.equal(tx._telemetryTimestamp, null);
  assert.equal(storage.has('iot_history_data_tx'), false);
});

test('R2 单一必需字段过期整体不得 live 且不写历史', async () => {
  const now = Date.now();
  const items = fullTxItems(now);
  items[1] = { ...items[1], time: now - 20000 };
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(items, 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx._isOnline, true);
  assert.equal(tx._isFresh, false);
  assert.equal(storage.has('iot_history_data_tx'), false);
});

test('R2 RX_TelemetryFresh 必须为 true 且自身源时间新鲜', async () => {
  const now = Date.now();
  /* false 但源时间新鲜 -> 不 live */
  const { api: api1, storage: storage1 } = loadWebModules(
    { iot_onenet_devices_v1: DUAL_CONFIG },
    makePropertyFetch({ list: fullRxItems(now, undefined, false) }, 1)
  );
  const rx1 = await api1.OneNetService.getLatestData('rx');
  assert.equal(rx1._isOnline, true);
  assert.equal(rx1._isFresh, false);
  assert.equal(storage1.has('iot_history_data_rx'), false);

  /* true 但自身源时间过期 -> 不 live */
  const { api: api2, storage: storage2 } = loadWebModules(
    { iot_onenet_devices_v1: DUAL_CONFIG },
    makePropertyFetch({ list: fullRxItems(now, undefined, true, now - 20000) }, 1)
  );
  const rx2 = await api2.OneNetService.getLatestData('rx');
  assert.equal(rx2._isOnline, true);
  assert.equal(rx2._isFresh, false);
  assert.equal(storage2.has('iot_history_data_rx'), false);

  /* true 且源时间新鲜 -> live 并写历史 */
  const { api: api3, storage: storage3 } = loadWebModules(
    { iot_onenet_devices_v1: DUAL_CONFIG },
    makePropertyFetch({ list: fullRxItems(now) }, 1)
  );
  const rx3 = await api3.OneNetService.getLatestData('rx');
  assert.equal(rx3._isOnline, true);
  assert.equal(rx3._isFresh, true);
  assert.equal(JSON.parse(storage3.get('iot_history_data_rx')).length, 1);
});

test('R3 完整遥测时间戳取必需字段最小值且历史一致', async () => {
  const now = Date.now();
  const times = [now - 1000, now - 4000, now - 2000, now - 3000];
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    makePropertyFetch(fullTxItems(now, times), 1)
  );
  const tx = await api.OneNetService.getLatestData('tx');
  assert.equal(tx._isFresh, true);
  assert.equal(tx._telemetryTimestamp, now - 4000);
  const history = JSON.parse(storage.get('iot_history_data_tx'));
  assert.equal(history.length, 1);
  assert.equal(history[0].timestamp, now - 4000);
});

test('R4 stop 后 visibilitychange 不再运行 task', async () => {
  const listeners = {};
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch: (type) => { (listeners[type] || []).forEach((fn) => fn()); }
  };
  const windowStub = {
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch: (type) => { (listeners[type] || []).forEach((fn) => fn()); }
  };
  let runs = 0;
  const { api } = loadUiCommon({
    document: documentStub,
    window: windowStub,
    setInterval: () => 1,
    clearInterval: () => {}
  });
  const poller = api.WptUi.createLifecyclePoller(() => { runs++; return Promise.resolve(); }, 5000);
  poller.start();
  await flushAsync();
  assert.equal(runs, 1);
  poller.stop();
  documentStub.dispatch('visibilitychange');
  await flushAsync();
  assert.equal(runs, 1);
});

test('R4 内部调用拒绝无未处理路径且公开 runNow 仍可感知', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const listeners = {};
    const timers = [];
    let timerId = 0;
    const documentStub = {
      visibilityState: 'visible',
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch: (type) => { (listeners[type] || []).forEach((fn) => fn()); }
    };
    const windowStub = {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch: (type) => { (listeners[type] || []).forEach((fn) => fn()); }
    };
    let calls = 0;
    const { api } = loadUiCommon({
      document: documentStub,
      window: windowStub,
      setInterval: (fn, ms) => { timerId++; timers.push({ id: timerId, fn, ms }); return timerId; },
      clearInterval: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }
    });
    const poller = api.WptUi.createLifecyclePoller(() => {
      calls++;
      return Promise.reject(new Error('boom'));
    }, 5000);
    poller.start();
    await flushAsync();
    timers.forEach((t) => t.fn());
    await flushAsync();
    documentStub.dispatch('visibilitychange');
    await flushAsync();
    assert.equal(calls, 3);
    assert.equal(unhandled.length, 0);
    await assert.rejects(poller.runNow());
    assert.equal(unhandled.length, 0);

    /* registerServiceWorker 拒绝必须被吸收 */
    const { api: api2 } = loadUiCommon({
      navigator: { serviceWorker: { register: () => Promise.reject(new Error('sw fail')) } }
    });
    api2.WptUi.registerServiceWorker();
    await flushAsync();
    assert.equal(unhandled.length, 0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('R5 window.Chart 为非函数对象时趋势降级且不抛错', async () => {
  const now = Date.now();
  const harness = buildMonitoringDom({});
  loadPage('js/monitoring-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, dualFetch(rxStaleItems(now, now - 1000)));
  await flushAsync();
  assert.equal(harness.trendEmpty.textContent, '图表组件不可用');
});

/* ========== R1-R10 设置页/配置校验/导航/文案修正 ========== */

test('R1 迁移一次后旧键删除，清除 TX 后不复活，RX 永不迁移', () => {
  const { api, storage } = loadWebModules({
    iot_onenet_config: JSON.stringify({ productId: 'A60e06YLYw', deviceName: '20260001', token: VALID_TOKEN })
  }, async () => { throw new Error('不应发起请求'); });

  assert.equal(api.getOneNetConfig('tx').PRODUCT_ID, 'A60e06YLYw');
  assert.equal(storage.has('iot_onenet_config'), false);
  assert.equal(api.getOneNetConfig('rx').TOKEN, '');

  assert.equal(api.saveOneNetDeviceConfig('rx', { productId: 'rxp', deviceName: 'RX_001', token: 'res=r&et=1&sign=r' }), true);
  assert.equal(api.clearOneNetDeviceConfig('tx'), true);
  assert.equal(api.getOneNetConfig('tx').TOKEN, '');
  assert.equal(api.getOneNetConfig('rx').TOKEN, 'res=r&et=1&sign=r');
  assert.equal(storage.has('iot_onenet_config'), false);
  /* 重复读取不复活 TX */
  assert.equal(api.getOneNetConfig('tx').TOKEN, '');
});

test('R2 配置严格校验：合法通过，空/超长/控制字符/缺段拒绝且不发请求', () => {
  const { api, storage } = loadWebModules({}, async () => { throw new Error('不应发起请求'); });
  const valid = { productId: 'A60e06YLYw', deviceName: 'RX_001', token: 'version=2026-08-08&res=products%2F1&et=1800&method=sha1&sign=abc' };
  assert.equal(api.saveOneNetDeviceConfig('rx', valid), true);
  assert.equal(JSON.parse(storage.get('iot_onenet_devices_v1')).rx.deviceName, 'RX_001');
  const trimmed = api.validateOneNetDeviceConfig({ productId: '  p1  ', deviceName: ' RX_001 ', token: ' res=a&et=1&sign=b ' });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.productId, 'p1');
  assert.equal(trimmed.token, 'res=a&et=1&sign=b');

  const badCases = [
    { productId: '', deviceName: 'x', token: 'res=a&et=1&sign=b' },
    { productId: 'a'.repeat(65), deviceName: 'x', token: 'res=a&et=1&sign=b' },
    { productId: 'bad id', deviceName: 'x', token: 'res=a&et=1&sign=b' },
    { productId: 'ok1', deviceName: '', token: 'res=a&et=1&sign=b' },
    { productId: 'ok1', deviceName: 'x'.repeat(129), token: 'res=a&et=1&sign=b' },
    { productId: 'ok1', deviceName: 'bad\u0007name', token: 'res=a&et=1&sign=b' },
    { productId: 'ok1', deviceName: 'x', token: 'only-sign=' },
    { productId: 'ok1', deviceName: 'x', token: 'res=a&et=1' },
    { productId: 'ok1', deviceName: 'x', token: 'res=a&et=1&sign=b\u0000' },
    { productId: 'ok1', deviceName: 'x', token: 'res=a&et=1&sign=' + 'b'.repeat(3000) }
  ];
  for (const bad of badCases) {
    assert.equal(api.saveOneNetDeviceConfig('tx', bad), false, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(storage.has('iot_onenet_devices_v1'), true);
  assert.deepEqual(JSON.parse(storage.get('iot_onenet_devices_v1')).tx, {});

  /* 损坏存储读取返回空配置 */
  storage.set('iot_onenet_devices_v1', JSON.stringify({
    version: 1,
    tx: { productId: 'bad id', deviceName: 'x', token: 'res=a&et=1&sign=b' },
    rx: { productId: 'ok1', deviceName: 'y', token: 'broken' }
  }));
  assert.equal(api.getOneNetConfig('tx').TOKEN, '');
  assert.equal(api.getOneNetConfig('rx').TOKEN, '');
});

test('R3 默认 TX 协议字段锁定，旧缓存仅可覆盖显示字段，附加项保留', () => {
  const malicious = JSON.stringify({
    sensors: [
      { id: 'voltage', name: '恶意电压', cloudKey: 'HACK', dataType: 'string', min: -999, max: 999, step: 100, unit: 'X', color: 'pink', icon: 'fa-fire' },
      { id: 'current', name: '电流A', cloudKey: 'I2', dataType: 'bool', min: -10, max: 99, step: 0.5, unit: 'mA' },
      { id: 'freq', name: '频率F', cloudKey: 'F2', dataType: 'string', min: 1, max: 999, step: 5 },
      { id: 'state', name: '状态S', cloudKey: 'S2', dataType: 'string', min: -1, max: 99 },
      { id: 'custom_co2', name: '自定义CO2', cloudKey: 'CO2', dataType: 'float', min: 0, max: 5000, step: 0.1 }
    ],
    controls: [
      { id: 'switch', name: '开关', cloudKey: 'Switch2', dataType: 'int32', step: 3 },
      { id: 'setfreq', name: '设频', cloudKey: 'SetFreq2', dataType: 'bool', min: 1, max: 9, step: 7 }
    ]
  });
  const { api } = loadWebModules({ iot_data_model: malicious });
  const model = api.getDataModel('tx');
  const byId = {};
  model.sensors.concat(model.controls).forEach((item) => { byId[item.id] = item; });
  const expect = {
    voltage: { cloudKey: 'V', dataType: 'double', unit: 'V', min: 0, max: 50, step: 0.01 },
    current: { cloudKey: 'I', dataType: 'double', unit: 'A', min: 0, max: 5, step: 0.001 },
    freq: { cloudKey: 'F', dataType: 'int32', unit: 'kHz', min: 20, max: 200, step: 0.1 },
    state: { cloudKey: 'S', dataType: 'int32', unit: '', min: 0, max: 3, step: 1 },
    switch: { cloudKey: 'Switch', dataType: 'bool', step: 1 },
    setfreq: { cloudKey: 'SetFreq', dataType: 'int32', unit: 'kHz', min: 20, max: 200, step: 0.1 }
  };
  for (const [id, e] of Object.entries(expect)) {
    const item = byId[id];
    assert.ok(item, id);
    assert.equal(item.cloudKey, e.cloudKey, id);
    assert.equal(item.dataType, e.dataType, id);
    if (e.unit !== undefined) assert.equal(item.unit, e.unit, id);
    if (e.min !== undefined) assert.equal(item.min, e.min, id);
    if (e.max !== undefined) assert.equal(item.max, e.max, id);
    assert.equal(item.step, e.step, id);
  }
  assert.equal(typeof byId.freq.fromCloud, 'function');
  assert.equal(typeof byId.setfreq.fromCloud, 'function');
  assert.equal(typeof byId.setfreq.toCloud, 'function');
  assert.equal(byId.voltage.name, '恶意电压');
  assert.equal(byId.voltage.color, 'pink');
  assert.ok(byId.custom_co2);
  assert.equal(byId.custom_co2.cloudKey, 'CO2');
});

function buildSettingsDom() {
  const h = createDomHarness();
  const { makeEl } = h;
  const els = {};
  ['tx', 'rx'].forEach((key) => {
    els[key + 'Form'] = makeEl('form');
    els[key + 'Form'].setAttribute('data-settings-device', key);
    els[key + 'ProductId'] = makeEl('input', key + 'ProductId');
    els[key + 'DeviceName'] = makeEl('input', key + 'DeviceName');
    els[key + 'Token'] = makeEl('input', key + 'Token');
    els[key + 'Token'].type = 'password';
    els[key + 'TokenToggle'] = makeEl('button', key + 'TokenToggle');
    els[key + 'TokenToggle'].setAttribute('aria-pressed', 'false');
    els[key + 'TokenToggle'].setAttribute('aria-label', '显示 Token');
    els[key + 'TokenToggleIcon'] = makeEl('i', key + 'TokenToggleIcon');
    els[key + 'TokenToggleIcon'].className = 'fas fa-eye';
    els[key + 'TokenHint'] = makeEl('span', key + 'TokenHint');
    els[key + 'SaveBtn'] = makeEl('button', key + 'SaveBtn');
    els[key + 'TestBtn'] = makeEl('button', key + 'TestBtn');
    els[key + 'ClearBtn'] = makeEl('button', key + 'ClearBtn');
    els[key + 'Status'] = makeEl('p', key + 'Status');
  });
  els.soundToggle = makeEl('input', 'soundToggle');
  els.txRuntimeBtn = makeEl('button', 'txRuntimeBtn');
  els.rxRuntimeBtn = makeEl('button', 'rxRuntimeBtn');
  els.allRuntimeBtn = makeEl('button', 'allRuntimeBtn');
  els.confirmDialog = makeEl('div', 'confirmDialog');
  els.confirmDialogTitle = makeEl('h3', 'confirmDialogTitle');
  els.confirmDialogMessage = makeEl('p', 'confirmDialogMessage');
  els.confirmDialogConfirm = makeEl('button', 'confirmDialogConfirm');
  els.confirmDialogCancel = makeEl('button', 'confirmDialogCancel');
  els.txModelSummary = makeEl('ul', 'txModelSummary');
  els.rxModelSummary = makeEl('ul', 'rxModelSummary');
  els.logoutBtn = makeEl('button', 'logoutBtn');
  return { ...h, els };
}

test('R4/R5 设置页独立表单：Token 不回填、保存只写本端、测试只 GET', async () => {
  const initialStorage = {
    iot_onenet_devices_v1: JSON.stringify({
      version: 1,
      tx: { productId: 'A60e06YLYw', deviceName: '20260001', token: VALID_TOKEN },
      rx: {}
    })
  };
  let postCount = 0;
  let getCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      postCount++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0 } }) };
    }
    getCount++;
    await gate;
    if (url.includes('/thingmodel/query-device-property')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: fullTxItems(Date.now()) }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
  };
  const harness = buildSettingsDom();
  const { storage } = loadPage('js/settings-page.js', harness, initialStorage, fetchImpl);
  await flushAsync();

  /* 已保存 Token 不回填，提示明确 */
  assert.equal(harness.els.txToken.value, '');
  assert.match(harness.els.txTokenHint.textContent, /已保存/);
  assert.equal(harness.els.txProductId.value, 'A60e06YLYw');

  /* 保存 RX 只写本端 */
  harness.els.rxProductId.value = 'rxp';
  harness.els.rxDeviceName.value = 'RX_001';
  harness.els.rxToken.value = 'res=r&et=1&sign=r';
  harness.els.rxForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  const store = JSON.parse(storage.get('iot_onenet_devices_v1'));
  assert.equal(store.rx.deviceName, 'RX_001');
  assert.equal(store.tx.deviceName, '20260001');
  assert.equal(harness.els.rxToken.value, '');
  assert.match(harness.els.rxStatus.textContent, /保存成功/);

  /* Token 留空 + 已保存 Token：沿用并只改本端 */
  harness.els.txDeviceName.value = 'TX_NEW';
  harness.els.txToken.value = '';
  harness.els.txForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  const store2 = JSON.parse(storage.get('iot_onenet_devices_v1'));
  assert.equal(store2.tx.deviceName, 'TX_NEW');
  assert.equal(store2.tx.token, VALID_TOKEN);
  assert.equal(harness.els.txToken.value, '');

  /* 测试已保存配置：GET 诊断、busy 禁用、无 POST */
  harness.els.txTestBtn.dispatch('click');
  await flushAsync();
  assert.equal(harness.els.txTestBtn.disabled, true);
  assert.equal(harness.els.txSaveBtn.disabled, true);
  release();
  await flushAsync();
  await flushAsync();
  assert.equal(harness.els.txTestBtn.disabled, false);
  assert.match(harness.els.txStatus.textContent, /测试结果：实时/);
  assert.ok(getCount >= 2);
  assert.equal(postCount, 0);
});

test('R4 未保存 Token 时留空保存失败且不写存储', async () => {
  const harness = buildSettingsDom();
  const { storage } = loadPage('js/settings-page.js', harness, {}, async () => { throw new Error('no fetch'); });
  await flushAsync();
  harness.els.txProductId.value = 'p1';
  harness.els.txDeviceName.value = 'd1';
  harness.els.txToken.value = '';
  harness.els.txForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  assert.match(harness.els.txStatus.textContent, /保存失败/);
  assert.equal(storage.has('iot_onenet_devices_v1'), false);
});

test('R6 精确数据维护：逐端清除与 clearAll 保留凭据/登录/偏好', () => {
  const initialStorage = {
    iot_onenet_devices_v1: JSON.stringify({
      version: 1,
      tx: { productId: 'txp', deviceName: 'txd', token: VALID_TOKEN },
      rx: { productId: 'rxp', deviceName: 'rxd', token: 'res=r&et=1&sign=r' }
    }),
    wpt_session_auth: 'sess',
    wpt_persistent_auth: 'persist',
    lastLoginTime: '123',
    iot_config: JSON.stringify({ soundAlert: true }),
    iot_latest_data_tx: '{}', iot_control_locks_tx: '{}', iot_history_data_tx: '[]',
    iot_latest_data_rx: '{}', iot_control_locks_rx: '{}', iot_history_data_rx: '[]',
    iot_latest_data: '{}', iot_control_locks: '{}', iot_history_data: '[]',
    iot_operation_logs: '[]', iot_alerts: '[]', iot_alarm_states: '{}',
    iot_operation_logs_v2: JSON.stringify([{ deviceKey: 'tx' }, { deviceKey: 'rx' }]),
    iot_alerts_v2: JSON.stringify([{ deviceKey: 'rx' }]),
    iot_alarm_states_v2: JSON.stringify({ 'tx:fault': true, 'rx:over': true, other: 1 })
  };
  const { api, storage } = loadWebModules(initialStorage, async () => { throw new Error('no'); });

  assert.equal(api.clearDeviceRuntimeData('rx'), true);
  assert.equal(storage.has('iot_latest_data_rx'), false);
  assert.equal(storage.has('iot_control_locks_rx'), false);
  assert.equal(storage.has('iot_history_data_rx'), false);
  assert.equal(storage.has('iot_latest_data_tx'), true);
  assert.equal(JSON.parse(storage.get('iot_operation_logs_v2')).length, 1);
  assert.equal(JSON.parse(storage.get('iot_operation_logs_v2'))[0].deviceKey, 'tx');
  assert.equal(storage.has('iot_alerts_v2'), false);
  assert.deepEqual(JSON.parse(storage.get('iot_alarm_states_v2')), { 'tx:fault': true, other: 1 });
  assert.equal(storage.has('iot_onenet_devices_v1'), true);

  assert.equal(api.clearAllRuntimeData(), true);
  for (const key of ['iot_latest_data_tx', 'iot_latest_data_rx', 'iot_control_locks_tx', 'iot_control_locks_rx', 'iot_history_data_tx', 'iot_history_data_rx', 'iot_latest_data', 'iot_control_locks', 'iot_history_data', 'iot_operation_logs', 'iot_alerts', 'iot_alarm_states', 'iot_operation_logs_v2', 'iot_alerts_v2', 'iot_alarm_states_v2']) {
    assert.equal(storage.has(key), false, key);
  }
  assert.ok(storage.has('iot_onenet_devices_v1'));
  assert.ok(storage.has('wpt_session_auth'));
  assert.ok(storage.has('wpt_persistent_auth'));
  assert.ok(storage.has('lastLoginTime'));
  assert.ok(storage.has('iot_config'));

  /* clearOneNetDeviceConfig：只清本端配置+本端运行数据 */
  assert.equal(api.clearOneNetDeviceConfig('tx'), true);
  assert.equal(api.getOneNetConfig('tx').TOKEN, '');
  assert.equal(api.getOneNetConfig('rx').TOKEN, 'res=r&et=1&sign=r');
  assert.equal(storage.has('iot_onenet_config'), false);
});

test('R4/R7 设置页结构契约：双端表单、模型摘要、无任意编辑、无 localStorage.clear', () => {
  const html = read('settings.html');
  const page = read('js/settings-page.js');
  for (const key of ['tx', 'rx']) {
    for (const suffix of ['ProductId', 'DeviceName', 'Token', 'TokenHint', 'SaveBtn', 'TestBtn', 'ClearBtn']) {
      assert.match(html, new RegExp(`id=["']${key}${suffix}["']`), key + suffix);
    }
    assert.match(html, new RegExp(`id=["']${key}Status["'][^>]*aria-live`), key + 'Status');
  }
  assert.match(html, /id=["']soundToggle["']/);
  assert.match(html, /id=["']confirmDialog["']/);
  assert.match(html, /id=["']txModelSummary["']/);
  assert.match(html, /id=["']rxModelSummary["']/);
  assert.match(html, /id=["']logoutBtn["']/);
  assert.doesNotMatch(html, /iot_onenet_config/);
  assert.doesNotMatch(html, /localStorage\.clear/);
  assert.doesNotMatch(html, /openDeviceModal|saveDeviceModal|dashboardTitle|clearCache/);
  const order = [
    html.indexOf('js/auth-guard.js'), html.indexOf('js/config.js'), html.indexOf('js/onenet.js'),
    html.indexOf('js/ui-common.js'), html.indexOf('js/settings-page.js')
  ];
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4]);
  assert.doesNotMatch(page, /localStorage\.clear/);
  assert.doesNotMatch(page, /iot_onenet_config/);
  assert.doesNotMatch(page, /innerHTML/);
  assert.doesNotMatch(page, /set-device-property/);
  assert.match(page, /validateOneNetDeviceConfig/);
  assert.match(page, /clearOneNetDeviceConfig/);
  assert.match(page, /clearDeviceRuntimeData/);
  assert.match(page, /clearAllRuntimeData/);
});

test('R8 SW web-3 预缓存设置页资源，设置样式无渐变', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
  assert.match(worker, /js\/settings-page\.js/);
  const css = read('css/dashboard.css');
  assert.doesNotMatch(css, /gradient\(/);
  assert.match(css, /settings-/);
  assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
  assert.match(css, /@media\s*\(max-width:\s*1023px\)/);
});

function navDom(pathname) {
  const h = createDomHarness();
  const { makeEl } = h;
  const links = ['/', '/monitoring', '/control', '/history', '/alerts', '/settings'].map((href) => {
    const a = makeEl('a');
    a.setAttribute('href', href);
    a.classList.add('nav-item');
    return a;
  });
  h.windowStub.location = { pathname };
  return { ...h, links };
}

test('R9 markActiveNavigation 按归一化 pathname 高亮唯一项', () => {
  const cases = [
    ['/', 0],
    ['/index.html', 0],
    ['/monitoring', 1],
    ['/monitoring.html', 1]
  ];
  for (const [pathname, expectedIndex] of cases) {
    const h = navDom(pathname);
    const context = {
      document: h.documentStub,
      window: h.windowStub,
      navigator: {},
      Promise, Set, Object, Array, JSON, Math, Number, String, Date
    };
    vm.createContext(context);
    vm.runInContext(read('js/ui-common.js') + '\n;globalThis.__w = { WptUi };', context);
    context.__w.WptUi.markActiveNavigation();
    const active = h.links.map((link) => link.classList.contains('is-active'));
    assert.equal(active.filter(Boolean).length, 1, pathname);
    assert.equal(active[expectedIndex], true, pathname);
    assert.equal(h.links[expectedIndex].getAttribute('aria-current'), 'page', pathname);
  }
});

test('R9 页面脚本调用 markActiveNavigation 且无旧内联导航脚本', () => {
  assert.match(read('js/index-page.js'), /markActiveNavigation/);
  assert.match(read('js/monitoring-page.js'), /markActiveNavigation/);
  assert.match(read('js/settings-page.js'), /markActiveNavigation/);
  for (const page of ['index', 'monitoring', 'settings']) {
    const html = read(`${page}.html`);
    assert.doesNotMatch(html, /getAttribute\(['"]href['"]\) === path/);
    assert.doesNotMatch(html, /link\.classList\.add\(['"]is-active['"]\)/);
  }
});

test('R10 RX_Safe 文案为启动门控语义且页面标签同步', () => {
  const { api } = loadUiCommon();
  assert.equal(api.WptUi.rxHealthText('rx_safe', true), '允许START');
  assert.equal(api.WptUi.rxHealthText('rx_safe', false), '禁止START');
  assert.equal(api.WptUi.rxHealthText('rx_safe', undefined), '未知');
  assert.match(read('index.html'), /启动门控/);
  assert.match(read('monitoring.html'), /启动门控/);
  assert.doesNotMatch(read('index.html'), /<h4>安全<\/h4>/);
  assert.doesNotMatch(read('monitoring.html'), /<span>安全<\/span>/);
  /* START 安全门控逻辑不受影响 */
  const { api: api2 } = loadWebModules({});
  const base = {
    _isOnline: true, _isFresh: true,
    rx_ble_online: true, rx_connected: true, rx_valid: true, rx_safe: true,
    rx_state: 2, rx_limit: false, rx_stim: false, rx_fault_flags: 0
  };
  assert.equal(api2.isReceiverStartAllowed(base), true);
  assert.equal(api2.isReceiverStartAllowed({ ...base, rx_safe: false }), false);
});

/* ========== R11-R18 设置页定点修正 ========== */

test('R11 TX voltage/current dataType 固定为 double', () => {
  const { api } = loadWebModules({});
  const tx = api.getDataModel('tx');
  assert.equal(tx.sensors.find((s) => s.id === 'voltage').dataType, 'double');
  assert.equal(tx.sensors.find((s) => s.id === 'current').dataType, 'double');
  const malicious = JSON.stringify({
    sensors: [
      { id: 'voltage', dataType: 'string', cloudKey: 'X' },
      { id: 'current', dataType: 'bool', cloudKey: 'Y' }
    ],
    controls: []
  });
  const { api: api2 } = loadWebModules({ iot_data_model: malicious });
  const tx2 = api2.getDataModel('tx');
  assert.equal(tx2.sensors.find((s) => s.id === 'voltage').dataType, 'double');
  assert.equal(tx2.sensors.find((s) => s.id === 'current').dataType, 'double');
});

test('R12 rx_safe 显示名为启动门控且协议字段不变', () => {
  const { api } = loadWebModules({});
  const safe = api.getDataModel('rx').sensors.find((s) => s.id === 'rx_safe');
  assert.equal(safe.name, '启动门控');
  assert.equal(safe.cloudKey, 'RX_Safe');
  assert.equal(safe.dataType, 'bool');
  assert.equal(safe.step, 1);
});

test('R13 clearAllRuntimeData 无条件删除三个 V2 键且保留凭据/登录/偏好/未知键', () => {
  const initialStorage = {
    iot_onenet_devices_v1: JSON.stringify({ version: 1, tx: { productId: 'txp', deviceName: 'txd', token: VALID_TOKEN } }),
    wpt_session_auth: 'sess',
    wpt_persistent_auth: 'persist',
    lastLoginTime: '123',
    iot_config: JSON.stringify({ soundAlert: true }),
    my_custom_key: 'keep-me',
    iot_latest_data_tx: '{}', iot_control_locks_tx: '{}', iot_history_data_tx: '[]',
    iot_latest_data_rx: '{}', iot_control_locks_rx: '{}', iot_history_data_rx: '[]',
    iot_latest_data: '{}', iot_control_locks: '{}', iot_history_data: '[]',
    iot_operation_logs: '[]', iot_alerts: '[]', iot_alarm_states: '{}',
    iot_operation_logs_v2: JSON.stringify([{ some: 'no-device-key' }, { deviceKey: 'unknown_dev' }]),
    iot_alerts_v2: 'not-json{{',
    iot_alarm_states_v2: 'garbage'
  };
  const { api, storage } = loadWebModules(initialStorage, async () => { throw new Error('no'); });
  assert.equal(api.clearAllRuntimeData(), true);
  for (const key of ['iot_latest_data_tx', 'iot_control_locks_tx', 'iot_history_data_tx', 'iot_latest_data_rx', 'iot_control_locks_rx', 'iot_history_data_rx', 'iot_latest_data', 'iot_control_locks', 'iot_history_data', 'iot_operation_logs', 'iot_alerts', 'iot_alarm_states', 'iot_operation_logs_v2', 'iot_alerts_v2', 'iot_alarm_states_v2']) {
    assert.equal(storage.has(key), false, key);
  }
  assert.ok(storage.has('iot_onenet_devices_v1'));
  assert.ok(storage.has('wpt_session_auth'));
  assert.ok(storage.has('wpt_persistent_auth'));
  assert.ok(storage.has('lastLoginTime'));
  assert.ok(storage.has('iot_config'));
  assert.equal(storage.get('my_custom_key'), 'keep-me');
});

test('R14 设置表单 submit 单次保存且无 click 双路径', async () => {
  const html = read('settings.html');
  assert.match(html, /type=["']submit["'][^>]*id=["']txSaveBtn["']/);
  assert.match(html, /type=["']submit["'][^>]*id=["']rxSaveBtn["']/);
  const page = read('js/settings-page.js');
  assert.match(page, /addEventListener\(['"]submit['"]/);
  assert.match(page, /preventDefault/);
  assert.doesNotMatch(page, /SaveBtn['"]\)\.addEventListener\(['"]click['"]/);

  const harness = buildSettingsDom();
  const { storage } = loadPage('js/settings-page.js', harness, {}, async () => { throw new Error('no fetch'); });
  await flushAsync();
  harness.els.rxProductId.value = 'rxp';
  harness.els.rxDeviceName.value = 'RX_001';
  harness.els.rxToken.value = 'res=r&et=1&sign=r';
  let preventCalls = 0;
  harness.els.rxForm.dispatch('submit', { preventDefault() { preventCalls++; } });
  await flushAsync();
  assert.ok(preventCalls >= 1);
  assert.equal(JSON.parse(storage.get('iot_onenet_devices_v1')).rx.deviceName, 'RX_001');
  assert.match(harness.els.rxStatus.textContent, /保存成功/);
  /* 再次提交不产生双写，仅一次覆盖 */
  harness.els.rxDeviceName.value = 'RX_002';
  harness.els.rxForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  assert.equal(JSON.parse(storage.get('iot_onenet_devices_v1')).rx.deviceName, 'RX_002');
});

test('R15 确认对话框焦点闭环与单次确认', async () => {
  const initialStorage = {
    iot_onenet_devices_v1: JSON.stringify({ version: 1, tx: { productId: 'txp', deviceName: 'txd', token: VALID_TOKEN } })
  };
  const harness = buildSettingsDom();
  const { storage } = loadPage('js/settings-page.js', harness, initialStorage, async () => { throw new Error('no'); });
  await flushAsync();
  const doc = harness.documentStub;

  /* 打开：焦点落到取消按钮 */
  harness.els.txClearBtn.dispatch('click');
  assert.equal(harness.els.confirmDialog.hidden, false);
  assert.equal(doc.activeElement, harness.els.confirmDialogCancel);

  /* ESC：不执行 action，关闭并恢复焦点 */
  doc.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(harness.els.confirmDialog.hidden, true);
  assert.equal(doc.activeElement, harness.els.txClearBtn);
  assert.equal(JSON.parse(storage.get('iot_onenet_devices_v1')).tx.deviceName, 'txd');

  /* 确认：只执行一次，关闭并恢复焦点 */
  harness.els.txClearBtn.dispatch('click');
  harness.els.confirmDialogConfirm.dispatch('click');
  assert.equal(harness.els.confirmDialog.hidden, true);
  assert.equal(doc.activeElement, harness.els.txClearBtn);
  assert.deepEqual(JSON.parse(storage.get('iot_onenet_devices_v1')).tx, {});
  assert.match(harness.els.txStatus.textContent, /已清除该端配置/);
  /* 关闭状态下再点确认：不重复执行 */
  harness.els.confirmDialogConfirm.dispatch('click');
  await flushAsync();
  assert.deepEqual(JSON.parse(storage.get('iot_onenet_devices_v1')).tx, {});

  /* Tab/Shift+Tab 在两个按钮间循环 */
  harness.els.txClearBtn.dispatch('click');
  doc.activeElement = harness.els.confirmDialogConfirm;
  doc.dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(doc.activeElement, harness.els.confirmDialogCancel);
  doc.activeElement = harness.els.confirmDialogCancel;
  doc.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(doc.activeElement, harness.els.confirmDialogConfirm);
  doc.dispatch('keydown', { key: 'Escape', preventDefault() {} });
});

test('R16 清理结果按 helper 返回值真实反馈', async () => {
  const harness = buildSettingsDom();
  const { context } = loadPage('js/settings-page.js', harness, {}, async () => { throw new Error('no'); });
  await flushAsync();

  harness.els.allRuntimeBtn.dispatch('click');
  harness.els.confirmDialogConfirm.dispatch('click');
  assert.match(harness.els.txStatus.textContent, /已清除全部运行数据/);
  assert.match(harness.els.rxStatus.textContent, /已清除全部运行数据/);

  context.clearOneNetDeviceConfig = () => false;
  harness.els.txClearBtn.dispatch('click');
  harness.els.confirmDialogConfirm.dispatch('click');
  assert.match(harness.els.txStatus.textContent, /清除失败/);

  context.clearDeviceRuntimeData = () => false;
  harness.els.rxRuntimeBtn.dispatch('click');
  harness.els.confirmDialogConfirm.dispatch('click');
  assert.match(harness.els.rxStatus.textContent, /清除失败/);

  context.clearAllRuntimeData = () => false;
  harness.els.allRuntimeBtn.dispatch('click');
  harness.els.confirmDialogConfirm.dispatch('click');
  assert.match(harness.els.txStatus.textContent, /清除失败/);
  assert.match(harness.els.rxStatus.textContent, /清除失败/);
});

test('R17 Token 可访问属性与显示切换不回填', async () => {
  const html = read('settings.html');
  assert.match(html, /<label for="txToken">OneNET Token<\/label>/);
  assert.match(html, /<label for="rxToken">OneNET Token<\/label>/);
  assert.match(html, /id=["']txToken["'][^>]*autocomplete=["']new-password["'][^>]*spellcheck=["']false["']/);
  assert.match(html, /id=["']rxToken["'][^>]*autocomplete=["']new-password["'][^>]*spellcheck=["']false["']/);
  assert.match(html, /id=["']txTokenToggle["'][^>]*aria-pressed=["']false["']/);
  assert.match(html, /id=["']rxTokenToggle["'][^>]*aria-pressed=["']false["']/);
  assert.match(html, /id=["']txTokenToggleIcon["']/);
  assert.match(html, /id=["']rxTokenToggleIcon["']/);

  const harness = buildSettingsDom();
  loadPage('js/settings-page.js', harness, {
    iot_onenet_devices_v1: JSON.stringify({ version: 1, tx: { productId: 'txp', deviceName: 'txd', token: VALID_TOKEN } })
  }, async () => { throw new Error('no'); });
  await flushAsync();
  assert.equal(harness.els.txToken.value, '');
  assert.equal(harness.els.txTokenToggle.getAttribute('aria-pressed'), 'false');
  harness.els.txTokenToggle.dispatch('click');
  assert.equal(harness.els.txToken.type, 'text');
  assert.equal(harness.els.txTokenToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(harness.els.txTokenToggle.getAttribute('aria-label'), '隐藏 Token');
  assert.equal(harness.els.txTokenToggleIcon.className, 'fas fa-eye-slash');
  assert.equal(harness.els.txToken.value, '');
  harness.els.txTokenToggle.dispatch('click');
  assert.equal(harness.els.txToken.type, 'password');
  assert.equal(harness.els.txTokenToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(harness.els.txTokenToggle.getAttribute('aria-label'), '显示 Token');
  assert.equal(harness.els.txTokenToggleIcon.className, 'fas fa-eye');
  assert.equal(harness.els.txToken.value, '');
});

/* ========== R19-R29 双端控制闭环 ========== */

function loadControlCore(initialStorage = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const context = {
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    document: { createElement: () => ({ textContent: '', innerHTML: '' }) },
    fetch: async () => { throw new Error('no'); },
    AbortController, setTimeout, clearTimeout,
    Promise, Set, Object, Array, JSON, Math, Number, String, Date
  };
  vm.createContext(context);
  vm.runInContext(read('js/config.js') + '\n' + read('js/onenet.js') + '\n' + read('js/control-core.js') +
    '\n;globalThis.__web = { WptControlCore };', context);
  return { api: context.__web, context, storage };
}

function rxGateOpenItems(now) {
  return fullRxItems(now).concat([
    { identifier: 'RX_BleOnline', value: true, data_type: 'bool', time: now - 1000 },
    { identifier: 'RX_Safe', value: true, data_type: 'bool', time: now - 1000 },
    { identifier: 'RX_State', value: 2, data_type: 'int32', time: now - 1000 }
  ]);
}

function controlFetch({ txItems, rxItems, postImpl, gate } = {}) {
  const tx = txItems || (() => fullTxItems(Date.now()));
  const rx = rxItems || (() => rxGateOpenItems(Date.now()));
  const post = postImpl || (async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0, msg: 'ok' } }) }));
  return async (url, options) => {
    if (options && options.method === 'POST') {
      if (gate) await gate;
      return post(url, options);
    }
    if (url.includes('/device/detail')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    }
    if (url.includes('device_name=rxd')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rx() } }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: tx() }) };
  };
}

function buildControlDom() {
  const h = createDomHarness();
  const { makeEl } = h;
  const els = {};
  const buttonIds = ['controlSyncBtn', 'txOnBtn', 'txOffBtn', 'txFrequencyBtn', 'rxStartBtn', 'rxStopBtn', 'rxStatusBtn', 'rxZeroBtn', 'rxRateBtn', 'clearOperationLogsBtn', 'controlConfirmCancel', 'controlConfirmConfirm'];
  const inputIds = ['txFrequencyInput', 'rxRateInput'];
  const ids = [
    'controlSyncBtn', 'controlStatus',
    'txEndpointState', 'txSourceTime', 'txDeviceName', 'txStateValue', 'txVoltageValue', 'txCurrentValue', 'txFrequencyValue', 'txGateReason', 'txOnBtn', 'txOffBtn', 'txFrequencyForm', 'txFrequencyInput', 'txFrequencyBtn',
    'rxEndpointState', 'rxSourceTime', 'rxDeviceName', 'rxStateValue', 'rxBleValue', 'rxValidValue', 'rxFaultValue', 'rxGateReason', 'rxStartBtn', 'rxStopBtn', 'rxStatusBtn', 'rxZeroBtn', 'rxRateForm', 'rxRateInput', 'rxRateBtn', 'rxAuditSequence', 'rxAuditCommand', 'rxAuditResult',
    'logDeviceFilter', 'clearOperationLogsBtn', 'operationLogBody',
    'controlConfirmDialog', 'controlConfirmTitle', 'controlConfirmMessage', 'controlConfirmCancel', 'controlConfirmConfirm'
  ];
  ids.forEach((id) => {
    if (id === 'txFrequencyForm' || id === 'rxRateForm') {
      const form = makeEl('form', id);
      form.setAttribute('data-device', id === 'txFrequencyForm' ? 'tx' : 'rx');
      els[id] = form;
      return;
    }
    const el = makeEl(buttonIds.includes(id) ? 'button' : (inputIds.includes(id) ? 'input' : 'div'), id);
    if (inputIds.includes(id)) el.type = 'text';
    els[id] = el;
  });
  els.logDeviceFilter = makeEl('select', 'logDeviceFilter');
  els.logDeviceFilter.value = 'all';
  els.operationLogBody = makeEl('tbody', 'operationLogBody');
  return { ...h, els };
}

function loadControlPage(harness, initialStorage, fetchImpl) {
  return loadPage('js/control-page.js', harness, initialStorage, fetchImpl, ['js/control-core.js']);
}

test('R19 命令真实成功/失败文本、回绕与未知文本分类', () => {
  const { api } = loadWebModules({});
  const shape = (o) => JSON.stringify(o);
  const audit = (cmd, res, base, seq) => api.getReceiverCommandOutcome({ rx_command_sequence: seq, rx_command: cmd, rx_command_result: res }, base, cmd);
  const successCases = [
    ['START', 'START accepted', 4, 5],
    ['STOP', 'stopped; fault cleared', 4, 5],
    ['STATUS', 'STATUS:requested:ok', 4, 5],
    ['ZERO', 'software zero recorded', 4, 5],
    ['RATE', 'rate accepted', 4, 5]
  ];
  for (const [cmd, res, base, seq] of successCases) {
    assert.equal(shape(audit(cmd, res, base, seq)), shape({ isNew: true, outcome: 'success', sequence: seq }), cmd + ':' + res);
  }
  const failureCases = [
    ['START', 'START rejected: limit', 4, 5],
    ['STOP', 'fault remains', 4, 5],
    ['ZERO', 'ZERO rejected', 4, 5],
    ['RATE', 'ERROR rate 100', 4, 5],
    ['STATUS', 'receiver timeout', 4, 5],
    ['START', 'BLE disconnected', 4, 5],
    ['STOP', 'rejected by receiver', 4, 5]
  ];
  for (const [cmd, res, base, seq] of failureCases) {
    assert.equal(shape(audit(cmd, res, base, seq)), shape({ isNew: true, outcome: 'failed', sequence: seq }), cmd + ':' + res);
  }
  assert.equal(shape(audit('START', 'queued somewhere', 4, 5)), shape({ isNew: true, outcome: 'pending', sequence: 5 }));
  assert.equal(shape(audit('START', 'success', 2147483647, 1)), shape({ isNew: true, outcome: 'success', sequence: 1 }));
  assert.equal(shape(audit('START', 'success', 2147483647, 2)), shape({ isNew: false, outcome: 'pending', sequence: null }));
  assert.equal(shape(api.getReceiverCommandOutcome({ rx_command_sequence: 5, rx_command: 'START', rx_command_result: 'START accepted' }, 4, 'STOP')), shape({ isNew: false, outcome: 'pending', sequence: null }));
  assert.equal(shape(api.getReceiverCommandOutcome(null, 4, 'START')), shape({ isNew: false, outcome: 'pending', sequence: null }));
});

test('R20 WptControlCore 权限/校验/结果分类', () => {
  const { api } = loadControlCore();
  const C = api.WptControlCore;
  assert.equal(C.validateTxFrequency(20), true);
  assert.equal(C.validateTxFrequency(99.9), true);
  assert.equal(C.validateTxFrequency(100), true);
  assert.equal(C.validateTxFrequency(200), true);
  assert.equal(C.validateTxFrequency(19.9), false);
  assert.equal(C.validateTxFrequency(99.95), false);
  assert.equal(C.validateTxFrequency(100.5), false);
  assert.equal(C.validateTxFrequency(200.1), false);
  assert.equal(C.validateTxFrequency('abc'), false);
  assert.equal(C.validateRate(100), true);
  assert.equal(C.validateRate(5000), true);
  assert.equal(C.validateRate(99), false);
  assert.equal(C.validateRate(5001), false);
  assert.equal(C.validateRate(100.5), false);

  const configured = { PRODUCT_ID: 'p', DEVICE_NAME: 'd', TOKEN: 't' };
  const liveData = { _isMock: false, _isOnline: true, _isFresh: true, state: 0 };
  let txp = C.getTxPermissions({ config: configured, data: liveData, error: null, pending: false });
  assert.equal(txp.configured, true);
  assert.equal(txp.live, true);
  assert.equal(txp.on, true);
  assert.equal(txp.setfreq, true);
  assert.equal(txp.off, true);
  txp = C.getTxPermissions({ config: configured, data: { ...liveData, state: 2 }, error: null, pending: false });
  assert.equal(txp.on, false);
  assert.equal(txp.setfreq, true);
  txp = C.getTxPermissions({ config: configured, data: null, error: new Error('x'), pending: false });
  assert.equal(txp.live, false);
  assert.equal(txp.on, false);
  assert.equal(txp.setfreq, false);
  assert.equal(txp.off, true);
  txp = C.getTxPermissions({ config: configured, data: liveData, error: null, pending: true });
  assert.equal(txp.on, false);
  assert.equal(txp.off, false);
  txp = C.getTxPermissions({ config: null, data: liveData, error: null, pending: false });
  assert.equal(txp.on, false);
  assert.equal(txp.off, false);

  const rxGate = { _isOnline: true, _isFresh: true, rx_ble_online: true, rx_connected: true, rx_valid: true, rx_safe: true, rx_state: 2, rx_limit: false, rx_stim: false, rx_fault_flags: 0 };
  let rxp = C.getRxPermissions({ config: configured, data: rxGate, error: null, pending: false });
  assert.equal(rxp.start, true);
  assert.equal(rxp.zero, true);
  assert.equal(rxp.stop, true);
  assert.equal(rxp.status, true);
  assert.equal(rxp.rate, true);
  rxp = C.getRxPermissions({ config: configured, data: { ...rxGate, rx_safe: false }, error: null, pending: false });
  assert.equal(rxp.start, false);
  assert.equal(rxp.zero, false);
  assert.equal(rxp.stop, true);
  rxp = C.getRxPermissions({ config: configured, data: null, error: new Error('x'), pending: false });
  assert.equal(rxp.start, false);
  assert.equal(rxp.stop, true);
  rxp = C.getRxPermissions({ config: configured, data: rxGate, error: null, pending: true });
  assert.equal(rxp.stop, false);

  const cls = (r) => JSON.stringify(C.classifyPropertyOutcome(r));
  assert.equal(cls({ confirmed: true }), JSON.stringify({ outcome: 'confirmed', label: '设备已确认执行' }));
  assert.equal(cls({ accepted: true, confirmed: false, deviceCode: 500 }), JSON.stringify({ outcome: 'device_rejected', label: '设备已拒绝' }));
  assert.equal(cls({ accepted: true, confirmed: false, deviceCode: null }), JSON.stringify({ outcome: 'accepted_only', label: '平台已受理，设备未确认' }));
  assert.equal(cls({ accepted: false }), JSON.stringify({ outcome: 'transport_failed', label: '传输失败' }));
  assert.equal(cls({ outcome: 'blocked' }), JSON.stringify({ outcome: 'blocked', label: '本地拦截' }));
});

test('R24 操作日志 schema、清洗与损坏 JSON 处理', () => {
  const { api, context } = loadControlCore();
  const C = api.WptControlCore;
  const now = Date.now();
  assert.equal(C.appendOperationLog({
    id: 'cmd_1', deviceKey: 'tx', timestamp: now, command: 'ON', requestedValue: true,
    outcome: 'confirmed', accepted: true, confirmed: true, deviceCode: 0,
    message: 'ok', requestId: 'r1', auditBaseline: null, auditOutcome: null, auditSequence: null, auditResult: ''
  }), true);
  C.appendOperationLog({
    id: 'x'.repeat(200), deviceKey: 'tx', timestamp: now, command: '<img src=x onerror=alert(1)>',
    outcome: 'blocked', accepted: false, confirmed: false,
    message: 'm'.repeat(500), requestId: 'r'.repeat(300), auditBaseline: null, auditOutcome: null, auditSequence: null, auditResult: ''
  });
  let logs = C.readOperationLogs();
  assert.equal(logs.length, 2);
  assert.ok(logs[0].id.length <= 64);
  assert.ok(logs[0].command.length <= 32);
  assert.ok(logs[0].message.length <= 160);
  assert.ok(logs[0].requestId.length <= 128);
  for (let i = 0; i < 120; i++) {
    C.appendOperationLog({ id: 'log_' + i, deviceKey: 'rx', timestamp: now - i * 1000, command: 'STOP', outcome: 'transport_failed', accepted: false, confirmed: false, message: '', requestId: '', auditBaseline: null, auditOutcome: null, auditSequence: null, auditResult: '' });
  }
  logs = C.readOperationLogs();
  assert.equal(logs.length, 100);
  assert.ok(logs[0].timestamp >= logs[logs.length - 1].timestamp);
  assert.ok(logs.every((entry) => entry.deviceKey === 'rx' || entry.deviceKey === 'tx'));
  assert.ok(logs.every((entry) => entry.outcome !== 'evil'));

  context.localStorage.setItem('iot_operation_logs_v2', 'not-json{{');
  assert.equal(context.__web.WptControlCore.readOperationLogs().length, 0);
  context.localStorage.setItem('iot_operation_logs_v2', JSON.stringify([{ id: 'bad' }, { id: 'ok', deviceKey: 'tx', timestamp: 1, command: 'OFF', outcome: 'blocked', accepted: false, confirmed: false, message: '', requestId: '', auditBaseline: null, auditOutcome: null, auditSequence: null, auditResult: '' }]));
  logs = context.__web.WptControlCore.readOperationLogs();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, 'ok');
  assert.equal(C.updateOperationLog(logs[0].id, { auditOutcome: 'success', auditSequence: 7, auditResult: 'ok' }), true);
  logs = C.readOperationLogs();
  assert.equal(logs[0].auditOutcome, 'success');
  assert.equal(logs[0].auditSequence, 7);
  assert.equal(C.clearOperationLogs(), true);
  assert.equal(C.readOperationLogs().length, 0);
});

test('R21 控制页双端结构契约与脚本顺序', () => {
  const html = read('control.html');
  const page = read('js/control-page.js');
  const requiredIds = ['controlSyncBtn', 'controlStatus', 'txEndpointState', 'txSourceTime', 'txDeviceName', 'txStateValue', 'txVoltageValue', 'txCurrentValue', 'txFrequencyValue', 'txGateReason', 'txOnBtn', 'txOffBtn', 'txFrequencyForm', 'txFrequencyInput', 'txFrequencyBtn', 'rxEndpointState', 'rxSourceTime', 'rxDeviceName', 'rxStateValue', 'rxBleValue', 'rxValidValue', 'rxFaultValue', 'rxGateReason', 'rxStartBtn', 'rxStopBtn', 'rxStatusBtn', 'rxZeroBtn', 'rxRateForm', 'rxRateInput', 'rxRateBtn', 'rxAuditSequence', 'rxAuditCommand', 'rxAuditResult', 'logDeviceFilter', 'clearOperationLogsBtn', 'operationLogBody', 'controlConfirmDialog', 'controlConfirmTitle', 'controlConfirmMessage', 'controlConfirmCancel', 'controlConfirmConfirm'];
  for (const id of requiredIds) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  const order = [html.indexOf('js/auth-guard.js'), html.indexOf('js/config.js'), html.indexOf('js/onenet.js'), html.indexOf('js/ui-common.js'), html.indexOf('js/control-core.js'), html.indexOf('js/control-page.js')];
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4] && order[4] < order[5]);
  assert.doesNotMatch(html, /getLatestData|sendProperty|setProperty/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(page, /innerHTML/);
  assert.doesNotMatch(page, /setProperty\(/);
  assert.doesNotMatch(page, /iot_latest_data/);
  assert.doesNotMatch(page, /iot_operation_logs[^_v2]/);
  assert.match(page, /OneNetService\.sendProperty\(/);
  assert.match(page, /createLifecyclePoller/);
});

test('R22 TX ON 待机确认后单次 POST 且 confirmed 反馈', async () => {
  const now = Date.now();
  let postCount = 0;
  let lastBody = null;
  const harness = buildControlDom();
  const { storage } = loadControlPage(harness, { iot_onenet_config: JSON.stringify(LEGACY_CFG) }, controlFetch({
    txItems: () => fullTxItems(now).map((item) => item.identifier === 'S' ? { ...item, value: 0 } : item),
    postImpl: async (url, options) => {
      postCount++;
      lastBody = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0, msg: 'ok' } }) };
    }
  }));
  await flushAsync();
  assert.equal(harness.els.txEndpointState.textContent, '实时');
  harness.els.txOnBtn.dispatch('click');
  assert.equal(harness.els.controlConfirmDialog.hidden, false);
  harness.els.controlConfirmConfirm.dispatch('click');
  await flushAsync();
  assert.equal(postCount, 1);
  assert.equal(lastBody.params.Switch, true);
  assert.match(harness.els.controlStatus.textContent, /设备已确认执行/);
  const logs = JSON.parse(storage.get('iot_operation_logs_v2'));
  assert.equal(logs[0].deviceKey, 'tx');
  assert.equal(logs[0].command, 'ON');
  assert.equal(logs[0].outcome, 'confirmed');
  assert.equal(logs[0].confirmed, true);
  assert.equal(logs[0].requestId, '');
});

test('R22 TX 运行态 ON 与非法频率被拦截，OFF 防重入且异常解锁', async () => {
  const now = Date.now();
  let postCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = buildControlDom();
  const { storage } = loadControlPage(harness, { iot_onenet_config: JSON.stringify(LEGACY_CFG) }, controlFetch({
    postImpl: async () => {
      postCount++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0 } }) };
    },
    gate
  }));
  await flushAsync();
  harness.els.txOnBtn.dispatch('click');
  await flushAsync();
  assert.equal(postCount, 0);
  assert.match(harness.els.controlStatus.textContent, /拦截/);
  assert.match(harness.els.txGateReason.textContent, /运行|扫频/);
  assert.equal(JSON.parse(storage.get('iot_operation_logs_v2'))[0].outcome, 'blocked');

  harness.els.txFrequencyInput.value = '100.5';
  harness.els.txFrequencyForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  assert.equal(postCount, 0);
  assert.match(harness.els.controlStatus.textContent, /频率不合法/);

  harness.els.txOffBtn.dispatch('click');
  harness.els.txOffBtn.dispatch('click');
  await flushAsync();
  release();
  await flushAsync();
  await flushAsync();
  assert.equal(postCount, 1);
  assert.match(harness.els.controlStatus.textContent, /设备已确认执行/);
  assert.equal(harness.els.txOffBtn.disabled, false);
});

test('R23 RX START 门控确认后单次 POST；门控关闭与非法 RATE 拦截；STOP 离线仍尝试', async () => {
  const now = Date.now();
  const postBodies = [];
  const harness = buildControlDom();
  const { storage } = loadControlPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, controlFetch({
    rxItems: () => rxGateOpenItems(now),
    postImpl: async (url, options) => {
      postBodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0, msg: 'ok' } }) };
    }
  }));
  await flushAsync();
  assert.equal(harness.els.rxEndpointState.textContent, '实时');
  harness.els.rxStartBtn.dispatch('click');
  assert.equal(harness.els.controlConfirmDialog.hidden, false);
  harness.els.controlConfirmConfirm.dispatch('click');
  await flushAsync();
  assert.equal(postBodies.length, 1);
  assert.equal(postBodies[0].params.RX_Command, 'START');
  const logs = JSON.parse(storage.get('iot_operation_logs_v2'));
  assert.equal(logs[0].command, 'START');
  assert.equal(logs[0].outcome, 'confirmed');
  assert.equal(logs[0].auditBaseline, null);

  const harness2 = buildControlDom();
  const { storage: storage2 } = loadControlPage(harness2, { iot_onenet_devices_v1: DUAL_CONFIG }, controlFetch({
    rxItems: () => rxGateOpenItems(now).map((item) => item.identifier === 'RX_BleOnline' ? { ...item, value: false } : item),
    postImpl: async (url, options) => {
      postBodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0 } }) };
    }
  }));
  await flushAsync();
  harness2.els.rxStartBtn.dispatch('click');
  await flushAsync();
  assert.equal(postBodies.length, 1);
  assert.match(harness2.els.controlStatus.textContent, /拦截/);
  assert.match(harness2.els.rxGateReason.textContent, /BLE/);
  assert.equal(JSON.parse(storage2.get('iot_operation_logs_v2'))[0].outcome, 'blocked');
  harness2.els.rxRateInput.value = '99';
  harness2.els.rxRateForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  assert.equal(postBodies.length, 1);
  assert.match(harness2.els.controlStatus.textContent, /RATE 不合法/);

  const harness3 = buildControlDom();
  let stopPosts = 0;
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      stopPosts++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0 } }) };
    }
    if (url.includes('/device/detail')) throw new Error('detail down');
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxGateOpenItems(now) } }) };
  };
  loadControlPage(harness3, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness3.els.rxEndpointState.textContent, '离线');
  assert.ok(!harness3.els.controlConfirmDialog.hidden);
  harness3.els.rxStopBtn.dispatch('click');
  await flushAsync();
  assert.equal(stopPosts, 1);
});

test('R25 双端独立降级与共享轮询，页面不读旧缓存', async () => {
  const now = Date.now();
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0 } }) };
    if (url.includes('/device/detail')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    if (url.includes('device_name=rxd')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxGateOpenItems(now) } }) };
    throw new Error('tx property down');
  };
  const harness = buildControlDom();
  loadControlPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness.els.txEndpointState.textContent, '获取失败');
  assert.equal(harness.els.rxEndpointState.textContent, '实时');
  assert.equal(harness.els.txVoltageValue.textContent, '--');
  assert.equal(harness.els.rxStateValue.textContent, '就绪');
  const page = read('js/control-page.js');
  assert.match(page, /Promise\.allSettled/);
  assert.doesNotMatch(page, /iot_latest_data/);
});

test('R26 控制确认对话框危险操作确认与键盘安全', () => {
  const html = read('control.html');
  assert.match(html, /id=["']controlConfirmDialog["'][^>]*role=["']alertdialog["']/);
  const page = read('js/control-page.js');
  assert.match(page, /previousFocus/);
  assert.match(page, /Escape/);
  assert.match(page, /controlConfirmCancel/);
  assert.match(page, /确认启动刺激/);
  assert.match(page, /确认清零/);
  assert.match(page, /确认启动/);
  assert.doesNotMatch(page, /window\.confirm/);
});

test('R27 控制页样式无渐变且响应式', () => {
  const css = read('css/dashboard.css');
  assert.doesNotMatch(css, /gradient\(/);
  assert.match(css, /\.control-grid/);
  assert.match(css, /@media\s*\(min-width:\s*1024px\)/);
  assert.match(css, /control-values/);
  assert.match(css, /:focus-visible/);
});

test('R28 SW web-4 预缓存控制模块', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
  assert.match(worker, /js\/control-core\.js/);
  assert.match(worker, /js\/control-page\.js/);
});

/* ========== R30-R33 最终门控与审计修正 ========== */

test('R30 RATE 审计按命令类型解析且 not accepted 不误判成功', () => {
  const { api } = loadWebModules({});
  const shape = (o) => JSON.stringify(o);
  const audit = (cmd, res, base, seq) => api.getReceiverCommandOutcome({ rx_command_sequence: seq, rx_command: cmd, rx_command_result: res }, base, cmd);
  assert.equal(shape(audit('RATE=2500', 'rate accepted', 4, 5)), shape({ isNew: true, outcome: 'success', sequence: 5 }));
  assert.equal(shape(audit('RATE=2500', 'ERROR rate 100', 4, 5)), shape({ isNew: true, outcome: 'failed', sequence: 5 }));
  assert.equal(shape(audit('RATE=2500', 'not accepted', 4, 5)), shape({ isNew: true, outcome: 'pending', sequence: 5 }));
  assert.equal(shape(audit('START', 'ACCEPTED', 4, 5)), shape({ isNew: true, outcome: 'pending', sequence: 5 }));
  assert.equal(shape(audit('START', 'success', 4, 5)), shape({ isNew: true, outcome: 'success', sequence: 5 }));
  assert.equal(shape(api.getReceiverCommandOutcome({ rx_command_sequence: 5, rx_command: 'RATE=2500', rx_command_result: 'rate accepted' }, 4, 'RATE=2501')), shape({ isNew: false, outcome: 'pending', sequence: null }));
});

test('R31 确认后最终门控：快照失效时 blocked 且不 POST', async () => {
  const now = Date.now();
  const state = { txState: 0, rxBle: true };
  let postCount = 0;
  const fetchImpl = async (url, options) => {
    if (options && options.method === 'POST') {
      postCount++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0 } }) };
    }
    if (url.includes('/device/detail')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    }
    if (url.includes('device_name=rxd')) {
      const items = rxGateOpenItems(now).map((item) => item.identifier === 'RX_BleOnline' ? { ...item, value: state.rxBle } : item);
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: items } }) };
    }
    const txItems = fullTxItems(now).map((item) => item.identifier === 'S' ? { ...item, value: state.txState } : item);
    return { ok: true, status: 200, json: async () => ({ code: 0, data: txItems }) };
  };

  /* TX ON：确认框打开期间状态变为运行 -> 最终门控拦截，不 POST */
  const harness = buildControlDom();
  const { storage } = loadControlPage(harness, { iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  await flushAsync();
  harness.els.txOnBtn.dispatch('click');
  assert.equal(harness.els.controlConfirmDialog.hidden, false);
  state.txState = 2;
  harness.els.controlSyncBtn.dispatch('click');
  await flushAsync();
  harness.els.controlConfirmConfirm.dispatch('click');
  await flushAsync();
  assert.equal(postCount, 0);
  const logs = JSON.parse(storage.get('iot_operation_logs_v2'));
  assert.equal(logs[0].outcome, 'blocked');
  assert.match(harness.els.controlStatus.textContent, /拦截/);

  /* RX START：确认框打开期间门控失效 -> 最终门控拦截，不 POST */
  const harness2 = buildControlDom();
  const { storage: storage2 } = loadControlPage(harness2, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  harness2.els.rxStartBtn.dispatch('click');
  assert.equal(harness2.els.controlConfirmDialog.hidden, false);
  state.rxBle = false;
  harness2.els.controlSyncBtn.dispatch('click');
  await flushAsync();
  harness2.els.controlConfirmConfirm.dispatch('click');
  await flushAsync();
  assert.equal(postCount, 0);
  assert.equal(JSON.parse(storage2.get('iot_operation_logs_v2'))[0].outcome, 'blocked');
});

test('R31 RATE/START 在最终门控后、POST 前捕获 auditBaseline', async () => {
  const now = Date.now();
  const postBodies = [];
  const rxItems = () => rxGateOpenItems(now).concat([
    { identifier: 'RX_CommandSequence', value: 42, data_type: 'int32', time: now - 1000 }
  ]);
  const harness = buildControlDom();
  const { storage } = loadControlPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, controlFetch({
    rxItems,
    postImpl: async (url, options) => {
      postBodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { code: 0, msg: 'ok' } }) };
    }
  }));
  await flushAsync();

  harness.els.rxRateInput.value = '2500';
  harness.els.rxRateForm.dispatch('submit', { preventDefault() {} });
  await flushAsync();
  assert.equal(postBodies.length, 1);
  assert.equal(postBodies[0].params.RX_Command, 'RATE=2500');
  let logs = JSON.parse(storage.get('iot_operation_logs_v2'));
  assert.equal(logs[0].command, 'RATE=2500');
  assert.equal(logs[0].auditBaseline, 42);

  harness.els.rxStartBtn.dispatch('click');
  harness.els.controlConfirmConfirm.dispatch('click');
  await flushAsync();
  assert.equal(postBodies.length, 2);
  assert.equal(postBodies[1].params.RX_Command, 'START');
  logs = JSON.parse(storage.get('iot_operation_logs_v2'));
  assert.equal(logs[0].command, 'START');
  assert.equal(logs[0].auditBaseline, 42);
});

test('R32/R33 频率与 RATE 输入显式 label，日志表头为操作时间', () => {
  const html = read('control.html');
  assert.match(html, /<label for="txFrequencyInput"[^>]*>频率 \(kHz\)<\/label>/);
  assert.match(html, /<label for="rxRateInput"[^>]*>RATE \(ms\)<\/label>/);
  assert.match(html, /<th>操作时间<\/th>/);
  assert.doesNotMatch(html, /<th>源时间<\/th>/);
});

/* ========== R34-R39 首页端点切换与控制表单手机布局 ========== */

test('R34 首页 TX/RX 分段切换结构契约', () => {
  const html = read('index.html');
  assert.match(html, /role=["']tablist["']/);
  assert.match(html, /id=["']homeTxTab["'][^>]*data-endpoint-tab=["']tx["'][^>]*aria-controls=["']txEndpointPanel["']/);
  assert.match(html, /id=["']homeRxTab["'][^>]*data-endpoint-tab=["']rx["'][^>]*aria-controls=["']rxEndpointPanel["']/);
  assert.match(html, /data-role=["']tab-status["']/);
  assert.match(html, /id=["']txEndpointPanel["'][^>]*role=["']tabpanel["'][^>]*aria-labelledby=["']homeTxTab["']/);
  assert.match(html, /id=["']rxEndpointPanel["'][^>]*role=["']tabpanel["'][^>]*aria-labelledby=["']homeRxTab["']/);
  assert.match(html, /data-endpoint-card=["']rx["'][^>]*hidden/);
  assert.doesNotMatch(html, /data-endpoint-card=["']tx["'][^>]*hidden/);
});

test('R35 首页端点选择持久化、损坏回退、点击与键盘切换', async () => {
  /* 默认 TX */
  const harness = buildIndexDom();
  const { storage } = loadPage('js/index-page.js', harness, { iot_onenet_config: JSON.stringify(LEGACY_CFG) }, async () => { throw new Error('no'); });
  await flushAsync();
  assert.equal(harness.tx.card.hidden, false);
  assert.equal(harness.rx.card.hidden, true);
  assert.equal(harness.tabs.tx.getAttribute('aria-selected'), 'true');
  assert.equal(harness.tabs.rx.getAttribute('aria-selected'), 'false');
  assert.equal(harness.tabs.tx.tabIndex, 0);
  assert.equal(harness.tabs.rx.tabIndex, -1);

  /* 点击 RX：DOM 立即切换并持久化 */
  harness.tabs.rx.dispatch('click');
  await flushAsync();
  assert.equal(harness.rx.card.hidden, false);
  assert.equal(harness.tx.card.hidden, true);
  assert.equal(harness.tabs.rx.getAttribute('aria-selected'), 'true');
  assert.equal(storage.get('wpt_home_endpoint_v1'), 'rx');

  /* 持久化 rx 启动 */
  const harness2 = buildIndexDom();
  loadPage('js/index-page.js', harness2, { wpt_home_endpoint_v1: 'rx' }, async () => { throw new Error('no'); });
  await flushAsync();
  assert.equal(harness2.rx.card.hidden, false);
  assert.equal(harness2.tx.card.hidden, true);

  /* 损坏值回退 TX */
  const harness3 = buildIndexDom();
  loadPage('js/index-page.js', harness3, { wpt_home_endpoint_v1: 'zzz' }, async () => { throw new Error('no'); });
  await flushAsync();
  assert.equal(harness3.tx.card.hidden, false);
  assert.equal(harness3.rx.card.hidden, true);

  /* 存储写入异常不回滚 UI */
  const harness4 = buildIndexDom();
  loadPage('js/index-page.js', harness4, {}, async () => { throw new Error('no'); }, [], {
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => {}
    }
  });
  await flushAsync();
  harness4.tabs.rx.dispatch('click');
  await flushAsync();
  assert.equal(harness4.rx.card.hidden, false);
  assert.equal(harness4.tabs.rx.getAttribute('aria-selected'), 'true');

  /* 键盘：ArrowRight 循环、Home/End，其他键不处理 */
  const harness5 = buildIndexDom();
  loadPage('js/index-page.js', harness5, {}, async () => { throw new Error('no'); });
  await flushAsync();
  const doc = harness5.documentStub;
  doc.activeElement = harness5.tabs.tx;
  doc.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(harness5.rx.card.hidden, false);
  assert.equal(doc.activeElement, harness5.tabs.rx);
  doc.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(harness5.tx.card.hidden, false);
  assert.equal(doc.activeElement, harness5.tabs.tx);
  doc.dispatch('keydown', { key: 'End', preventDefault() {} });
  assert.equal(harness5.rx.card.hidden, false);
  doc.dispatch('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(harness5.tx.card.hidden, false);
  doc.dispatch('keydown', { key: 'Tab', preventDefault() {} });
  assert.equal(harness5.tx.card.hidden, false);
});

test('R36 隐藏端状态按钮仍实时更新且两端并行轮询', async () => {
  const now = Date.now();
  let txFetch = 0;
  let rxFetch = 0;
  const fetchImpl = async (url, options) => {
    if (url.includes('/device/detail')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    }
    if (url.includes('device_name=rxd')) {
      rxFetch++;
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxGateOpenItems(now) } }) };
    }
    txFetch++;
    return { ok: true, status: 200, json: async () => ({ code: 0, data: fullTxItems(now) }) };
  };
  const harness = buildIndexDom();
  loadPage('js/index-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness.rx.card.hidden, true);
  assert.equal(harness.tabStatuses.tx.textContent, '实时');
  assert.equal(harness.tabStatuses.rx.textContent, '实时');
  assert.equal(harness.tabStatuses.rx.dataset.state, 'live');
  assert.ok(txFetch >= 1);
  assert.ok(rxFetch >= 1);
  const page = read('js/index-page.js');
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /wpt_home_endpoint_v1/);
});

test('R37 首页详情单列切换器样式契约', () => {
  const css = read('css/dashboard.css');
  assert.doesNotMatch(css, /gradient\(/);
  assert.match(css, /\.endpoint-switcher/);
  assert.match(css, /\.endpoint-switcher__tab/);
  assert.match(css, /\.endpoint-detail-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*1fr/);
  assert.match(css, /:focus-visible/);
});

test('R38 control-form 手机布局不换行且可收缩', () => {
  const css = read('css/dashboard.css');
  assert.match(css, /\.control-form label\s*\{/);
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
  assert.match(css, /\.control-form\s*\{/);
  assert.match(css, /min-width:\s*0/);
});

test('R39 SW web-5 资源清单同步', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
  for (const asset of ['js/ui-common.js', 'js/index-page.js', 'js/monitoring-page.js', 'js/settings-page.js', 'js/control-core.js', 'js/control-page.js']) {
    assert.match(worker, new RegExp(asset.replace(/[.]/g, '\\.')), asset);
  }
});

/* ========== R40-R46 云历史查询与历史页 ========== */

function loadHistoryCore() {
  const context = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {}
    },
    document: { createElement: () => ({ textContent: '', innerHTML: '' }) },
    fetch: async () => { throw new Error('no'); },
    AbortController, setTimeout, clearTimeout,
    Promise, Set, Object, Array, JSON, Math, Number, String, Date
  };
  vm.createContext(context);
  vm.runInContext(read('js/config.js') + '\n' + read('js/onenet.js') + '\n' + read('js/history-core.js') +
    '\n;globalThis.__web = { WptHistoryCore };', context);
  return { api: context.__web, context };
}

function buildHistoryDom(ChartClass, initialValues = {}) {
  const h = createDomHarness();
  const { makeEl } = h;
  h.windowStub.Chart = ChartClass;
  const els = {};
  const selectIds = ['historyModeSelect', 'historyTxMetricSelect', 'historyRxMetricSelect', 'historyRangeSelect'];
  const buttonIds = ['historyRefreshBtn', 'historyExportBtn'];
  const divIds = ['historyStatus', 'historyChartWrap', 'historyEmpty', 'historyMetricSelectors', 'historyTxSelector', 'historyRxSelector'];
  [...selectIds, ...buttonIds, ...divIds].forEach((id) => {
    els[id] = makeEl(selectIds.includes(id) ? 'select' : (buttonIds.includes(id) ? 'button' : 'div'), id);
  });
  els.historyModeSelect.value = initialValues.historyModeSelect || 'tx';
  els.historyTxMetricSelect.value = initialValues.historyTxMetricSelect || 'voltage';
  els.historyRxMetricSelect.value = initialValues.historyRxMetricSelect || 'rx_current_ua';
  els.historyRangeSelect.value = initialValues.historyRangeSelect || '1';
  els.historyTableHead = makeEl('thead', 'historyTableHead');
  els.historyTableBody = makeEl('tbody', 'historyTableBody');
  els.historyChart = makeEl('canvas', 'historyChart');
  return { ...h, els };
}

function loadHistoryPage(harness, initialStorage, fetchImpl) {
  return loadPage('js/history-page.js', harness, initialStorage, fetchImpl, ['js/history-core.js']);
}

test('R40 云历史请求参数/响应兼容/严格校验', async () => {
  const now = Date.now();
  const calls = [];
  const { api, storage } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { list: [
          { value: 100000, time: now - 3000 },
          { value: 99900, time: now - 2000 },
          { value: 100000, time: now - 3000 }
        ] } })
      };
    }
  );
  const points = await api.OneNetService.getPropertyHistory('tx', 'freq', now - 3600000, now, 100);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /thingmodel\/query-device-property-history/);
  assert.match(calls[0].url, /product_id=p/);
  assert.match(calls[0].url, /device_name=d/);
  assert.match(calls[0].url, /identifier=F/);
  assert.match(calls[0].url, /start_time=/);
  assert.match(calls[0].url, /end_time=/);
  assert.match(calls[0].url, /sort=1/);
  assert.match(calls[0].url, /offset=0/);
  assert.match(calls[0].url, /limit=100/);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, VALID_TOKEN);
  const freqPoints = points.filter((p) => p.metricId === 'freq');
  assert.equal(freqPoints.length, 2);
  assert.equal(freqPoints[0].timestamp, now - 3000);
  assert.equal(freqPoints[0].value, 100);
  assert.equal(freqPoints[1].timestamp, now - 2000);
  assert.equal(freqPoints[1].value, 99.9);
  assert.ok(points[0].timestamp <= points[points.length - 1].timestamp);
  for (const p of points) {
    assert.equal(p.deviceKey, 'tx');
    assert.equal(p.timeSource, 'onenet');
    assert.equal(p.cloudKey, 'F');
    assert.ok(Number.isFinite(p.value));
  }
  const keys = [...storage.keys()];
  assert.ok(!keys.some((k) => k.indexOf('iot_history_data') === 0), JSON.stringify(keys));
  assert.ok(!keys.some((k) => k.indexOf('iot_latest_data') === 0), JSON.stringify(keys));
});

test('R40 data 数组兼容、负值保留与非法输入 fetch 前拒绝', async () => {
  const now = Date.now();
  let callsA = 0;
  const { api } = loadWebModules(
    { iot_onenet_devices_v1: DUAL_CONFIG },
    async () => {
      callsA++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: [
          { value: -1.234, time: now - 1000 },
          { value: '99999999', time: now - 2000 },
          { value: 2.5, time: now - 3000 }
        ] })
      };
    }
  );
  const points = await api.OneNetService.getPropertyHistory('rx', 'rx_imon', now - 3600000, now, 100);
  assert.equal(callsA, 1);
  assert.ok(points.some((p) => p.value === -1.234));
  assert.ok(points.every((p) => Math.abs(p.value) <= 3.3));

  let callsB = 0;
  const { api: api2 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    async () => { callsB++; throw new Error('no'); }
  );
  const rejects = [
    () => api2.OneNetService.getPropertyHistory('bad', 'voltage', now - 1000, now, 100),
    () => api2.OneNetService.getPropertyHistory('tx', 'nope', now - 1000, now, 100),
    () => api2.OneNetService.getPropertyHistory('tx', 'voltage', 'x', now, 100),
    () => api2.OneNetService.getPropertyHistory('tx', 'voltage', now, now, 100),
    () => api2.OneNetService.getPropertyHistory('tx', 'voltage', now - 1000, now + 99999999999999, 100),
    () => api2.OneNetService.getPropertyHistory('tx', 'voltage', now - 1000, now, 0),
    () => api2.OneNetService.getPropertyHistory('tx', 'voltage', now - 1000, now, 101),
    () => api2.OneNetService.getPropertyHistory('tx', 'voltage', now - 1000, now, 1.5),
    () => api2.OneNetService.getPropertyHistory('rx', 'rx_limit', now - 1000, now, 100),
    () => api2.OneNetService.getPropertyHistory('rx', 'rx_fault_reason', now - 1000, now, 100)
  ];
  for (const fn of rejects) {
    await assert.rejects(fn());
  }
  assert.equal(callsB, 0);

  const { api: api3 } = loadWebModules({}, async () => { callsB++; throw new Error('no'); });
  await assert.rejects(api3.OneNetService.getPropertyHistory('tx', 'voltage', now - 1000, now, 100), /未配置/);
  assert.equal(callsB, 0);

  let abortCalls = 0;
  const { api: api4 } = loadWebModules(
    { iot_onenet_config: JSON.stringify(LEGACY_CFG) },
    async () => {
      abortCalls++;
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
  );
  await assert.rejects(api4.OneNetService.getPropertyHistory('tx', 'voltage', now - 1000, now, 100), /请求超时/);
  assert.equal(abortCalls, 1);
});

test('R41 源时间配对保留未配对且输入不变', () => {
  const { api } = loadHistoryCore();
  const tx = [{ timestamp: 1000, value: 1 }, { timestamp: 9000, value: 9 }];
  const rx = [{ timestamp: 1500, value: 1.5 }, { timestamp: 20000, value: 20 }];
  const originalTx = JSON.stringify(tx);
  const originalRx = JSON.stringify(rx);
  const rows = api.WptHistoryCore.buildCompareRows(tx, rx, 5000);
  assert.equal(rows.length, 3);
  const paired = rows.find((r) => r.pairState === 'paired');
  assert.ok(paired);
  assert.equal(paired.tx.timestamp, 1000);
  assert.equal(paired.rx.timestamp, 1500);
  assert.equal(paired.deltaMs, 500);
  const unpaired = rows.filter((r) => r.pairState === 'unpaired');
  assert.equal(unpaired.length, 2);
  assert.ok(unpaired.some((r) => r.tx && r.tx.timestamp === 9000 && r.rx === null));
  assert.ok(unpaired.some((r) => r.rx && r.rx.timestamp === 20000 && r.tx === null));
  assert.equal(JSON.stringify(tx), originalTx);
  assert.equal(JSON.stringify(rx), originalRx);
});

test('R44 CSV 防公式注入、保留负数、BOM 且不访问 localStorage', () => {
  const { api, context } = loadHistoryCore();
  const C = api.WptHistoryCore;
  const rows = [
    { timestamp: 1000, deviceKey: 'tx', metricId: 'voltage', value: -1.25 },
    { timestamp: 2000, deviceKey: 'tx', metricId: 'current', value: '=cmd' },
    { timestamp: 3000, deviceKey: 'tx', metricId: 'freq', value: '+cmd' },
    { timestamp: 4000, deviceKey: 'tx', metricId: 'state', value: '-cmd' },
    { timestamp: 5000, deviceKey: 'tx', metricId: 'voltage', value: '@cmd' },
    { timestamp: 6000, deviceKey: 'tx', metricId: 'voltage', value: 'say "hi"' }
  ];
  const csv = C.buildCsv({ mode: 'tx', metricLabel: '电压', rows });
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.match(csv, /-1\.25/);
  assert.match(csv, /'=cmd/);
  assert.match(csv, /'\+cmd/);
  assert.match(csv, /'-cmd/);
  assert.match(csv, /'@cmd/);
  assert.match(csv, /say ""hi""/);
  assert.equal(context.localStorage.getItem('iot_history_data'), null);

  const compareCsv = C.buildCsv({ mode: 'compare', rows: [
    { timestamp: 1000, tx: { timestamp: 1000, value: 1 }, rx: { timestamp: 1500, value: 1.5 }, pairState: 'paired', deltaMs: 500 },
    { timestamp: 9000, tx: { timestamp: 9000, value: 9 }, rx: null, pairState: 'unpaired', deltaMs: null }
  ] });
  assert.match(compareCsv, /已配对/);
  assert.match(compareCsv, /未配对/);
  assert.equal(compareCsv.charCodeAt(0), 0xFEFF);
});

test('R42 历史页双端云查询结构契约', () => {
  const html = read('history.html');
  const page = read('js/history-page.js');
  for (const id of ['historyModeSelect', 'historyTxMetricSelect', 'historyRxMetricSelect', 'historyRangeSelect', 'historyRefreshBtn', 'historyExportBtn', 'historyStatus', 'historyChartWrap', 'historyChart', 'historyEmpty', 'historyTableHead', 'historyTableBody', 'historyMetricSelectors', 'historyTxSelector', 'historyRxSelector']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  assert.match(html, /data-page=["']history["']/);
  const order = [html.indexOf('js/auth-guard.js'), html.indexOf('js/config.js'), html.indexOf('js/onenet.js'), html.indexOf('js/ui-common.js'), html.indexOf('js/history-core.js'), html.indexOf('js/history-page.js')];
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4] && order[4] < order[5]);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  assert.doesNotMatch(html, /onclick=/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /iot_history_data/);
  assert.doesNotMatch(page, /iot_history_data/);
  assert.doesNotMatch(page, /innerHTML/);
  assert.match(page, /getPropertyHistory/);
  assert.match(page, /createLifecyclePoller/);
});

test('R42 历史页云查询模式与独立降级', async () => {
  const now = Date.now();
  const requests = [];
  let failRx = false;
  let failTx = false;
  const fetchImpl = async (url, options) => {
    if (url.includes('query-device-property-history')) {
      requests.push(url);
      const identifier = decodeURIComponent(/identifier=([^&]+)/.exec(url)[1]);
      if (identifier === 'RX_Current_uA' && failRx) throw new Error('rx down');
      if (identifier === 'V' && failTx) throw new Error('tx down');
      if (identifier === 'V') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ value: 12.5, time: now - 2000 }] }) };
      }
      if (identifier === 'RX_Current_uA') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ value: 250, time: now - 1000 }] } }) };
      }
      throw new Error('unknown identifier');
    }
    throw new Error('unexpected url');
  };
  const harness = buildHistoryDom(undefined);
  loadHistoryPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /identifier=V/);
  assert.match(harness.els.historyStatus.textContent, /已加载/);
  assert.ok(harness.els.historyTableBody.children.length >= 1);
  assert.equal(harness.els.historyEmpty.textContent, '图表组件不可用');

  harness.els.historyModeSelect.value = 'rx';
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /identifier=RX_Current_uA/);

  harness.els.historyModeSelect.value = 'compare';
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  assert.equal(requests.length, 4);
  assert.match(harness.els.historyStatus.textContent, /已加载|暂无/);

  failRx = true;
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  assert.equal(requests.length, 6);
  assert.equal(harness.els.historyStatus.textContent, '部分成功');
  assert.ok(harness.els.historyTableBody.children.length >= 1);

  failTx = true;
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  assert.equal(harness.els.historyStatus.textContent, '查询失败');
  assert.equal(harness.els.historyTableBody.children.length, 0);
});

test('R43 图表源时间/双轴/负数/无 Chart 降级', async () => {
  const now = Date.now();
  const charts = [];
  function FakeChart(ctx, config) { charts.push(config); this.destroy = () => {}; }
  const fetchImpl = async (url, options) => {
    if (url.includes('query-device-property-history')) {
      const identifier = decodeURIComponent(/identifier=([^&]+)/.exec(url)[1]);
      if (identifier === 'V') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ value: 12.5, time: now - 2000 }] }) };
      }
      if (identifier === 'RX_Current_uA') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ value: -250, time: now - 1000 }] } }) };
      }
    }
    throw new Error('unexpected');
  };
  const harness = buildHistoryDom(FakeChart);
  loadHistoryPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.ok(charts.length >= 1);
  const single = charts[charts.length - 1];
  assert.equal(single.type, 'line');
  assert.equal(single.data.datasets[0].fill, false);
  assert.equal(single.data.datasets[0].parsing, false);
  assert.equal(single.data.datasets[0].spanGaps, false);
  assert.equal(single.options.scales.x.type, 'linear');
  assert.equal(single.options.scales.y.beginAtZero, false);
  assert.equal(single.data.datasets[0].data[0].x, now - 2000);

  harness.els.historyModeSelect.value = 'rx';
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  const rxChart = charts[charts.length - 1];
  assert.equal(rxChart.data.datasets[0].data[0].y, -250);

  harness.els.historyModeSelect.value = 'compare';
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  const compare = charts[charts.length - 1];
  assert.equal(compare.data.datasets.length, 2);
  assert.equal(compare.data.datasets[0].yAxisID, 'yTx');
  assert.equal(compare.data.datasets[1].yAxisID, 'yRx');
  assert.equal(compare.options.scales.yTx.beginAtZero, false);
  assert.equal(compare.options.scales.yRx.beginAtZero, false);

  const harness2 = buildHistoryDom(undefined);
  loadHistoryPage(harness2, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness2.els.historyEmpty.textContent, '图表组件不可用');
  assert.ok(harness2.els.historyTableBody.children.length >= 1);
});

test('R45 SW 同源全 network-first 与历史资源（web-9）', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
  assert.match(worker, /js\/history-core\.js/);
  assert.match(worker, /js\/history-page\.js/);
  assert.match(worker, /url\.origin === self\.location\.origin/);
  assert.match(worker, /Response\.error\(\)/);
  assert.match(worker, /CDN_HOSTS\.indexOf[\s\S]{0,80}cacheFirst/);
  assert.doesNotMatch(worker, /request\.mode === 'navigate' \? networkFirst/);
});

/* ========== R47-R51 历史模块定点修正 ========== */

test('R47 CSV 字段整体包裹、公式防护与指标标签', () => {
  const { api } = loadHistoryCore();
  const C = api.WptHistoryCore;
  const cell = C.toCsvCell;
  assert.equal(cell(-1.25), '-1.25');
  assert.equal(cell('1.'), '1.');
  assert.equal(cell('.5'), '.5');
  assert.equal(cell(1), '1');
  assert.equal(cell('a,b'), '"a,b"');
  assert.equal(cell('a\nb'), '"a\nb"');
  assert.equal(cell('a"b'), '"a""b"');
  assert.equal(cell('=cmd'), '"\'=cmd"');
  assert.equal(cell('-cmd'), "\"'-cmd\"");
  assert.equal(cell('@cmd'), '"\'@cmd"');
  assert.equal(cell('say "hi"'), '"say ""hi"""');
  assert.equal(cell(null), '');
  assert.equal(cell(undefined), '');

  const single = C.buildCsv({ mode: 'tx', metricLabel: '电压 (V)', rows: [{ timestamp: 1000, deviceKey: 'tx', metricId: 'voltage', value: 1 }] });
  assert.match(single, /电压 \(V\)/);
  const compare = C.buildCsv({ mode: 'compare', txMetricLabel: '电压 (V)', rxMetricLabel: '刺激电流 (uA)', rows: [
    { timestamp: 1000, tx: { timestamp: 1000, value: 1 }, rx: { timestamp: 1500, value: 1.5 }, pairState: 'paired', deltaMs: 500 }
  ] });
  assert.match(compare, /TX 数值 \(电压 \(V\)\)/);
  assert.match(compare, /RX 数值 \(刺激电流 \(uA\)\)/);
});

test('R48 查询竞态：pending 时切换模式后自动补发最新请求且旧结果不渲染', async () => {
  const now = Date.now();
  const requests = [];
  const gates = { V: null, RX: Promise.resolve() };
  const resolvers = {};
  const fetchImpl = async (url) => {
    if (url.includes('query-device-property-history')) {
      requests.push(url);
      const identifier = decodeURIComponent(/identifier=([^&]+)/.exec(url)[1]);
      const key = identifier === 'V' ? 'V' : 'RX';
      if (gates[key] === null) {
        gates[key] = new Promise((resolve) => { resolvers[key] = resolve; });
      }
      await gates[key];
      if (identifier === 'V') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ value: 12.5, time: now - 2000 }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ value: 250, time: now - 1000 }] } }) };
    }
    throw new Error('unexpected');
  };
  const harness = buildHistoryDom(undefined);
  loadHistoryPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /identifier=V/);
  assert.equal(harness.els.historyTableBody.children.length, 0);

  /* pending 时切换到 rx：排队一次 */
  harness.els.historyModeSelect.value = 'rx';
  harness.els.historyModeSelect.dispatch('change');
  await flushAsync();
  assert.equal(requests.length, 1);

  /* pending 时点击刷新：再排队（与模式切换合并为一次补发） */
  harness.els.historyRefreshBtn.dispatch('click');
  await flushAsync();

  resolvers.V();
  await flushAsync();
  await flushAsync();
  assert.equal(requests.length, 2);
  assert.match(requests[1], /identifier=RX_Current_uA/);
  assert.match(harness.els.historyStatus.textContent, /已加载 1 条云历史/);
  assert.equal(harness.els.historyTableBody.children.length, 1);
  const row = harness.els.historyTableBody.children[0];
  assert.ok(row.children.some((c) => c.textContent === '接收端 RX'));
  assert.ok(row.children.some((c) => c.textContent === '250'));
  assert.ok(![...row.children].some((c) => c.textContent === '12.5'));
});

test('R49 历史页无内联样式、空态 hidden 与 SW 最终回退', () => {
  const html = read('history.html');
  assert.doesNotMatch(html, /style\s*=/i);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /onclick=/i);
  const page = read('js/history-page.js');
  assert.doesNotMatch(page, /style\.display/);
  assert.match(page, /\.hidden\s*=/);
  const worker = read('service-worker.js');
  assert.match(worker, /同源资源网络优先，CDN资源缓存优先/);
  assert.match(worker, /login \|\| Response\.error\(\)/);
});

test('R50 TX 指标固定四项且历史响应按 limit 截断', async () => {
  const now = Date.now();
  const harness = buildHistoryDom(undefined);
  loadHistoryPage(harness, {
    iot_onenet_devices_v1: DUAL_CONFIG,
    iot_data_model: JSON.stringify({
      sensors: [{ id: 'extra_numeric', name: '附加数值', cloudKey: 'EX', dataType: 'float', min: 0, max: 100, step: 1 }],
      controls: []
    })
  }, async (url) => {
    if (url.includes('query-device-property-history')) {
      const lim = Number(/limit=(\d+)/.exec(url)[1]);
      const items = [];
      for (let i = 0; i < lim + 50; i++) {
        items.push({ value: 1, time: now - i * 1000 });
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: items }) };
    }
    throw new Error('unexpected');
  });
  await flushAsync();
  const options = harness.els.historyTxMetricSelect.children.map((option) => option.value);
  assert.deepEqual(options, ['voltage', 'current', 'freq', 'state']);
  const rows = harness.els.historyTableBody.children;
  assert.ok(rows.length <= 100);
  assert.equal(rows.length, 100);
});

test('R51 buildSingleRows 只保留有限数值', () => {
  const { api } = loadHistoryCore();
  const rows = api.WptHistoryCore.buildSingleRows([
    { timestamp: 1, value: 2 },
    { timestamp: 2, value: NaN },
    { timestamp: 3, value: Infinity },
    { timestamp: 4, value: null },
    { timestamp: 5, value: '1' },
    { timestamp: 6, value: -1.25 }
  ], 'tx');
  assert.equal(rows.length, 2);
  assert.equal(JSON.stringify(rows.map((r) => r.timestamp)), JSON.stringify([1, 6]));
  assert.equal(rows[1].value, -1.25);
});

/* ========== R52 历史页定点修正 ========== */

test('R52a RX 指标默认 rx_current_ua 且合法已有选择保持', async () => {
  const now = Date.now();
  const fetchImpl = async (url) => {
    if (url.includes('query-device-property-history')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ value: 250, time: now - 1000 }] }) };
    }
    throw new Error('unexpected');
  };
  const harness = buildHistoryDom(undefined);
  loadHistoryPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness.els.historyRxMetricSelect.value, 'rx_current_ua');

  const harness2 = buildHistoryDom(undefined, { historyRxMetricSelect: 'rx_bonep' });
  loadHistoryPage(harness2, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness2.els.historyRxMetricSelect.value, 'rx_bonep');
});

test('R52b 图表 x 轴时间刻度与 tooltip 源时间', async () => {
  const now = Date.now();
  const charts = [];
  function FakeChart(ctx, config) { charts.push(config); this.destroy = () => {}; }
  const fetchImpl = async (url) => {
    if (url.includes('query-device-property-history')) {
      const identifier = decodeURIComponent(/identifier=([^&]+)/.exec(url)[1]);
      if (identifier === 'V') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ value: 12.5, time: now - 2000 }] }) };
      }
      if (identifier === 'RX_Current_uA') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ value: 250, time: now - 1000 }] } }) };
      }
    }
    throw new Error('unexpected');
  };
  const harness = buildHistoryDom(FakeChart);
  loadHistoryPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  const cfg = charts[charts.length - 1];
  const ticks = cfg.options.scales.x.ticks;
  assert.equal(ticks.maxTicksLimit, 6);
  assert.equal(ticks.maxRotation, 0);
  assert.equal(ticks.minRotation, 0);
  const time = now - 2000;
  const pad = (n) => String(n).padStart(2, '0');
  const shortD = new Date(time);
  const expectedShort = `${pad(shortD.getMonth() + 1)}-${pad(shortD.getDate())} ${pad(shortD.getHours())}:${pad(shortD.getMinutes())}`;
  assert.equal(ticks.callback(time), expectedShort);
  assert.equal(ticks.callback('bad'), '--');
  const fullD = new Date(time);
  const expectedFull = `${fullD.getFullYear()}-${pad(fullD.getMonth() + 1)}-${pad(fullD.getDate())} ${pad(fullD.getHours())}:${pad(fullD.getMinutes())}:${pad(fullD.getSeconds())}`;
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ parsed: { x: time } }]), expectedFull);
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([]), '');
  assert.equal(cfg.options.plugins.tooltip.callbacks.title([{ parsed: { x: 'bad' } }]), '');
});

test('R52c 历史页手机头部与空态样式契约', () => {
  const html = read('history.html');
  assert.match(html, /class=["'][^"']*history-header/);
  assert.match(html, /class=["'][^"']*history-title/);
  assert.match(html, /class=["'][^"']*history-header-actions/);
  assert.match(html, /class=["'][^"']*history-user-badge/);
  assert.match(html, /id=["']historyEmpty["'][^>]*hidden/);
  const css = read('css/dashboard.css');
  assert.match(css, /\.history-title\s*\{\s*white-space:\s*nowrap/);
  assert.match(css, /\.history-empty\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
  assert.match(css, /\.history-user-badge\s*\{\s*display:\s*none/);
});

test('R52d CSV 表头经 toCsvCell 公式/逗号/换行安全', () => {
  const { api } = loadHistoryCore();
  const C = api.WptHistoryCore;
  const csv = C.buildCsv({
    mode: 'compare',
    txMetricLabel: '=A,1',
    rxMetricLabel: 'a\nb',
    rows: [{ timestamp: 1000, tx: { timestamp: 1000, value: 1 }, rx: { timestamp: 1500, value: 1.5 }, pairState: 'paired', deltaMs: 500 }]
  });
  const headerLine = csv.split('\r\n')[0];
  /* 整个表头单元格只编码一次：含整体引号，且不出现编码器自身形成的双层可见引号。 */
  assert.ok(headerLine.indexOf('"TX 数值 (=A,1)"') !== -1, headerLine);
  assert.ok(headerLine.indexOf('"RX 数值 (a\nb)"') !== -1, headerLine);
  assert.ok(headerLine.indexOf("'=A,1") === -1, headerLine);
  /* 含双引号的标签：整单元格按 CSV 双写，解析后标签为 a"b。 */
  const quoteCsv = C.buildCsv({
    mode: 'compare',
    txMetricLabel: 'a"b',
    rxMetricLabel: 'c',
    rows: [{ timestamp: 1000, tx: { timestamp: 1000, value: 1 }, rx: { timestamp: 1500, value: 1.5 }, pairState: 'paired', deltaMs: 500 }]
  });
  assert.ok(quoteCsv.split('\r\n')[0].indexOf('"TX 数值 (a""b)"') !== -1);
  /* 合法纯数值数据仍裸输出 */
  assert.ok(csv.indexOf(',1.5,') !== -1);
  assert.ok(csv.indexOf(',500') !== -1);
});

test('R52e history-page 无重复死代码', () => {
  const page = read('js/history-page.js');
  assert.equal((page.match(/function queryWindow/g) || []).length, 1);
  assert.doesNotMatch(page, /function sensorLabel/);
  assert.doesNotMatch(page, /function txMetricLabel/);
  assert.doesNotMatch(page, /function rxMetricLabel/);
  assert.doesNotMatch(page, /var currentMode/);
});

test('R52f/R64 SW 缓存版本 web-9', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
});

/* ========== R54-R57 告警引擎与告警中心 ========== */

const ALERT_RULES = [
  { deviceKey: 'tx', ruleId: 'tx_fault', cloudKey: 'S', valueKey: 'state', active: 3, safe: 0 },
  { deviceKey: 'tx', ruleId: 'tx_overcurrent', cloudKey: 'I', valueKey: 'current', active: 5, safe: 4.9 },
  { deviceKey: 'rx', ruleId: 'rx_fault_flags', cloudKey: 'RX_FaultFlags', valueKey: 'rx_fault_flags', active: 1, safe: 0 },
  { deviceKey: 'rx', ruleId: 'rx_limit', cloudKey: 'RX_Limit', valueKey: 'rx_limit', active: true, safe: false },
  { deviceKey: 'rx', ruleId: 'rx_invalid', cloudKey: 'RX_Valid', valueKey: 'rx_valid', active: false, safe: true },
  { deviceKey: 'rx', ruleId: 'rx_ble_offline', cloudKey: 'RX_BleOnline', valueKey: 'rx_ble_online', active: false, safe: true },
  { deviceKey: 'rx', ruleId: 'rx_disconnected', cloudKey: 'RX_Connected', valueKey: 'rx_connected', active: false, safe: true },
  { deviceKey: 'rx', ruleId: 'rx_telemetry_stale', cloudKey: 'RX_TelemetryFresh', valueKey: 'rx_telemetry_fresh', active: false, safe: true }
];

function loadAlertEngine(initialStorage = {}, options = {}) {
  const storage = new Map(Object.entries(initialStorage));
  const context = {
    localStorage: options.localStorage || {
      getItem: (k) => storage.has(k) ? storage.get(k) : null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: { createElement: () => ({ textContent: '', innerHTML: '' }) },
    fetch: async () => { throw new Error('no'); },
    AbortController, setTimeout, clearTimeout,
    Promise, Set, Object, Array, JSON, Math, Number, String, Date
  };
  vm.createContext(context);
  vm.runInContext(read('js/config.js') + '\n' + read('js/onenet.js') + '\n' + read('js/ui-common.js') + '\n' + read('js/alert-engine.js') +
    '\n;globalThis.__web = { WptAlertEngine };', context);
  return { api: context.__web, context, storage };
}

function alertData(cloudKey, valueKey, value, now, opts = {}) {
  const d = { _isOnline: true, _isFresh: true, _propertyTimes: {} };
  d._propertyTimes[cloudKey] = opts.time !== undefined ? opts.time : now - 1000;
  d[valueKey] = value;
  if (opts.isOnline === false) d._isOnline = false;
  return d;
}

function alertSnapshots(deviceKey, data, error) {
  return deviceKey === 'tx'
    ? { tx: { data, error }, rx: { data: null, error: new Error('no rx') } }
    : { tx: { data: null, error: new Error('no tx') }, rx: { data, error } };
}

function ruleSeverity(ruleId) {
  return ruleId === 'rx_invalid' || ruleId === 'rx_ble_offline' || ruleId === 'rx_disconnected' || ruleId === 'rx_telemetry_stale' ? 'warning' : 'critical';
}

test('R54a 八条规则 fresh 触发、重复幂等且 stale/offline/error/非法类型均 no-op', () => {
  const now = 1750000000000;
  for (const rule of ALERT_RULES) {
    const { api } = loadAlertEngine();
    const E = api.WptAlertEngine;
    E.evaluateSnapshots(alertSnapshots(rule.deviceKey, alertData(rule.cloudKey, rule.valueKey, rule.active, now), null), now);
    let incs = E.getIncidents().filter((i) => i.ruleId === rule.ruleId);
    assert.equal(incs.length, 1, rule.ruleId);
    assert.equal(incs[0].active, true, rule.ruleId);
    assert.equal(incs[0].startedAt, now - 1000, rule.ruleId);
    assert.equal(incs[0].id, `${rule.deviceKey}:${rule.ruleId}:${now - 1000}`, rule.ruleId);
    assert.equal(incs[0].severity, ruleSeverity(rule.ruleId), rule.ruleId);
    E.evaluateSnapshots(alertSnapshots(rule.deviceKey, alertData(rule.cloudKey, rule.valueKey, rule.active, now), null), now);
    incs = E.getIncidents().filter((i) => i.ruleId === rule.ruleId);
    assert.equal(incs.length, 1, 'repeat ' + rule.ruleId);
  }
  for (const rule of ALERT_RULES) {
    const { api: a1 } = loadAlertEngine();
    a1.WptAlertEngine.evaluateSnapshots(alertSnapshots(rule.deviceKey, alertData(rule.cloudKey, rule.valueKey, rule.active, now, { time: now - 20000 }), null), now);
    assert.equal(a1.WptAlertEngine.getIncidents().filter((i) => i.ruleId === rule.ruleId).length, 0, 'stale ' + rule.ruleId);
    const { api: a2 } = loadAlertEngine();
    a2.WptAlertEngine.evaluateSnapshots(alertSnapshots(rule.deviceKey, alertData(rule.cloudKey, rule.valueKey, rule.active, now, { isOnline: false }), null), now);
    assert.equal(a2.WptAlertEngine.getIncidents().filter((i) => i.ruleId === rule.ruleId).length, 0, 'offline ' + rule.ruleId);
    const { api: a3 } = loadAlertEngine();
    a3.WptAlertEngine.evaluateSnapshots(alertSnapshots(rule.deviceKey, alertData(rule.cloudKey, rule.valueKey, rule.active, now), new Error('x')), now);
    assert.equal(a3.WptAlertEngine.getIncidents().filter((i) => i.ruleId === rule.ruleId).length, 0, 'error ' + rule.ruleId);
  }
  const { api } = loadAlertEngine();
  const E = api.WptAlertEngine;
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', '3', now), null), now);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('I', 'current', 'abc', now), null), now);
  E.evaluateSnapshots(alertSnapshots('rx', alertData('RX_Valid', 'rx_valid', 1, now), null), now);
  assert.equal(E.getIncidents().length, 0);
  /* RX_Safe=false 永不触发 */
  E.evaluateSnapshots(alertSnapshots('rx', alertData('RX_Safe', 'rx_safe', false, now), null), now);
  assert.equal(E.getIncidents().length, 0);
});

test('R54b 事件状态机：更新/恢复/确认/watermark 防重触发', () => {
  const now = 1750000000000;
  const { api } = loadAlertEngine();
  const E = api.WptAlertEngine;
  const t1 = now - 5000;
  const t2 = now - 4000;
  const t3 = now - 3000;
  const t4 = now - 2000;
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t1 }), null), now);
  let incs = E.getIncidents();
  assert.equal(incs.length, 1);
  assert.equal(incs[0].id, 'tx:tx_fault:' + t1);
  assert.equal(incs[0].startedAt, t1);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t2 }), null), now);
  incs = E.getIncidents();
  assert.equal(incs.length, 1);
  assert.equal(incs[0].lastSeenAt, t2);
  assert.equal(incs[0].sourceTime, t2);
  const ack = E.acknowledge('tx:tx_fault:' + t1, now);
  assert.equal(ack.changed, true);
  assert.equal(E.getIncidents()[0].acknowledged, true);
  assert.equal(E.getIncidents()[0].active, true);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 0, now, { time: t3 }), null), now);
  incs = E.getIncidents();
  assert.equal(incs[0].active, false);
  assert.equal(incs[0].resolvedAt, t3);
  assert.equal(incs[0].acknowledged, true);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t3 }), null), now);
  assert.equal(E.getIncidents().filter((i) => i.active).length, 0);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t2 }), null), now);
  assert.equal(E.getIncidents().filter((i) => i.active).length, 0);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t4 }), null), now);
  const active = E.getIncidents().filter((i) => i.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'tx:tx_fault:' + t4);
  const cr = E.clearResolved();
  assert.equal(cr.changed, true);
  incs = E.getIncidents();
  assert.equal(incs.length, 1);
  assert.equal(incs[0].active, true);
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t2 }), null), now);
  assert.equal(E.getIncidents().filter((i) => i.active).length, 1);
});

test('R54c 损坏恢复、active 归一、上限与写失败', () => {
  const now = 1750000000000;
  const { api: a0 } = loadAlertEngine({ iot_alerts_v2: 'not-json{{', iot_alarm_states_v2: 'garbage' });
  assert.equal(a0.WptAlertEngine.getIncidents().length, 0);
  a0.WptAlertEngine.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  assert.equal(a0.WptAlertEngine.getIncidents().length, 1);

  const { api, storage } = loadAlertEngine();
  const E = api.WptAlertEngine;
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  let states = JSON.parse(storage.get('iot_alarm_states_v2'));
  assert.equal(states['tx:tx_fault'].activeIncidentId, 'tx:tx_fault:' + (now - 1000));
  /* 真正 dangling：同时移除 incident，仅保留指向缺失项的 state */
  storage.set('iot_alerts_v2', JSON.stringify([]));
  storage.set('iot_alarm_states_v2', JSON.stringify({ 'tx:tx_fault': { version: 1, lastSourceTime: now - 1000, activeIncidentId: 'ghost' } }));
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  states = JSON.parse(storage.get('iot_alarm_states_v2'));
  assert.equal(states['tx:tx_fault'].activeIncidentId, null);
  assert.equal(states['tx:tx_fault'].lastSourceTime, now - 1000);

  const { api: a2, storage: s2 } = loadAlertEngine();
  const t1 = now - 5000;
  const t2 = now - 3000;
  const mk = (id, ts) => ({ version: 1, id, deviceKey: 'tx', ruleId: 'tx_fault', title: '发射端故障', severity: 'critical', active: true, acknowledged: false, startedAt: ts, lastSeenAt: ts, resolvedAt: null, acknowledgedAt: null, sourceTime: ts, value: 3, threshold: 3, unit: '', message: '' });
  s2.set('iot_alerts_v2', JSON.stringify([mk('tx:tx_fault:' + t1, t1), mk('tx:tx_fault:' + t2, t2)]));
  a2.WptAlertEngine.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t2 }), null), now);
  const incs2 = a2.WptAlertEngine.getIncidents().filter((i) => i.ruleId === 'tx_fault');
  assert.equal(incs2.filter((i) => i.active).length, 1);
  assert.equal(incs2.filter((i) => i.active)[0].id, 'tx:tx_fault:' + t2);

  const { api: a3, storage: s3 } = loadAlertEngine();
  const many = [];
  for (let i = 0; i < 220; i++) {
    const ts = now - i * 1000;
    many.push({ version: 1, id: 'rx:rx_limit:' + ts, deviceKey: 'rx', ruleId: 'rx_limit', title: '接收端限流', severity: 'critical', active: i === 0, acknowledged: false, startedAt: ts, lastSeenAt: ts, resolvedAt: null, acknowledgedAt: null, sourceTime: ts, value: true, threshold: true, unit: '', message: '' });
  }
  s3.set('iot_alerts_v2', JSON.stringify(many));
  a3.WptAlertEngine.evaluateSnapshots(alertSnapshots('rx', alertData('RX_Limit', 'rx_limit', false, now, { time: now - 1000 }), null), now);
  const incs3 = a3.WptAlertEngine.getIncidents();
  assert.equal(incs3.length, 200);
  assert.equal(incs3.filter((i) => i.active).length, 1);

  const { api: a4 } = loadAlertEngine({}, {
    localStorage: { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} }
  });
  const r4 = a4.WptAlertEngine.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  assert.equal(r4.persisted, false);
  assert.equal(r4.incidents.length, 1);
});

test('R54d 公共 API 形状、确认/全确认/清已恢复、now 回退', () => {
  const now = 1750000000000;
  const { api } = loadAlertEngine();
  const E = api.WptAlertEngine;
  const r = E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  assert.deepEqual(Object.keys(r).sort(), ['incidents', 'persisted', 'states', 'summary']);
  assert.equal(r.persisted, true);
  assert.equal(r.summary.total, 1);
  assert.equal(r.summary.active, 1);
  assert.equal(r.summary.unacknowledged, 1);
  assert.equal(r.summary.criticalActive, 1);
  assert.equal(r.summary.resolved, 0);
  const id = 'tx:tx_fault:' + (now - 1000);
  const ack = E.acknowledge(id, now);
  assert.equal(ack.changed, true);
  assert.equal(ack.persisted, true);
  const inc = E.getIncidents()[0];
  assert.equal(inc.acknowledged, true);
  assert.equal(inc.acknowledgedAt, now);
  assert.equal(inc.active, true);
  assert.equal(E.acknowledge(id, now).changed, false);
  E.evaluateSnapshots(alertSnapshots('rx', alertData('RX_Valid', 'rx_valid', false, now, { time: now - 1000 }), null), now);
  assert.equal(E.acknowledgeAll(now).changed, true);
  assert.ok(E.getIncidents().every((i) => i.acknowledged));
  E.evaluateSnapshots(alertSnapshots('rx', alertData('RX_Valid', 'rx_valid', true, now, { time: now - 100 }), null), now);
  assert.equal(E.clearResolved().changed, true);
  assert.ok(E.getIncidents().every((i) => i.active));
  assert.equal(E.clearResolved().changed, false);
  E.evaluateSnapshots(alertSnapshots('rx', alertData('RX_BleOnline', 'rx_ble_online', false, now, { time: now - 1000 }), null), now);
  const freshId = E.getIncidents().find((i) => i.ruleId === 'rx_ble_offline').id;
  const badAck = E.acknowledge(freshId, 'bad');
  assert.equal(badAck.changed, true);
  const ackAt = E.getIncidents().find((i) => i.id === freshId).acknowledgedAt;
  assert.ok(Number.isFinite(ackAt) && ackAt >= 946684800000 && ackAt <= 4102444800000);
});

test('R58 等值 sourceTime 幂等：equal safe 不恢复、equal active 不重复', () => {
  const now = 1750000000000;
  const { api } = loadAlertEngine();
  const E = api.WptAlertEngine;
  const t1 = now - 3000;
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t1 }), null), now);
  let inc = E.getIncidents()[0];
  assert.equal(inc.active, true);
  assert.equal(inc.resolvedAt, null);
  /* equal-time safe：不得恢复 */
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 0, now, { time: t1 }), null), now);
  inc = E.getIncidents()[0];
  assert.equal(inc.active, true);
  assert.equal(inc.resolvedAt, null);
  /* equal-time active：只维护，不新建 */
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: t1 }), null), now);
  assert.equal(E.getIncidents().length, 1);
  assert.equal(E.getIncidents()[0].active, true);
  assert.equal(E.getIncidents()[0].id, 'tx:tx_fault:' + t1);
  /* 更大时间 safe 才恢复 */
  E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 0, now, { time: now - 1000 }), null), now);
  inc = E.getIncidents()[0];
  assert.equal(inc.active, false);
  assert.equal(inc.resolvedAt, now - 1000);
});

test('R59 新鲜度缺失/抛错/非 true 均 fail-closed', () => {
  const now = 1750000000000;
  const data = alertData('S', 'state', 3, now);
  const snapshots = alertSnapshots('tx', data, null);
  const ctx = {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {},
    fetch: async () => { throw new Error('no'); },
    AbortController, setTimeout, clearTimeout,
    Promise, Set, Object, Array, JSON, Math, Number, String, Date
  };
  vm.createContext(ctx);
  vm.runInContext(read('js/config.js') + '\n' + read('js/onenet.js') + '\n' + read('js/alert-engine.js') +
    '\n;globalThis.__web={WptAlertEngine};', ctx);
  assert.equal(ctx.__web.WptAlertEngine.evaluateSnapshots(snapshots, now).incidents.length, 0);

  const { api: a2, context: c2 } = loadAlertEngine();
  c2.WptUi = { isPropertyCurrent: () => false };
  assert.equal(a2.WptAlertEngine.evaluateSnapshots(snapshots, now).incidents.length, 0);

  const { api: a3, context: c3 } = loadAlertEngine();
  c3.WptUi = { isPropertyCurrent: () => { throw new Error('boom'); } };
  assert.equal(a3.WptAlertEngine.evaluateSnapshots(snapshots, now).incidents.length, 0);
});

test('R60 严格清洗：规则元数据不可篡改、未知 state key/非法时间被拒绝', () => {
  const now = 1750000000000;
  const t = now - 1000;
  const { api, storage } = loadAlertEngine();
  const E = api.WptAlertEngine;
  storage.set('iot_alerts_v2', JSON.stringify([
    { version: 1, id: 'tx:tx_fault:' + t, deviceKey: 'tx', ruleId: 'tx_fault', title: '看起来正常', severity: 'warning', active: true, acknowledged: false, startedAt: t, lastSeenAt: t, resolvedAt: null, acknowledgedAt: null, sourceTime: t, value: 3, threshold: 999, unit: 'X', message: 'hack' }
  ]));
  storage.set('iot_alarm_states_v2', JSON.stringify({
    'tx:tx_fault': { version: 1, lastSourceTime: t, activeIncidentId: 'tx:tx_fault:' + t },
    'mystery:key': { version: 1, lastSourceTime: 'abc', activeIncidentId: 'x' }
  }));
  const r = E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 0, now, { time: now - 1000 }), null), now);
  const inc = r.incidents[0];
  assert.equal(inc.title, '发射端故障');
  assert.equal(inc.severity, 'critical');
  assert.equal(inc.threshold, 3);
  assert.equal(inc.unit, '');
  assert.equal(inc.message, 'hack');
  assert.ok(!r.states['mystery:key']);
  assert.equal(r.states['tx:tx_fault'].lastSourceTime, t);

  /* 非确定性 id 丢弃 */
  storage.set('iot_alerts_v2', JSON.stringify([
    { version: 1, id: 'garbage', deviceKey: 'tx', ruleId: 'tx_fault', active: true, acknowledged: false, startedAt: t, lastSeenAt: t, resolvedAt: null, acknowledgedAt: null, sourceTime: t, value: 3 }
  ]));
  assert.equal(E.getIncidents().length, 0);
  /* 字符串/布尔时间被拒绝，state 时间归 null */
  storage.set('iot_alerts_v2', JSON.stringify([]));
  storage.set('iot_alarm_states_v2', JSON.stringify({ 'tx:tx_fault': { version: 1, lastSourceTime: 'abc', activeIncidentId: null } }));
  const r2 = E.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  assert.equal(r2.states['tx:tx_fault'].lastSourceTime, now - 1000);
});

test('R61 persistPair 两次写入都尝试且不抛', () => {
  const now = 1750000000000;
  const writes = [];
  const counting = {
    getItem: () => null,
    setItem: (k, v) => { writes.push(k); if (writes.length === 1) throw new Error('quota'); },
    removeItem: () => {}
  };
  const { api } = loadAlertEngine({}, { localStorage: counting });
  const r = api.WptAlertEngine.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes, ['iot_alerts_v2', 'iot_alarm_states_v2']);
  assert.equal(r.persisted, false);

  const writes2 = [];
  const failing2 = {
    getItem: () => null,
    setItem: (k, v) => { writes2.push(k); if (writes2.length === 2) throw new Error('quota'); },
    removeItem: () => {}
  };
  const { api: a2 } = loadAlertEngine({}, { localStorage: failing2 });
  const r2 = a2.WptAlertEngine.evaluateSnapshots(alertSnapshots('tx', alertData('S', 'state', 3, now, { time: now - 1000 }), null), now);
  assert.equal(writes2.length, 2);
  assert.equal(r2.persisted, false);

  /* acknowledge changed=true 时也走 persistPair：两次写入都尝试 */
  const writes3 = [];
  const seedIncident = JSON.stringify([{ version: 1, id: 'tx:tx_fault:' + (now - 1000), deviceKey: 'tx', ruleId: 'tx_fault', title: '发射端故障', severity: 'critical', active: true, acknowledged: false, startedAt: now - 1000, lastSeenAt: now - 1000, resolvedAt: null, acknowledgedAt: null, sourceTime: now - 1000, value: 3, threshold: 3, unit: '', message: '' }]);
  const seedState = JSON.stringify({ 'tx:tx_fault': { version: 1, lastSourceTime: now - 1000, activeIncidentId: 'tx:tx_fault:' + (now - 1000) } });
  const failing3 = {
    getItem: (k) => k === 'iot_alerts_v2' ? seedIncident : (k === 'iot_alarm_states_v2' ? seedState : null),
    setItem: (k, v) => { writes3.push(k); if (writes3.length === 1) throw new Error('quota'); },
    removeItem: () => {}
  };
  const { api: a3 } = loadAlertEngine({}, { localStorage: failing3 });
  const ack3 = a3.WptAlertEngine.acknowledge('tx:tx_fault:' + (now - 1000), now);
  assert.equal(ack3.changed, true);
  assert.equal(writes3.length, 2);
  assert.equal(ack3.persisted, false);
});

function buildAlertsDom() {
  const h = createDomHarness();
  const { makeEl } = h;
  const els = {};
  const ids = ['alertsSummary', 'alertsRefreshBtn', 'acknowledgeAllBtn', 'clearResolvedBtn', 'alertPollStatus', 'activeAlertCount', 'unackAlertCount', 'resolvedAlertCount', 'alertDeviceFilter', 'alertsList', 'alertsEmpty', 'alertClearDialog', 'alertClearTitle', 'alertClearMessage', 'alertClearCancel', 'alertClearConfirm'];
  ids.forEach((id) => {
    const isBtn = /Btn|Cancel|Confirm/.test(id);
    els[id] = makeEl(isBtn ? 'button' : (id === 'alertDeviceFilter' ? 'select' : 'div'), id);
  });
  els.alertDeviceFilter.value = 'all';
  const filters = {};
  for (const f of ['all', 'active', 'unacknowledged', 'resolved']) {
    const btn = makeEl('button');
    btn.setAttribute('data-alert-filter', f);
    btn.setAttribute('aria-pressed', f === 'all' ? 'true' : 'false');
    filters[f] = btn;
  }
  return { ...h, els, filters };
}

function loadAlertsPage(harness, initialStorage, fetchImpl) {
  return loadPage('js/alerts-page.js', harness, initialStorage, fetchImpl, ['js/alert-engine.js']);
}

test('R55a 告警中心结构契约', () => {
  const html = read('alerts.html');
  const page = read('js/alerts-page.js');
  for (const id of ['alertsSummary', 'alertsRefreshBtn', 'acknowledgeAllBtn', 'clearResolvedBtn', 'alertPollStatus', 'activeAlertCount', 'unackAlertCount', 'resolvedAlertCount', 'alertDeviceFilter', 'alertsList', 'alertsEmpty', 'alertClearDialog', 'alertClearTitle', 'alertClearMessage', 'alertClearCancel', 'alertClearConfirm']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), id);
  }
  for (const f of ['all', 'active', 'unacknowledged', 'resolved']) {
    assert.match(html, new RegExp(`data-alert-filter=["']${f}["']`), f);
  }
  assert.match(html, /id=["']alertClearDialog["'][^>]*role=["']alertdialog["'][^>]*aria-modal=["']true["'][^>]*aria-labelledby=["']alertClearTitle["'][^>]*hidden/);
  const order = [html.indexOf('js/auth-guard.js'), html.indexOf('js/config.js'), html.indexOf('js/onenet.js'), html.indexOf('js/ui-common.js'), html.indexOf('js/alert-engine.js'), html.indexOf('js/alerts-page.js')];
  assert.ok(order.every((i) => i >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2] && order[2] < order[3] && order[3] < order[4] && order[4] < order[5]);
  assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  assert.doesNotMatch(html, /<style|style\s*=|onclick=|window\.confirm/);
  assert.doesNotMatch(page, /innerHTML/);
  assert.match(page, /createLifecyclePoller/);
  assert.match(page, /Promise\.allSettled/);
  assert.match(page, /evaluateSnapshots/);
});

test('R55b 告警中心双端同步、筛选、确认与清理对话框', async () => {
  const now = Date.now();
  let txFault = true;
  let txDown = false;
  let txFetch = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/device/detail')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    if (url.includes('device_name=rxd')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxGateOpenItems(Date.now()) } }) };
    txFetch++;
    if (txDown) throw new Error('tx down');
    const items = fullTxItems(Date.now()).map((item) => item.identifier === 'S' ? { ...item, value: txFault ? 3 : 0 } : item);
    return { ok: true, status: 200, json: async () => ({ code: 0, data: items }) };
  };
  const harness = buildAlertsDom();
  const { storage } = loadAlertsPage(harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(txFetch, 1);
  assert.match(harness.els.alertsSummary.textContent, /活动 1/);
  assert.equal(harness.els.activeAlertCount.textContent, '1');
  assert.equal(harness.els.unackAlertCount.textContent, '1');
  assert.equal(harness.els.acknowledgeAllBtn.disabled, false);
  assert.equal(harness.els.clearResolvedBtn.disabled, true);
  assert.ok(harness.els.alertsList.children.length >= 1);
  const first = harness.els.alertsList.children[0];
  const deepTexts = (el) => {
    const out = [];
    const walk = (node) => { node.children.forEach((c) => { out.push(c.textContent); walk(c); }); };
    walk(el);
    return out;
  };
  assert.ok(deepTexts(first).some((t) => t.includes('发射端故障')));
  assert.ok(deepTexts(first).some((t) => t.includes('活动，未确认')));

  /* 部分失败：保持现有 active，不恢复 */
  txDown = true;
  harness.els.alertsRefreshBtn.dispatch('click');
  await flushAsync();
  assert.match(harness.els.alertPollStatus.textContent, /保持现有报警/);
  assert.equal(harness.els.activeAlertCount.textContent, '1');
  txDown = false;

  /* 单条确认 */
  const findDeep = (el, pred) => {
    for (const c of el.children) {
      if (pred(c)) return c;
      const found = findDeep(c, pred);
      if (found) return found;
    }
    return null;
  };
  const ackBtn = findDeep(first, (c) => c.getAttribute && c.getAttribute('data-ack-id'));
  assert.ok(ackBtn);
  ackBtn.dispatch('click');
  await flushAsync();
  assert.equal(harness.els.unackAlertCount.textContent, '0');
  assert.equal(harness.els.acknowledgeAllBtn.disabled, true);
  const textsAfterAck = deepTexts(harness.els.alertsList.children[0]);
  assert.ok(textsAfterAck.some((t) => t.includes('已确认，仍活动')));

  /* 筛选 */
  harness.filters.active.dispatch('click');
  await flushAsync();
  assert.equal(harness.filters.active.getAttribute('aria-pressed'), 'true');
  assert.ok(harness.els.alertsList.children.length >= 1);
  harness.filters.resolved.dispatch('click');
  await flushAsync();
  assert.equal(harness.els.alertsList.children.length, 0);
  assert.equal(harness.els.alertsEmpty.hidden, false);
  harness.filters.all.dispatch('click');
  await flushAsync();

  /* 恢复 */
  txFault = false;
  harness.els.alertsRefreshBtn.dispatch('click');
  await flushAsync();
  assert.equal(harness.els.resolvedAlertCount.textContent, '1');
  assert.equal(harness.els.clearResolvedBtn.disabled, false);

  /* 清理对话框：ESC 取消不执行 */
  harness.els.clearResolvedBtn.dispatch('click');
  assert.equal(harness.els.alertClearDialog.hidden, false);
  assert.equal(harness.documentStub.activeElement, harness.els.alertClearCancel);
  harness.documentStub.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(harness.els.alertClearDialog.hidden, true);
  assert.equal(harness.els.resolvedAlertCount.textContent, '1');
  /* 确认执行一次 */
  harness.els.clearResolvedBtn.dispatch('click');
  harness.els.alertClearConfirm.dispatch('click');
  await flushAsync();
  assert.equal(harness.els.alertClearDialog.hidden, true);
  assert.equal(harness.els.resolvedAlertCount.textContent, '0');
  assert.equal(harness.els.clearResolvedBtn.disabled, true);
});

test('R56 首页告警摘要：每轮一次评估、隐藏端参与、异常隔离', async () => {
  let txSourceNow = Date.now();
  let txFault = true;
  let txFetch = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/device/detail')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    if (url.includes('device_name=rxd')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxGateOpenItems(Date.now()) } }) };
    txFetch++;
    txSourceNow += 1000;
    const items = fullTxItems(txSourceNow).map((item) => item.identifier === 'S' ? { ...item, value: txFault ? 3 : 0 } : item);
    return { ok: true, status: 200, json: async () => ({ code: 0, data: items }) };
  };
  const harness = buildIndexDom();
  const { storage } = loadPage('js/index-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl, ['js/alert-engine.js']);
  await flushAsync();
  assert.equal(harness.homeAlertSummary.textContent, '1 项活动 · 1 项未确认');
  assert.equal(harness.homeAlertSummary.dataset.state, 'critical');
  assert.equal(txFetch, 1);
  harness.syncBtn.dispatch('click');
  await flushAsync();
  assert.equal(harness.homeAlertSummary.textContent, '1 项活动 · 1 项未确认');
  assert.equal(txFetch, 2);
  /* 隐藏端 RX 仍参与评估（rx safe 无事件，总数不变） */
  harness.tabs.rx.dispatch('click');
  harness.syncBtn.dispatch('click');
  await flushAsync();
  assert.equal(harness.homeAlertSummary.textContent, '1 项活动 · 1 项未确认');
  /* 恢复：summary clear */
  txFault = false;
  harness.syncBtn.dispatch('click');
  await flushAsync();
  assert.equal(harness.homeAlertSummary.textContent, '无活动报警');
  assert.equal(harness.homeAlertSummary.dataset.state, 'clear');

  /* 引擎缺失：异常隔离，不破坏遥测 */
  const harness2 = buildIndexDom();
  loadPage('js/index-page.js', harness2, { iot_onenet_config: JSON.stringify(LEGACY_CFG) }, fetchImpl);
  await flushAsync();
  assert.equal(harness2.homeAlertSummary.textContent, '报警状态不可用');
  assert.equal(harness2.homeAlertSummary.dataset.state, 'error');
  assert.equal(harness2.tx.card.hidden, false);
});

test('R56 监测页告警摘要与异常隔离', async () => {
  const now = Date.now();
  const fetchImpl = async (url) => {
    if (url.includes('/device/detail')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    if (url.includes('device_name=rxd')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: rxGateOpenItems(Date.now()) } }) };
    const items = fullTxItems(Date.now()).map((item) => item.identifier === 'S' ? { ...item, value: 3 } : item);
    return { ok: true, status: 200, json: async () => ({ code: 0, data: items }) };
  };
  const harness = buildMonitoringDom(undefined);
  loadPage('js/monitoring-page.js', harness, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl, ['js/alert-engine.js']);
  await flushAsync();
  assert.equal(harness.monitorAlertSummary.textContent, '1 项活动 · 1 项未确认');
  assert.equal(harness.monitorAlertSummary.dataset.state, 'critical');
  assert.equal(harness.txSummary.status.textContent, '实时');

  const harness2 = buildMonitoringDom(undefined);
  loadPage('js/monitoring-page.js', harness2, { iot_onenet_devices_v1: DUAL_CONFIG }, fetchImpl);
  await flushAsync();
  assert.equal(harness2.monitorAlertSummary.textContent, '报警状态不可用');
  assert.equal(harness2.monitorAlertSummary.dataset.state, 'error');
  assert.equal(harness2.rxSummary.status.textContent, '实时');
});

test('R57 告警样式与 SW web-9 资源', () => {
  const html = read('index.html');
  assert.match(html, /id=["']homeAlertSummary["'][^>]*href=["']\/alerts["']/);
  assert.match(html, /js\/alert-engine\.js/);
  const monitoring = read('monitoring.html');
  assert.match(monitoring, /id=["']monitorAlertSummary["'][^>]*href=["']\/alerts["']/);
  assert.match(monitoring, /js\/alert-engine\.js/);
  const css = read('css/dashboard.css');
  assert.doesNotMatch(css, /gradient\(/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.match(css, /\.alert-summary-link/);
  assert.match(css, /\.alerts-main/);
  assert.match(css, /\.alerts-overview/);
  assert.match(css, /\.alert-card/);
  assert.match(css, /@media\s*\(max-width:\s*520px\)/);
  assert.match(css, /:focus-visible/);
  const worker = read('service-worker.js');
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-9'/);
  assert.match(worker, /js\/alert-engine\.js/);
  assert.match(worker, /js\/alerts-page\.js/);
});

/* ========== R62-R63 本轮 RED 契约（R64 已在既有 SW 区域映射；生产代码未改，保持 RED） ========== */

test('R62 历史页未配置/比较配置不完整时不发云请求、给出明确提示', async () => {
  const txOnly = JSON.stringify({ version: 1, tx: JSON.parse(DUAL_CONFIG).tx, rx: {} });

  /* (a) 完全无配置、默认 tx：fetch 0 次、明确提示、表格 0 行、导出禁用 */
  let fetchesA = 0;
  const h1 = buildHistoryDom(undefined);
  loadHistoryPage(h1, {}, async () => { fetchesA++; throw new Error('不应发起云请求'); });
  await flushAsync();
  assert.equal(fetchesA, 0);
  assert.equal(h1.els.historyStatus.textContent, '该端点未配置，请前往设置');
  assert.equal(h1.els.historyTableBody.children.length, 0);
  assert.equal(h1.els.historyExportBtn.disabled, true);

  /* (b) 同一无配置 harness 切到 compare：fetch 仍 0 次、提示双端均未配置 */
  h1.els.historyModeSelect.value = 'compare';
  h1.els.historyModeSelect.dispatch('change');
  await flushAsync();
  assert.equal(fetchesA, 0);
  assert.equal(h1.els.historyStatus.textContent, '双端均未配置，请前往设置');

  /* (c) 仅 TX 完整配置且初始 compare：fetch 0 次、提示需先配置 TX 与 RX、表格 0 行、导出禁用 */
  let fetchesC = 0;
  const h2 = buildHistoryDom(undefined, { historyModeSelect: 'compare' });
  loadHistoryPage(h2, { iot_onenet_devices_v1: txOnly }, async () => { fetchesC++; throw new Error('不应发起云请求'); });
  await flushAsync();
  assert.equal(fetchesC, 0);
  assert.equal(h2.els.historyStatus.textContent, '双端比较需先配置 TX 与 RX');
  assert.equal(h2.els.historyTableBody.children.length, 0);
  assert.equal(h2.els.historyExportBtn.disabled, true);
});

test('R63 告警页无配置/仅部分配置时只请求已配置端点并给出明确提示', async () => {
  const txOnly = JSON.stringify({ version: 1, tx: JSON.parse(DUAL_CONFIG).tx, rx: {} });

  /* (a) 完全无配置：fetch 0 次、仅显示本机报警记录 */
  let fetchesA = 0;
  const h1 = buildAlertsDom();
  loadAlertsPage(h1, {}, async () => { fetchesA++; throw new Error('不应发起云请求'); });
  await flushAsync();
  assert.equal(fetchesA, 0);
  assert.equal(h1.els.alertPollStatus.textContent, '未配置云端连接，仅显示本机报警记录');

  /* (b) 仅 TX 完整配置、RX 为空：只出现 TX 请求、提示部分端点未配置 */
  const callsB = [];
  const h2 = buildAlertsDom();
  loadAlertsPage(h2, { iot_onenet_devices_v1: txOnly }, async (url) => {
    callsB.push(url);
    if (url.includes('/device/detail')) return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
    return { ok: true, status: 200, json: async () => ({ code: 0, data: fullTxItems(Date.now()) }) };
  });
  await flushAsync();
  assert.ok(callsB.length > 0);
  assert.ok(callsB.some((u) => u.includes('device_name=txd')));
  assert.ok(callsB.every((u) => !u.includes('device_name=rxd')));
  assert.equal(h2.els.alertPollStatus.textContent, '部分端点未配置，已同步可用端点');

  /* (c) 仅 TX 配置但 TX 请求抛错：不得出现 RX 请求、保持现有报警 */
  const callsC = [];
  const h3 = buildAlertsDom();
  loadAlertsPage(h3, { iot_onenet_devices_v1: txOnly }, async (url) => {
    callsC.push(url);
    throw new Error('tx down');
  });
  await flushAsync();
  assert.ok(callsC.length > 0);
  assert.ok(callsC.every((u) => !u.includes('device_name=rxd')));
  assert.equal(h3.els.alertPollStatus.textContent, '已配置端点数据不可用，保持现有报警');
});
