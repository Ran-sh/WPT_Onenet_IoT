/**
 * OneNET WPT Monitor Service（V6.0.0）
 * 用于与 OneNET 云平台进行数据同步
 * V4 双设备数据契约：TX/RX 配置、缓存、控制锁与历史完全隔离。
 */

/* 安全: 无 console 输出, 无 token 泄露 */
function safeJSONParse(str, fallback) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
}

/* ---------- 设备键与常量 ---------- */

function normalizeDeviceKey(deviceKey) {
    return deviceKey === 'rx' ? 'rx' : (deviceKey === 'tx' ? 'tx' : null);
}

function getDeviceKeyOrDefault(deviceKey) {
    return deviceKey === 'rx' ? 'rx' : 'tx';
}

/* 与旧接口兼容：省略 deviceKey 时默认 tx；显式传入非法键仍返回 null。 */
function normalizeDeviceKeyOrDefault(deviceKey) {
    return deviceKey === undefined || deviceKey === null ? 'tx' : normalizeDeviceKey(deviceKey);
}

function deviceStorageKey(deviceKey, base) {
    var key = getDeviceKeyOrDefault(deviceKey);
    return base + '_' + key;
}

/* 遥测新鲜窗口、最大未来偏差与 OneNET 源时间合法区间（2000-01-01 至 2100-01-01）。 */
var TELEMETRY_FRESH_MS = 15000;
var MAX_FUTURE_MS = 60000;
var MIN_SOURCE_TIME = 946684800000;
var MAX_SOURCE_TIME = 4102444800000;
var TX_CURRENT_TELEMETRY_MIN_A = 0;
var TX_CURRENT_TELEMETRY_MAX_A = 10;
var TX_TELEMETRY_CLOUD_KEYS = ['V', 'I', 'F', 'S'];
var RX_TELEMETRY_CLOUD_KEYS = ['RX_IMon', 'RX_Current_uA', 'RX_BoneP', 'RX_BoneN', 'RX_BoneV', 'RX_Resistance', 'RX_Vout', 'RX_Limit', 'RX_Stim', 'RX_Connected', 'RX_Valid', 'RX_FaultFlags'];
var RX_TELEMETRY_FRESH_KEY = 'RX_TelemetryFresh';
var RX_START_GATE_CLOUD_KEYS = [
    'RX_BleOnline', 'RX_Connected', 'RX_Valid', 'RX_Safe', 'RX_State',
    'RX_Limit', 'RX_Stim', 'RX_FaultFlags', RX_TELEMETRY_FRESH_KEY
];

/* ---------- 双设备 OneNET 配置 ---------- */

/* 新存储 iot_onenet_devices_v1={version:1,tx:{...},rx:{...}}；
 * 旧 iot_onenet_config 只单向迁移到 tx，绝不复制给 rx；
 * 主 store 写成功后移除旧键，clear TX 同样移除旧键防复活。 */

function isValidOneNetProductId(productId) {
    return typeof productId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(productId);
}

function isValidOneNetDeviceName(deviceName) {
    if (typeof deviceName !== 'string') return false;
    if (!deviceName || deviceName.length > 128) return false;
    return !/[\u0000-\u001F\u007F]/.test(deviceName);
}

function isValidOneNetToken(token) {
    if (typeof token !== 'string') return false;
    if (!token || token.length > 2048) return false;
    if (/[\u0000-\u001F\u007F]/.test(token)) return false;
    return token.indexOf('res=') !== -1 && token.indexOf('et=') !== -1 && token.indexOf('sign=') !== -1;
}

/* 纯函数：解析 Token 中唯一的十进制 et 秒字段为毫秒时间戳，供设置页过期预检；
 * 输入非字符串、格式不合法、et 缺失/非十进制/重复/数值越界一律返回 null；
 * 不修改、不解码、不记录 token，仅返回到期时间或 null。 */
function getOneNetTokenExpiryMs(token) {
    if (typeof token !== 'string') return null;
    if (!token || token.length > 2048) return null;
    if (!isValidOneNetToken(token)) return null;
    var parts = token.split('&');
    var etValue = null;
    var etCount = 0;
    for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf('et=') === 0) {
            etCount++;
            etValue = parts[i].slice(3);
        }
    }
    if (etCount !== 1) return null;
    if (!/^[1-9][0-9]{0,12}$/.test(etValue)) return null;
    var seconds = Number(etValue);
    if (!Number.isSafeInteger(seconds)) return null;
    var milliseconds = seconds * 1000;
    if (!Number.isSafeInteger(milliseconds)) return null;
    if (milliseconds > 8640000000000000) return null;
    return milliseconds;
}

/* 纯校验/规范化 helper：save/read 共用，设置页不得复制另一套规则。 */
function validateOneNetDeviceConfig(config) {
    if (!config || typeof config !== 'object') return { ok: false };
    var productId = typeof config.productId === 'string' ? config.productId.trim() : '';
    var deviceName = typeof config.deviceName === 'string' ? config.deviceName.trim() : '';
    var token = typeof config.token === 'string' ? config.token.trim() : '';
    if (!isValidOneNetProductId(productId)) return { ok: false };
    if (!isValidOneNetDeviceName(deviceName)) return { ok: false };
    if (!isValidOneNetToken(token)) return { ok: false };
    return { ok: true, productId: productId, deviceName: deviceName, token: token };
}

function removeStorageKey(key) {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
}

function readDeviceStore() {
    var store = getStoredObject('iot_onenet_devices_v1');
    var clean = { version: 1, tx: {}, rx: {} };
    if (store && store.version === 1) {
        var txRaw = store.tx && typeof store.tx === 'object' && !Array.isArray(store.tx) ? store.tx : {};
        var rxRaw = store.rx && typeof store.rx === 'object' && !Array.isArray(store.rx) ? store.rx : {};
        var txValidated = validateOneNetDeviceConfig(txRaw);
        var rxValidated = validateOneNetDeviceConfig(rxRaw);
        if (txValidated.ok) clean.tx = { productId: txValidated.productId, deviceName: txValidated.deviceName, token: txValidated.token };
        if (rxValidated.ok) clean.rx = { productId: rxValidated.productId, deviceName: rxValidated.deviceName, token: rxValidated.token };
    }
    if (!clean.tx.productId && !clean.tx.deviceName && !clean.tx.token) {
        var legacyValidated = validateOneNetDeviceConfig(getStoredObject('iot_onenet_config'));
        if (legacyValidated.ok) {
            clean.tx = { productId: legacyValidated.productId, deviceName: legacyValidated.deviceName, token: legacyValidated.token };
            if (writeStorage('iot_onenet_devices_v1', clean)) removeStorageKey('iot_onenet_config');
        }
    } else if (typeof localStorage !== 'undefined' && localStorage.getItem('iot_onenet_config') !== null) {
        /* 主 store 已有合法 TX：迁移已完成，清除遗留键防止复活。 */
        removeStorageKey('iot_onenet_config');
    }
    return clean;
}

