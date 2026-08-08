/**
 * WPT 双端监控首页（V6.0.0）
 * 只调用核心 API 与 WptUi 工具层；测量值仅在端点 live 时显示，
 * RX 健康摘要按各自 OneNET 属性源时间逐项判定新鲜度。
 */
(function () {
    var POLL_MS = 5000;
    var HEALTH_IDS = ['rx_ble_online', 'rx_telemetry_fresh', 'rx_valid', 'rx_safe'];
    var HOME_ENDPOINT_KEY = 'wpt_home_endpoint_v1';
    var activeHomeEndpoint = 'tx';

    var rxModel = typeof getDataModel === 'function' ? getDataModel('rx') : { sensors: [] };
    var cloudKeyById = {};
    rxModel.sensors.forEach(function (s) { cloudKeyById[s.id] = s.cloudKey; });

    function deviceLabel(key) {
        var config = typeof getOneNetConfig === 'function' ? getOneNetConfig(key) : null;
        return config && config.DEVICE_NAME ? config.DEVICE_NAME : '未配置';
    }

    function endpointClass(data, error) {
        if (data === null && !error) return { state: 'pending', label: '等待数据', isLive: false };
        return WptUi.classifyEndpoint(data, error);
    }

    function renderBoundValue(el, key, data, cls) {
        var bind = el.getAttribute('data-bind');
        if (!bind) return;
        var parts = bind.split('.');
        if (parts.length !== 2 || parts[0] !== key) return;
        var metricId = parts[1];
        var kind = el.getAttribute('data-kind') || '';
        if (kind === 'rx-health') {
            var current = WptUi.isPropertyCurrent(data, cloudKeyById[metricId], Date.now(), 15000);
            el.textContent = current ? WptUi.rxHealthText(metricId, data[metricId]) : '未知';
            return;
        }
        if (!cls.isLive || !data) {
            el.textContent = '--';
            return;
        }
        if (kind === 'tx-state') {
            el.textContent = WptUi.txStateLabel(data[metricId]);
            return;
        }
        el.textContent = WptUi.formatMetric(data[metricId], el.getAttribute('data-decimals'), el.getAttribute('data-unit'));
    }

    function renderEndpoint(key, data, error) {
        var cls = endpointClass(data, error);
        /* 切换按钮状态摘要常驻更新：隐藏端也同步。 */
        var tabStatus = document.querySelector('[data-endpoint-tab="' + key + '"] [data-role="tab-status"]');
        if (tabStatus) {
            tabStatus.textContent = cls.label;
            tabStatus.dataset.state = cls.state;
        }
        var statusEl = document.querySelector('article[data-endpoint-card="' + key + '"] [data-role="endpoint-status"]');
        var nameEl = document.querySelector('article[data-endpoint-card="' + key + '"] [data-role="device-name"]');
        var timeEl = document.querySelector('article[data-endpoint-card="' + key + '"] [data-role="source-time"]');
        var noteEl = document.querySelector('article[data-endpoint-card="' + key + '"] [data-role="endpoint-note"]');
        if (statusEl) {
            statusEl.textContent = cls.label;
            statusEl.dataset.state = cls.state;
        }
        if (nameEl) nameEl.textContent = deviceLabel(key);
        if (timeEl) {
            timeEl.textContent = data && data._telemetryTimestamp ? WptUi.formatSourceTime(data._telemetryTimestamp) : '--';
        }
        if (noteEl) {
            if (cls.state === 'pending') noteEl.textContent = '等待数据';
            else if (cls.state === 'error') noteEl.textContent = '获取失败';
            else if (cls.state === 'preview') noteEl.textContent = '未配置云端连接，当前为预览';
            else if (cls.state === 'offline') noteEl.textContent = '离线';
            else if (cls.state === 'stale') noteEl.textContent = '数据过期';
            else noteEl.textContent = '';
        }
        var bindEls = document.querySelectorAll('[data-bind]');
        for (var i = 0; i < bindEls.length; i++) renderBoundValue(bindEls[i], key, data, cls);
    }

    async function syncAll() {
        var settled = await Promise.allSettled([
            OneNetService.getLatestData('tx'),
            OneNetService.getLatestData('rx')
        ]);
        var liveCount = 0;
        settled.forEach(function (result, index) {
            var key = index === 0 ? 'tx' : 'rx';
            var data = result.status === 'fulfilled' ? result.value : null;
            var error = result.status === 'rejected' ? result.reason : null;
            renderEndpoint(key, data, error);
            if (WptUi.classifyEndpoint(data, error).isLive) liveCount++;
        });
        updateAlertSummary(settled);
        var summary = document.getElementById('systemSummary');
        if (summary) {
            summary.textContent = liveCount === 2 ? '2/2 实时' : (liveCount === 1 ? '1/2 实时' : '未建立实时链路');
        }
    }

    /* 告警摘要：每轮两端同步后恰好评估一次；引擎异常不破坏遥测。 */
    function updateAlertSummary(settled) {
        var el = document.getElementById('homeAlertSummary');
        if (!el) return;
        var snapshots = {
            tx: { data: settled[0].status === 'fulfilled' ? settled[0].value : null, error: settled[0].status === 'rejected' ? settled[0].reason : null },
            rx: { data: settled[1].status === 'fulfilled' ? settled[1].value : null, error: settled[1].status === 'rejected' ? settled[1].reason : null }
        };
        var summary;
        try {
            if (typeof WptAlertEngine === 'undefined') throw new Error('engine missing');
            summary = WptAlertEngine.evaluateSnapshots(snapshots, Date.now()).summary;
        } catch (e) {
            el.textContent = '报警状态不可用';
            el.dataset.state = 'error';
            return;
        }
        applyAlertSummary(el, summary);
    }

    function applyAlertSummary(el, summary) {
        if (!summary || summary.active === 0) {
            el.textContent = '无活动报警';
            el.dataset.state = 'clear';
        } else {
            el.textContent = summary.active + ' 项活动 · ' + summary.unacknowledged + ' 项未确认';
            el.dataset.state = summary.criticalActive > 0 ? 'critical' : 'warning';
        }
    }

    function renderStoredAlertSummary() {
        var el = document.getElementById('homeAlertSummary');
        if (!el) return;
        try {
            if (typeof WptAlertEngine === 'undefined') throw new Error('engine missing');
            applyAlertSummary(el, WptAlertEngine.getSummary());
        } catch (e) {
            el.textContent = '报警状态不可用';
            el.dataset.state = 'error';
        }
    }

    /* ---------- 首页端点选择（仅影响显示，不影响请求/缓存/安全判定） ---------- */

    function readSelectedEndpoint() {
        var value = null;
        try {
            if (typeof localStorage !== 'undefined') value = localStorage.getItem(HOME_ENDPOINT_KEY);
        } catch (e) {
            value = null;
        }
        return value === 'rx' ? 'rx' : 'tx';
    }

    function writeSelectedEndpoint(endpoint) {
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(HOME_ENDPOINT_KEY, endpoint);
        } catch (e) {}
    }

    function selectEndpoint(endpoint) {
        var key = endpoint === 'rx' ? 'rx' : 'tx';
        activeHomeEndpoint = key;
        var txTab = document.getElementById('homeTxTab');
        var rxTab = document.getElementById('homeRxTab');
        var txPanel = document.getElementById('txEndpointPanel');
        var rxPanel = document.getElementById('rxEndpointPanel');
        if (txTab) {
            txTab.setAttribute('aria-selected', key === 'tx' ? 'true' : 'false');
            txTab.tabIndex = key === 'tx' ? 0 : -1;
        }
        if (rxTab) {
            rxTab.setAttribute('aria-selected', key === 'rx' ? 'true' : 'false');
            rxTab.tabIndex = key === 'rx' ? 0 : -1;
        }
        if (txPanel) txPanel.hidden = key !== 'tx';
        if (rxPanel) rxPanel.hidden = key !== 'rx';
    }

    function switchHomeEndpoint(endpoint) {
        selectEndpoint(endpoint);
        writeSelectedEndpoint(activeHomeEndpoint);
        var tab = document.getElementById(endpoint === 'rx' ? 'homeRxTab' : 'homeTxTab');
        if (tab && typeof tab.focus === 'function') tab.focus();
    }

    function onHomeTabKeydown(e) {
        if (!e) return;
        var active = typeof document !== 'undefined' ? document.activeElement : null;
        var txTab = document.getElementById('homeTxTab');
        var rxTab = document.getElementById('homeRxTab');
        if (active !== txTab && active !== rxTab) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            switchHomeEndpoint(activeHomeEndpoint === 'tx' ? 'rx' : 'tx');
        } else if (e.key === 'Home') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            switchHomeEndpoint('tx');
        } else if (e.key === 'End') {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            switchHomeEndpoint('rx');
        }
    }

    function bindEndpointSwitcher() {
        var txTab = document.getElementById('homeTxTab');
        var rxTab = document.getElementById('homeRxTab');
        if (txTab) txTab.addEventListener('click', function () { switchHomeEndpoint('tx'); });
        if (rxTab) rxTab.addEventListener('click', function () { switchHomeEndpoint('rx'); });
        document.addEventListener('keydown', onHomeTabKeydown);
    }

    function init() {
        WptUi.markActiveNavigation();
        activeHomeEndpoint = readSelectedEndpoint();
        selectEndpoint(activeHomeEndpoint);
        bindEndpointSwitcher();
        renderEndpoint('tx', null, null);
        renderEndpoint('rx', null, null);
        renderStoredAlertSummary();
        var poller = WptUi.createLifecyclePoller(syncAll, POLL_MS);
        var syncBtn = document.getElementById('syncBtn');
        if (syncBtn) syncBtn.addEventListener('click', function () {
            /* 手动触发同样吸收拒绝，避免未处理 Promise 拒绝。 */
            poller.runNow().catch(function () {});
        });
        WptUi.registerServiceWorker();
        poller.start();
    }

    init();
})();
