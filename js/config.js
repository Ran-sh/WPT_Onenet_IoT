/**
 * WPT 数据模型配置（V6.0.0）
 * 纯数据存储在读取时重新补回频率换算函数。
 */

const DATA_MODEL_VERSION = 4;
const MAX_MODEL_ITEMS = 24;
const MODEL_COLORS = ['orange', 'blue', 'slate', 'cyan', 'teal', 'yellow', 'red', 'green', 'purple', 'pink'];
const MODEL_TYPES = ['bool', 'int32', 'float', 'double', 'string'];

function frequencyFromCloud(value) {
    return Math.round(Number(value) / 100) / 10;
}

function frequencyToCloud(value) {
    return Math.round(Number(value) * 1000);
}

const DEFAULT_DATA_MODEL = {
    version: DATA_MODEL_VERSION,
    sensors: [
        { id: 'voltage', name: '电压', icon: 'fa-bolt', color: 'cyan', unit: 'V', cloudKey: 'V', min: 0, max: 50, dataType: 'double', step: 0.01 },
        { id: 'current', name: '电流', icon: 'fa-bolt', color: 'yellow', unit: 'A', cloudKey: 'I', min: 0, max: 5, dataType: 'double', step: 0.001 },
        { id: 'freq', name: '频率', icon: 'fa-wave-square', color: 'blue', unit: 'kHz', cloudKey: 'F', min: 20, max: 200, dataType: 'int32', step: 0.1, fromCloud: frequencyFromCloud },
        { id: 'state', name: '状态', icon: 'fa-microchip', color: 'slate', unit: '', cloudKey: 'S', min: 0, max: 3, dataType: 'int32', step: 1 }
    ],
    controls: [
        { id: 'switch', name: '启停控制', icon: 'fa-power-off', color: 'red', cloudKey: 'Switch', dataType: 'bool', step: 1 },
        { id: 'setfreq', name: '频率设置', icon: 'fa-sliders-h', color: 'blue', unit: 'kHz', cloudKey: 'SetFreq', dataType: 'int32', step: 0.1, min: 20, max: 200, toCloud: frequencyToCloud, fromCloud: frequencyFromCloud }
    ]
};

