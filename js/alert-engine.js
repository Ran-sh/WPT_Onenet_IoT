/**
 * WPT 告警引擎（V6.0.0）
 * 双端 8 条规则的事件化告警状态机；唯一告警状态所有者。
 * 存储键精确为 iot_alerts_v2（数组）与 iot_alarm_states_v2（对象）。
 */
var WptAlertEngine = (function () {
    var MIN_TIME = 946684800000;
    var MAX_TIME = 4102444800000;
    var FRESH_WINDOW_MS = 15000;
    var MAX_INCIDENTS = 200;
    var INCIDENTS_KEY = 'iot_alerts_v2';
    var STATES_KEY = 'iot_alarm_states_v2';

    var RULES = [
        { deviceKey: 'tx', ruleId: 'tx_fault', cloudKey: 'S', valueKey: 'state', title: '发射端故障', severity: 'critical', unit: '', threshold: 3 },
        { deviceKey: 'tx', ruleId: 'tx_overcurrent', cloudKey: 'I', valueKey: 'current', title: '发射端过流', severity: 'critical', unit: 'A', threshold: 5 },
        { deviceKey: 'rx', ruleId: 'rx_fault_flags', cloudKey: 'RX_FaultFlags', valueKey: 'rx_fault_flags', title: '接收端故障', severity: 'critical', unit: '', threshold: 0 },
        { deviceKey: 'rx', ruleId: 'rx_limit', cloudKey: 'RX_Limit', valueKey: 'rx_limit', title: '接收端限流', severity: 'critical', unit: '', threshold: true },
        { deviceKey: 'rx', ruleId: 'rx_invalid', cloudKey: 'RX_Valid', valueKey: 'rx_valid', title: '接收端测量无效', severity: 'warning', unit: '', threshold: false },
        { deviceKey: 'rx', ruleId: 'rx_ble_offline', cloudKey: 'RX_BleOnline', valueKey: 'rx_ble_online', title: '接收端 BLE 断开', severity: 'warning', unit: '', threshold: false },
        { deviceKey: 'rx', ruleId: 'rx_disconnected', cloudKey: 'RX_Connected', valueKey: 'rx_connected', title: '接收端未连接', severity: 'warning', unit: '', threshold: false },
        { deviceKey: 'rx', ruleId: 'rx_telemetry_stale', cloudKey: 'RX_TelemetryFresh', valueKey: 'rx_telemetry_fresh', title: '接收端遥测过期', severity: 'warning', unit: '', threshold: false }
    ];
    var RULE_BY_ID = {};
    RULES.forEach(function (rule) { RULE_BY_ID[rule.ruleId] = rule; });

    function str(value, maxLength) {
        return typeof value === 'string' ? value.slice(0, maxLength) : '';
    }

    /* 严格时间：只接受 JSON number 且有限、位于 2000..2100；禁止字符串/布尔隐式转换。 */
    function strictTime(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        if (value < MIN_TIME || value > MAX_TIME) return null;
        return value;
    }

    function strictTimeOrNull(value) {
        if (value === null || value === undefined) return null;
        return strictTime(value);
    }

    function validNow(nowMs) {
        var t = Number(nowMs);
        if (Number.isFinite(t) && t >= MIN_TIME && t <= MAX_TIME) return t;
        return Date.now();
    }

    /* ---------- 清洗 ---------- */

    function sanitizeIncident(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var deviceKey = raw.deviceKey === 'rx' ? 'rx' : (raw.deviceKey === 'tx' ? 'tx' : null);
        var rule = deviceKey && RULE_BY_ID[raw.ruleId] ? RULE_BY_ID[raw.ruleId] : null;
        if (!deviceKey || !rule) return null;
        var startedAt = strictTime(raw.startedAt);
        var sourceTime = strictTime(raw.sourceTime);
        if (startedAt === null || sourceTime === null) return null;
        /* id 必须精确等于确定性形式，否则丢弃（防止损坏缓存伪造事件）。 */
        var id = deviceKey + ':' + rule.ruleId + ':' + startedAt;
        if (typeof raw.id !== 'string' || raw.id !== id) return null;
        var lastSeenAt = strictTime(raw.lastSeenAt);
        if (lastSeenAt === null) lastSeenAt = startedAt;
        var resolvedAt = strictTimeOrNull(raw.resolvedAt);
        var acknowledgedAt = strictTimeOrNull(raw.acknowledgedAt);
        var value = raw.value;
        if (typeof value === 'number' && !Number.isFinite(value)) value = null;
        if (typeof value !== 'number' && typeof value !== 'boolean') value = null;
        return {
            version: 1,
            id: id,
            deviceKey: deviceKey,
            ruleId: rule.ruleId,
            /* 规则元数据一律取规范值，损坏缓存不得篡改标题/级别/阈值/单位。 */
            title: rule.title,
            severity: rule.severity,
            active: raw.active === true,
            acknowledged: raw.acknowledged === true,
            startedAt: startedAt,
            lastSeenAt: lastSeenAt,
            resolvedAt: resolvedAt,
            acknowledgedAt: acknowledgedAt,
            sourceTime: sourceTime,
            value: value,
            threshold: rule.threshold,
            unit: rule.unit,
            message: str(raw.message, 160)
        };
    }

    function sanitizeState(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var lastSourceTime = strictTimeOrNull(raw.lastSourceTime);
        return {
            version: 1,
            lastSourceTime: lastSourceTime,
            activeIncidentId: typeof raw.activeIncidentId === 'string' ? raw.activeIncidentId.slice(0, 128) : null
        };
    }

    function readIncidents() {
        if (typeof localStorage === 'undefined') return [];
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(INCIDENTS_KEY)); } catch (e) { return []; }
        if (!Array.isArray(raw)) return [];
        var out = [];
        raw.forEach(function (item) {
            var clean = sanitizeIncident(item);
            if (clean) out.push(clean);
        });
        return out;
    }

    function readStates() {
        if (typeof localStorage === 'undefined') return {};
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(STATES_KEY)); } catch (e) { return {}; }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        var out = {};
        /* 只接受 8 个精确 state key（由 RULES 派生），忽略未知键。 */
        RULES.forEach(function (rule) {
            var key = rule.deviceKey + ':' + rule.ruleId;
            if (raw[key] !== undefined && raw[key] !== null) {
                var clean = sanitizeState(raw[key]);
                if (clean) out[key] = clean;
            }
        });
        return out;
    }

    function writeIncidents(incidents) {
        try {
            if (typeof localStorage === 'undefined') return false;
            localStorage.setItem(INCIDENTS_KEY, JSON.stringify(incidents));
            return true;
        } catch (e) {
            return false;
        }
    }

    function writeStates(states) {
        try {
            if (typeof localStorage === 'undefined') return false;
            localStorage.setItem(STATES_KEY, JSON.stringify(states));
            return true;
        } catch (e) {
            return false;
        }
    }

    /* 两个键各尝试写一次；任一失败 persisted=false，调用方不抛。 */
    function persistPair(incidents, states) {
        var incidentsOk = writeIncidents(incidents);
        var statesOk = writeStates(states);
        return incidentsOk && statesOk;
    }

    /* ---------- 归一化：重复 active、缺失/dangling state、排序与上限 ---------- */

    function normalizeIncidents(incidents, states) {
        var byRule = {};
        incidents.forEach(function (inc) {
            var key = inc.deviceKey + ':' + inc.ruleId;
            if (!byRule[key]) byRule[key] = [];
            byRule[key].push(inc);
        });
        var normalized = [];
        Object.keys(byRule).forEach(function (key) {
            var list = byRule[key];
            var activeList = list.filter(function (inc) { return inc.active; });
            var winner = null;
            activeList.forEach(function (inc) {
                if (!winner || inc.startedAt > winner.startedAt || (inc.startedAt === winner.startedAt && inc.id > winner.id)) winner = inc;
            });
            list.forEach(function (inc) {
                if (activeList.length > 1 && inc.active && inc !== winner) {
                    normalized.push(Object.assign({}, inc, { active: false, resolvedAt: winner.startedAt }));
                } else {
                    normalized.push(inc);
                }
            });
        });
        var activeByRule = {};
        normalized.forEach(function (inc) {
            if (inc.active) activeByRule[inc.deviceKey + ':' + inc.ruleId] = inc;
        });
        Object.keys(activeByRule).forEach(function (key) {
            var activeIncident = activeByRule[key];
            var state = states[key] || { version: 1, lastSourceTime: null, activeIncidentId: null };
            if (state.activeIncidentId !== activeIncident.id) state.activeIncidentId = activeIncident.id;
            if (state.lastSourceTime === null || activeIncident.sourceTime > state.lastSourceTime) {
                state.lastSourceTime = activeIncident.sourceTime;
            }
            states[key] = state;
        });
        Object.keys(states).forEach(function (key) {
            var state = states[key];
            if (state.activeIncidentId && !normalized.some(function (inc) {
                return inc.id === state.activeIncidentId && inc.active;
            })) {
                states[key] = Object.assign({}, state, { activeIncidentId: null });
            }
        });
        normalized.sort(function (a, b) { return b.startedAt - a.startedAt; });
        var active = normalized.filter(function (inc) { return inc.active; });
        var resolved = normalized.filter(function (inc) { return !inc.active; })
            .slice(0, Math.max(0, MAX_INCIDENTS - Math.min(active.length, MAX_INCIDENTS)));
        return { incidents: active.concat(resolved), states: states };
    }

    function buildSummary(incidents) {
        var summary = { total: incidents.length, active: 0, resolved: 0, unacknowledged: 0, criticalActive: 0 };
        incidents.forEach(function (inc) {
            if (inc.active) {
                summary.active += 1;
                if (inc.severity === 'critical') summary.criticalActive += 1;
            } else {
                summary.resolved += 1;
            }
            if (!inc.acknowledged) summary.unacknowledged += 1;
        });
        return summary;
    }

    /* ---------- 三态分类 ---------- */

    function classifyValue(rule, value) {
        if (rule.ruleId === 'tx_fault') {
            if (typeof value !== 'number' || !Number.isInteger(value)) return 'unknown';
            return value === 3 ? 'active' : (value === 0 || value === 1 || value === 2 ? 'safe' : 'unknown');
        }
        if (rule.ruleId === 'tx_overcurrent') {
            if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
            return value >= 5 ? 'active' : 'safe';
        }
        if (rule.ruleId === 'rx_fault_flags') {
            if (typeof value !== 'number' || !Number.isInteger(value)) return 'unknown';
            return value > 0 ? 'active' : (value === 0 ? 'safe' : 'unknown');
        }
        if (rule.ruleId === 'rx_limit') {
            if (typeof value !== 'boolean') return 'unknown';
            return value ? 'active' : 'safe';
        }
        if (typeof value !== 'boolean') return 'unknown';
        return value === false ? 'active' : 'safe';
    }

    /* ---------- 评估 ---------- */

    function evaluateSnapshots(snapshots, nowMs) {
        var now = validNow(nowMs);
        var incidents = readIncidents();
        var states = readStates();
        var norm = normalizeIncidents(incidents, states);
        incidents = norm.incidents;
        states = norm.states;
        RULES.forEach(function (rule) {
            var snapshot = snapshots && snapshots[rule.deviceKey];
            var data = snapshot ? snapshot.data : null;
            var error = snapshot ? snapshot.error : null;
            if (error || !data || typeof data !== 'object' || data._isOnline !== true) return;
            /* 新鲜度 fail-closed：工具缺失、函数缺失、抛错或返回非 true 一律该规则 no-op。 */
            if (typeof WptUi === 'undefined' || typeof WptUi.isPropertyCurrent !== 'function') return;
            var isCurrent = false;
            try {
                isCurrent = WptUi.isPropertyCurrent(data, rule.cloudKey, now, FRESH_WINDOW_MS) === true;
            } catch (e) {
                isCurrent = false;
            }
            if (!isCurrent) return;
            var tri = classifyValue(rule, data[rule.valueKey]);
            if (tri === 'unknown') return;
            var sourceTime = Number(data._propertyTimes && data._propertyTimes[rule.cloudKey]);
            if (!Number.isFinite(sourceTime)) return;
            var stateKey = rule.deviceKey + ':' + rule.ruleId;
            var state = states[stateKey] || { version: 1, lastSourceTime: null, activeIncidentId: null };
            var activeIncident = null;
            if (state.activeIncidentId) {
                for (var i = 0; i < incidents.length; i++) {
                    if (incidents[i].id === state.activeIncidentId && incidents[i].active) {
                        activeIncident = incidents[i];
                        break;
                    }
                }
            }
            if (state.lastSourceTime !== null && sourceTime < state.lastSourceTime) return;
            /* 等值 sourceTime：只允许维护同一 active，其他一律 no-op（不恢复、不新建、不推进）。 */
            if (state.lastSourceTime !== null && sourceTime === state.lastSourceTime) {
                if (tri === 'active' && activeIncident) {
                    activeIncident.lastSeenAt = sourceTime;
                    activeIncident.sourceTime = sourceTime;
                    activeIncident.value = data[rule.valueKey];
                    activeIncident.message = '';
                }
                return;
            }
            /* sourceTime > lastSourceTime（或 watermark 为 null）才允许恢复/新建/推进。 */
            if (tri === 'safe') {
                if (activeIncident) {
                    activeIncident.active = false;
                    activeIncident.resolvedAt = sourceTime;
                    activeIncident.lastSeenAt = Math.max(Number(activeIncident.lastSeenAt) || sourceTime, sourceTime);
                    state.activeIncidentId = null;
                }
                if (state.lastSourceTime === null || sourceTime > state.lastSourceTime) {
                    state.lastSourceTime = sourceTime;
                }
                states[stateKey] = state;
                return;
            }
            if (activeIncident) {
                activeIncident.lastSeenAt = sourceTime;
                activeIncident.sourceTime = sourceTime;
                activeIncident.value = data[rule.valueKey];
                activeIncident.message = '';
                return;
            }
            if (state.lastSourceTime !== null && sourceTime <= state.lastSourceTime) return;
            var incident = {
                version: 1,
                id: rule.deviceKey + ':' + rule.ruleId + ':' + sourceTime,
                deviceKey: rule.deviceKey,
                ruleId: rule.ruleId,
                title: rule.title,
                severity: rule.severity,
                active: true,
                acknowledged: false,
                startedAt: sourceTime,
                lastSeenAt: sourceTime,
                resolvedAt: null,
                acknowledgedAt: null,
                sourceTime: sourceTime,
                value: data[rule.valueKey],
                threshold: rule.threshold,
                unit: rule.unit,
                message: ''
            };
            incidents.push(incident);
            state.activeIncidentId = incident.id;
            state.lastSourceTime = sourceTime;
            states[stateKey] = state;
        });
        var final = normalizeIncidents(incidents, states);
        var persisted = persistPair(final.incidents, final.states);
        return {
            incidents: final.incidents,
            states: final.states,
            summary: buildSummary(final.incidents),
            persisted: persisted
        };
    }

    function getIncidents() {
        var states = readStates();
        var norm = normalizeIncidents(readIncidents(), states);
        return norm.incidents.map(function (inc) { return Object.assign({}, inc); });
    }

    function getSummary(optionalIncidents) {
        return buildSummary(optionalIncidents || getIncidents());
    }

    function acknowledge(id, nowMs) {
        var now = validNow(nowMs);
        var incidents = readIncidents();
        var states = readStates();
        var norm = normalizeIncidents(incidents, states);
        var changed = false;
        norm.incidents.forEach(function (inc) {
            if (inc.id === id && !inc.acknowledged) {
                inc.acknowledged = true;
                inc.acknowledgedAt = now;
                changed = true;
            }
        });
        var persisted = changed ? persistPair(norm.incidents, norm.states) : true;
        return { changed: changed, persisted: persisted, incidents: norm.incidents, summary: buildSummary(norm.incidents) };
    }

    function acknowledgeAll(nowMs) {
        var now = validNow(nowMs);
        var incidents = readIncidents();
        var states = readStates();
        var norm = normalizeIncidents(incidents, states);
        var changed = false;
        norm.incidents.forEach(function (inc) {
            if (!inc.acknowledged) {
                inc.acknowledged = true;
                inc.acknowledgedAt = now;
                changed = true;
            }
        });
        var persisted = changed ? persistPair(norm.incidents, norm.states) : true;
        return { changed: changed, persisted: persisted, incidents: norm.incidents, summary: buildSummary(norm.incidents) };
    }

    function clearResolved() {
        var incidents = readIncidents();
        var states = readStates();
        var norm = normalizeIncidents(incidents, states);
        var kept = norm.incidents.filter(function (inc) { return inc.active; });
        var changed = kept.length !== norm.incidents.length;
        var persisted = changed ? persistPair(kept, norm.states) : true;
        return { changed: changed, persisted: persisted, incidents: kept, summary: buildSummary(kept) };
    }

    return {
        evaluateSnapshots: evaluateSnapshots,
        getIncidents: getIncidents,
        getSummary: getSummary,
        acknowledge: acknowledge,
        acknowledgeAll: acknowledgeAll,
        clearResolved: clearResolved
    };
})();
