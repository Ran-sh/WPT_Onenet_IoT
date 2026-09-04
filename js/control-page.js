/**
 * WPT 双端控制台（V6.0.0）
 * 仅调用 OneNetService.sendProperty 与 WptControlCore；普通事务单次 POST、无乐观成功，
 * 安全抢占只在旧危险请求晚到时补发一次幂等 OFF/STOP。
 */
(function () {
    var POLL_MS = 5000;
    var RX_AUDIT_TIMEOUT_MS = 15000;
    var pending = { tx: false, rx: false };
    var pendingCommand = { tx: null, rx: null };
    var commandGeneration = { tx: 0, rx: 0 };
    var MAX_AUTO_SAFETY_COMPENSATIONS = 1;
    /* 安全状态与可清空操作日志完全分离；日志写失败时仍由此状态 fail-closed。 */
    var commandSafetyState = {
        tx: { danger: null, shutdown: null },
        rx: { danger: null, shutdown: null }
    };
    var pendingConfirm = null;
    var previousFocus = null;
    var lastSnapshot = {
        tx: { data: null, error: null },
        rx: { data: null, error: null }
    };
    var poller = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function setText(id, text) {
        var el = byId(id);
        if (el) el.textContent = text;
    }

    function setDisabled(id, disabled) {
        var el = byId(id);
        if (el) el.disabled = !!disabled;
    }

    function setStatus(message) {
        setText('controlStatus', message);
    }

    function currentConfig(deviceKey) {
        return typeof getOneNetConfig === 'function' ? getOneNetConfig(deviceKey) : null;
    }

    function isSafetyLatched(deviceKey) {
        var state = commandSafetyState[deviceKey];
        return !!(state && (state.danger || state.shutdown));
    }

    /* ---------- 渲染 ---------- */

    function txGateReason(perms) {
        if (pending.tx) return '命令执行中';
        if (isSafetyLatched('tx')) return '等待危险命令与安全关断终态确认';
        if (!perms.configured) return '未配置云端连接，请前往设置';
        if (!perms.live) return '实时数据不可用，控制已禁用';
        if (perms.on) return '';
        var state = Number(lastSnapshot.tx.data && lastSnapshot.tx.data.state);
        if (state === 3) return '故障状态，仅 OFF 可用';
        if (state === 1 || state === 2) return '运行/扫频中，仅调频与 OFF 可用';
        return '实时数据不可用，控制已禁用';
    }

    function rxGateReason(perms) {
        if (pending.rx || hasPendingRxAudit() || isSafetyLatched('rx')) return '等待上一条接收端命令确认';
        if (!perms.configured) return '未配置云端连接，请前往设置';
        if (perms.start) return '';
        var reason = WptControlCore.getRxStartGateReason(lastSnapshot.rx.data);
        if (!reason) return '';
        /* 实时数据可用但接收端安全门控未满足时，STOP/STATUS/RATE 仍可用；
         * 实时数据不可用时全部控制禁用，不再出现"仅安全命令"误导。 */
        return reason === '实时数据不可用' ? reason : reason + '（仅安全命令可用）';
    }

    function renderEndpoint(deviceKey, data, error) {
        var cls = WptUi.classifyEndpoint(data, error);
        var isTx = deviceKey === 'tx';
        var config = currentConfig(deviceKey);
        var live = cls.isLive && !!data;
        setText(deviceKey + 'EndpointState', cls.label);
        var stateEl = byId(deviceKey + 'EndpointState');
        if (stateEl) stateEl.dataset.state = cls.state;
        setText(deviceKey + 'SourceTime', data && data._telemetryTimestamp ? WptUi.formatSourceTime(data._telemetryTimestamp) : '--');
        setText(deviceKey + 'DeviceName', config && config.DEVICE_NAME ? config.DEVICE_NAME : '未配置');
        if (isTx) {
            setText('txStateValue', live ? WptUi.txStateLabel(data.state) : '--');
            setText('txVoltageValue', live ? WptUi.formatMetric(data.voltage, 2, 'V') : '--');
            setText('txCurrentValue', live ? WptUi.formatMetric(data.current, 3, 'A') : '--');
            setText('txFrequencyValue', live ? WptUi.formatMetric(data.freq, 1, 'kHz') : '--');
            var txPerms = WptControlCore.getTxPermissions({ config: config, data: data, error: error,
                pending: pending.tx, safetyLatched: isSafetyLatched('tx') });
            setText('txGateReason', txGateReason(txPerms));
            setDisabled('txOnBtn', !txPerms.on);
            setDisabled('txOffBtn', !txPerms.off);
            setDisabled('txFrequencyBtn', !txPerms.setfreq);
        } else {
            setText('rxStateValue', live ? WptUi.rxStateLabel(data.rx_state) : '--');
            setText('rxBleValue', live ? (data.rx_ble_online === true ? '正常' : '异常') : '--');
            setText('rxValidValue', live ? (data.rx_valid === true ? '有效' : '无效') : '--');
            setText('rxFaultValue', live ? String(data.rx_fault_flags) : '--');
            var rxPerms = WptControlCore.getRxPermissions({ config: config, data: data, error: error,
                pending: pending.rx || hasPendingRxAudit(), safetyLatched: isSafetyLatched('rx') });
            setText('rxGateReason', rxGateReason(rxPerms));
            setDisabled('rxStartBtn', !rxPerms.start);
            setDisabled('rxZeroBtn', !rxPerms.zero);
            setDisabled('rxStopBtn', !rxPerms.stop);
            setDisabled('rxStatusBtn', !rxPerms.status);
            setDisabled('rxRateBtn', !rxPerms.rate);
        }
    }

    function renderPermissions(deviceKey) {
        renderEndpoint(deviceKey, lastSnapshot[deviceKey].data, lastSnapshot[deviceKey].error);
    }

    /* ---------- 操作日志 ---------- */

    function logId() {
        return 'cmd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    }

    function appendLog(deviceKey, entry) {
        var base = {
            id: logId(),
            deviceKey: deviceKey,
            timestamp: Date.now(),
            command: '',
            requestedValue: null,
            outcome: 'blocked',
            accepted: false,
            confirmed: false,
            deviceCode: null,
            message: '',
            requestId: '',
            auditBaseline: null,
            auditSourceWatermark: null,
            auditOutcome: null,
            auditSequence: null,
            auditResult: ''
        };
        var merged = {};
        Object.keys(base).forEach(function (key) { merged[key] = base[key]; });
        Object.keys(entry || {}).forEach(function (key) { merged[key] = entry[key]; });
        WptControlCore.appendOperationLog(merged);
        return merged.id;
    }

    function resultLabel(entry) {
        return WptControlCore.classifyPropertyOutcome({
            outcome: entry.outcome,
            accepted: entry.accepted,
            confirmed: entry.confirmed,
            deviceCode: entry.deviceCode
        }).label;
    }

    function auditLabel(entry) {
        if (entry.auditOutcome === 'success') return '成功' + (entry.auditResult ? ' · ' + entry.auditResult : '');
        if (entry.auditOutcome === 'failed') return '失败' + (entry.auditResult ? ' · ' + entry.auditResult : '');
        if (entry.auditOutcome === 'pending') return '等待';
        return '--';
    }

    function renderOperationLogs() {
        var tbody = byId('operationLogBody');
        if (!tbody) return;
        tbody.textContent = '';
        var filterEl = byId('logDeviceFilter');
        var filter = filterEl ? filterEl.value : 'all';
        var logs = WptControlCore.readOperationLogs().filter(function (entry) {
            return filter === 'all' || entry.deviceKey === filter;
        });
        if (!logs.length) {
            var emptyRow = document.createElement('tr');
            var emptyCell = document.createElement('td');
            emptyCell.colSpan = 6;
            emptyCell.textContent = '暂无操作记录';
            emptyRow.appendChild(emptyCell);
            tbody.appendChild(emptyRow);
            return;
        }
        logs.forEach(function (entry) {
            var row = document.createElement('tr');
            var commandText = entry.command + (entry.requestedValue === null || entry.requestedValue === undefined ? '' : ' ' + entry.requestedValue);
            [
                WptUi.formatSourceTime(entry.timestamp),
                entry.deviceKey === 'tx' ? '发射端 TX' : '接收端 RX',
                commandText,
                resultLabel(entry),
                entry.requestId || '--',
                auditLabel(entry)
            ].forEach(function (text) {
                var td = document.createElement('td');
                td.textContent = String(text);
                row.appendChild(td);
            });
            tbody.appendChild(row);
        });
    }

    /* ---------- RX 审计 ---------- */

    /* RX 审计卡片选择：候选必须为 deviceKey==='rx' 且 auditBaseline!==null；未完成
     * （auditOutcome 非 success/failed）优先，均按 Number(timestamp) 取最新；同时间戳保持原顺序。 */
    function selectRxAuditEntry(logs) {
        var pending = null;
        var fallback = null;
        for (var i = 0; i < logs.length; i++) {
            var entry = logs[i];
            if (!entry || entry.deviceKey !== 'rx' || entry.auditBaseline === null) continue;
            if (entry.auditOutcome !== 'success' && entry.auditOutcome !== 'failed') {
                if (!pending || Number(entry.timestamp) > Number(pending.timestamp)) pending = entry;
            }
            if (!fallback || Number(entry.timestamp) > Number(fallback.timestamp)) fallback = entry;
        }
        return pending || fallback;
    }

    function hasPendingRxAudit() {
        return WptControlCore.readOperationLogs().some(function(entry) {
            return entry.deviceKey === 'rx' && entry.auditBaseline !== null &&
                entry.auditOutcome === 'pending' &&
                Date.now() - Number(entry.timestamp) < RX_AUDIT_TIMEOUT_MS;
        });
    }

    function supersedePendingRxAudits(excludedId) {
        WptControlCore.readOperationLogs().forEach(function(target) {
            if (!target || target.deviceKey !== 'rx' || target.id === excludedId ||
                target.auditOutcome !== 'pending') return;
            WptControlCore.updateOperationLog('rx', target.id, {
                auditOutcome: 'failed', auditSequence: null,
                auditResult: '被安全 STOP 取代'
            });
        });
    }

    function joinAuditMessage(message, suffix) {
        var base = String(message || '');
        return (base ? base + ' · ' : '') + suffix;
    }

    function markDangerSuperseded(deviceKey, safetyCommand) {
        var danger = commandSafetyState[deviceKey].danger;
        if (!danger) return;
        danger.supersededBy = safetyCommand;
        WptControlCore.updateOperationLog(deviceKey, danger.logId, {
            command: danger.command + '→' + safetyCommand,
            supersededBy: safetyCommand,
            message: joinAuditMessage(danger.message, '已被 ' + safetyCommand + ' 抢占，等待安全终态')
        });
    }

    function beginDangerState(deviceKey, generation, command, requestedValue, auditBaseline, auditSourceWatermark) {
        var id = logId();
        var danger = {
            generation: generation,
            command: command,
            requestedValue: requestedValue,
            logId: id,
            requestState: 'pending',
            message: '',
            supersededBy: null,
            auditBaseline: auditBaseline,
            auditSourceWatermark: auditSourceWatermark
        };
        /* 先建立内存锁，再尝试持久化；日志失败不得影响安全状态或放行后续危险命令。 */
        commandSafetyState[deviceKey].danger = danger;
        appendLog(deviceKey, {
            id: id,
            command: command,
            requestedValue: requestedValue,
            outcome: 'pending',
            message: '等待平台结果',
            auditBaseline: auditBaseline,
            auditSourceWatermark: auditSourceWatermark
        });
        return danger;
    }

    function settleDangerState(deviceKey, generation, outcome) {
        var state = commandSafetyState[deviceKey];
        var danger = state.danger;
        var cls;
        var marker;
        var late;
        var message;
        var shutdown;
        if (!danger || danger.generation !== generation) return null;
        cls = WptControlCore.classifyPropertyOutcome(outcome);
        marker = danger.supersededBy;
        shutdown = state.shutdown;
        late = !!(marker && shutdown && shutdown.dangerGeneration === generation && shutdown.terminalTrusted);
        message = String(outcome && outcome.message || '');
        if (marker) {
            message = joinAuditMessage(message,
                (late ? '迟到终态，' : '') + '已被 ' + marker + ' 抢占');
        }
        danger.requestState = cls.outcome;
        danger.message = message;
        WptControlCore.updateOperationLog(deviceKey, danger.logId, {
            command: marker ? danger.command + '→' + marker : danger.command,
            outcome: cls.outcome,
            accepted: !!(outcome && outcome.accepted),
            confirmed: !!(outcome && outcome.confirmed),
            deviceCode: outcome && outcome.deviceCode !== undefined ? outcome.deviceCode : null,
            message: message,
            requestId: String(outcome && outcome.requestId || ''),
            supersededBy: marker || '',
            lateSettlement: late,
            auditOutcome: deviceKey === 'rx' && cls.outcome === 'accepted_only' ? 'pending' : undefined
        });
        if (!marker) {
            /* accepted-only/传输未知仍可能在设备侧执行，必须保持独立危险锁。 */
            if (cls.outcome === 'confirmed' || cls.outcome === 'device_rejected') state.danger = null;
            return cls;
        }
        if (shutdown && shutdown.dangerGeneration === generation &&
            shutdown.dangerPendingAtDispatch && shutdown.terminalTrusted) {
            requestSafetyCompensation(deviceKey, '旧危险请求在安全关断后迟到');
        }
        return cls;
    }

    function beginShutdownState(deviceKey, generation, command, auditBaseline,
        auditSourceWatermark, isCompensation) {
        var state = commandSafetyState[deviceKey];
        var previous = state.shutdown;
        var danger = state.danger;
        var count = isCompensation
            ? (previous ? previous.compensationCount + 1 : 1) : 0;
        if (danger) markDangerSuperseded(deviceKey, command);
        state.shutdown = {
            generation: generation,
            command: command,
            requestState: 'pending',
            terminalTrusted: false,
            sourceWatermark: currentSafetySourceTime(deviceKey),
            terminalSourceWatermark: null,
            compensationCount: count,
            compensationScheduled: false,
            compensationNeeded: false,
            compensationReason: '',
            dangerGeneration: danger ? danger.generation : null,
            dangerPendingAtDispatch: !!(danger && danger.requestState === 'pending'),
            auditBaseline: auditBaseline,
            auditSourceWatermark: auditSourceWatermark
        };
    }

    function settleShutdownState(deviceKey, generation, outcome) {
        var shutdown = commandSafetyState[deviceKey].shutdown;
        var cls;
        var currentSource;
        if (!shutdown || shutdown.generation !== generation) return null;
        cls = WptControlCore.classifyPropertyOutcome(outcome);
        shutdown.requestState = cls.outcome;
        shutdown.terminalTrusted = !!(outcome && outcome.confirmed === true);
        if (shutdown.terminalTrusted) {
            currentSource = currentSafetySourceTime(deviceKey);
            shutdown.terminalSourceWatermark = shutdown.sourceWatermark;
            if (currentSource !== null && (shutdown.terminalSourceWatermark === null ||
                currentSource > shutdown.terminalSourceWatermark)) {
                shutdown.terminalSourceWatermark = currentSource;
            }
        }
        return cls;
    }

    function requestSafetyCompensation(deviceKey, reason) {
        var shutdown = commandSafetyState[deviceKey].shutdown;
        if (!shutdown || shutdown.compensationScheduled ||
            shutdown.compensationCount >= MAX_AUTO_SAFETY_COMPENSATIONS) return;
        if (pending[deviceKey]) {
            shutdown.compensationNeeded = true;
            shutdown.compensationReason = reason;
            return;
        }
        shutdown.compensationNeeded = false;
        shutdown.compensationScheduled = true;
        if (deviceKey === 'tx') executeTx('off', null, reason + '，补发最终 OFF', true);
        else executeRx('STOP', null, reason + '，补发最终 STOP', true);
    }

    function flushDeferredSafetyCompensation(deviceKey) {
        var shutdown = commandSafetyState[deviceKey].shutdown;
        if (!shutdown || !shutdown.compensationNeeded) return;
        requestSafetyCompensation(deviceKey,
            shutdown.compensationReason || '危险请求迟到');
    }

    function observeRuntimeRxAudit(data) {
        var state = commandSafetyState.rx;
        var danger = state.danger;
        var shutdown = state.shutdown;
        var outcome;
        var resultText = data && data.rx_command_result ? String(data.rx_command_result) : '';
        if (danger && danger.auditBaseline !== null && danger.auditSourceWatermark !== null) {
            outcome = getReceiverCommandOutcome(data, danger.auditBaseline,
                danger.command, danger.auditSourceWatermark);
            if (outcome.isNew && (outcome.outcome === 'success' || outcome.outcome === 'failed')) {
                WptControlCore.updateOperationLog('rx', danger.logId, {
                    auditOutcome: outcome.outcome,
                    auditSequence: outcome.sequence,
                    auditResult: resultText.slice(0, 160)
                });
                danger.requestState = outcome.outcome === 'success' ? 'confirmed' : 'device_rejected';
                if (!danger.supersededBy) state.danger = null;
            }
        }
        if (!shutdown || shutdown.terminalTrusted || shutdown.auditBaseline === null ||
            shutdown.auditSourceWatermark === null) return;
        outcome = getReceiverCommandOutcome(data, shutdown.auditBaseline,
            shutdown.command, shutdown.auditSourceWatermark);
        if (!outcome.isNew) return;
        if (outcome.outcome === 'success') {
            shutdown.requestState = 'confirmed';
            shutdown.terminalTrusted = true;
            shutdown.terminalSourceWatermark = currentSafetySourceTime('rx');
            supersedePendingRxAudits(null);
        } else if (outcome.outcome === 'failed') {
            shutdown.requestState = 'device_rejected';
        }
    }

    function observeSafetyTelemetry(deviceKey, data) {
        var state = commandSafetyState[deviceKey];
        var shutdown = state.shutdown;
        var danger = state.danger;
        var sourceTime;
        var safe;
        if (!shutdown || !shutdown.terminalTrusted || !data ||
            data._isOnline !== true || data._isFresh !== true) return;
        if (shutdown.compensationNeeded) {
            requestSafetyCompensation(deviceKey,
                shutdown.compensationReason || '危险请求迟到');
            return;
        }
        if (danger && shutdown.dangerGeneration === danger.generation &&
            danger.requestState === 'pending') return;
        sourceTime = currentSafetySourceTime(deviceKey);
        if (sourceTime === null || shutdown.terminalSourceWatermark === null ||
            sourceTime <= shutdown.terminalSourceWatermark) return;
        safe = deviceKey === 'tx'
            ? (Number(data.state) === 0 || Number(data.state) === 3)
            : data.rx_stim === false;
        if (!safe) {
            if (shutdown.dangerGeneration !== null) {
                requestSafetyCompensation(deviceKey, '安全关断后检测到危险设备态');
            }
            return;
        }
        if (danger && shutdown.dangerGeneration === danger.generation) {
            if (deviceKey === 'rx') {
                WptControlCore.updateOperationLog('rx', danger.logId, {
                    auditOutcome: 'failed', auditSequence: null,
                    auditResult: '被安全 STOP 终态取代'
                });
            }
            state.danger = null;
        }
        state.shutdown = null;
    }

    function renderAuditDisplay() {
        var logs = WptControlCore.readOperationLogs();
        var entry = selectRxAuditEntry(logs);
        setText('rxAuditSequence', entry && entry.auditSequence !== null ? String(entry.auditSequence) : '--');
        setText('rxAuditCommand', entry ? entry.command : '--');
        var auditText = '--';
        if (entry && entry.auditOutcome === 'success') auditText = '成功' + (entry.auditResult ? ' · ' + entry.auditResult : '');
        else if (entry && entry.auditOutcome === 'failed') auditText = '失败' + (entry.auditResult ? ' · ' + entry.auditResult : '');
        else if (entry && entry.auditOutcome === 'pending') auditText = '等待';
        setText('rxAuditResult', auditText);
    }

    function updateRxAudit() {
        var data = lastSnapshot.rx.data;
        var logs = WptControlCore.readOperationLogs();
        var target = selectRxAuditEntry(logs);
        if (target && target.auditOutcome !== 'success' && target.auditOutcome !== 'failed' &&
            typeof getReceiverCommandOutcome === 'function') {
            var outcome = getReceiverCommandOutcome(
                data, target.auditBaseline, target.command, target.auditSourceWatermark);
            if (outcome.isNew && (outcome.outcome === 'success' || outcome.outcome === 'failed')) {
                var resultText = data && data.rx_command_result ? String(data.rx_command_result) : '';
                WptControlCore.updateOperationLog(target.deviceKey, target.id, {
                    auditOutcome: outcome.outcome,
                    auditSequence: outcome.sequence,
                    auditResult: resultText.slice(0, 160)
                });
                if (target.command === 'STOP' && outcome.outcome === 'success') {
                    supersedePendingRxAudits(target.id);
                }
            } else if (Date.now() - Number(target.timestamp) >= RX_AUDIT_TIMEOUT_MS) {
                WptControlCore.updateOperationLog(target.deviceKey, target.id, {
                    auditOutcome: 'failed',
                    auditSequence: null,
                    auditResult: '接收端确认超时'
                });
            }
        }
        renderAuditDisplay();
    }

    /* ---------- TX 命令 ---------- */

    function txParamsFor(type, frequency) {
        if (type === 'on') return { switch: true };
        if (type === 'off') return { switch: false };
        return { setfreq: frequency };
    }

    function txCommandLabel(type, frequency) {
        if (type === 'on') return 'ON';
        if (type === 'off') return 'OFF';
        return 'SETFREQ=' + frequency;
    }

    function needsTxConfirm(type) {
        if (type === 'on') return true;
        if (type === 'setfreq') {
            var state = Number(lastSnapshot.tx.data && lastSnapshot.tx.data.state);
            return state === 1 || state === 2;
        }
        return false;
    }

    function executeTx(type, frequency, safetyReason, isCompensation) {
        var deviceKey = 'tx';
        var command = txCommandLabel(type, frequency);
        var requestedValue = type === 'on' ? true : (type === 'off' ? false : frequency);
        var generation;
        var cls;
        var message;
        /* 最终门控：以最新快照/配置/pending 复核；失败只写 blocked，不调用网络。 */
        var config = currentConfig('tx');
        var perms = WptControlCore.getTxPermissions({
            config: config,
            data: lastSnapshot.tx.data,
            error: lastSnapshot.tx.error,
            pending: pending.tx,
            safetyLatched: isSafetyLatched('tx')
        });
        var allowed = type === 'on' ? perms.on : (type === 'off' ? perms.off : perms.setfreq);
        if (!allowed) {
            var blockedReason = txGateReason(perms);
            appendLog(deviceKey, { command: command, requestedValue: requestedValue, outcome: 'blocked', message: blockedReason.slice(0, 160) });
            setStatus('已拦截：' + blockedReason);
            renderOperationLogs();
            return;
        }
        if (type === 'setfreq' && !WptControlCore.validateTxFrequency(frequency)) {
            appendLog(deviceKey, { command: command, requestedValue: requestedValue, outcome: 'blocked', message: '频率超出 20.0-200.0kHz 双档步进' });
            setStatus('已拦截：频率不合法');
            renderOperationLogs();
            return;
        }
        commandGeneration.tx++;
        generation = commandGeneration.tx;
        if (type === 'on') beginDangerState('tx', generation, command, requestedValue, null, null);
        if (type === 'off') beginShutdownState('tx', generation, command, null, null, isCompensation === true);
        pending.tx = true;
        pendingCommand.tx = type;
        renderPermissions('tx');
        OneNetService.sendProperty(deviceKey, txParamsFor(type, frequency)).then(function (outcome) {
            if (type === 'on') cls = settleDangerState('tx', generation, outcome);
            else if (type === 'off') cls = settleShutdownState('tx', generation, outcome);
            else cls = WptControlCore.classifyPropertyOutcome(outcome);
            if (generation !== commandGeneration.tx) return;
            if (type !== 'on') {
                message = safetyReason
                    ? joinAuditMessage(outcome.message, safetyReason) : String(outcome.message || '');
                appendLog(deviceKey, {
                    command: command,
                    requestedValue: requestedValue,
                    outcome: cls.outcome,
                    accepted: !!outcome.accepted,
                    confirmed: !!outcome.confirmed,
                    deviceCode: outcome.deviceCode === undefined || outcome.deviceCode === null ? null : Number(outcome.deviceCode),
                    message: message.slice(0, 160),
                    requestId: String(outcome.requestId || '').slice(0, 128)
                });
            }
            setStatus(cls.label);
            renderOperationLogs();
        }).catch(function () {
            var failed = { accepted: false, confirmed: false, deviceCode: null,
                message: '传输异常', requestId: '' };
            if (type === 'on') settleDangerState('tx', generation, failed);
            else if (type === 'off') settleShutdownState('tx', generation, failed);
            if (generation !== commandGeneration.tx) return;
            if (type !== 'on') appendLog(deviceKey, { command: command, requestedValue: requestedValue,
                outcome: 'transport_failed', message: String(safetyReason || '传输异常').slice(0, 160) });
            setStatus('传输失败');
            renderOperationLogs();
        }).finally(function () {
            if (generation === commandGeneration.tx) {
                pending.tx = false;
                pendingCommand.tx = null;
                renderPermissions('tx');
                flushDeferredSafetyCompensation('tx');
                if (poller) poller.runNow();
            }
        });
    }

    function dispatchTxCommand(type) {
        if (pending.tx && type !== 'off') return;
        if (pending.tx && pendingCommand.tx === 'off') {
            appendLog('tx', { command: 'OFF', requestedValue: false,
                outcome: 'blocked', message: '安全 OFF 已在执行' });
            setStatus('已拦截：安全 OFF 已在执行');
            renderOperationLogs();
            return;
        }
        var config = currentConfig('tx');
        var perms = WptControlCore.getTxPermissions({
            config: config,
            data: lastSnapshot.tx.data,
            error: lastSnapshot.tx.error,
            pending: pending.tx,
            safetyLatched: isSafetyLatched('tx')
        });
        var allowed = type === 'on' ? perms.on : (type === 'off' ? perms.off : perms.setfreq);
        if (!allowed) {
            var reason = txGateReason(perms);
            appendLog('tx', { command: txCommandLabel(type, null), outcome: 'blocked', message: reason.slice(0, 160) });
            setStatus('已拦截：' + reason);
            renderOperationLogs();
            return;
        }
        if (type === 'setfreq') {
            var input = byId('txFrequencyInput');
            var frequency = Number(input && input.value);
            if (!WptControlCore.validateTxFrequency(frequency)) {
                appendLog('tx', { command: 'SETFREQ', requestedValue: String(input ? input.value : ''), outcome: 'blocked', message: '频率超出 20.0-200.0kHz 双档步进' });
                setStatus('已拦截：频率不合法');
                renderOperationLogs();
                return;
            }
            if (needsTxConfirm(type)) {
                askConfirm('确认调频', '将设置发射频率为 ' + frequency + ' kHz，确认？', function () { executeTx(type, frequency); });
            } else {
                executeTx(type, frequency);
            }
            return;
        }
        if (needsTxConfirm(type)) {
            askConfirm(type === 'on' ? '确认启动' : '确认关闭', type === 'on' ? '将向发射端发送 ON，请确认设备已就绪？' : '将向发射端发送 OFF，确认？', function () { executeTx(type, null); });
        } else {
            executeTx(type, null);
        }
    }

    /* ---------- RX 命令 ---------- */

    function rxCommandValue(type) {
        if (type === 'start') return 'START';
        if (type === 'stop') return 'STOP';
        if (type === 'status') return 'STATUS';
        if (type === 'zero') return 'ZERO';
        return null;
    }

    function rxAuditBaseline() {
        var data = lastSnapshot.rx.data;
        var seq = data ? Number(data.rx_command_sequence) : NaN;
        if (!Number.isInteger(seq) || seq < 0 || seq > 2147483647) return null;
        return seq;
    }

    function rxAuditSourceWatermark() {
        var data = lastSnapshot.rx.data;
        var times = data && data._propertyTimes;
        var sequenceTime = Number(times && times.RX_CommandSequence);
        var watermark;
        var keys;
        var i;
        var value;
        if (!Number.isFinite(sequenceTime) || !Number.isInteger(sequenceTime)) return null;
        watermark = sequenceTime;
        keys = ['RX_Command', 'RX_CommandResult'];
        for (i = 0; i < keys.length; i++) {
            value = Number(times && times[keys[i]]);
            if (Number.isFinite(value) && Number.isInteger(value) && value > watermark) {
                watermark = value;
            }
        }
        return watermark;
    }

    function rxCommandType(command) {
        if (command === 'START') return 'start';
        if (command === 'STOP') return 'stop';
        if (command === 'STATUS') return 'status';
        if (command === 'ZERO') return 'zero';
        if (/^RATE=\d+$/.test(command)) return 'rate';
        return null;
    }

    function executeRx(command, rate, safetyReason, isCompensation) {
        var deviceKey = 'rx';
        var type = rxCommandType(command);
        var generation;
        var commandStartedMs;
        var auditSourceWatermark;
        var cls;
        var message;
        if (!type) return;
        /* 最终门控：以最新快照/配置/pending 复核，失败只写 blocked，不调用网络。 */
        var config = currentConfig('rx');
        var perms = WptControlCore.getRxPermissions({
            config: config,
            data: lastSnapshot.rx.data,
            error: lastSnapshot.rx.error,
            pending: pending.rx || hasPendingRxAudit(),
            safetyLatched: isSafetyLatched('rx')
        });
        var allowed = (type === 'start' || type === 'zero') ? perms.start
            : (type === 'rate' ? perms.rate : (type === 'stop' ? perms.stop : perms.status));
        if (!allowed) {
            var blockedReason = rxGateReason(perms);
            appendLog(deviceKey, { command: command, requestedValue: rate, outcome: 'blocked', message: blockedReason.slice(0, 160) });
            setStatus('已拦截：' + blockedReason);
            renderOperationLogs();
            return;
        }
        if (type === 'rate' && !WptControlCore.validateRate(rate)) {
            appendLog(deviceKey, { command: command, requestedValue: rate, outcome: 'blocked', message: 'RATE 需为 100-5000 整数' });
            setStatus('已拦截：RATE 不合法');
            renderOperationLogs();
            return;
        }
        /* 最终门控通过后、POST 前读取审计基线；无合法序号为 null，不伪造。 */
        var baseline = rxAuditBaseline();
        auditSourceWatermark = rxAuditSourceWatermark();
        if (baseline === null && type !== 'stop') {
            appendLog(deviceKey, { command: command, requestedValue: rate,
                outcome: 'blocked', message: '缺少接收端命令序号，无法建立确认链' });
            setStatus('已拦截：缺少接收端命令序号');
            renderOperationLogs();
            return;
        }
        if (auditSourceWatermark === null && type !== 'stop') {
            appendLog(deviceKey, { command: command, requestedValue: rate,
                outcome: 'blocked', message: '缺少接收端审计源时间，无法建立确认链' });
            setStatus('已拦截：缺少接收端审计源时间');
            renderOperationLogs();
            return;
        }
        commandStartedMs = Date.now();
        commandGeneration.rx++;
        generation = commandGeneration.rx;
        if (type === 'start') {
            beginDangerState('rx', generation, command, rate, baseline, auditSourceWatermark);
        }
        if (type === 'stop') {
            beginShutdownState('rx', generation, command, baseline,
                auditSourceWatermark, isCompensation === true);
        }
        pending.rx = true;
        pendingCommand.rx = type;
        renderPermissions('rx');
        OneNetService.sendProperty(deviceKey, { command: command }).then(function (outcome) {
            if (type === 'start') cls = settleDangerState('rx', generation, outcome);
            else if (type === 'stop') cls = settleShutdownState('rx', generation, outcome);
            else cls = WptControlCore.classifyPropertyOutcome(outcome);
            if (type === 'stop' && outcome.confirmed === true) supersedePendingRxAudits(null);
            if (generation !== commandGeneration.rx) return;
            if (type !== 'start') {
                message = safetyReason
                    ? joinAuditMessage(outcome.message, safetyReason) : String(outcome.message || '');
                appendLog(deviceKey, {
                    command: command,
                    timestamp: commandStartedMs,
                    requestedValue: rate,
                    outcome: cls.outcome,
                    accepted: !!outcome.accepted,
                    confirmed: !!outcome.confirmed,
                    deviceCode: outcome.deviceCode === undefined || outcome.deviceCode === null ? null : Number(outcome.deviceCode),
                    message: message.slice(0, 160),
                    requestId: String(outcome.requestId || '').slice(0, 128),
                    auditBaseline: baseline,
                    auditSourceWatermark: auditSourceWatermark,
                    auditOutcome: baseline !== null && auditSourceWatermark !== null &&
                        outcome.accepted === true && outcome.confirmed !== true &&
                        (outcome.deviceCode === null || outcome.deviceCode === undefined) ? 'pending' : null,
                    auditSequence: null,
                    auditResult: ''
                });
            }
            setStatus(cls.label);
            renderOperationLogs();
        }).catch(function () {
            var failed = { accepted: false, confirmed: false, deviceCode: null,
                message: '传输异常', requestId: '' };
            if (type === 'start') settleDangerState('rx', generation, failed);
            else if (type === 'stop') settleShutdownState('rx', generation, failed);
            if (generation !== commandGeneration.rx) return;
            if (type !== 'start') appendLog(deviceKey, { command: command, timestamp: commandStartedMs,
                requestedValue: rate, outcome: 'transport_failed',
                message: String(safetyReason || '传输异常').slice(0, 160), auditBaseline: baseline });
            setStatus('传输失败');
            renderOperationLogs();
        }).finally(function () {
            if (generation === commandGeneration.rx) {
                pending.rx = false;
                pendingCommand.rx = null;
                renderPermissions('rx');
                flushDeferredSafetyCompensation('rx');
                if (poller) poller.runNow();
            }
        });
    }

    function dispatchRxCommand(type) {
        if (pending.rx && type !== 'stop') return;
        if (pending.rx && pendingCommand.rx === 'stop') {
            appendLog('rx', { command: 'STOP', outcome: 'blocked', message: '安全 STOP 已在执行' });
            setStatus('已拦截：安全 STOP 已在执行');
            renderOperationLogs();
            return;
        }
        var config = currentConfig('rx');
        var perms = WptControlCore.getRxPermissions({
            config: config,
            data: lastSnapshot.rx.data,
            error: lastSnapshot.rx.error,
            pending: pending.rx || hasPendingRxAudit(),
            safetyLatched: isSafetyLatched('rx')
        });
        var allowed = type === 'start' ? perms.start : (type === 'zero' ? perms.zero : (type === 'rate' ? perms.rate : (type === 'stop' ? perms.stop : perms.status)));
        var command = rxCommandValue(type);
        if (!allowed) {
            var reason = rxGateReason(perms);
            appendLog('rx', { command: command || 'RATE', outcome: 'blocked', message: reason.slice(0, 160) });
            setStatus('已拦截：' + reason);
            renderOperationLogs();
            return;
        }
        if (type === 'rate') {
            var input = byId('rxRateInput');
            var rate = Number(input && input.value);
            if (!WptControlCore.validateRate(rate)) {
                appendLog('rx', { command: 'RATE', requestedValue: String(input ? input.value : ''), outcome: 'blocked', message: 'RATE 需为 100-5000 整数' });
                setStatus('已拦截：RATE 不合法');
                renderOperationLogs();
                return;
            }
            executeRx('RATE=' + rate, rate);
            return;
        }
        if (type === 'start' || type === 'zero') {
            askConfirm(type === 'start' ? '确认启动刺激' : '确认清零',
                type === 'start' ? '将向接收端发送 START，请确认安全条件满足？' : '将向接收端发送 ZERO，请确认安全条件满足？',
                function () { executeRx(command, null); });
        } else {
            executeRx(command, null);
        }
    }

    /* ---------- 轮询与生命周期 ---------- */

    function currentSafetySourceTime(deviceKey) {
        var data = lastSnapshot[deviceKey].data;
        var cloudKey = deviceKey === 'tx' ? 'S' : 'RX_Stim';
        var sourceTime = Number(data && data._propertyTimes && data._propertyTimes[cloudKey]);
        return Number.isFinite(sourceTime) && Number.isInteger(sourceTime) ? sourceTime : null;
    }

    async function syncAll() {
        var settled = await Promise.allSettled([
            OneNetService.getLatestData('tx'),
            OneNetService.getLatestData('rx')
        ]);
        settled.forEach(function (result, index) {
            var deviceKey = index === 0 ? 'tx' : 'rx';
            lastSnapshot[deviceKey] = {
                data: result.status === 'fulfilled' ? result.value : null,
                error: result.status === 'rejected' ? result.reason : null
            };
            if (deviceKey === 'rx') observeRuntimeRxAudit(lastSnapshot.rx.data);
            observeSafetyTelemetry(deviceKey, lastSnapshot[deviceKey].data);
            renderEndpoint(deviceKey, lastSnapshot[deviceKey].data, lastSnapshot[deviceKey].error);
        });
        updateRxAudit();
        renderOperationLogs();
    }

    /* ---------- 确认对话框 ---------- */

    function askConfirm(title, message, onConfirm) {
        var dialog = byId('controlConfirmDialog');
        if (!dialog) return;
        pendingConfirm = onConfirm;
        previousFocus = typeof document !== 'undefined' && document.activeElement ? document.activeElement : null;
        var titleEl = byId('controlConfirmTitle');
        var messageEl = byId('controlConfirmMessage');
        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;
        dialog.hidden = false;
        var cancelBtn = byId('controlConfirmCancel');
        if (cancelBtn && typeof cancelBtn.focus === 'function') cancelBtn.focus();
    }

    function closeDialog() {
        pendingConfirm = null;
        var dialog = byId('controlConfirmDialog');
        if (dialog) dialog.hidden = true;
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        previousFocus = null;
    }

    function confirmCurrent() {
        if (!pendingConfirm) return;
        var action = pendingConfirm;
        closeDialog();
        action();
    }

    /* ---------- 初始化 ---------- */

    function init() {
        if (typeof WptUi !== 'undefined' && typeof WptUi.markActiveNavigation === 'function') {
            WptUi.markActiveNavigation();
        }
        var syncBtn = byId('controlSyncBtn');
        if (syncBtn) syncBtn.addEventListener('click', function () { if (poller) poller.runNow(); });
        var txOnBtn = byId('txOnBtn');
        var txOffBtn = byId('txOffBtn');
        var txFreqForm = byId('txFrequencyForm');
        var rxStartBtn = byId('rxStartBtn');
        var rxStopBtn = byId('rxStopBtn');
        var rxStatusBtn = byId('rxStatusBtn');
        var rxZeroBtn = byId('rxZeroBtn');
        var rxRateForm = byId('rxRateForm');
        var confirmBtn = byId('controlConfirmConfirm');
        var cancelBtn = byId('controlConfirmCancel');
        var clearLogsBtn = byId('clearOperationLogsBtn');
        var logFilter = byId('logDeviceFilter');
        if (txOnBtn) txOnBtn.addEventListener('click', function () { dispatchTxCommand('on'); });
        if (txOffBtn) txOffBtn.addEventListener('click', function () { dispatchTxCommand('off'); });
        if (txFreqForm) txFreqForm.addEventListener('submit', function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            dispatchTxCommand('setfreq');
        });
        if (rxStartBtn) rxStartBtn.addEventListener('click', function () { dispatchRxCommand('start'); });
        if (rxStopBtn) rxStopBtn.addEventListener('click', function () { dispatchRxCommand('stop'); });
        if (rxStatusBtn) rxStatusBtn.addEventListener('click', function () { dispatchRxCommand('status'); });
        if (rxZeroBtn) rxZeroBtn.addEventListener('click', function () { dispatchRxCommand('zero'); });
        if (rxRateForm) rxRateForm.addEventListener('submit', function (e) {
            if (e && typeof e.preventDefault === 'function') e.preventDefault();
            dispatchRxCommand('rate');
        });
        if (confirmBtn) confirmBtn.addEventListener('click', confirmCurrent);
        if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);
        if (clearLogsBtn) clearLogsBtn.addEventListener('click', function () {
            askConfirm('清空操作记录', '将删除本机全部操作日志，确认？', function () {
                WptControlCore.clearOperationLogs();
                renderOperationLogs();
                renderAuditDisplay();
                setStatus('操作记录已清空');
            });
        });
        if (logFilter) logFilter.addEventListener('change', renderOperationLogs);
        document.addEventListener('keydown', function (e) {
            if (!e) return;
            var dialog = byId('controlConfirmDialog');
            if (!dialog || dialog.hidden) return;
            if (e.key === 'Escape') {
                closeDialog();
                return;
            }
            if (e.key !== 'Tab') return;
            var cancel = byId('controlConfirmCancel');
            var confirm = byId('controlConfirmConfirm');
            var active = typeof document !== 'undefined' ? document.activeElement : null;
            if (e.shiftKey) {
                if (active === confirm && cancel && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    cancel.focus();
                } else if (confirm && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    confirm.focus();
                }
            } else {
                if (active === cancel && confirm && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    confirm.focus();
                } else if (cancel && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    cancel.focus();
                }
            }
        });
        renderOperationLogs();
        renderAuditDisplay();
        if (typeof WptUi !== 'undefined' && typeof WptUi.registerServiceWorker === 'function') {
            WptUi.registerServiceWorker();
        }
        poller = WptUi.createLifecyclePoller(syncAll, POLL_MS);
        poller.start();
    }

    init();
})();