/* RX 固定物模型：范围、类型、云端键不允许被本地缓存覆盖（安全边界）。 */
const DEFAULT_DEVICE_MODELS = {
    tx: DEFAULT_DATA_MODEL,
    rx: {
        version: DATA_MODEL_VERSION,
        sensors: [
            { id: 'rx_imon', name: '电流监视电压', icon: 'fa-bolt', color: 'cyan', unit: 'V', cloudKey: 'RX_IMon', dataType: 'double', min: -3.3, max: 3.3, step: 0.001 },
            { id: 'rx_current_ua', name: '刺激电流', icon: 'fa-bolt', color: 'yellow', unit: 'uA', cloudKey: 'RX_Current_uA', dataType: 'double', min: -1000, max: 1000, step: 0.1 },
            { id: 'rx_bonep', name: '正向电压', icon: 'fa-bolt', color: 'teal', unit: 'V', cloudKey: 'RX_BoneP', dataType: 'double', min: 0, max: 3.3, step: 0.001 },
            { id: 'rx_bonen', name: '负向电压', icon: 'fa-bolt', color: 'purple', unit: 'V', cloudKey: 'RX_BoneN', dataType: 'double', min: 0, max: 3.3, step: 0.001 },
            { id: 'rx_bonev', name: '骨电压', icon: 'fa-bolt', color: 'blue', unit: 'V', cloudKey: 'RX_BoneV', dataType: 'double', min: -3.3, max: 3.3, step: 0.001 },
            { id: 'rx_resistance', name: '阻抗', icon: 'fa-microchip', color: 'slate', unit: 'ohm', cloudKey: 'RX_Resistance', dataType: 'int32', min: -10000000, max: 10000000, step: 1, unavailableValue: -1, unavailableLabel: '电流不足' },
            { id: 'rx_vout', name: '输出电压', icon: 'fa-bolt', color: 'orange', unit: 'V', cloudKey: 'RX_Vout', dataType: 'double', min: 0, max: 36.3, step: 0.01 },
            { id: 'rx_limit', name: '限流', icon: 'fa-lock', color: 'red', unit: '', cloudKey: 'RX_Limit', dataType: 'bool', step: 1 },
            { id: 'rx_stim', name: '刺激中', icon: 'fa-bolt', color: 'yellow', unit: '', cloudKey: 'RX_Stim', dataType: 'bool', step: 1 },
            { id: 'rx_connected', name: 'BLE连接', icon: 'fa-link', color: 'green', unit: '', cloudKey: 'RX_Connected', dataType: 'bool', step: 1 },
            { id: 'rx_valid', name: '数据有效', icon: 'fa-check', color: 'green', unit: '', cloudKey: 'RX_Valid', dataType: 'bool', step: 1 },
            { id: 'rx_fault_flags', name: '故障标志', icon: 'fa-exclamation-triangle', color: 'red', unit: '', cloudKey: 'RX_FaultFlags', dataType: 'int32', min: 0, max: 1023, step: 1 },
            { id: 'rx_fault_reason', name: '故障说明', icon: 'fa-comment', color: 'red', unit: '', cloudKey: 'RX_FaultReason', dataType: 'string', step: 1 },
            { id: 'rx_state', name: '接收状态', icon: 'fa-microchip', color: 'slate', unit: '', cloudKey: 'RX_State', dataType: 'int32', min: 0, max: 5, step: 1 },
            { id: 'rx_ble_online', name: 'BLE在线', icon: 'fa-bluetooth', color: 'blue', unit: '', cloudKey: 'RX_BleOnline', dataType: 'bool', step: 1 },
            { id: 'rx_mqtt_online', name: 'MQTT在线', icon: 'fa-cloud', color: 'cyan', unit: '', cloudKey: 'RX_MqttOnline', dataType: 'bool', step: 1 },
            { id: 'rx_gateway_online', name: '网关在线', icon: 'fa-server', color: 'slate', unit: '', cloudKey: 'RX_GatewayOnline', dataType: 'bool', step: 1 },
            { id: 'rx_wifi_online', name: 'WiFi在线', icon: 'fa-wifi', color: 'green', unit: '', cloudKey: 'RX_WifiOnline', dataType: 'bool', step: 1 },
            { id: 'rx_telemetry_fresh', name: '遥测新鲜', icon: 'fa-clock', color: 'green', unit: '', cloudKey: 'RX_TelemetryFresh', dataType: 'bool', step: 1 },
            { id: 'rx_safe', name: '启动门控', icon: 'fa-shield', color: 'green', unit: '', cloudKey: 'RX_Safe', dataType: 'bool', step: 1 },
            { id: 'rx_command', name: '命令', icon: 'fa-terminal', color: 'slate', unit: '', cloudKey: 'RX_Command', dataType: 'string', step: 1 },
            { id: 'rx_command_result', name: '命令结果', icon: 'fa-comment', color: 'slate', unit: '', cloudKey: 'RX_CommandResult', dataType: 'string', step: 1 },
            { id: 'rx_command_sequence', name: '命令序号', icon: 'fa-hashtag', color: 'slate', unit: '', cloudKey: 'RX_CommandSequence', dataType: 'int32', min: 0, max: 2147483647, step: 1 }
        ],
        controls: [
            { id: 'command', name: '接收端命令', icon: 'fa-terminal', color: 'slate', unit: '', cloudKey: 'RX_Command', dataType: 'string', step: 1 }
        ]
    }
};

/* 部署默认端点标识：仅用于新浏览器或未配置时的表单预填，不属于已配置凭据。 */
const DEFAULT_ONENET_ENDPOINTS = Object.freeze({
    tx: Object.freeze({ productId: '1iS397oJFL', deviceName: '20260001' }),
    rx: Object.freeze({ productId: 'A60e06YLYw', deviceName: 'RX_001' })
});

function getDefaultOneNetEndpoint(deviceKey) {
    if (deviceKey !== 'tx' && deviceKey !== 'rx') return { productId: '', deviceName: '' };
    return { productId: DEFAULT_ONENET_ENDPOINTS[deviceKey].productId, deviceName: DEFAULT_ONENET_ENDPOINTS[deviceKey].deviceName };
}

