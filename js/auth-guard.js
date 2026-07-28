/**
 * WPT Monitor 登录守卫（V5.1.3）
 * 会话登录仅在当前标签页有效，勾选自动登录时最多保留七天。
 */
(function() {
  'use strict';

  var SESSION_KEY = 'wpt_session_auth';
  var LOGIN_TIME_KEY = 'lastLoginTime';
  var PERSISTENT_KEY = 'wpt_persistent_auth';
  var NEXT_PATH_KEY = 'wpt_login_next';
  var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  var sessionValid = false;
  var persistentValid = false;

  try {
    sessionValid = sessionStorage.getItem(SESSION_KEY) === '1';
    var persistentRecord = null;
    try { persistentRecord = JSON.parse(localStorage.getItem(PERSISTENT_KEY) || 'null'); } catch (parseError) {}
    var now = Date.now();
    persistentValid = !!(persistentRecord && persistentRecord.version === 1 &&
      Number.isFinite(Number(persistentRecord.issuedAt)) && Number.isFinite(Number(persistentRecord.expiresAt)) &&
      now >= Number(persistentRecord.issuedAt) && now < Number(persistentRecord.expiresAt) &&
      Number(persistentRecord.expiresAt) - Number(persistentRecord.issuedAt) <= MAX_AGE_MS);

    /* 兼容旧版七天登录时间戳，并立即迁移到带明确失效时间的记录。 */
    var loginTime = Number(localStorage.getItem(LOGIN_TIME_KEY));
    var legacyAge = now - loginTime;
    if (!persistentValid && Number.isFinite(loginTime) && loginTime > 0 && legacyAge >= 0 && legacyAge < MAX_AGE_MS) {
      persistentValid = true;
      localStorage.setItem(PERSISTENT_KEY, JSON.stringify({ version: 1, issuedAt: loginTime, expiresAt: loginTime + MAX_AGE_MS }));
    }
    if (!persistentValid) {
      localStorage.removeItem(LOGIN_TIME_KEY);
      localStorage.removeItem(PERSISTENT_KEY);
    }
  } catch (error) {
    sessionValid = false;
    persistentValid = false;
  }

  if (sessionValid || persistentValid) {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (error) {}
    return;
  }

  try {
    var requestedPath = window.location.pathname + window.location.search;
    if (requestedPath.charAt(0) === '/' && requestedPath.indexOf('//') !== 0) {
      sessionStorage.setItem(NEXT_PATH_KEY, requestedPath);
    }
  } catch (error) {}
  window.location.replace('/login.html');
})();
