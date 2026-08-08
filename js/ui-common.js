/**
 * WPT 双端 UI 工具层（V6.0.0）
 * 纯函数与生命周期轮询：端点分类、格式化、逐属性新鲜度、趋势序列与轮询器。
 * 页面业务脚本只依赖全局 WptUi，不复制核心解析/校验/缓存逻辑。
 */

var WptUi = (function () {
    var MIN_SOURCE_TIME = 946684800000;
    var MAX_SOURCE_TIME = 4102444800000;
    var DEFAULT_FRESH_MS = 15000;
    var DEFAULT_WINDOW_MS = 1800000;
    var MAX_FUTURE_MS = 60000;

    /* 端点整体分类：error/preview/offline/stale/live，实时必须严格双 true。 */
    function classifyEndpoint(data, error) {
        if (error) return { state: 'error', label: '获取失败', isLive: false };
        if (!data || typeof data !== 'object') return { state: 'error', label: '获取失败', isLive: false };
        if (data._isMock) return { state: 'preview', label: '预览', isLive: false };
        if (data._isOnline !== true) return { state: 'offline', label: '离线', isLive: false };
        if (data._isFresh !== true) return { state: 'stale', label: '数据过期', isLive: false };
        return { state: 'live', label: '实时', isLive: true };
    }

    /* 只使用传入的 OneNET 源时间戳格式化本地年月日时分秒。 */
    function formatSourceTime(timestamp) {
        var t = Number(timestamp);
        if (!Number.isFinite(t) || t < MIN_SOURCE_TIME || t > MAX_SOURCE_TIME) return '--';
        var d = new Date(t);
        function pad(n) { return n < 10 ? '0' + n : String(n); }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function formatAge(ageMs) {
        var age = Number(ageMs);
        if (!Number.isFinite(age)) return '--';
        if (age < 0) age = 0;
        if (age < 1000) return '刚刚';
        if (age < 60000) return Math.floor(age / 1000) + '秒前';
        return Math.floor(age / 60000) + '分钟前';
    }

    /* 数值按小数位安全格式化；bool 显示明确文本；无效一律 '--'。 */
    function formatMetric(value, decimals, unit) {
        if (typeof value === 'boolean') return value ? '开启' : '关闭';
        var number = Number(value);
        if (!Number.isFinite(number)) return '--';
        var digits = Number.isFinite(Number(decimals)) ? Number(decimals) : 0;
        return number.toFixed(digits) + (typeof unit === 'string' ? unit : '');
    }

    var TX_STATE_MAP = { 0: '待机', 1: '扫频', 2: '运行', 3: '故障' };
    var RX_STATE_MAP = { 0: '启动', 1: '空闲', 2: '就绪', 3: '刺激', 4: '故障', 5: 'BLE断开' };

    function txStateLabel(state) {
        return TX_STATE_MAP[state] || '未知';
    }

    function rxStateLabel(state) {
        return RX_STATE_MAP[state] || '未知';
    }

    /* RX 健康矩阵文本：状态类 bool 显示正常/断开/过期等明确文字，不限流/刺激显示开/关。 */
    function rxHealthText(metricId, value) {
        if (metricId === 'rx_state') return rxStateLabel(value);
        if (metricId === 'rx_fault_flags') {
            var n = Number(value);
            if (!Number.isFinite(n)) return '未知';
            return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
        }
        if (metricId === 'rx_fault_reason') {
            return typeof value === 'string' && value ? value : '未知';
        }
        switch (metricId) {
            case 'rx_ble_online': return value === true ? '正常' : (value === false ? 'BLE断开' : '未知');
            case 'rx_telemetry_fresh': return value === true ? '正常' : (value === false ? '遥测过期' : '未知');
            case 'rx_gateway_online': return value === true ? '正常' : (value === false ? '网关离线' : '未知');
            case 'rx_wifi_online': return value === true ? '正常' : (value === false ? 'WiFi离线' : '未知');
            case 'rx_mqtt_online': return value === true ? '正常' : (value === false ? 'MQTT离线' : '未知');
            case 'rx_safe': return value === true ? '允许START' : (value === false ? '禁止START' : '未知');
            case 'rx_connected': return value === true ? '已连接' : (value === false ? '未连接' : '未知');
            case 'rx_valid': return value === true ? '有效' : (value === false ? '无效' : '未知');
            case 'rx_limit': return value === true ? '开启' : (value === false ? '关闭' : '未知');
            case 'rx_stim': return value === true ? '开启' : (value === false ? '关闭' : '未知');
            default: return '未知';
        }
    }

    /* 单个属性的新鲜度：整体接口在线且该属性源时间有效、年龄在 [-60s, windowMs] 内。 */
    function isPropertyCurrent(data, cloudKey, nowMs, windowMs) {
        if (!data || typeof data !== 'object') return false;
        if (data._isOnline !== true) return false;
        var time = Number(data._propertyTimes && data._propertyTimes[cloudKey]);
        if (!Number.isFinite(time)) return false;
        if (time < MIN_SOURCE_TIME || time > MAX_SOURCE_TIME) return false;
        var age = Number(nowMs) - time;
        var window = Number.isFinite(Number(windowMs)) ? Number(windowMs) : DEFAULT_FRESH_MS;
        if (age < -MAX_FUTURE_MS || age > window) return false;
        return true;
    }

    /* 趋势序列：只保留匹配设备、OneNET 源时间、窗口内且数值有限的点；
     * 按时间升序，重复 timestamp 保留最后一次值，允许负数，不修改输入。 */
    function buildTrendSeries(deviceKey, metricId, history, nowMs, windowMs) {
        var now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
        var window = Number.isFinite(Number(windowMs)) ? Number(windowMs) : DEFAULT_WINDOW_MS;
        var byTime = {};
        (Array.isArray(history) ? history : []).forEach(function (item) {
            if (!item || typeof item !== 'object') return;
            if (item.deviceKey !== deviceKey) return;
            if (item.timeSource !== 'onenet') return;
            var timestamp = Number(item.timestamp);
            if (!Number.isFinite(timestamp)) return;
            if (timestamp < now - window || timestamp > now) return;
            var value = Number(item.data && item.data[metricId]);
            if (!Number.isFinite(value)) return;
            byTime[timestamp] = { x: timestamp, y: value };
        });
        var points = [];
        Object.keys(byTime).forEach(function (ts) { points.push(byTime[ts]); });
        points.sort(function (a, b) { return a.x - b.x; });
        return points;
    }

    /* 生命周期轮询：一次只允许一个 task 执行；start 立即同步且只建一个 interval；
     * 隐藏时停 interval，恢复可见立即同步并重建；pagehide/beforeunload 彻底停止。 */
    function createLifecyclePoller(task, intervalMs) {
        var started = false;
        var inFlight = false;
        var timer = null;

        function clearTimer() {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        }

        function startTimer() {
            clearTimer();
            if (!started) return;
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            timer = setInterval(function () { safeRunNow(); }, intervalMs);
        }

        async function runNow() {
            if (inFlight) return;
            inFlight = true;
            try {
                return await task();
            } finally {
                inFlight = false;
            }
        }

        /* 内部触发统一吸收拒绝，避免未处理 Promise 拒绝；公开 runNow 语义保持不变。 */
        function safeRunNow() {
            return runNow().catch(function () {});
        }

        function start() {
            if (started) return;
            started = true;
            safeRunNow();
            startTimer();
        }

        function stop() {
            started = false;
            clearTimer();
        }

        function onVisibility() {
            if (typeof document === 'undefined') return;
            if (!started) return;
            if (document.visibilityState === 'hidden') {
                clearTimer();
            } else {
                startTimer();
                safeRunNow();
            }
        }

        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisibility);
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('pagehide', stop);
            window.addEventListener('beforeunload', stop);
        }

        return { start: start, stop: stop, runNow: runNow };
    }

    /* Service Worker 统一安全注册：仅支持时注册，失败静默。 */
    function registerServiceWorker() {
        if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
        try {
            var registration = navigator.serviceWorker.register('service-worker.js');
            if (registration && typeof registration.catch === 'function') {
                registration.catch(function () {});
            }
        } catch (e) {}
    }

    /* 桌面侧栏当前项高亮：pathname 去掉 .html、末尾 /，/index 归一化为 /。 */
    function markActiveNavigation() {
        if (typeof document === 'undefined') return;
        var path = '';
        if (typeof window !== 'undefined' && window.location && window.location.pathname) {
            path = String(window.location.pathname);
        }
        path = path.replace(/\.html$/, '').replace(/\/+$/, '');
        if (!path) path = '/';
        if (path === '/index') path = '/';
        var links = document.querySelectorAll('.nav-item');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href');
            var isActive = href === path;
            if (isActive) {
                links[i].classList.add('is-active');
                links[i].setAttribute('aria-current', 'page');
            } else {
                links[i].classList.remove('is-active');
                links[i].removeAttribute('aria-current');
            }
        }
    }

    return {
        classifyEndpoint: classifyEndpoint,
        formatSourceTime: formatSourceTime,
        formatAge: formatAge,
        formatMetric: formatMetric,
        txStateLabel: txStateLabel,
        rxStateLabel: rxStateLabel,
        rxHealthText: rxHealthText,
        isPropertyCurrent: isPropertyCurrent,
        buildTrendSeries: buildTrendSeries,
        createLifecyclePoller: createLifecyclePoller,
        registerServiceWorker: registerServiceWorker,
        markActiveNavigation: markActiveNavigation
    };
})();
