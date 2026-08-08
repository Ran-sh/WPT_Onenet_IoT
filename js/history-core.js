/**
 * WPT 历史核心（V6.0.0）
 * 纯逻辑：单端/双端行构建、±5000ms 源时间配对与安全 CSV。
 * 不依赖 DOM，不读写任何 localStorage。
 */
var WptHistoryCore = (function () {
    var DEFAULT_TOLERANCE_MS = 5000;

    function sourceTimeString(timestamp) {
        var t = Number(timestamp);
        if (!Number.isFinite(t)) return '';
        var d = new Date(t);
        function pad(n) { return n < 10 ? '0' + n : String(n); }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    /* 单端行：按源时间升序，保留端点与指标信息。 */
    function buildSingleRows(points, deviceKey) {
        var rows = [];
        (Array.isArray(points) ? points : []).forEach(function (point) {
            if (!point || typeof point !== 'object') return;
            var timestamp = Number(point.timestamp);
            if (!Number.isFinite(timestamp)) return;
            var value = point.value;
            /* 云历史契约只保留有限 number。 */
            if (typeof value !== 'number' || !Number.isFinite(value)) return;
            rows.push({
                timestamp: timestamp,
                deviceKey: deviceKey === 'rx' ? 'rx' : 'tx',
                metricId: typeof point.metricId === 'string' ? point.metricId : '',
                value: value
            });
        });
        rows.sort(function (a, b) { return a.timestamp - b.timestamp; });
        return rows;
    }

    /* 双端比较行：调用既有 alignHistoriesByTimestamp（按最小时间差、容差内一对一），
     * 未配对显式保留；不允许按数组下标配对；不修改输入。 */
    function buildCompareRows(txPoints, rxPoints, toleranceMs) {
        var tolerance = Number.isFinite(Number(toleranceMs)) ? Number(toleranceMs) : DEFAULT_TOLERANCE_MS;
        var txRows = buildSingleRows(txPoints, 'tx');
        var rxRows = buildSingleRows(rxPoints, 'rx');
        var aligned = typeof alignHistoriesByTimestamp === 'function'
            ? alignHistoriesByTimestamp(txRows, rxRows, tolerance)
            : [];
        var rows = aligned.map(function (row) {
            var paired = !!(row.tx && row.rx);
            return {
                timestamp: Number(row.timestamp),
                tx: row.tx || null,
                rx: row.rx || null,
                pairState: paired ? 'paired' : 'unpaired',
                deltaMs: paired ? Math.abs(Number(row.tx.timestamp) - Number(row.rx.timestamp)) : null
            };
        });
        rows.sort(function (a, b) { return a.timestamp - b.timestamp; });
        return rows;
    }

    /* CSV 单元格：合法数值（-1.25、1.、.5）原样返回；
     * 非数值先做公式前缀防护与双引号转义，再用一对双引号整体包裹，保证逗号/换行/引号不破坏列。 */
    function toCsvCell(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        var text = String(value);
        /* 完整纯数值判定：覆盖 -1.25、1.、.5 等合法数字，防止被当作公式注入。 */
        if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return text;
        if (/^[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
    }

    /* CSV：首行 UTF-8 BOM；只使用传入行，不读取 localStorage。 */
    function buildCsv(options) {
        var opts = options || {};
        var mode = opts.mode === 'rx' ? 'rx' : (opts.mode === 'compare' ? 'compare' : 'tx');
        var rows = Array.isArray(opts.rows) ? opts.rows : [];
        var lines = [];
        if (mode === 'compare') {
            /* 表头首字符固定为 T/R，不可能以 = + - @ 开头，无需内层预转义；
             * 整个表头单元格只经 map(toCsvCell) 编码一次，避免出现双层可见引号。 */
            var txValueHeader = 'TX 数值 (' + String(opts.txMetricLabel || '') + ')';
            var rxValueHeader = 'RX 数值 (' + String(opts.rxMetricLabel || '') + ')';
            lines.push(['对齐时间', 'TX源时间', txValueHeader, 'RX源时间', rxValueHeader, '配对状态', '时间差'].map(toCsvCell).join(','));
            rows.forEach(function (row) {
                lines.push([
                    toCsvCell(sourceTimeString(row.timestamp)),
                    toCsvCell(row.tx ? sourceTimeString(row.tx.timestamp) : ''),
                    toCsvCell(row.tx ? row.tx.value : ''),
                    toCsvCell(row.rx ? sourceTimeString(row.rx.timestamp) : ''),
                    toCsvCell(row.rx ? row.rx.value : ''),
                    toCsvCell(row.pairState === 'paired' ? '已配对' : '未配对'),
                    toCsvCell(row.deltaMs)
                ].join(','));
            });
        } else {
            lines.push(['源时间', '端点', '指标', '数值'].map(toCsvCell).join(','));
            var metricLabel = opts.metricLabel || '';
            rows.forEach(function (row) {
                lines.push([
                    toCsvCell(sourceTimeString(row.timestamp)),
                    toCsvCell(row.deviceKey === 'rx' ? '接收端 RX' : '发射端 TX'),
                    toCsvCell(metricLabel || row.metricId),
                    toCsvCell(row.value)
                ].join(','));
            });
        }
        return '\uFEFF' + lines.join('\r\n');
    }

    return {
        buildSingleRows: buildSingleRows,
        buildCompareRows: buildCompareRows,
        buildCsv: buildCsv,
        toCsvCell: toCsvCell
    };
})();