/* 仅允许使用已知图标类，避免本地缓存被篡改后注入属性。 */
const COMMON_ICONS = [
    'fa-thermometer-half', 'fa-droplet', 'fa-wind', 'fa-water', 'fa-fire', 
    'fa-bolt', 'fa-lightbulb', 'fa-fan', 'fa-toggle-on', 'fa-toggle-off', 
    'fa-bell', 'fa-bullhorn', 'fa-plug', 'fa-power-off', 'fa-microchip', 
    'fa-server', 'fa-battery-full', 'fa-smog', 'fa-cloud', 'fa-sun',
    'fa-snowflake', 'fa-lock', 'fa-unlock', 'fa-video', 'fa-camera',
    'fa-door-open', 'fa-door-closed', 'fa-car-battery', 'fa-satellite-dish',
    'fa-wave-square', 'fa-sliders-h'
];

function readLocalJSON(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function readLocalArray(key) {
    const value = readLocalJSON(key, []);
    return Array.isArray(value) ? value : [];
}

function readLocalObject(key) {
    const value = readLocalJSON(key, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function writeLocalJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        return false;
    }
}

function sanitizeText(value, fallback, maxLength) {
    const text = typeof value === 'string' ? value.trim().replace(/[<>&"'`]/g, '') : '';
    return (text || fallback || '').slice(0, maxLength);
}

function sanitizeNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function sanitizeModelItem(item, fallback) {
    const source = item && typeof item === 'object' ? item : {};
    const base = fallback && typeof fallback === 'object' ? fallback : {};
    const idCandidate = sanitizeText(source.id, base.id, 32);
    const id = /^[A-Za-z][A-Za-z0-9_]*$/.test(idCandidate) ? idCandidate : base.id;
    if (!id) return null;

    const iconCandidate = sanitizeText(source.icon, base.icon || 'fa-microchip', 40);
    const colorCandidate = sanitizeText(source.color, base.color || 'slate', 12);
    const typeCandidate = sanitizeText(source.dataType, base.dataType || 'float', 12);
    const min = sanitizeNumber(source.min, sanitizeNumber(base.min, 0));
    const max = sanitizeNumber(source.max, sanitizeNumber(base.max, 100));
    const step = sanitizeNumber(source.step, sanitizeNumber(base.step, 1));
    const normalized = {
        id: id,
        name: sanitizeText(source.name, base.name || id, 40),
        icon: COMMON_ICONS.indexOf(iconCandidate) >= 0 ? iconCandidate : (base.icon || 'fa-microchip'),
        color: MODEL_COLORS.indexOf(colorCandidate) >= 0 ? colorCandidate : (base.color || 'slate'),
        unit: sanitizeText(source.unit, base.unit || '', 12),
        cloudKey: sanitizeText(source.cloudKey, base.cloudKey || id, 64),
        dataType: MODEL_TYPES.indexOf(typeCandidate) >= 0 ? typeCandidate : (base.dataType || 'float'),
        step: step > 0 ? step : 1
    };

    if (source.min !== undefined || source.max !== undefined || base.min !== undefined || base.max !== undefined) {
        normalized.min = Math.min(min, max);
        normalized.max = Math.max(min, max);
    }

    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized.cloudKey)) normalized.cloudKey = base.cloudKey || id;
    if (base.fromCloud) normalized.fromCloud = base.fromCloud;
    if (base.toCloud) normalized.toCloud = base.toCloud;
    return normalized;
}

function copyFields(source) {
    const target = {};
    if (!source || typeof source !== 'object') return target;
    Object.keys(source).forEach(function(key) {
        if (key !== '__proto__' && key !== 'prototype' && key !== 'constructor' &&
            typeof source[key] !== 'function') target[key] = source[key];
    });
    return target;
}

function normalizeGroup(savedItems, defaults) {
    const saved = Array.isArray(savedItems) ? savedItems.slice(0, MAX_MODEL_ITEMS) : [];
    const used = new Set();
    const seenIds = new Set();
    /* 默认 TX 固定协议项：cloudKey/类型/单位/范围/步进/换算一律以 DEFAULT_DATA_MODEL 为准，
     * 旧缓存只能覆盖 name/icon/color 等纯显示字段，防止 V/I/F/S/Switch/SetFreq 脱离固定协议。 */
    const FIXED_PROTOCOL_IDS = { voltage: 1, current: 1, freq: 1, state: 1, switch: 1, setfreq: 1 };
    const result = defaults.map(function(defaultItem) {
        const index = saved.findIndex(function(item) { return item && item.id === defaultItem.id; });
        const merged = sanitizeModelItem(index >= 0 ? Object.assign(copyFields(defaultItem), copyFields(saved[index])) : defaultItem, defaultItem);
        if (index >= 0) used.add(index);
        /* 与固件安全边界有关的字段不允许被旧缓存覆盖。 */
        if (merged.id === 'current') merged.max = 5;
        if (merged.id === 'freq' || merged.id === 'setfreq') {
            merged.min = 20;
            merged.max = 200;
            merged.step = 0.1;
            merged.fromCloud = frequencyFromCloud;
            if (merged.id === 'setfreq') merged.toCloud = frequencyToCloud;
        }
        if (merged.id === 'state') {
            merged.min = 0;
            merged.max = 3;
            merged.step = 1;
            merged.dataType = 'int32';
        }
        if (FIXED_PROTOCOL_IDS[merged.id]) {
            merged.cloudKey = defaultItem.cloudKey;
            merged.dataType = defaultItem.dataType;
            merged.unit = defaultItem.unit;
            merged.min = defaultItem.min;
            merged.max = defaultItem.max;
            merged.step = defaultItem.step;
            merged.fromCloud = defaultItem.fromCloud;
            merged.toCloud = defaultItem.toCloud;
        }
        seenIds.add(merged.id);
        return merged;
    });
    saved.forEach(function(item, index) {
        if (used.has(index) || !item || !item.id) return;
        const normalized = sanitizeModelItem(item, null);
        if (normalized && !seenIds.has(normalized.id)) {
            seenIds.add(normalized.id);
            result.push(normalized);
        }
    });
    return result;
}

function normalizeDataModel(model) {
    const source = model && typeof model === 'object' ? model : {};
    const defaultSensorIds = new Set(DEFAULT_DATA_MODEL.sensors.map(function (item) { return item.id; }));
    const defaultControlIds = new Set(DEFAULT_DATA_MODEL.controls.map(function (item) { return item.id; }));
    const fixedCloudKeys = new Set(DEFAULT_DATA_MODEL.sensors.concat(DEFAULT_DATA_MODEL.controls)
        .map(function (item) { return item.cloudKey; }));
    let sensors = normalizeGroup(source.sensors, DEFAULT_DATA_MODEL.sensors);
    let controls = normalizeGroup(source.controls, DEFAULT_DATA_MODEL.controls);

    /* 跨组 ID 必须唯一：固定协议项优先，附加项冲突时保留只读 sensor。
     * 否则同 ID sensor 可把控制命令重映射到任意 cloudKey。 */
    sensors = sensors.filter(function (item) { return !defaultControlIds.has(item.id); });
    controls = controls.filter(function (item) { return !defaultSensorIds.has(item.id); });
    const sensorIds = new Set(sensors.map(function (item) { return item.id; }));
    controls = controls.filter(function (item) { return !sensorIds.has(item.id); });
    const seenCloudKeys = new Set();
    sensors = sensors.filter(function (item) {
        if (defaultSensorIds.has(item.id)) { seenCloudKeys.add(item.cloudKey); return true; }
        if (fixedCloudKeys.has(item.cloudKey) || seenCloudKeys.has(item.cloudKey)) return false;
        seenCloudKeys.add(item.cloudKey);
        return true;
    });
    controls = controls.filter(function (item) {
        if (defaultControlIds.has(item.id)) { seenCloudKeys.add(item.cloudKey); return true; }
        if (fixedCloudKeys.has(item.cloudKey) || seenCloudKeys.has(item.cloudKey)) return false;
        seenCloudKeys.add(item.cloudKey);
        return true;
    });
    return {
        version: DATA_MODEL_VERSION,
        sensors: sensors,
        controls: controls
    };
}

function getDataModel(deviceKey) {
    if (deviceKey === 'rx') {
        /* RX 模型固定返回，不做任何本地合并，防止安全边界被缓存放宽。 */
        return {
            version: DATA_MODEL_VERSION,
            sensors: DEFAULT_DEVICE_MODELS.rx.sensors.map(function (item) { return Object.assign({}, item); }),
            controls: DEFAULT_DEVICE_MODELS.rx.controls.map(function (item) { return Object.assign({}, item); })
        };
    }
    return normalizeDataModel(readLocalJSON('iot_data_model', null));
}

/* 哨兵不可用值唯一语义：只认 sensor 元数据中精确数值匹配的有限 number。 */
function getUnavailableMetricLabel(deviceKey, metricId, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    var model = typeof getDataModel === 'function' ? getDataModel(deviceKey) : null;
    if (!model || !Array.isArray(model.sensors)) return null;
    for (var i = 0; i < model.sensors.length; i++) {
        if (model.sensors[i].id !== metricId) continue;
        var sensor = model.sensors[i];
        if (typeof sensor.unavailableValue === 'number' &&
            Number.isFinite(sensor.unavailableValue) &&
            value === sensor.unavailableValue &&
            typeof sensor.unavailableLabel === 'string' && sensor.unavailableLabel) {
            return sensor.unavailableLabel;
        }
        return null;
    }
    return null;
}

function saveDataModel(model) {
    return writeLocalJSON('iot_data_model', normalizeDataModel(model));
}

/**
 * HTML 实体编码 — 防止 XSS 攻击
 * 对所有来自 localStorage/API 的用户可控字符串,
 * 在插入 innerHTML 前必须通过此函数转义。
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Helper to determine decimal places based on data type and step
function getDecimals(dataType, step) {
    if (step !== undefined && step !== null) {
        const stepStr = String(step);
        if (stepStr.includes('.')) return stepStr.split('.')[1].length;
    }
    return dataType === 'int32' ? 0 : 1;
}

function getWptState(data) {
    if (!data || data._isMock) return 'PREVIEW';
    if (!data._isOnline) return 'OFFLINE';
    var protocolState = data._raw && Number(data._raw.S);
    if (protocolState === 3) return 'FAULT';
    if (protocolState === 2) return 'RUNNING';
    if (protocolState === 1) return 'SWEEP';
    if (protocolState === 0) return 'IDLE';
    if (data.switch === true || data.switch === 1 || data.switch === 'true' || data.switch === '1') return 'RUNNING';
    if (Number(data.freq) > 0) return 'SWEEP';
    return 'IDLE';
}

function isSensorValueNormal(sensor, value, data) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return false;
    /* STM32 在 IDLE/FAULT 状态按协议上报 F=0，这不是低频报警。 */
    if (sensor && sensor.id === 'freq' && numericValue === 0 &&
        (getWptState(data) === 'IDLE' || getWptState(data) === 'FAULT')) return true;
    return numericValue >= sensor.min && numericValue <= sensor.max;
}