/* 动态获取 OneNET 配置；非法设备键返回空配置，默认 tx。 */
function getOneNetConfig(deviceKey) {
    var empty = { PRODUCT_ID: '', DEVICE_NAME: '', TOKEN: '', BASE_URL: 'https://iot-api.heclouds.com' };
    var key = deviceKey === undefined || deviceKey === null ? 'tx' : normalizeDeviceKey(deviceKey);
    if (!key) return empty;
    var device = readDeviceStore()[key] || {};
    if (device.productId && device.deviceName && device.token) {
        return { PRODUCT_ID: device.productId, DEVICE_NAME: device.deviceName, TOKEN: device.token, BASE_URL: empty.BASE_URL };
    }
    return empty;
}

function saveOneNetDeviceConfig(deviceKey, config) {
    var key = normalizeDeviceKey(deviceKey);
    if (!key) return false;
    var validated = validateOneNetDeviceConfig(config);
    if (!validated.ok) return false;
    var store = readDeviceStore();
    store[key] = { productId: validated.productId, deviceName: validated.deviceName, token: validated.token };
    if (!writeStorage('iot_onenet_devices_v1', store)) return false;
    if (key === 'tx') removeStorageKey('iot_onenet_config');
    return true;
}

/* ---------- 精确数据维护（严禁 localStorage.clear） ---------- */

var TX_LEGACY_RUNTIME_KEYS = ['iot_latest_data', 'iot_control_locks', 'iot_history_data', 'iot_operation_logs', 'iot_alerts', 'iot_alarm_states'];

/* 数组型设备记录（iot_operation_logs_v2/iot_alerts_v2）：只移除匹配 deviceKey 的项。 */
function filterDeviceArrayKey(key, deviceKey) {
    if (typeof localStorage === 'undefined') return;
    var raw = localStorage.getItem(key);
    if (raw === null) return;
    var list = safeJSONParse(raw, null);
    if (!Array.isArray(list)) return;
    var kept = list.filter(function(item) { return !(item && item.deviceKey === deviceKey); });
    if (kept.length === list.length) return;
    if (kept.length === 0) removeStorageKey(key);
    else writeStorage(key, kept);
}

/* 对象型设备记录（iot_alarm_states_v2）：仅移除键前缀 '<deviceKey>:'。 */
function filterDeviceObjectKey(key, deviceKey) {
    if (typeof localStorage === 'undefined') return;
    var raw = localStorage.getItem(key);
    if (raw === null) return;
    var obj = safeJSONParse(raw, null);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    var prefix = deviceKey + ':';
    var changed = false;
    Object.keys(obj).forEach(function(stateKey) {
        if (stateKey.indexOf(prefix) === 0) {
            delete obj[stateKey];
            changed = true;
        }
    });
    if (changed) writeStorage(key, obj);
}

/* 只清该端运行缓存/历史/日志/报警，绝不动凭据、登录状态与本机偏好。 */
function clearDeviceRuntimeData(deviceKey) {
    var key = normalizeDeviceKey(deviceKey);
    if (!key) return false;
    removeStorageKey(deviceStorageKey(key, 'iot_latest_data'));
    removeStorageKey(deviceStorageKey(key, 'iot_control_locks'));
    removeStorageKey(deviceStorageKey(key, 'iot_history_data'));
    if (key === 'tx') {
        TX_LEGACY_RUNTIME_KEYS.forEach(function(legacyKey) { removeStorageKey(legacyKey); });
    }
    filterDeviceArrayKey('iot_operation_logs_v2', key);
    filterDeviceArrayKey('iot_alerts_v2', key);
    filterDeviceObjectKey('iot_alarm_states_v2', key);
    return true;
}

/* 清除该端配置（凭据）与该端运行数据；TX 同时移除遗留键防复活。 */
function clearOneNetDeviceConfig(deviceKey) {
    var key = normalizeDeviceKey(deviceKey);
    if (!key) return false;
    var store = readDeviceStore();
    store[key] = {};
    if (!writeStorage('iot_onenet_devices_v1', store)) return false;
    if (key === 'tx') removeStorageKey('iot_onenet_config');
    clearDeviceRuntimeData(key);
    return true;
}

/* 清两端运行缓存/旧运行键/日志/报警，保留 TX/RX 凭据与本地偏好。
 * 三个 V2 运行键无条件整体删除：无 deviceKey、未知 deviceKey 或损坏 JSON 的记录
 * 不得残留；严禁 localStorage.clear() 或遍历删除未知键。 */
function clearAllRuntimeData() {
    clearDeviceRuntimeData('tx');
    clearDeviceRuntimeData('rx');
    removeStorageKey('iot_operation_logs_v2');
    removeStorageKey('iot_alerts_v2');
    removeStorageKey('iot_alarm_states_v2');
    return true;
}

/* 所有网络请求都设置超时, 避免断网时页面长时间卡在加载状态。 */
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, timeoutMs || 10000);
    try {
        const requestOptions = Object.assign({}, options || {}, { signal: controller.signal });
        return await fetch(url, requestOptions);
    } finally {
        clearTimeout(timer);
    }
}

function writeStorage(key, value) {
    if (typeof writeLocalJSON === 'function') return writeLocalJSON(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}

/* ---------- 每设备存储读写（旧单设备键只做 TX 只读兼容） ---------- */

function readLatestData(deviceKey) {
    var key = getDeviceKeyOrDefault(deviceKey);
    var primary = getStoredObject(deviceStorageKey(key, 'iot_latest_data'));
    if (key === 'tx' && Object.keys(primary).length === 0) return getStoredObject('iot_latest_data');
    return primary;
}

function readControlLocks(deviceKey) {
    var key = getDeviceKeyOrDefault(deviceKey);
    var primary = getStoredObject(deviceStorageKey(key, 'iot_control_locks'));
    if (key === 'tx' && Object.keys(primary).length === 0) return getStoredObject('iot_control_locks');
    return primary;
}

function readDeviceHistory(deviceKey) {
    var key = getDeviceKeyOrDefault(deviceKey);
    var primary = typeof readLocalArray === 'function' ? readLocalArray(deviceStorageKey(key, 'iot_history_data')) : [];
    if (key === 'tx' && primary.length === 0) {
        var legacy = typeof readLocalArray === 'function' ? readLocalArray('iot_history_data') : [];
        return Array.isArray(legacy) ? legacy : [];
    }
    return primary;
}

function compactHistoryData(rawData) {
    var compacted = {};
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) return null;
    Object.keys(rawData).forEach(function(fieldName) {
        if (fieldName.charAt(0) === '_') return;
        var value = rawData[fieldName];
        if (typeof value === 'boolean' || typeof value === 'string' ||
            (typeof value === 'number' && Number.isFinite(value))) compacted[fieldName] = value;
    });
    return compacted;
}

