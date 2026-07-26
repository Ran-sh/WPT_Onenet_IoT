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