// UI Color mapping helpers
const COLOR_CLASSES = {
    'orange': { bg: 'bg-orange-50', text: 'text-orange-500', border: 'border-orange-100/50', fill: 'bg-orange-500' },
    'blue': { bg: 'bg-blue-50', text: 'text-blue-500', border: 'border-blue-100/50', fill: 'bg-blue-500' },
    'slate': { bg: 'bg-slate-50', text: 'text-slate-500', border: 'border-slate-100/50', fill: 'bg-slate-500' },
    'cyan': { bg: 'bg-cyan-50', text: 'text-cyan-500', border: 'border-cyan-100/50', fill: 'bg-cyan-500' },
    'teal': { bg: 'bg-teal-50', text: 'text-teal-500', border: 'border-teal-100/50', fill: 'bg-teal-500' },
    'yellow': { bg: 'bg-yellow-50', text: 'text-yellow-500', border: 'border-yellow-100/50', fill: 'bg-yellow-500' },
    'red': { bg: 'bg-red-50', text: 'text-red-500', border: 'border-red-100/50', fill: 'bg-red-500' },
    'green': { bg: 'bg-green-50', text: 'text-green-500', border: 'border-green-100/50', fill: 'bg-green-500' },
    'purple': { bg: 'bg-purple-50', text: 'text-purple-500', border: 'border-purple-100/50', fill: 'bg-purple-500' },
    'pink': { bg: 'bg-pink-50', text: 'text-pink-500', border: 'border-pink-100/50', fill: 'bg-pink-500' }
};
