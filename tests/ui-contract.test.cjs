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

function loadWebModules(initialStorage = {}, fetchImpl) {
  const storage = new Map(Object.entries(initialStorage));
  const context = {
    localStorage: {
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key)
    },
    document: { createElement: () => ({ textContent: '', innerHTML: '' }) },
    fetch: fetchImpl,
    AbortController, setTimeout, clearTimeout, Promise, Set, Object, Array, JSON, Math, Number, String
  };
  vm.createContext(context);
  vm.runInContext(read('js/config.js') + '\n' + read('js/onenet.js') +
    '\n;globalThis.__web = { OneNetService, validateControlParams, normalizeCloudValue, getDataModel };', context);
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
  assert.match(html, /id=["']monitorStatusChip["']/);
  assert.match(html, /id=["']lastUpdateText["']/);
  assert.match(html, /id=["']sensorCardsContainer["'][^>]*monitor-grid/);
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
  assert.match(read('js/mobile-nav.js'), /V6\.0\.0/);
  assert.match(read('css/dashboard.css'), /V6\.0\.0/);
  assert.match(read('service-worker.js'), /WPT Monitor V6\.0\.0/);
  assert.match(read('service-worker.js'), /wpt-v6-0-0-web-1/);
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
  assert.match(worker, /CACHE\s*=\s*'wpt-v6-0-0-web-1'/);
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
    iot_onenet_config: JSON.stringify({ productId: 'p', deviceName: 'd', token: 't' }),
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
  const cached = JSON.parse(storage.get('iot_latest_data'));
  assert.equal(latest._isOnline, true);
  assert.equal(cached._isOnline, true);
  assert.equal(cached._isMock, undefined);
  assert.equal(cached._error, undefined);
});

test('网页云端部分属性响应不会把旧缓存字段写成新的实时历史', async () => {
  const initialStorage = {
    iot_onenet_config: JSON.stringify({ productId: 'p', deviceName: 'd', token: 't' }),
    iot_latest_data: JSON.stringify({ voltage: 48, _isOnline: true, hasOwnProperty: null }),
    iot_control_locks: JSON.stringify({})
  };
  const fetchImpl = async (url) => {
    if (url.includes('/thingmodel/query-device-property')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: [{ identifier: 'I', value: 1.25 }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { status: 1 } }) };
  };
  const { api, storage } = loadWebModules(initialStorage, fetchImpl);
  await api.OneNetService.getLatestData();
  const latest = JSON.parse(storage.get('iot_latest_data'));
  const history = JSON.parse(storage.get('iot_history_data'));
  assert.equal(latest.voltage, undefined);
  assert.equal(latest.current, 1.25);
  assert.equal(history[0].data.voltage, undefined);
  assert.equal(history[0].data.current, 1.25);
});

test('网页控制页仅在实时在线状态确认后开放下发', () => {
  const control = read('control.html');
  assert.match(control, /let\s+_controlsEnabled\s*=\s*false/);
  assert.match(control, /function\s+setControlsEnabled\s*\(enabled\)/);
  assert.match(control, /if\s*\(!_controlsEnabled\)[\s\S]{0,160}return false/);
  assert.match(control, /data\._isMock[\s\S]{0,500}setControlsEnabled\(false\)/);
  assert.match(control, /!data\._isOnline[\s\S]{0,700}setControlsEnabled\(false\)/);
  assert.match(control, /\/\* 在线 \*\/[\s\S]{0,700}setControlsEnabled\(true\)/);
  assert.match(control, /catch\s*\(error\)[\s\S]{0,500}setControlsEnabled\(false\)/);
  assert.doesNotMatch(control, /data\._isOnline\s*===\s*true[\s\S]{0,300}cs\.innerText\s*=\s*'在线'/);
});

test('网页首页和监测页在请求失败时立即遮蔽旧实时值', () => {
  const index = read('index.html');
  const monitoring = read('monitoring.html');
  assert.match(index, /catch\s*\(error\)[\s\S]{0,500}updateUI\(\{\s*_isOnline:\s*false\s*\}\)/);
  assert.match(monitoring, /catch\s*\(error\)[\s\S]{0,300}updateCards\(\{\s*_isOnline:\s*false\s*\}\)/);
});

test('网页首页和监测页启动时不会把持久化缓存显示成实时在线数据', () => {
  const index = read('index.html');
  const monitoring = read('monitoring.html');
  assert.match(index, /var\s+isOffline\s*=\s*isFromCache\s*\|\|/);
  assert.match(index, /updateUI\(JSON\.parse\(cachedData\),\s*true\)/);
  assert.match(monitoring, /updateCards\(JSON\.parse\(cachedData\),\s*true\)/);
  assert.match(monitoring, /function\s+updateCards\(data,\s*isFromCache\s*=\s*false\)/);
  assert.match(monitoring, /var\s+isOffline\s*=\s*isFromCache\s*\|\|/);
});

test('网页历史CSV防公式注入时仍保留合法负数', () => {
  const history = read('history.html');
  assert.match(history, /var\s+numeric\s*=\s*\/\^-/);
  assert.match(history, /if\s*\(!numeric\s*&&\s*\/\^\[=\+\\-@\]\//);
});

test('数据模型会过滤异常缓存并保留固件安全边界', () => {
  const config = read('js/config.js');
  assert.match(config, /DATA_MODEL_VERSION\s*=\s*3/);
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
  const expectations = {
    index: /stopIndexPolling/,
    monitoring: /stopMonitorPolling/,
    control: /_stopControlSync/,
    history: /stopHistoryPolling/
  };
  for (const [page, pattern] of Object.entries(expectations)) {
    const html = read(`${page}.html`);
    assert.match(html, pattern);
    assert.match(html, /visibilitychange/);
    assert.match(html, /pagehide/);
  }
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

test('Service Worker采用页面网络优先并立即接管新版本', () => {
  const worker = read('service-worker.js');
  assert.match(worker, /networkFirst/);
  assert.match(worker, /request\.mode === 'navigate'/);
  assert.match(worker, /skipWaiting/);
  assert.match(worker, /clients\.claim/);
  assert.match(worker, /icon\.svg/);
});

test('控制页 Switch 请求结束立即解锁，不再使用 2s 定时器且异常不永久锁死', async () => {
  const control = read('control.html');
  /* 静态契约：_switchPending 必须在 finally 中与 checkbox 一起恢复，并更新 UI */
  assert.match(control, /finally\s*\{[\s\S]{0,200}checkbox\.disabled\s*=\s*false;[\s\S]{0,200}_switchPending\s*=\s*false/);
  assert.match(control, /finally\s*\{[\s\S]{0,300}updateToggleUI\(`toggle-\$\{id\}`\)/);
  /* 不再依赖 2s 定时解锁 */
  assert.doesNotMatch(control, /_switchPending\s*=\s*false;[\s\S]{0,40}\},\s*2000/);

  /* 行为契约：真实 in-flight 期间拒绝重入，请求结束后立即解锁 */
  const fnSrc = extractFunction(control, 'async function handleControl(id)');
  const checkbox = { checked: false, disabled: false };
  const context = buildHandleControlContext(checkbox, () => new Promise((resolve) => {
    context.__resolveSend = () => resolve(true);
  }));
  vm.createContext(context);
  vm.runInContext('let _switchPending = false;\n' + fnSrc + '\nglobalThis.__getPending = () => _switchPending;', context);

  const first = context.handleControl('switch');
  await Promise.resolve();
  context.handleControl('switch'); /* in-flight 重入应被拒绝 */
  assert.equal(context.__sendCalls.length, 1);
  assert.equal(checkbox.disabled, true);
  context.__resolveSend();
  await first;
  assert.equal(context.__getPending(), false);
  assert.equal(checkbox.disabled, false);
  assert.equal(context.__sendCalls.length, 1);
});

test('控制页 Switch 请求抛异常时仍恢复 checkbox 与锁状态', async () => {
  const control = read('control.html');
  const fnSrc = extractFunction(control, 'async function handleControl(id)');
  const checkbox = { checked: true, disabled: false };
  const context = buildHandleControlContext(checkbox, async () => { throw new Error('网络异常'); });
  vm.createContext(context);
  vm.runInContext('let _switchPending = false;\n' + fnSrc + '\nglobalThis.__getPending = () => _switchPending;', context);

  await assert.rejects(context.handleControl('switch'));
  assert.equal(checkbox.checked, false);
  assert.equal(context.__getPending(), false);
  assert.equal(checkbox.disabled, false);
});

test('三个轮询页的 500ms 初始同步都有独立句柄且 stop 可取消', () => {
  const index = read('index.html');
  const monitoring = read('monitoring.html');
  const control = read('control.html');

  /* 首页：独立句柄、stop 清理、start 去重、回调先置空再同步 */
  assert.match(index, /_pollInitTimer\s*=\s*setTimeout\(/);
  assert.match(index, /function\s+stopIndexPolling\(\)\s*\{[\s\S]{0,200}clearTimeout\(_pollInitTimer\)/);
  assert.match(index, /function\s+startIndexPolling\(\)\s*\{[\s\S]{0,160}if\s*\(_pollTimer\s*\|\|\s*_pollInitTimer/);
  assert.match(index, /_pollInitTimer\s*=\s*null;\s*syncData\(\)/);

  /* 监测页：独立句柄、stop 清理、start 去重、回调先置空再同步 */
  assert.match(monitoring, /_monitorInitTimer\s*=\s*setTimeout\(/);
  assert.match(monitoring, /function\s+stopMonitorPolling\(\)\s*\{[\s\S]{0,200}clearTimeout\(_monitorInitTimer\)/);
  assert.match(monitoring, /function\s+startMonitorPolling\(\)\s*\{[\s\S]{0,160}if\s*\(_monitorTimer\s*\|\|\s*_monitorInitTimer/);
  assert.match(monitoring, /_monitorInitTimer\s*=\s*null;\s*syncData\(\)/);

  /* 控制页：独立句柄、stop 清理、start 去重、回调先置空再同步 */
  assert.match(control, /_controlInitTimer\s*=\s*setTimeout\(/);
  assert.match(control, /function\s+_stopControlSync\(\)\s*\{[\s\S]{0,200}clearTimeout\(_controlInitTimer\)/);
  assert.match(control, /function\s+_startControlSync\(\)\s*\{[\s\S]{0,160}if\s*\(_controlSyncStarted\s*\|\|\s*_controlInitTimer/);
  assert.match(control, /_controlInitTimer\s*=\s*null;\s*syncStatus\(\)/);
});

test('轮询生命周期保留 interval/retry 清理与 pagehide/visibilitychange 行为', () => {
  const index = read('index.html');
  const monitoring = read('monitoring.html');
  const control = read('control.html');

  assert.match(index, /function\s+stopIndexPolling\(\)\s*\{[\s\S]{0,200}clearInterval\(_pollTimer\)[\s\S]{0,200}clearTimeout\(_indexRetryTimer\)/);
  assert.match(monitoring, /function\s+stopMonitorPolling\(\)\s*\{[\s\S]{0,200}clearInterval\(_monitorTimer\)/);
  assert.match(control, /function\s+_stopControlSync\(\)\s*\{[\s\S]{0,200}clearInterval\(_ctrlSyncTimer\)[\s\S]{0,200}clearTimeout\(_controlRetryTimer\)/);
  for (const html of [index, monitoring, control]) {
    assert.match(html, /visibilitychange/);
    assert.match(html, /pagehide/);
  }
});
