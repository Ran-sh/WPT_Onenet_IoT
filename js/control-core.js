/**
 * WPT 控制核心（V6.0.0）
 * 唯一拥有权限门控、频率/RATE 校验、结果分类与 V2 操作日志规范化。
 * 纯逻辑只依赖传入参数与明确存储键，不发起任何网络请求。
 */
var WptControlCore = (function () {
    var MAX_SEQUENCE = 2147483647;
    var LOG_LIMIT = 100;
    var LOG_KEY = 'iot_operation_logs_v2';
    var OUTCOME_LABELS = {
        blocked: '本地拦截',
        transport_failed: '传输失败',
        accepted_only: '平台已受理，设备未确认',
        device_rejected: '设备已拒绝',
        confirmed: '设备已确认执行'
    };
    var LOG_OUTCOMES = ['blocked', 'transport_failed', 'accepted_only', 'device_rejected', 'confirmed'];
    var AUDIT_OUTCOMES = ['pending', 'success', 'failed'];

    function hasConfig(config) {
        return !!(config && config.PRODUCT_ID && config.DEVICE_NAME && config.TOKEN);
    }

    function isLive(data, error) {
        return !error && !!data && typeof data === 'object' &&
            data._isMock !== true && data._isOnline === true && data._isFresh === true;
    }

    /* TX 频率：20.0<=f<100.0 每 0.1；100<=f<=200 每 1kHz。 */
    function validateTxFrequency(frequency) {
        var f = Number(frequency);
        if (!Number.isFinite(f)) return false;
        if (f >= 20 && f < 100) return Math.abs(f * 10 - Math.round(f * 10)) <= 1e-7;
        if (f >= 100 && f <= 200) return Number.isInteger(f);
        return false;
    }

    /* RX RATE：100..5000 整数。 */
    function validateRate(rate) {
        var r = Number(rate);
        return Number.isInteger(r) && r >= 100 && r <= 5000;
    }

    /* TX 权限：ON/SETFREQ 需实时快照；OFF 只要已配置；同端 pending 全部关闭。 */
    function getTxPermissions(context) {
        var c = context || {};
        var configured = hasConfig(c.config);
        var live = isLive(c.data, c.error);
        var pending = c.pending === true;
        var state = live ? Number(c.data.state) : NaN;
        return {
            configured: configured,
            live: live,
            on: !pending && configured && live && state === 0,
            setfreq: !pending && configured && live && (state === 0 || state === 1 || state === 2),
            off: !pending && configured
        };
    }

    /* RX 权限：START/ZERO 严格映射 isReceiverStartAllowed；STOP/STATUS/RATE 只要已配置。 */
    function getRxPermissions(context) {
        var c = context || {};
        var configured = hasConfig(c.config);
        var pending = c.pending === true;
        var startAllowed = typeof isReceiverStartAllowed === 'function' && isReceiverStartAllowed(c.data);
        return {
            configured: configured,
            start: !pending && configured && startAllowed,
            zero: !pending && configured && startAllowed,
            stop: !pending && configured,
            status: !pending && configured,
            rate: !pending && configured
        };
    }

    /* START/ZERO 门控未满足时的原因说明（纯逻辑，与安全门控同源）。 */
    function getRxStartGateReason(data) {
        if (!data || typeof data !== 'object') return '实时数据不可用';
        if (data._isOnline !== true || data._isFresh !== true) return '实时数据不可用';
        if (data.rx_ble_online !== true) return 'BLE 未在线';
        if (data.rx_connected !== true) return 'BLE 未连接';
        if (data.rx_valid !== true) return '测量数据无效';
        if (data.rx_safe !== true) return '启动门控未允许';
        if (data.rx_state !== 2) return '接收端未就绪';
        if (data.rx_limit === true) return '限流开启';
        if (data.rx_stim === true) return '刺激进行中';
        if (data.rx_fault_flags !== 0) return '存在故障';
        return '';
    }

    /* 下发结果分类：confirmed 才叫确认；accepted 分设备拒绝/平台受理。 */
    function classifyPropertyOutcome(result) {
        if (result && result.outcome === 'blocked') {
            return { outcome: 'blocked', label: OUTCOME_LABELS.blocked };
        }
        if (result && result.confirmed === true) {
            return { outcome: 'confirmed', label: OUTCOME_LABELS.confirmed };
        }
        var rawDeviceCode = result && result.deviceCode;
        if (result && result.accepted === true && rawDeviceCode !== null && rawDeviceCode !== undefined &&
            Number.isFinite(Number(rawDeviceCode))) {
            return { outcome: 'device_rejected', label: OUTCOME_LABELS.device_rejected };
        }
        if (result && result.accepted === true) {
            return { outcome: 'accepted_only', label: OUTCOME_LABELS.accepted_only };
        }
        return { outcome: 'transport_failed', label: OUTCOME_LABELS.transport_failed };
    }

    function sanitizeText(value, maxLength) {
        return typeof value === 'string' ? value.slice(0, maxLength) : '';
    }

    function sanitizeLogEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var id = sanitizeText(raw.id, 64);
        var deviceKey = raw.deviceKey === 'rx' ? 'rx' : (raw.deviceKey === 'tx' ? 'tx' : null);
        var timestamp = Number(raw.timestamp);
        var command = sanitizeText(raw.command, 32);
        var outcome = LOG_OUTCOMES.indexOf(raw.outcome) !== -1 ? raw.outcome : null;
        if (!id || !deviceKey || !Number.isFinite(timestamp) || !command || !outcome) return null;
        var requestedValue = raw.requestedValue;
        if (typeof requestedValue !== 'string' && typeof requestedValue !== 'number' &&
            typeof requestedValue !== 'boolean' && requestedValue !== null) {
            requestedValue = null;
        }
        if (typeof requestedValue === 'string') requestedValue = requestedValue.slice(0, 64);
        var deviceCode = raw.deviceCode === null || raw.deviceCode === undefined ? null : Number(raw.deviceCode);
        if (deviceCode !== null && !Number.isFinite(deviceCode)) deviceCode = null;
        var auditBaseline = raw.auditBaseline === null || raw.auditBaseline === undefined ? null : Number(raw.auditBaseline);
        if (auditBaseline !== null && (!Number.isInteger(auditBaseline) || auditBaseline < 0 || auditBaseline > MAX_SEQUENCE)) auditBaseline = null;
        var auditSequence = raw.auditSequence === null || raw.auditSequence === undefined ? null : Number(raw.auditSequence);
        if (auditSequence !== null && (!Number.isInteger(auditSequence) || auditSequence < 0 || auditSequence > MAX_SEQUENCE)) auditSequence = null;
        var auditOutcome = AUDIT_OUTCOMES.indexOf(raw.auditOutcome) !== -1 ? raw.auditOutcome : null;
        return {
            id: id,
            deviceKey: deviceKey,
            timestamp: timestamp,
            command: command,
            requestedValue: requestedValue,
            outcome: outcome,
            accepted: raw.accepted === true,
            confirmed: raw.confirmed === true,
            deviceCode: deviceCode,
            message: sanitizeText(raw.message, 160),
            requestId: sanitizeText(raw.requestId, 128),
            auditBaseline: auditBaseline,
            auditOutcome: auditOutcome,
            auditSequence: auditSequence,
            auditResult: sanitizeText(raw.auditResult, 160)
        };
    }

    function readOperationLogs() {
        if (typeof localStorage === 'undefined') return [];
        var raw = null;
        try {
            raw = JSON.parse(localStorage.getItem(LOG_KEY));
        } catch (e) {
            return [];
        }
        if (!Array.isArray(raw)) return [];
        var logs = [];
        raw.forEach(function (item) {
            var clean = sanitizeLogEntry(item);
            if (clean) logs.push(clean);
        });
        logs.sort(function (a, b) { return b.timestamp - a.timestamp; });
        return logs.slice(0, LOG_LIMIT);
    }

    function writeOperationLogs(logs) {
        try {
            if (typeof localStorage === 'undefined') return false;
            localStorage.setItem(LOG_KEY, JSON.stringify(logs));
            return true;
        } catch (e) {
            return false;
        }
    }

    function appendOperationLog(entry) {
        var clean = sanitizeLogEntry(entry);
        if (!clean) return false;
        var logs = readOperationLogs();
        logs.unshift(clean);
        return writeOperationLogs(logs.slice(0, LOG_LIMIT));
    }

    function updateOperationLog(id, patch) {
        if (typeof id !== 'string' || !id) return false;
        var logs = readOperationLogs();
        var found = false;
        logs = logs.map(function (entry) {
            if (entry.id !== id) return entry;
            found = true;
            var merged = Object.assign({}, entry);
            if (patch && typeof patch === 'object') {
                if (patch.auditOutcome !== undefined) {
                    merged.auditOutcome = AUDIT_OUTCOMES.indexOf(patch.auditOutcome) !== -1 ? patch.auditOutcome : merged.auditOutcome;
                }
                if (patch.auditSequence !== undefined) {
                    var seq = patch.auditSequence === null ? null : Number(patch.auditSequence);
                    merged.auditSequence = seq !== null && (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQUENCE) ? merged.auditSequence : seq;
                }
                if (patch.auditResult !== undefined) merged.auditResult = sanitizeText(patch.auditResult, 160);
            }
            return merged;
        });
        if (!found) return false;
        return writeOperationLogs(logs);
    }

    function clearOperationLogs() {
        return writeOperationLogs([]);
    }

    return {
        validateTxFrequency: validateTxFrequency,
        validateRate: validateRate,
        getTxPermissions: getTxPermissions,
        getRxPermissions: getRxPermissions,
        getRxStartGateReason: getRxStartGateReason,
        classifyPropertyOutcome: classifyPropertyOutcome,
        readOperationLogs: readOperationLogs,
        appendOperationLog: appendOperationLog,
        updateOperationLog: updateOperationLog,
        clearOperationLogs: clearOperationLogs
    };
})();
