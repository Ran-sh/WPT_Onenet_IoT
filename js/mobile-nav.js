/* 移动端底部导航栏 */
(function() {
  if (window.innerWidth >= 1024) return;
  const nav = document.createElement('nav');
  nav.className = 'lg:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-50 flex justify-around items-center';
  nav.style.cssText = 'padding:8px 0;padding-bottom:max(8px, env(safe-area-inset-bottom))';

  const items = [
    { href: './', icon: 'fa-home', label: '首页' },
    { href: './monitoring.html', icon: 'fa-chart-bar', label: '监测' },
    { href: './control.html', icon: 'fa-sliders-h', label: '控制' },
    { href: './history.html', icon: 'fa-chart-line', label: '历史' },
    { href: './settings.html', icon: 'fa-cog', label: '设置' }
  ];

  let path = window.location.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
  items.forEach(item => {
    const isActive = (path === item.href || (item.href !== '/' && path.startsWith(item.href)));
    nav.innerHTML += `
      <a href="${item.href}" class="flex flex-col items-center px-2 py-1 no-underline" style="color:${isActive ? '#3b82f6' : '#9ca3af'}">
        <i class="fas ${item.icon}" style="font-size:20px"></i>
        <span style="font-size:10px;margin-top:2px;font-weight:500">${item.label}</span>
      </a>
    `;
  });

  document.body.appendChild(nav);
  const main = document.querySelector('main') || document.querySelector('.flex-1');
  if (main) main.style.paddingBottom = '64px';
})();