function normalizeHistoryTimestamp(rawTimestamp, now) {
    var timestamp;
    var validated;
    if (typeof rawTimestamp === 'number') timestamp = rawTimestamp;
    else if (typeof rawTimestamp === 'string' && rawTimestamp.trim() !== '') timestamp = Number(rawTimestamp);
    else return null;
    if (!Number.isFinite(timestamp)) return null;
    validated = isValidSourceTime(timestamp);
    if (validated === false) return null;
    if (validated > now + MAX_FUTURE_MS) return null;
    return validated;
}

/* 历史写入前统一清洗旧/新条目，仅保留 OneNET 源时间语义。 */
function migrateDeviceHistory(deviceKey) {
    var key = getDeviceKeyOrDefault(deviceKey);
    var now = Date.now();
    var history = readDeviceHistory(key);
    if (!Array.isArray(history)) history = [];
    if (history.length === 0) return [];
    history = history.map(function(item) {
        var isLegacyTx;
        var normalizedKey;
        var timeSource;
        var timestamp;
        var data;
        if (!item || typeof item !== 'object') return null;
        isLegacyTx = key === 'tx' && item.deviceKey === undefined && item.timeSource === undefined &&
            (typeof item.time === 'string' || typeof item.fullTime === 'string');
        normalizedKey = isLegacyTx ? 'tx' : item.deviceKey;
        timeSource = isLegacyTx ? 'onenet' : item.timeSource;
        timestamp = normalizeHistoryTimestamp(item.timestamp, now);
        data = compactHistoryData(item.data);
        if (normalizedKey !== key || timeSource !== 'onenet' ||
            timestamp === null || data === null) return null;
        return { deviceKey: normalizedKey, timestamp: timestamp, timeSource: timeSource, data: data };
    }).filter(function(item) { return item !== null; }).slice(-1440);
    return history;
}

/* ---------- 命令与参数校验 ---------- */

/* RX 命令白名单整帧匹配：START/STOP/STATUS/ZERO/RATE=<100..5000 整数>，
 * 拒绝空格、符号、小数、尾随字符与越界。 */
function isValidReceiverCommand(command) {
    if (typeof command !== 'string') return false;
    if (/^(START|STOP|STATUS|ZERO)$/.test(command)) return true;
    var match = /^RATE=(\d+)$/.exec(command);
    if (!match) return false;
    var rate = Number(match[1]);
    return Number.isInteger(rate) && rate >= 100 && rate <= 5000;
}

function validateControlParams(model, params, deviceKey) {
    var keys = Object.keys(params || {});
    if (keys.length !== 1) return false;
    var key = normalizeDeviceKey(deviceKey) || 'tx';
    return keys.every(function(k) {
        var control = model.controls.find(function(item) { return item.id === k; });
        var value = params[k];
        if (!control) return false;
        if (control.dataType === 'bool') return typeof value === 'boolean';
        if (control.dataType === 'string') {
            if (typeof value !== 'string') return false;
            if (key === 'rx' && control.id === 'command') return isValidReceiverCommand(value);
            return true;
        }
        value = Number(value);
        if (!Number.isFinite(value)) return false;
        if (control.min !== undefined && value < control.min) return false;
        if (control.max !== undefined && value > control.max) return false;
        if (control.id === 'setfreq') {
            if (value < 100) return Math.abs(value * 10 - Math.round(value * 10)) <= 1e-7;
            return Number.isInteger(value);
        }
        if (!control.step || control.step <= 0) return true;
        var scaled = (value - (control.min || 0)) / control.step;
        return Math.abs(scaled - Math.round(scaled)) <= 1e-7;
    });
}

