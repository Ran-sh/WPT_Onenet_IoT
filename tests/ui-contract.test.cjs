const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = ['index', 'monitoring', 'control', 'history', 'alerts', 'settings', 'login'];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('所有页面使用统一的V5工业仪表盘视觉系统', () => {
  for (const page of pages) {
    const html = read(`${page}.html`);
    assert.match(html, /css\/dashboard-v5\.css/, `${page}.html 缺少统一样式`);
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
  const css = read('css/dashboard-v5.css');
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

test('网页活动资源统一标记V5.1.3', () => {
  for (const page of pages) {
    assert.match(read(`${page}.html`), /name=["']wpt-version["'][^>]*V5\.1\.3/);
  }
  assert.match(read('js/config.js'), /V5\.1\.3/);
  assert.match(read('js/onenet.js'), /V5\.1\.3/);
  assert.match(read('js/mobile-nav.js'), /V5\.1\.3/);
  assert.match(read('css/dashboard-v5.css'), /V5\.1\.3/);
  assert.match(read('README.md'), /V5\.1\.3/);
});
