/**
 * WPT 历史页（V6.0.0）
 * 云历史查询：TX/RX/双端比较三种模式、1h/6h/24h、独立指标选择。
 * 只调用 OneNetService.getPropertyHistory；不读不写本地历史。
 */
(function () {
    var POLL_MS = 60000;
    var LIMIT = 100;
    var PAIR_TOLERANCE_MS = 5000;
    var RANGES = { '1': 3600000, '6': 21600000, '24': 86400000 };
    var TX_HISTORY_METRICS = ['voltage', 'current', 'freq', 'state'];
    var loading = false;
    var reloadPending = false;
    var currentRows = [];
    var currentSelection = null;
    var trendChart = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function setStatus(text) {
        var el = byId('historyStatus');
        if (el) el.textContent = text;
    }

    function setBusy(busy) {
        var refresh = byId('historyRefreshBtn');
        if (refresh) refresh.disabled = !!busy;
    }

    function metricDisplayLabel(deviceKey, metricId) {
        var model = typeof getDataModel === 'function' ? getDataModel(deviceKey) : { sensors: [] };
        for (var i = 0; i < model.sensors.length; i++) {
            var sensor = model.sensors[i];
            if (sensor.id === metricId) {
                return sensor.name + (sensor.unit ? ' (' + sensor.unit + ')' : '');
            }
        }
        return metricId;
    }

    function fillMetrics(select, sensors, fallback) {
        if (!select) return;
        /* 清空前保存原选择；若仍合法则保持，否则回退默认。 */
        var previous = select.value;
        select.textContent = '';
        var ids = [];
        sensors.forEach(function (sensor) {
            var option = document.createElement('option');
            option.value = sensor.id;
            option.textContent = sensor.name + ' (' + sensor.id + ')';
            select.appendChild(option);
            ids.push(sensor.id);
        });
        if (previous && ids.indexOf(previous) !== -1) {
            select.value = previous;
        } else if (ids.indexOf(fallback) !== -1) {
            select.value = fallback;
        } else {
            select.value = ids[0] || '';
        }
    }

    function numericSensors(deviceKey) {
        var model = typeof getDataModel === 'function' ? getDataModel(deviceKey) : { sensors: [] };
        return model.sensors.filter(function (sensor) {
            return sensor.dataType === 'int32' || sensor.dataType === 'float' || sensor.dataType === 'double';
        });
    }

    /* TX 历史指标固定四项，顺序固定；旧本地模型附加数值项不显示。 */
    function txHistorySensors() {
        var model = typeof getDataModel === 'function' ? getDataModel('tx') : { sensors: [] };
        return TX_HISTORY_METRICS.map(function (metricId) {
            for (var i = 0; i < model.sensors.length; i++) {
                if (model.sensors[i].id === metricId) return model.sensors[i];
            }
            return null;
        }).filter(Boolean);
    }

    function rebuildMetricOptions() {
        var txSelect = byId('historyTxMetricSelect');
        var rxSelect = byId('historyRxMetricSelect');
        fillMetrics(txSelect, txHistorySensors(), 'voltage');
        fillMetrics(rxSelect, numericSensors('rx'), 'rx_current_ua');
    }

    function updateModeVisibility() {
        var select = byId('historyModeSelect');
        var mode = select ? select.value : 'tx';
        if (mode !== 'rx' && mode !== 'compare') mode = 'tx';
        var txSel = byId('historyTxSelector');
        var rxSel = byId('historyRxSelector');
        if (txSel) txSel.hidden = mode === 'rx';
        if (rxSel) rxSel.hidden = mode === 'tx';
    }

    /* ---------- 查询与渲染 ---------- */

    function selectionSnapshot() {
        var modeSelect = byId('historyModeSelect');
        var txSelect = byId('historyTxMetricSelect');
        var rxSelect = byId('historyRxMetricSelect');
        var rangeSelect = byId('historyRangeSelect');
        return JSON.stringify({
            mode: modeSelect ? modeSelect.value : 'tx',
            txMetric: txSelect ? txSelect.value : 'voltage',
            rxMetric: rxSelect ? rxSelect.value : 'rx_current_ua',
            range: rangeSelect ? rangeSelect.value : '1'
        });
    }

    function parseSelection(snapshot) {
        var parsed = JSON.parse(snapshot);
        var mode = parsed.mode === 'rx' ? 'rx' : (parsed.mode === 'compare' ? 'compare' : 'tx');
        var txMetric = parsed.txMetric || 'voltage';
        var rxMetric = parsed.rxMetric || 'rx_current_ua';
        return {
            mode: mode,
            txMetric: txMetric,
            rxMetric: rxMetric,
            range: parsed.range || '1',
            txLabel: metricDisplayLabel('tx', txMetric),
            rxLabel: metricDisplayLabel('rx', rxMetric)
        };
    }

    function queryWindow(range) {
        var rangeMs = RANGES[String(range)] || RANGES['1'];
        var now = Date.now();
        return { start: now - rangeMs, end: now };
    }

    function renderTable(selection) {
        var head = byId('historyTableHead');
        var body = byId('historyTableBody');
        if (!head || !body) return;
        head.textContent = '';
        body.textContent = '';
        var mode = selection.mode;
        var headers = mode === 'compare'
            ? ['对齐时间', 'TX 源时间', 'TX 数值', 'RX 源时间', 'RX 数值', '配对状态', '时间差']
            : ['源时间', '端点', '指标', '数值'];
        var headRow = document.createElement('tr');
        headers.forEach(function (header) {
            var th = document.createElement('th');
            th.textContent = header;
            headRow.appendChild(th);
        });
        head.appendChild(headRow);
        /* 表格默认新到旧 */
        var rows = currentRows.slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            var cells;
            if (mode === 'compare') {
                cells = [
                    WptUi.formatSourceTime(row.timestamp),
                    row.tx ? WptUi.formatSourceTime(row.tx.timestamp) : '--',
                    row.tx ? String(row.tx.value) : '--',
                    row.rx ? WptUi.formatSourceTime(row.rx.timestamp) : '--',
                    row.rx ? String(row.rx.value) : '--',
                    row.pairState === 'paired' ? '已配对' : '未配对',
                    row.deltaMs === null || row.deltaMs === undefined ? '--' : String(row.deltaMs)
                ];
            } else {
                cells = [
                    WptUi.formatSourceTime(row.timestamp),
                    row.deviceKey === 'rx' ? '接收端 RX' : '发射端 TX',
                    (mode === 'tx' ? selection.txLabel : selection.rxLabel) || row.metricId,
                    String(row.value)
                ];
            }
            cells.forEach(function (text) {
                var td = document.createElement('td');
                td.textContent = String(text);
                tr.appendChild(td);
            });
            body.appendChild(tr);
        });
    }

    function renderChart(selection) {
        var canvas = byId('historyChart');
        var empty = byId('historyEmpty');
        if (!canvas || !empty) return;
        var ChartCtor = typeof window !== 'undefined' ? window.Chart : null;
        if (typeof ChartCtor !== 'function') {
            empty.textContent = '图表组件不可用';
            empty.hidden = false;
            canvas.hidden = true;
            if (trendChart) { trendChart.destroy(); trendChart = null; }
            return;
        }
        if (!currentRows.length) {
            empty.textContent = '暂无云历史';
            empty.hidden = false;
            canvas.hidden = true;
            if (trendChart) { trendChart.destroy(); trendChart = null; }
            return;
        }
        empty.hidden = true;
        canvas.hidden = false;
        var mode = selection.mode;
        var datasets = [];
        var scales = {
            x: {
                type: 'linear',
                grid: { display: false },
                ticks: {
                    autoSkip: true,
                    maxTicksLimit: 6,
                    maxRotation: 0,
                    minRotation: 0,
                    /* 线性 x 轴显示 MM-DD HH:mm，避免原始毫秒时间戳。 */
                    callback: function (value) {
                        var formatted = WptUi.formatSourceTime(Number(value));
                        return formatted === '--' ? '--' : formatted.slice(5, 16);
                    }
                }
            }
        };
        if (mode === 'compare') {
            var txPoints = currentRows.filter(function (row) { return row.tx; }).map(function (row) {
                return { x: row.tx.timestamp, y: row.tx.value };
            });
            var rxPoints = currentRows.filter(function (row) { return row.rx; }).map(function (row) {
                return { x: row.rx.timestamp, y: row.rx.value };
            });
            datasets = [
                { label: 'TX ' + selection.txLabel, data: txPoints, parsing: false, fill: false, spanGaps: false, borderColor: '#0891b2', yAxisID: 'yTx', pointRadius: 2, borderWidth: 2 },
                { label: 'RX ' + selection.rxLabel, data: rxPoints, parsing: false, fill: false, spanGaps: false, borderColor: '#169873', yAxisID: 'yRx', pointRadius: 2, borderWidth: 2 }
            ];
            scales.yTx = { position: 'left', beginAtZero: false };
            scales.yRx = { position: 'right', beginAtZero: false };
        } else {
            var points = currentRows.map(function (row) {
                return { x: row.timestamp, y: row.value };
            });
            datasets = [{
                label: mode === 'rx' ? selection.rxLabel : selection.txLabel,
                data: points,
                parsing: false,
                fill: false,
                spanGaps: false,
                borderColor: mode === 'rx' ? '#169873' : '#0891b2',
                pointRadius: 2,
                borderWidth: 2
            }];
            scales.y = { beginAtZero: false };
        }
        var ctx = canvas.getContext('2d');
        if (trendChart) trendChart.destroy();
        trendChart = new ChartCtor(ctx, {
            type: 'line',
            data: { datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                plugins: {
                    legend: { display: true },
                    tooltip: {
                        callbacks: {
                            /* tooltip 标题显示完整 OneNET 源时间 YYYY-MM-DD HH:mm:ss。 */
                            title: function (items) {
                                if (!items || !items.length) return '';
                                var x = items[0] && items[0].parsed && items[0].parsed.x;
                                if (!Number.isFinite(Number(x))) return '';
                                return WptUi.formatSourceTime(Number(x));
                            }
                        }
                    }
                },
                scales: scales
            }
        });
    }

    function render(result, selection) {
        currentSelection = selection;
        var mode = selection.mode;
        var txPoints = result.tx || [];
        var rxPoints = result.rx || [];
        var rows = [];
        var statusText = '';
        if (mode === 'compare') {
            rows = WptHistoryCore.buildCompareRows(txPoints, rxPoints, PAIR_TOLERANCE_MS);
            if (result.failed) statusText = '查询失败';
            else if (result.partial) statusText = '部分成功';
            else if (rows.length) statusText = '已加载 ' + rows.length + ' 行云历史';
            else statusText = '暂无云历史';
        } else {
            var points = mode === 'tx' ? txPoints : rxPoints;
            rows = WptHistoryCore.buildSingleRows(points, mode);
            if (result.failed) statusText = '查询失败';
            else if (rows.length) statusText = '已加载 ' + rows.length + ' 条云历史';
            else statusText = '暂无云历史';
        }
        currentRows = rows;
        setStatus(statusText);
        renderTable(selection);
        renderChart(selection);
        var exportBtn = byId('historyExportBtn');
        if (exportBtn) exportBtn.disabled = rows.length === 0;
    }

    async function performQuery(selection) {
        var window = queryWindow(selection.range);
        if (selection.mode === 'compare') {
            var settled = await Promise.allSettled([
                OneNetService.getPropertyHistory('tx', selection.txMetric, window.start, window.end, LIMIT),
                OneNetService.getPropertyHistory('rx', selection.rxMetric, window.start, window.end, LIMIT)
            ]);
            var txOk = settled[0].status === 'fulfilled';
            var rxOk = settled[1].status === 'fulfilled';
            return {
                tx: txOk ? settled[0].value : null,
                rx: rxOk ? settled[1].value : null,
                partial: txOk !== rxOk,
                failed: !txOk && !rxOk
            };
        }
        var metric = selection.mode === 'tx' ? selection.txMetric : selection.rxMetric;
        var points = await OneNetService.getPropertyHistory(selection.mode, metric, window.start, window.end, LIMIT);
        return selection.mode === 'tx'
            ? { tx: points, rx: null, partial: false, failed: false }
            : { tx: null, rx: points, partial: false, failed: false };
    }

    async function load() {
        if (loading) {
            reloadPending = true;
            return;
        }
        loading = true;
        setBusy(true);
        try {
            do {
                reloadPending = false;
                var snapshot = selectionSnapshot();
                var selection = parseSelection(snapshot);
                updateModeVisibility();
                var result;
                try {
                    result = await performQuery(selection);
                } catch (e) {
                    if (reloadPending || snapshot !== selectionSnapshot()) {
                        reloadPending = true;
                        continue;
                    }
                    result = { tx: null, rx: null, partial: false, failed: true };
                }
                if (reloadPending || snapshot !== selectionSnapshot()) {
                    reloadPending = true;
                    continue;
                }
                render(result, selection);
            } while (reloadPending);
        } finally {
            loading = false;
            setBusy(false);
        }
    }

    /* ---------- 导出 ---------- */

    function exportCsv() {
        if (!currentRows.length) return;
        if (typeof Blob === 'undefined' || typeof URL === 'undefined') return;
        var selection = currentSelection || parseSelection(selectionSnapshot());
        var mode = selection.mode;
        var csv = WptHistoryCore.buildCsv({
            mode: mode,
            metricLabel: mode === 'rx' ? selection.rxLabel : selection.txLabel,
            txMetricLabel: selection.txLabel,
            rxMetricLabel: selection.rxLabel,
            rows: currentRows
        });
        var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        var d = new Date();
        function pad(n) { return n < 10 ? '0' + n : String(n); }
        a.download = 'WPT_history_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
            pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }

    /* ---------- 初始化 ---------- */

    function bindEvents(poller) {
        var refreshBtn = byId('historyRefreshBtn');
        var modeSelect = byId('historyModeSelect');
        var txSelect = byId('historyTxMetricSelect');
        var rxSelect = byId('historyRxMetricSelect');
        var rangeSelect = byId('historyRangeSelect');
        var exportBtn = byId('historyExportBtn');
        /* 每次变化先标记排队并立即应用控件可见性，再触发轮询；
         * load 在 in-flight 时通过 reloadPending 保证至少再执行一次最新选择。 */
        function requestReload() {
            reloadPending = true;
            updateModeVisibility();
            poller.runNow().catch(function () {});
        }
        if (refreshBtn) refreshBtn.addEventListener('click', requestReload);
        if (modeSelect) modeSelect.addEventListener('change', requestReload);
        if (txSelect) txSelect.addEventListener('change', requestReload);
        if (rxSelect) rxSelect.addEventListener('change', requestReload);
        if (rangeSelect) rangeSelect.addEventListener('change', requestReload);
        if (exportBtn) exportBtn.addEventListener('click', exportCsv);
    }

    function init() {
        if (typeof WptUi !== 'undefined' && typeof WptUi.markActiveNavigation === 'function') {
            WptUi.markActiveNavigation();
        }
        rebuildMetricOptions();
        updateModeVisibility();
        var poller = WptUi.createLifecyclePoller(load, POLL_MS);
        bindEvents(poller);
        if (typeof WptUi !== 'undefined' && typeof WptUi.registerServiceWorker === 'function') {
            WptUi.registerServiceWorker();
        }
        poller.start();
    }

    init();
})();
