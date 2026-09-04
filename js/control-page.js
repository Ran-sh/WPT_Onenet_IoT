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
    var safetyStartedMs = { tx: 0, rx: 0 };
    var safetySourceWatermark = { tx: null, rx: null };
    var safetyPreemption = { tx: null, rx: null };
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

    /* OFF/STOP 抢占普通请求时记录两个请求的代际与完成顺序。若旧危险请求最后完成，
     * 只补发一次幂等安全命令；若原安全命令最后完成，则其本身已保证最终顺序。 */
    function rememberSafetyPreemption(deviceKey, dangerGeneration, safetyGeneration) {
        safetyPreemption[deviceKey] = {
            dangerGeneration: dangerGeneration,
            safetyGeneration: safetyGeneration,
            dangerSettled: false,
            safetySettled: false
        };
    }

    function notePreemptedDangerSettled(deviceKey, generation) {
        var state = safetyPreemption[deviceKey];
        if (!state || state.dangerGeneration !== generation) return;
        state.dangerSettled = true;
        if (!state.safetySettled) return;
        /* 先清记录再补偿，保证补偿命令自身无论成功或失败都不会递归重试。 */
        safetyPreemption[deviceKey] = null;
        if (deviceKey === 'tx') executeTx('off', null, '旧危险请求晚到，补发最终 OFF');
        else executeRx('STOP', null, '旧危险请求晚到，补发最终 STOP');
    }

    function noteSafetySettled(deviceKey, generation) {
        var state = safetyPreemption[deviceKey];
        if (!state || state.safetyGeneration !== generation) return;
        state.safetySettled = true;
        /* 旧请求先完成、安全命令后完成时，已有安全的最终设备顺序，无需重复下发。 */
        if (state.dangerSettled) safetyPreemption[deviceKey] = null;
    }

    /* ---------- 渲染 ---------- */

    function txGateReason(perms) {
        if (pending.tx) return '命令执行中';
        if (!perms.configured) return '未配置云端连接，请前往设置';
        if (!perms.live) return '实时数据不可用，控制已禁用';
        if (perms.on) return '';
        var state = Number(lastSnapshot.tx.data && lastSnapshot.tx.data.state);
        if (state === 3) return '故障状态，仅 OFF 可用';
        if (state === 1 || state === 2) return '运行/扫频中，仅调频与 OFF 可用';
        return '实时数据不可用，控制已禁用';
    }

    function rxGateReason(perms) {
        if (pending.rx || hasPendingRxAudit()) return '等待上一条接收端命令确认';
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
                pending: pending.tx, safetyLatched: safetyStartedMs.tx !== 0 });
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
                pending: pending.rx || hasPendingRxAudit(), safetyLatched: safetyStartedMs.rx !== 0 });
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

    function executeTx(type, frequency, safetyReason) {
        var deviceKey = 'tx';
        var command = txCommandLabel(type, frequency);
        var requestedValue = type === 'on' ? true : (type === 'off' ? false : frequency);
        var generation;
        var preemptedGeneration = type === 'off' && pending.tx && pendingCommand.tx !== 'off'
            ? commandGeneration.tx : 0;
        /* 最终门控：以最新快照/配置/pending 复核；失败只写 blocked，不调用网络。 */
        var config = currentConfig('tx');
        var perms = WptControlCore.getTxPermissions({
            config: config,
            data: lastSnapshot.tx.data,
            error: lastSnapshot.tx.error,
            pending: pending.tx,
            safetyLatched: safetyStartedMs.tx !== 0
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
        if (preemptedGeneration !== 0) {
            rememberSafetyPreemption('tx', preemptedGeneration, generation);
        }
        if (type === 'off') {
            safetyStartedMs.tx = Date.now();
            safetySourceWatermark.tx = currentSafetySourceTime('tx');
        }
        pending.tx = true;
        pendingCommand.tx = type;
        renderPermissions('tx');
        OneNetService.sendProperty(deviceKey, txParamsFor(type, frequency)).then(function (outcome) {
            if (generation !== commandGeneration.tx) return;
            var cls = WptControlCore.classifyPropertyOutcome(outcome);
            appendLog(deviceKey, {
                command: command,
                requestedValue: requestedValue,
                outcome: cls.outcome,
                accepted: !!outcome.accepted,
                confirmed: !!outcome.confirmed,
                deviceCode: outcome.deviceCode === undefined || outcome.deviceCode === null ? null : Number(outcome.deviceCode),
                message: String(safetyReason || outcome.message || '').slice(0, 160),
                requestId: String(outcome.requestId || '').slice(0, 128)
            });
            setStatus(cls.label);
            renderOperationLogs();
        }).catch(function () {
            if (generation !== commandGeneration.tx) return;
            appendLog(deviceKey, { command: command, requestedValue: requestedValue,
                outcome: 'transport_failed', message: String(safetyReason || '传输异常').slice(0, 160) });
            setStatus('传输失败');
            renderOperationLogs();
        }).finally(function () {
            if (generation === commandGeneration.tx) {
                pending.tx = false;
                pendingCommand.tx = null;
                renderPermissions('tx');
                if (poller) poller.runNow();
            }
            if (type === 'off') noteSafetySettled('tx', generation);
            else notePreemptedDangerSettled('tx', generation);
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
            safetyLatched: safetyStartedMs.tx !== 0
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

    function executeRx(command, rate, safetyReason) {
        var deviceKey = 'rx';
        var type = rxCommandType(command);
        var generation;
        var commandStartedMs;
        var auditSourceWatermark;
        var preemptedGeneration = type === 'stop' && pending.rx && pendingCommand.rx !== 'stop'
            ? commandGeneration.rx : 0;
        if (!type) return;
        /* 最终门控：以最新快照/配置/pending 复核，失败只写 blocked，不调用网络。 */
        var config = currentConfig('rx');
        var perms = WptControlCore.getRxPermissions({
            config: config,
            data: lastSnapshot.rx.data,
            error: lastSnapshot.rx.error,
            pending: pending.rx || hasPendingRxAudit(),
            safetyLatched: safetyStartedMs.rx !== 0
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
        if (preemptedGeneration !== 0) {
            rememberSafetyPreemption('rx', preemptedGeneration, generation);
        }
        if (type === 'stop') {
            safetyStartedMs.rx = Date.now();
            safetySourceWatermark.rx = currentSafetySourceTime('rx');
        }
        pending.rx = true;
        pendingCommand.rx = type;
        renderPermissions('rx');
        OneNetService.sendProperty(deviceKey, { command: command }).then(function (outcome) {
            if (generation !== commandGeneration.rx) return;
            var cls = WptControlCore.classifyPropertyOutcome(outcome);
            if (type === 'stop' && outcome.confirmed === true) supersedePendingRxAudits(null);
            appendLog(deviceKey, {
                command: command,
                timestamp: commandStartedMs,
                requestedValue: rate,
                outcome: cls.outcome,
                accepted: !!outcome.accepted,
                confirmed: !!outcome.confirmed,
                deviceCode: outcome.deviceCode === undefined || outcome.deviceCode === null ? null : Number(outcome.deviceCode),
                message: String(safetyReason || outcome.message || '').slice(0, 160),
                requestId: String(outcome.requestId || '').slice(0, 128),
                auditBaseline: baseline,
                auditSourceWatermark: auditSourceWatermark,
                auditOutcome: baseline !== null && auditSourceWatermark !== null &&
                    outcome.accepted === true && outcome.confirmed !== true &&
                    (outcome.deviceCode === null || outcome.deviceCode === undefined) ? 'pending' : null,
                auditSequence: null,
                auditResult: ''
            });
            setStatus(cls.label);
            renderOperationLogs();
        }).catch(function () {
            if (generation !== commandGeneration.rx) return;
            appendLog(deviceKey, { command: command, timestamp: commandStartedMs,
                requestedValue: rate, outcome: 'transport_failed',
                message: String(safetyReason || '传输异常').slice(0, 160), auditBaseline: baseline });
            setStatus('传输失败');
            renderOperationLogs();
        }).finally(function () {
            if (generation === commandGeneration.rx) {
                pending.rx = false;
                pendingCommand.rx = null;
                renderPermissions('rx');
                if (poller) poller.runNow();
            }
            if (type === 'stop') noteSafetySettled('rx', generation);
            else notePreemptedDangerSettled('rx', generation);
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
            safetyLatched: safetyStartedMs.rx !== 0
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

    function clearConfirmedSafetyLatch(deviceKey, data) {
        var sourceTime;
        var watermark;

        if (!data || data._isOnline !== true || data._isFresh !== true ||
            safetyPreemption[deviceKey] !== null ||
            safetyStartedMs[deviceKey] === 0) return;
        if (deviceKey === 'tx') {
            sourceTime = Number(data._propertyTimes && data._propertyTimes.S);
            watermark = safetySourceWatermark.tx;
            if (Number.isFinite(sourceTime) && Number.isInteger(sourceTime) &&
                (watermark === null || sourceTime > watermark) &&
                (Number(data.state) === 0 || Number(data.state) === 3)) {
                safetyStartedMs.tx = 0;
                safetySourceWatermark.tx = null;
            }
            return;
        }
        sourceTime = Number(data._propertyTimes && data._propertyTimes.RX_Stim);
        watermark = safetySourceWatermark.rx;
        if (Number.isFinite(sourceTime) && Number.isInteger(sourceTime) &&
            (watermark === null || sourceTime > watermark) && data.rx_stim === false) {
            safetyStartedMs.rx = 0;
            safetySourceWatermark.rx = null;
        }
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
            clearConfirmedSafetyLatch(deviceKey, lastSnapshot[deviceKey].data);
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