function getStoredObject(key) {
    if (typeof readLocalObject === 'function') return readLocalObject(key);
    var value = safeJSONParse(localStorage.getItem(key), {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeCloudValue(definition, rawValue) {
    if (!definition || rawValue === null || rawValue === undefined) return undefined;
    if (definition.dataType === 'bool') {
        if (rawValue === true || rawValue === 1 || rawValue === '1' || rawValue === 'true') return true;
        if (rawValue === false || rawValue === 0 || rawValue === '0' || rawValue === 'false') return false;
        return undefined;
    }
    if (definition.dataType === 'int32' || definition.dataType === 'float' || definition.dataType === 'double') {
        if (typeof rawValue === 'string' && !rawValue.trim()) return undefined;
        var number = Number(rawValue);
        if (!Number.isFinite(number)) return undefined;
        if (definition.dataType === 'int32' && !Number.isInteger(number)) return undefined;
        if (definition.fromCloud) number = definition.fromCloud(number);
        return Number.isFinite(number) ? number : undefined;
    }
    return String(rawValue).slice(0, 256);
}

function normalizeRawValue(value) {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    var text = value.trim();
    if (!text) return undefined;
    if (text === 'true') return true;
    if (text === 'false') return false;
    var numeric = Number(text);
    return Number.isFinite(numeric) ? numeric : text.slice(0, 256);
}

function owns(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

/* ---------- 属性响应解析：兼容 data 数组与 data.list，按源时间计算新鲜度 ---------- */

function extractPropertyItems(resultData) {
    if (Array.isArray(resultData)) return resultData;
    if (resultData && typeof resultData === 'object' && Array.isArray(resultData.list)) return resultData.list;
    return [];
}

function isCompatibleDataType(modelType, dataType) {
    if (modelType === dataType) return true;
    /* float 与 double 可互认；int32/bool/string 严格匹配。 */
    if (modelType === 'float' && dataType === 'double') return true;
    if (modelType === 'double' && dataType === 'float') return true;
    return false;
}

function isValidSourceTime(time) {
    var t = Number(time);
    if (!Number.isFinite(t)) return false;
    if (t < MIN_SOURCE_TIME || t > MAX_SOURCE_TIME) return false;
    /* 超过浏览器当前时间 60 秒以上的时间戳视为非法，不得作为新鲜依据。 */
    if (t > Date.now() + MAX_FUTURE_MS) return false;
    return t;
}

function isTelemetryValueInRange(definition, value, deviceKey) {
    var min = Number(definition.telemetryMin);
    var max = Number(definition.telemetryMax);
    /* 5A 是安全/告警边界，不是 CC6920-10A 入站数据的可表示上限。
     * 保留固定模型 max=5，避免 UI 与告警边界被解析容差反向放宽。 */
    if (deviceKey === 'tx' && definition.id === 'current') {
        min = TX_CURRENT_TELEMETRY_MIN_A;
        max = TX_CURRENT_TELEMETRY_MAX_A;
    } else {
        if (!Number.isFinite(min)) min = Number(definition.min);
        if (!Number.isFinite(max)) max = Number(definition.max);
    }
    if (Number.isFinite(min) && value < min) return false;
    if (Number.isFinite(max) && value > max) return false;
    return true;
}

function isStepValid(definition, value) {
    if (!definition.step || definition.step <= 0) return true;
    var min = Number.isFinite(Number(definition.min)) ? Number(definition.min) : 0;
    var scaled = (Number(value) - min) / definition.step;
    return Math.abs(scaled - Math.round(scaled)) <= 1e-7;
}

/* 返回 {data, raw, propertyTimes, telemetryTimestamp}；
 * 只接受合法 identifier，类型不兼容、越界、步进不符或值非法的字段直接丢弃。 */
function parsePropertyResponse(resultData, model, deviceKey) {
    var items = extractPropertyItems(resultData);
    var byCloud = {};
    /* 读回字段优先使用 sensor 定义（如 RX_Command 读回为 rx_command），
     * control 定义只负责写入方向，避免同一 cloudKey 覆盖读回 id。 */
    model.sensors.forEach(function(item) {
        if (item && item.cloudKey) byCloud[item.cloudKey] = item;
    });
    model.controls.forEach(function(item) {
        if (item && item.cloudKey && !owns(byCloud, item.cloudKey)) byCloud[item.cloudKey] = item;
    });
    var data = {}, raw = {}, propertyTimes = {};
    /* 必需遥测键：TX 为 V/I/F/S；RX 为 12 项遥测字段外加 RX_TelemetryFresh。
     * 每个必需键必须恰好出现一次、通过全部校验且具有合法源时间，整体才算完整。 */
    var telemetryKeys = deviceKey === 'rx' ? RX_TELEMETRY_CLOUD_KEYS.slice() : TX_TELEMETRY_CLOUD_KEYS.slice();
    if (deviceKey === 'rx') telemetryKeys.push(RX_TELEMETRY_FRESH_KEY);
    var telemetryOccurrences = {};
    var telemetryTimes = {};
    var telemetryValid = {};
    telemetryKeys.forEach(function(key) {
        telemetryOccurrences[key] = 0;
        telemetryTimes[key] = null;
        telemetryValid[key] = false;
    });
    items.slice(0, 64).forEach(function(item) {
        if (!item || typeof item.identifier !== 'string' ||
            !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(item.identifier)) return;
        var definition = byCloud[item.identifier];
        if (!definition) return;
        /* 同一必需 identifier 出现多次即视为重复，不允许作为完整快照。 */
        if (telemetryKeys.indexOf(item.identifier) !== -1) telemetryOccurrences[item.identifier] += 1;
        if (item.data_type !== undefined && item.data_type !== null &&
            !isCompatibleDataType(definition.dataType, String(item.data_type))) return;
        var normalized = normalizeCloudValue(definition, item.value);
        if (normalized === undefined) return;
        if (definition.dataType !== 'bool' && definition.dataType !== 'string') {
            if (definition.id === 'freq') {
                /* TX F 是 TIM1 实际 Hz：raw 只要求整数 Hz（IDLE/FAULT 按协议允许 0）
                 * 且 20000..200000，不套用控制目标的双档设置步进。 */
                var rawFreq = Number(item.value);
                if (!Number.isInteger(rawFreq) || !(rawFreq === 0 || (rawFreq >= 20000 && rawFreq <= 200000))) return;
            } else {
                if (!isTelemetryValueInRange(definition, normalized, deviceKey)) return;
                if (!isStepValid(definition, normalized)) return;
            }
        }
        data[definition.id] = normalized;
        raw[item.identifier] = normalizeRawValue(item.value);
        var sourceTime = isValidSourceTime(item.time);
        if (sourceTime !== false) {
            propertyTimes[item.identifier] = sourceTime;
            if (telemetryKeys.indexOf(item.identifier) !== -1) {
                telemetryTimes[item.identifier] = sourceTime;
                telemetryValid[item.identifier] = true;
            }
        }
    });
    var complete = true;
    var telemetryTimestamp = null;
    telemetryKeys.forEach(function(key) {
        if (telemetryOccurrences[key] !== 1 || !telemetryValid[key] || telemetryTimes[key] === null) {
            complete = false;
            return;
        }
        /* 完整快照时间戳取所有必需字段源时间的最小值（最保守/最老字段）。 */
        var time = telemetryTimes[key];
        if (telemetryTimestamp === null || time < telemetryTimestamp) telemetryTimestamp = time;
    });
    return {
        data: data,
        raw: raw,
        propertyTimes: propertyTimes,
        telemetry: {
            keys: telemetryKeys,
            occurrences: telemetryOccurrences,
            times: telemetryTimes,
            valid: telemetryValid,
            complete: complete,
            telemetryTimestamp: complete ? telemetryTimestamp : null
        }
    };
}

/* ---------- RX 安全门控与命令审计 ---------- */

/* START/ZERO 前置条件：每次判断都以当前时刻复核全部门控属性源时间，
 * 防止确认框停留期间把已过期的旧快照继续用于危险控制。 */
function isReceiverStartAllowed(data) {
    var now;
    var index;
    var sourceTime;
    var age;

    if (!data || typeof data !== 'object') return false;
    if (data._isOnline !== true || data._isFresh !== true) return false;
    if (data.rx_telemetry_fresh !== true) return false;
    now = Date.now();
    for (index = 0; index < RX_START_GATE_CLOUD_KEYS.length; index++) {
        sourceTime = data._propertyTimes && data._propertyTimes[RX_START_GATE_CLOUD_KEYS[index]];
        if (typeof sourceTime !== 'number' || !Number.isFinite(sourceTime) ||
            sourceTime < MIN_SOURCE_TIME || sourceTime > MAX_SOURCE_TIME) return false;
        age = now - sourceTime;
        if (age < -MAX_FUTURE_MS || age > TELEMETRY_FRESH_MS) return false;
    }
    if (data.rx_ble_online !== true || data.rx_connected !== true || data.rx_valid !== true || data.rx_safe !== true) return false;
    if (data.rx_state !== 2) return false;
    if (data.rx_limit !== false || data.rx_stim !== false) return false;
    return data.rx_fault_flags === 0;
}

var RX_MAX_AUDIT_SEQUENCE = 2147483647;

/* 命令审计终态：baseline/current 必须是 0..2147483647 的整数且命令整帧相等；
 * 新审计条件为 current>baseline，或 baseline=max 且 current=1（固件回绕）。
 * 三个审计属性源时间必须都严格越过 POST 前的远端源时间水位，禁止与浏览器墙钟比较。
 * 先按命令匹配真实成功/失败文本，再按通用失败/兜底 success|accepted 分类，其余 pending。 */
function getReceiverCommandOutcome(data, baselineSequence, command, sourceWatermark) {
    var empty = { isNew: false, outcome: 'pending', sequence: null };
    if (!data || typeof data !== 'object') return empty;
    var baseline = Number(baselineSequence);
    var sequence = Number(data.rx_command_sequence);
    if (!Number.isInteger(baseline) || baseline < 0 || baseline > RX_MAX_AUDIT_SEQUENCE) return empty;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > RX_MAX_AUDIT_SEQUENCE) return empty;
    var isNew = sequence > baseline || (baseline === RX_MAX_AUDIT_SEQUENCE && sequence === 1);
    if (!isNew) return empty;
    if (data.rx_command !== command) return empty;
    var watermark = Number(sourceWatermark);
    if (!Number.isFinite(watermark) || !Number.isInteger(watermark) ||
        watermark < MIN_SOURCE_TIME || watermark > MAX_SOURCE_TIME) return empty;
    var auditTimes = ['RX_Command', 'RX_CommandResult', 'RX_CommandSequence'].map(function(key) {
        return Number(data._propertyTimes && data._propertyTimes[key]);
    });
    if (auditTimes.some(function(time) {
        return !Number.isFinite(time) || !Number.isInteger(time) || time <= watermark;
    }) || Math.max.apply(null, auditTimes) - Math.min.apply(null, auditTimes) > 5000) return empty;
    /* 文本映射只按命令类型：完整 RATE=<整数> 归为 RATE，其余按原命令；
     * data.rx_command 与 command 的整帧相等校验不放宽。 */
    var commandType = /^RATE=\d+$/.test(command) ? 'RATE' : command;
    var resultText = String(data.rx_command_result || '').trim().toLowerCase();
    var outcome = 'pending';
    function terminalPattern(message) {
        return new RegExp('^(?:' + message + '|[a-z_]+:' + message + ':f=[0-9a-f]{4})$');
    }
    var successPattern = {
        START: terminalPattern('start accepted'),
        STOP: terminalPattern('stopped; fault cleared'),
        STATUS: terminalPattern('requested'),
        ZERO: terminalPattern('software zero recorded'),
        RATE: terminalPattern('rate accepted')
    };
    var failurePattern = {
        START: terminalPattern('start rejected'),
        STOP: terminalPattern('fault remains'),
        ZERO: terminalPattern('zero rejected'),
        RATE: terminalPattern('error rate 100\\.\\.5000')
    };
    if ((failurePattern[commandType] && failurePattern[commandType].test(resultText)) ||
        /^(receiver timeout|ble disconnected|rejected by receiver)$/.test(resultText)) {
        outcome = 'failed';
    } else if (successPattern[commandType] && successPattern[commandType].test(resultText)) {
        outcome = 'success';
    } else if (resultText === 'success') {
        outcome = 'success';
    }
    return { isNew: true, outcome: outcome, sequence: sequence };
}

/* ---------- 按源时间戳对齐双端历史 ---------- */

function isAlignableItem(item) {
    return item && typeof item === 'object' && Number.isFinite(Number(item.timestamp));
}

function cloneHistoryItem(item) {
    var copy = {};
    Object.keys(item).forEach(function(k) { copy[k] = item[k]; });
    return copy;
}

function byTimestamp(a, b) {
    return Number(a.timestamp) - Number(b.timestamp);
}

/* 纯函数：过滤无效项并按时间升序，通过动态规划最大化配对数，再最小化总时间差；
 * 未配对项也保留；禁止按数组下标配对；不修改输入数组。 */
function alignHistoriesByTimestamp(txHistory, rxHistory, toleranceMs) {
    var tolerance = Number.isFinite(Number(toleranceMs)) ? Number(toleranceMs) : 5000;
    var validTx = (Array.isArray(txHistory) ? txHistory : []).filter(isAlignableItem).map(cloneHistoryItem).sort(byTimestamp);
    var validRx = (Array.isArray(rxHistory) ? rxHistory : []).filter(isAlignableItem).map(cloneHistoryItem).sort(byTimestamp);
    var width = validRx.length + 1;
    var cells = (validTx.length + 1) * width;
    var pairCounts = new Int32Array(cells);
    var costs = new Float64Array(cells);
    var choices = new Uint8Array(cells);
    var matchedTx = new Uint8Array(validTx.length);
    var matchedRx = new Uint8Array(validRx.length);
    var rows = [];
    var i;
    var j;

    if (tolerance < 0) tolerance = 0;
    for (j = 1; j <= validRx.length; j++) choices[j] = 2;
    for (i = 1; i <= validTx.length; i++) {
        choices[i * width] = 1;
        for (j = 1; j <= validRx.length; j++) {
            var index = i * width + j;
            var up = (i - 1) * width + j;
            var left = i * width + j - 1;
            var diagonal = (i - 1) * width + j - 1;
            var bestCount = pairCounts[up];
            var bestCost = costs[up];
            var choice = 1;
            var diff = Math.abs(Number(validTx[i - 1].timestamp) - Number(validRx[j - 1].timestamp));

            if (pairCounts[left] > bestCount ||
                (pairCounts[left] === bestCount && costs[left] < bestCost)) {
                bestCount = pairCounts[left];
                bestCost = costs[left];
                choice = 2;
            }
            if (diff <= tolerance) {
                var pairedCount = pairCounts[diagonal] + 1;
                var pairedCost = costs[diagonal] + diff;
                if (pairedCount > bestCount ||
                    (pairedCount === bestCount && pairedCost < bestCost)) {
                    bestCount = pairedCount;
                    bestCost = pairedCost;
                    choice = 3;
                }
            }
            pairCounts[index] = bestCount;
            costs[index] = bestCost;
            choices[index] = choice;
        }
    }

    i = validTx.length;
    j = validRx.length;
    while (i > 0 || j > 0) {
        var backtrackChoice = choices[i * width + j];
        if (backtrackChoice === 3) {
            matchedTx[i - 1] = 1;
            matchedRx[j - 1] = 1;
            rows.push({
                timestamp: Number(validTx[i - 1].timestamp),
                tx: validTx[i - 1],
                rx: validRx[j - 1]
            });
            i--;
            j--;
        } else if (backtrackChoice === 1) {
            i--;
        } else {
            j--;
        }
    }
    validTx.forEach(function(txItem, index) {
        if (matchedTx[index] === 0) rows.push({ timestamp: Number(txItem.timestamp), tx: txItem, rx: null });
    });
    validRx.forEach(function(rxItem, index) {
        if (matchedRx[index] === 0) rows.push({ timestamp: Number(rxItem.timestamp), tx: null, rx: rxItem });
    });
    rows.sort(byTimestamp);
    return rows;
}

/* ---------- 属性设置：单次 POST，只有设备回复码 0/200 才算 confirmed ---------- */

function makePropertyOutcome(accepted, confirmed, deviceCode, message, requestId) {
    return {
        accepted: !!accepted,
        confirmed: !!confirmed,
        deviceCode: deviceCode === undefined || deviceCode === null ? null : deviceCode,
        message: message || '',
        requestId: requestId || ''
    };
}

/* requestId 只使用平台真实标识：合法字符串/数值的 result.request_id 优先，
 * 否则 data.id；均为空或类型非法时返回空字符串，不生成随机号。 */
function normalizePlatformRequestId(candidate) {
    if (typeof candidate === 'string' && candidate) return candidate.slice(0, 128);
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate).slice(0, 128);
    return '';
}

function extractPlatformRequestId(result, data) {
    if (result && result.request_id !== undefined && result.request_id !== null) {
        var requestId = normalizePlatformRequestId(result.request_id);
        if (requestId) return requestId;
    }
    if (data && data.id !== undefined && data.id !== null) {
        return normalizePlatformRequestId(data.id);
    }
    return '';
}

/* 只有 confirmed 才写对应设备缓存与 3 秒乐观锁；未确认绝不写。 */
function applyConfirmedCache(deviceKey, params) {
    var key = getDeviceKeyOrDefault(deviceKey);
    var cachedData = readLatestData(key);
    var controlLocks = readControlLocks(key);
    var now = Date.now();
    for (var k in params) {
        if (!owns(params, k)) continue;
        cachedData[k] = params[k];
        controlLocks[k] = now;
    }
    writeStorage(deviceStorageKey(key, 'iot_latest_data'), cachedData);
    writeStorage(deviceStorageKey(key, 'iot_control_locks'), controlLocks);
}

class OneNetService {
    static async getLatestData(deviceKey) {
        var key = normalizeDeviceKeyOrDefault(deviceKey);
        if (!key) throw new Error('非法设备键: 仅支持 tx/rx');
        var config = getOneNetConfig(key);
        try {
            if (!config.TOKEN) return this.getMockData(key);

            var model = typeof getDataModel === 'function' ? getDataModel(key) : { sensors: [], controls: [] };
            var productId = encodeURIComponent(config.PRODUCT_ID);
            var deviceName = encodeURIComponent(config.DEVICE_NAME);
            var url = config.BASE_URL + '/thingmodel/query-device-property?product_id=' + productId + '&device_name=' + deviceName;
            var statusUrl = config.BASE_URL + '/device/detail?product_id=' + productId + '&device_name=' + deviceName;

            var results = await Promise.all([
                fetchWithTimeout(url, { method: 'GET', headers: { 'Authorization': config.TOKEN } }, 10000),
                fetchWithTimeout(statusUrl, { method: 'GET', headers: { 'Authorization': config.TOKEN } }, 10000).catch(function() { return null; })
            ]);
            var response = results[0], statusResponse = results[1];

            if (!response.ok) {
                var errorText = '';
                try { errorText = await response.text(); } catch (e) {}
                if (response.status === 401) throw new Error('鉴权失败(401): 请检查 Token');
                if (response.status === 403) throw new Error('拒绝访问(403): 检查产品/设备名');
                if (response.status === 404) throw new Error('服务未找到(404): 检查 BASE_URL');
                if (response.status === 429) throw new Error('请求过于频繁(429): 请稍后刷新');
                if (response.status === 503) throw new Error('服务暂不可用(503): 服务器维护中');
                if (response.status === 406) {
                    var titleMatch = errorText.match(/<title>(.*?)<\/title>/i);
                    throw new Error('连接失败: ' + (titleMatch ? titleMatch[1] : '服务器拒绝请求(406)'));
                }
                throw new Error('HTTP Error: ' + response.status);
            }

            var result = await response.json();
            if (result.code !== 0) {
                if (result.code === 401 || (result.msg || '').toLowerCase().indexOf('token') !== -1)
                    throw new Error('Token 过期或格式错误');
                if ((result.msg || '').indexOf('device not found') !== -1)
                    throw new Error('找不到该设备');
                throw new Error('API错误(' + result.code + '): ' + result.msg);
            }

            var parsed = parsePropertyResponse(result.data, model, key);
            var data = parsed.data;
            /* 乐观锁: 3s 内确认下发过的属性不覆盖；其余字段只保留本次响应，不补旧缓存。 */
            var cachedData = readLatestData(key);
            var controlLocks = readControlLocks(key);
            var lockNow = Date.now();
            /* 历史快照：在乐观锁覆盖循环之前保存本次响应的原始值，历史记录云端原值而非被
             * 乐观覆盖后的显示值；显示缓存仍使用下方覆盖后的 data。 */
            var historySnapshot = Object.assign({}, data);
            for (var field in data) {
                if (owns(data, field) && controlLocks[field] && (lockNow - controlLocks[field] < 3000)) {
                    data[field] = cachedData[field];
                }
            }
            var rawData = parsed.raw;
            data._raw = rawData;

            /* 只有设备详情接口明确确认在线才开放实时状态，避免把历史属性误判为在线。 */
            var isOnline = false;
            if (statusResponse && statusResponse.ok) {
                try {
                    var statusResult = await statusResponse.json();
                    if (statusResult.code === 0 && statusResult.data) {
                        var st = statusResult.data.status;
                        var enableStatus = statusResult.data.enable_status;
                        /* 官方设备详情：status 为 int，仅数值 1=在线、2=未激活、0=离线；
                         * 字符串与宽松相等一律不算在线，enable_status 明确禁用也不算。 */
                        var enableStatusValid = enableStatus === undefined ||
                            enableStatus === true || enableStatus === 1;
                        isOnline = (typeof st === 'number' && st === 1 && enableStatusValid);
                    }
                } catch (e) {}
            }

            var receivedAt = Date.now();
            var telemetry = parsed.telemetry;
            var telemetryTimestamp = telemetry.telemetryTimestamp;
            var ageMs = telemetryTimestamp === null ? null : receivedAt - telemetryTimestamp;
            var isFresh = false;
            if (isOnline && telemetry.complete && telemetryTimestamp !== null) {
                /* 整体新鲜 = 每个必需遥测字段分别新鲜：年龄在 [-60s, 15s] 内。 */
                isFresh = true;
                telemetry.keys.forEach(function(telemetryKey) {
                    var fieldAge = receivedAt - telemetry.times[telemetryKey];
                    if (fieldAge < -MAX_FUTURE_MS || fieldAge > TELEMETRY_FRESH_MS) isFresh = false;
                });
                /* RX 固件健康字段 RX_TelemetryFresh 必须严格为 true，其源时间已在上方逐项检查。 */
                if (key === 'rx' && !(data.rx_telemetry_fresh === true)) isFresh = false;
            }

            data._isOnline = isOnline;
            data._isFresh = isFresh;
            data._telemetryTimestamp = telemetryTimestamp;
            data._receivedAt = receivedAt;
            data._ageMs = ageMs;
            data._propertyTimes = parsed.propertyTimes;

            /* 只写本次响应合法字段；旧单设备键只做 TX 只读兼容，不再写入。 */
            var cacheCopy = {};
            Object.keys(data).forEach(function(fieldName) {
                if (fieldName === '_isMock' || fieldName === '_error') return;
                cacheCopy[fieldName] = data[fieldName];
            });
            writeStorage(deviceStorageKey(key, 'iot_latest_data'), cacheCopy);

            /* 历史只在在线且新鲜且存在有效 OneNET 源时间时写入，按源时间所在分钟去重。 */
            if (isOnline && isFresh && telemetryTimestamp !== null) {
                var history = migrateDeviceHistory(key);
                var minute = Math.floor(telemetryTimestamp / 60000);
                var duplicate = history.some(function(item) {
                    return item && item.deviceKey === key && item.timeSource === 'onenet' &&
                        Number.isFinite(Number(item.timestamp)) && Math.floor(Number(item.timestamp) / 60000) === minute;
                });
                if (!duplicate) {
                    history.push({
                        deviceKey: key,
                        timestamp: telemetryTimestamp,
                        timeSource: 'onenet',
                        data: compactHistoryData(historySnapshot)
                    });
                }
                history = history.slice(-1440);
                writeStorage(deviceStorageKey(key, 'iot_history_data'), history);
            }
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('请求超时: 请检查网络连接');
            if (error.message === 'Failed to fetch')
                throw new Error('网络请求被拦截(请重启APP生效)');
            throw error;
        }
    }

    static getMockData(deviceKey) {
        var key = getDeviceKeyOrDefault(deviceKey);
        var mockData = { _isMock: true, _isOnline: false, _isFresh: false };
        var model = typeof getDataModel === 'function' ? getDataModel(key) : { sensors: [], controls: [] };
        model.sensors.forEach(function(s) {
            if (s.dataType === 'bool') { mockData[s.id] = false; return; }
            if (s.dataType === 'string') { mockData[s.id] = '预览'; return; }
            var min = Number.isFinite(Number(s.min)) ? Number(s.min) : 0;
            var max = Number.isFinite(Number(s.max)) ? Number(s.max) : min + 100;
            var rawVal = min + (max - min) / 2;
            var decimals = typeof getDecimals === 'function' ? getDecimals(s.dataType, s.step) : 1;
            mockData[s.id] = Number(rawVal.toFixed(decimals));
        });
        model.controls.forEach(function(c) {
            if (c.dataType === 'bool') mockData[c.id] = false;
            else if (c.dataType === 'string') mockData[c.id] = '预览';
            else if (c.id === 'setfreq') mockData[c.id] = 100;
            else mockData[c.id] = Number.isFinite(Number(c.min)) ? Number(c.min) : 0;
        });
        /* RX 预览状态固定为 BOOT，任何安全/在线布尔都不置 true。 */
        if (key === 'rx') mockData.rx_state = 0;
        return mockData;
    }

    /* 单次 POST，禁止自动重试；只有设备回复码 0/200 才 confirmed 并写缓存与锁。 */
    static async sendProperty(deviceKey, params) {
        var requestId = '';
        var key = normalizeDeviceKeyOrDefault(deviceKey);
        if (!key) return makePropertyOutcome(false, false, null, '设备键非法', requestId);
        var config = getOneNetConfig(key);
        if (!config.TOKEN || !config.PRODUCT_ID || !config.DEVICE_NAME || !params || typeof params !== 'object') {
            return makePropertyOutcome(false, false, null, '未配置或参数非法', requestId);
        }
        var model = typeof getDataModel === 'function' ? getDataModel(key) : { sensors: [], controls: [] };
        if (!validateControlParams(model, params, key)) {
            return makePropertyOutcome(false, false, null, '参数校验失败', requestId);
        }
        var reverseMap = {};
        model.controls.forEach(function(c) { reverseMap[c.id] = c.cloudKey; });
        var mappedParams = {};
        for (var k in params) {
            if (!owns(params, k)) continue;
            var val = params[k];
            for (var j = 0; j < model.controls.length; j++) {
                if (model.controls[j].id === k && model.controls[j].toCloud) { val = model.controls[j].toCloud(val); break; }
            }
            mappedParams[reverseMap[k] || k] = val;
        }

        try {
            var response = await fetchWithTimeout(config.BASE_URL + '/thingmodel/set-device-property', {
                method: 'POST',
                headers: { 'Authorization': config.TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({ product_id: config.PRODUCT_ID, device_name: config.DEVICE_NAME, params: mappedParams })
            }, 10000);
            if (!response.ok) return makePropertyOutcome(false, false, null, 'HTTP ' + response.status, requestId);
            var result = await response.json();
            var outerOk = result && (result.code === 0 || result.success === true);
            if (!outerOk) {
                return makePropertyOutcome(false, false, null, String((result && result.msg) || '平台拒绝'), requestId);
            }
            var data = result.data && typeof result.data === 'object' ? result.data : {};
            /* 平台真实请求标识；未提供时为空字符串，不得用本地随机号冒充。 */
            requestId = extractPlatformRequestId(result, data);
            /* 设备回复码存在时优先 data.msg，避免外层成功信息遮蔽设备拒绝/超时原因。 */
            var message = data.code !== undefined
                ? String(data.msg || result.msg || '')
                : String(result.msg || data.msg || '');
            /* 外层成功但无设备回复码：只能 accepted，不能乐观确认。 */
            if (data.code === undefined) {
                return makePropertyOutcome(true, false, null, message, requestId);
            }
            var deviceCode = Number(data.code);
            if (deviceCode === 0 || deviceCode === 200) {
                applyConfirmedCache(key, params);
                return makePropertyOutcome(true, true, deviceCode, message, requestId);
            }
            return makePropertyOutcome(true, false, deviceCode, message, requestId);
        } catch (error) {
            return makePropertyOutcome(false, false, null, String((error && error.message) || '传输失败'), requestId);
        }
    }

    /* 云历史查询：单 identifier、只读、严格校验，不读写任何本地历史。 */
    static async getPropertyHistory(deviceKey, metricId, startTime, endTime, limit) {
        var key = normalizeDeviceKey(deviceKey);
        if (!key) throw new Error('非法设备键: 仅支持 tx/rx');
        var config = getOneNetConfig(key);
        if (!config.TOKEN || !config.PRODUCT_ID || !config.DEVICE_NAME) throw new Error('该端点未配置');
        var model = typeof getDataModel === 'function' ? getDataModel(key) : { sensors: [] };
        var definition = null;
        var matched = 0;
        model.sensors.forEach(function (sensor) {
            if (sensor.id === metricId) { matched += 1; definition = sensor; }
        });
        if (matched !== 1 || !definition) throw new Error('指标不存在或非唯一');
        if (definition.dataType !== 'int32' && definition.dataType !== 'float' && definition.dataType !== 'double') {
            throw new Error('仅支持数值指标历史');
        }
        var start = Number(startTime);
        var end = Number(endTime);
        var lim = Number(limit);
        if (!Number.isInteger(start) || start < MIN_SOURCE_TIME || start > MAX_SOURCE_TIME) throw new Error('开始时间非法');
        if (!Number.isInteger(end) || end < MIN_SOURCE_TIME || end > MAX_SOURCE_TIME) throw new Error('结束时间非法');
        if (start >= end) throw new Error('开始时间必须小于结束时间');
        if (end > Date.now() + MAX_FUTURE_MS) throw new Error('结束时间超前');
        if (!Number.isInteger(lim) || lim < 1 || lim > 100) throw new Error('limit 需为 1..100 整数');

        var url = config.BASE_URL + '/thingmodel/query-device-property-history?product_id=' +
            encodeURIComponent(config.PRODUCT_ID) + '&device_name=' + encodeURIComponent(config.DEVICE_NAME) +
            '&identifier=' + encodeURIComponent(definition.cloudKey) +
            '&start_time=' + start + '&end_time=' + end +
            /* sort=0 为时间倒序，确保 limit 截断后保留时间窗内最新点。 */
            '&sort=0&offset=0&limit=' + lim;
        var response;
        try {
            response = await fetchWithTimeout(url, { method: 'GET', headers: { 'Authorization': config.TOKEN } }, 10000);
        } catch (error) {
            if (error && error.name === 'AbortError') throw new Error('请求超时: 请检查网络连接');
            throw error;
        }
        if (!response.ok) {
            var errorText = '';
            try { errorText = await response.text(); } catch (e) {}
            if (response.status === 401 || response.status === 403) throw new Error('鉴权失败: 请检查 Token');
            if (response.status === 404) throw new Error('服务未找到: 检查 BASE_URL');
            if (response.status === 429) throw new Error('请求过于频繁: 请稍后刷新');
            if (response.status === 503) throw new Error('服务暂不可用');
            throw new Error('HTTP Error: ' + response.status);
        }
        var result = await response.json();
        if (result.code !== 0) {
            throw new Error('API错误(' + result.code + '): ' + String(result.msg || ''));
        }
        /* 异常超量响应最多处理前 limit 条。 */
        var items = extractPropertyItems(result.data).slice(0, lim);
        var byTime = {};
        items.forEach(function (item) {
            if (!item || typeof item !== 'object') return;
            var time = Number(item.time);
            if (!Number.isInteger(time) || time < MIN_SOURCE_TIME || time > MAX_SOURCE_TIME) return;
            if (time < start || time > end) return;
            var value;
            if (definition.id === 'freq') {
                /* TX F 是 TIM1 实际 Hz：raw 只要求整数 Hz（IDLE/FAULT 允许 0）且 20000..200000。 */
                var rawFreq = Number(item.value);
                if (!Number.isInteger(rawFreq) || !(rawFreq === 0 || (rawFreq >= 20000 && rawFreq <= 200000))) return;
                value = definition.fromCloud ? definition.fromCloud(rawFreq) : rawFreq;
            } else {
                var normalized = normalizeCloudValue(definition, item.value);
                if (normalized === undefined) return;
                if (!isTelemetryValueInRange(definition, normalized, key)) return;
                if (!isStepValid(definition, normalized)) return;
                value = normalized;
            }
            if (!Number.isFinite(Number(value))) return;
            if (typeof getUnavailableMetricLabel === 'function' &&
                getUnavailableMetricLabel(key, metricId, value) !== null) return;
            /* 同一源时间戳后出现的合法点覆盖，最后升序。 */
            byTime[time] = {
                deviceKey: key,
                metricId: metricId,
                cloudKey: definition.cloudKey,
                timestamp: time,
                timeSource: 'onenet',
                value: value
            };
        });
        var points = [];
        Object.keys(byTime).forEach(function (t) { points.push(byTime[t]); });
        points.sort(function (a, b) { return a.timestamp - b.timestamp; });
        return points;
    }

    /* TX 旧页面兼容包装：只返回 confirmed 布尔值。 */
    static async setProperty(params) {
        var outcome = await OneNetService.sendProperty('tx', params);
        return outcome.confirmed === true;
    }
}
