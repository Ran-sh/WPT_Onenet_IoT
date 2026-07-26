/**
 * WPT Monitor 登录守卫（V5.1.3）
 * 会话登录仅在当前标签页有效，勾选自动登录时最多保留七天。
 */
(function() {
  'use strict';

  var SESSION_KEY = 'wpt_session_auth';
  var LOGIN_TIME_KEY = 'lastLoginTime';
  var NEXT_PATH_KEY = 'wpt_login_next';
  var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  var sessionValid = false;
  var persistentValid = false;

  try {
    sessionValid = sessionStorage.getItem(SESSION_KEY) === '1';
    var loginTime = Number(localStorage.getItem(LOGIN_TIME_KEY));
    persistentValid = Number.isFinite(loginTime) && loginTime > 0 && Date.now() - loginTime < MAX_AGE_MS;
    if (!persistentValid) localStorage.removeItem(LOGIN_TIME_KEY);
  } catch (error) {
    sessionValid = false;
    persistentValid = false;
  }

  if (sessionValid || persistentValid) return;

  try {
    sessionStorage.setItem(NEXT_PATH_KEY, window.location.pathname + window.location.search);
  } catch (error) {}
  window.location.replace('/login.html');
})();
