/* V5.1.3 移动端底部导航栏 */
(function() {
  if (window.innerWidth >= 1024) return;
  const nav = document.createElement('nav');
  nav.className = 'app-mobile-nav lg:hidden';
  nav.setAttribute('aria-label', '主导航');

  const items = [
    { href: '/', icon: 'fa-home', label: '首页' },
    { href: '/monitoring', icon: 'fa-chart-bar', label: '监测' },
    { href: '/control', icon: 'fa-sliders-h', label: '控制' },
    { href: '/history', icon: 'fa-chart-line', label: '历史' },
    { href: '/alerts', icon: 'fa-bell', label: '报警' },
    { href: '/settings', icon: 'fa-cog', label: '设置' }
  ];

  var path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  if (path === '/index') path = '/';

  var navHtml = '';
  items.forEach(function(item) {
    var isActive = (path === item.href || (item.href !== '/' && path.indexOf(item.href) === 0));
    navHtml += '<a href="' + item.href + '" class="app-mobile-nav__item' + (isActive ? ' is-active' : '') + '"' + (isActive ? ' aria-current="page"' : '') + '><i class="fas ' + item.icon + '" aria-hidden="true"></i><span>' + item.label + '</span></a>';
  });
  nav.innerHTML = navHtml;

  document.body.appendChild(nav);
})();
