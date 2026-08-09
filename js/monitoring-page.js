/**
 * WPT 实时双端监测（V6.0.0）
 * 双端驾驶舱：测量值仅在端点 live 时显示；RX 健康矩阵按属性源时间逐项判定；
 * 趋势图使用 OneNET 源时间 x 轴，允许负数，不使用渐变。
 */
(function () {
    var POLL_MS = 5000;
    var TREND_WINDOW_MS = 1800000;
    var TREND_METRICS = {
        tx: ['voltage', 'current', 'freq'],
        rx: ['rx_imon', 'rx_current_ua', 'rx_bonep', 'rx_bonen', 'rx_bonev', 'rx_resistance', 'rx_vout']
    };

    var rxModel = typeof getDataModel === 'function' ? getDataModel('rx') : { sensors: [] };
    var cloudKeyById = {};
    rxModel.sensors.forEach(function (s) { cloudKeyById[s.id] = s.cloudKey; });

    var trendChart = null;

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
            /* 健康项只在本属性源时间新鲜时显示本次值，否则未知；
             * 固件降级时会重发健康字段，因此不能按端点整体一刀切。 */
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
        if (kind === 'rx-state') {
            el.textContent = WptUi.rxStateLabel(data[metricId]);
            return;
        }
        el.textContent = WptUi.formatDeviceMetric(key, metricId, data[metricId], el.getAttribute('data-decimals'), el.getAttribute('data-unit'));
    }

    function renderAllBindings(key, data, error) {
        var cls = endpointClass(data, error);
        var bindEls = document.querySelectorAll('[data-bind]');
        for (var i = 0; i < bindEls.length; i++) renderBoundValue(bindEls[i], key, data, cls);
        return cls;
    }

    function renderEndpointSummary(key, data, error) {
        var cls = renderAllBindings(key, data, error);
        var statusEl = document.querySelector('[data-endpoint-summary="' + key + '"] [data-role="endpoint-status"]');
        var nameEl = document.querySelector('[data-endpoint-summary="' + key + '"] [data-role="device-name"]');
        var timeEl = document.querySelector('[data-endpoint-summary="' + key + '"] [data-role="source-time"]');
        var ageEl = document.querySelector('[data-endpoint-summary="' + key + '"] [data-role="data-age"]');
        if (statusEl) {
            statusEl.textContent = cls.label;
            statusEl.dataset.state = cls.state;
        }
        if (nameEl) nameEl.textContent = deviceLabel(key);
        if (timeEl) {
            timeEl.textContent = data && data._telemetryTimestamp ? WptUi.formatSourceTime(data._telemetryTimestamp) : '--';
        }
        if (ageEl) {
            ageEl.textContent = data && Number.isFinite(Number(data._ageMs)) ? WptUi.formatAge(data._ageMs) : '--';
        }
        return cls;
    }

    function metricLabel(deviceKey, metricId) {
        var model = typeof getDataModel === 'function' ? getDataModel(deviceKey) : { sensors: [] };
        var sensor = null;
        for (var i = 0; i < model.sensors.length; i++) {
            if (model.sensors[i].id === metricId) { sensor = model.sensors[i]; break; }
        }
        return sensor ? sensor.name : metricId;
    }

    function rebuildMetricSelect() {
        var deviceSelect = document.getElementById('trendDeviceSelect');
        var select = document.getElementById('trendMetricSelect');
        if (!deviceSelect || !select) return;
        var deviceKey = deviceSelect.value;
        var metrics = TREND_METRICS[deviceKey] || [];
        select.textContent = '';
        metrics.forEach(function (metricId) {
            var option = document.createElement('option');
            option.value = metricId;
            option.textContent = metricLabel(deviceKey, metricId);
            select.appendChild(option);
        });
        if (metrics.length && metrics.indexOf(select.value) === -1) select.value = metrics[0];
    }

    function refreshTrend() {
        var deviceSelect = document.getElementById('trendDeviceSelect');
        var metricSelect = document.getElementById('trendMetricSelect');
        var empty = document.getElementById('trendEmpty');
        var canvas = document.getElementById('trendChart');
        if (!deviceSelect || !metricSelect || !empty || !canvas) return;
        var ChartCtor = typeof window !== 'undefined' ? window.Chart : null;
        /* 仅当 window.Chart 为函数时才构造图表，其余一律降级显示不可用。 */
        if (typeof ChartCtor !== 'function') {
            empty.textContent = '图表组件不可用';
            empty.style.display = 'block';
            if (trendChart) { trendChart.destroy(); trendChart = null; }
            return;
        }
        var deviceKey = deviceSelect.value;
        var metricId = metricSelect.value;
        var history = typeof readDeviceHistory === 'function' ? readDeviceHistory(deviceKey) : [];
        var points = WptUi.buildTrendSeries(deviceKey, metricId, history, Date.now(), TREND_WINDOW_MS);
        if (!points.length) {
            empty.textContent = '暂无趋势数据';
            empty.style.display = 'block';
            if (trendChart) { trendChart.destroy(); trendChart = null; }
            return;
        }
        empty.style.display = 'none';
        var labels = points.map(function (p) { return WptUi.formatSourceTime(p.x); });
        var ctx = canvas.getContext('2d');
        if (trendChart) trendChart.destroy();
        trendChart = new ChartCtor(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: metricLabel(deviceKey, metricId),
                    data: points.map(function (p) { return p.y; }),
                    borderColor: deviceKey === 'rx' ? '#169873' : '#0891b2',
                    fill: false,
                    tension: 0.3,
                    pointRadius: 2,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: false },
                    x: { grid: { display: false } }
                }
            }
        });
    }

    async function syncAll() {
        var settled = await Promise.allSettled([
            OneNetService.getLatestData('tx'),
            OneNetService.getLatestData('rx')
        ]);
        var liveCount = 0;
        var maxTelemetry = null;
        settled.forEach(function (result, index) {
            var key = index === 0 ? 'tx' : 'rx';
            var data = result.status === 'fulfilled' ? result.value : null;
            var error = result.status === 'rejected' ? result.reason : null;
            var cls = renderEndpointSummary(key, data, error);
            if (cls.isLive) liveCount++;
            if (data && Number.isFinite(Number(data._telemetryTimestamp))) {
                var ts = Number(data._telemetryTimestamp);
                if (maxTelemetry === null || ts > maxTelemetry) maxTelemetry = ts;
            }
        });
        var summary = document.getElementById('systemSummary');
        if (summary) {
            summary.textContent = liveCount === 2 ? '2/2 实时' : (liveCount === 1 ? '1/2 实时' : '未建立实时链路');
        }
        var updated = document.getElementById('lastUpdateText');
        if (updated) {
            updated.textContent = maxTelemetry === null ? '--:--:--' : WptUi.formatSourceTime(maxTelemetry).slice(11);
        }
        updateAlertSummary(settled);
        refreshTrend();
    }

    /* 告警摘要：每轮两端同步后恰好评估一次；引擎异常不破坏遥测。 */
    function updateAlertSummary(settled) {
        var el = document.getElementById('monitorAlertSummary');
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
        if (!summary || summary.active === 0) {
            el.textContent = '无活动报警';
            el.dataset.state = 'clear';
        } else {
            el.textContent = summary.active + ' 项活动 · ' + summary.unacknowledged + ' 项未确认';
            el.dataset.state = summary.criticalActive > 0 ? 'critical' : 'warning';
        }
    }

    function renderStoredAlertSummary() {
        var el = document.getElementById('monitorAlertSummary');
        if (!el) return;
        try {
            if (typeof WptAlertEngine === 'undefined') throw new Error('engine missing');
            var summary = WptAlertEngine.getSummary();
            if (!summary || summary.active === 0) {
                el.textContent = '无活动报警';
                el.dataset.state = 'clear';
            } else {
                el.textContent = summary.active + ' 项活动 · ' + summary.unacknowledged + ' 项未确认';
                el.dataset.state = summary.criticalActive > 0 ? 'critical' : 'warning';
            }
        } catch (e) {
            el.textContent = '报警状态不可用';
            el.dataset.state = 'error';
        }
    }

    function onTrendChange() {
        rebuildMetricSelect();
        refreshTrend();
    }

    function init() {
        WptUi.markActiveNavigation();
        renderStoredAlertSummary();
        renderEndpointSummary('tx', null, null);
        renderEndpointSummary('rx', null, null);
        rebuildMetricSelect();
        refreshTrend();
        var deviceSelect = document.getElementById('trendDeviceSelect');
        var metricSelect = document.getElementById('trendMetricSelect');
        if (deviceSelect) deviceSelect.addEventListener('change', onTrendChange);
        if (metricSelect) metricSelect.addEventListener('change', onTrendChange);
        var refreshBtn = document.getElementById('refreshBtn');
        var poller = WptUi.createLifecyclePoller(syncAll, POLL_MS);
        if (refreshBtn) refreshBtn.addEventListener('click', function () {
            /* 手动触发同样吸收拒绝，避免未处理 Promise 拒绝。 */
            poller.runNow().catch(function () {});
        });
        WptUi.registerServiceWorker();
        poller.start();
    }

    init();
})();
