/**
 * WPT 数据模型配置（V5.1.2）
 * 纯数据存储在读取时重新补回频率换算函数。
 */

const DATA_MODEL_VERSION = 2;

function frequencyFromCloud(value) {
    return Math.round(Number(value) / 100) / 10;
}

function frequencyToCloud(value) {
    return Math.round(Number(value) * 1000);
}

const DEFAULT_DATA_MODEL = {
    version: DATA_MODEL_VERSION,
    sensors: [
        { id: 'voltage', name: '电压', icon: 'fa-bolt', color: 'cyan', unit: 'V', cloudKey: 'V', min: 0, max: 50, dataType: 'float', step: 0.01 },
        { id: 'current', name: '电流', icon: 'fa-bolt', color: 'yellow', unit: 'A', cloudKey: 'I', min: 0, max: 5, dataType: 'float', step: 0.001 },
        { id: 'freq', name: '频率', icon: 'fa-wave-square', color: 'blue', unit: 'kHz', cloudKey: 'F', min: 20, max: 200, dataType: 'int32', step: 0.1, fromCloud: frequencyFromCloud }
    ],
    controls: [
        { id: 'switch', name: '启停控制', icon: 'fa-power-off', color: 'red', cloudKey: 'Switch', dataType: 'bool', step: 1 },
        { id: 'setfreq', name: '频率设置', icon: 'fa-sliders-h', color: 'blue', unit: 'kHz', cloudKey: 'SetFreq', dataType: 'int32', step: 0.1, min: 20, max: 200, toCloud: frequencyToCloud, fromCloud: frequencyFromCloud }
    ]
};

// Common FontAwesome icons for the user to select
const COMMON_ICONS = [
    'fa-thermometer-half', 'fa-droplet', 'fa-wind', 'fa-water', 'fa-fire', 
    'fa-bolt', 'fa-lightbulb', 'fa-fan', 'fa-toggle-on', 'fa-toggle-off', 
    'fa-bell', 'fa-bullhorn', 'fa-plug', 'fa-power-off', 'fa-microchip', 
    'fa-server', 'fa-battery-full', 'fa-smog', 'fa-cloud', 'fa-sun',
    'fa-snowflake', 'fa-lock', 'fa-unlock', 'fa-video', 'fa-camera',
    'fa-door-open', 'fa-door-closed', 'fa-car-battery', 'fa-satellite-dish'
];

function copyFields(source) {
    const target = {};
    if (!source || typeof source !== 'object') return target;
    Object.keys(source).forEach(function(key) {
        if (typeof source[key] !== 'function') target[key] = source[key];
    });
    return target;
}

function normalizeGroup(savedItems, defaults) {
    const saved = Array.isArray(savedItems) ? savedItems : [];
    const used = new Set();
    const result = defaults.map(function(defaultItem) {
        const index = saved.findIndex(function(item) { return item && item.id === defaultItem.id; });
        const merged = Object.assign(copyFields(defaultItem), index >= 0 ? copyFields(saved[index]) : {});
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
        return merged;
    });
    saved.forEach(function(item, index) {
        if (!used.has(index) && item && item.id) result.push(copyFields(item));
    });
    return result;
}

function normalizeDataModel(model) {
    const source = model && typeof model === 'object' ? model : {};
    return {
        version: DATA_MODEL_VERSION,
        sensors: normalizeGroup(source.sensors, DEFAULT_DATA_MODEL.sensors),
        controls: normalizeGroup(source.controls, DEFAULT_DATA_MODEL.controls)
    };
}

function getDataModel() {
    try {
        const saved = localStorage.getItem('iot_data_model');
        if (saved) return normalizeDataModel(JSON.parse(saved));
    } catch (e) {
        /* JSON 解析错误, 回退到默认模型 */
    }
    return normalizeDataModel(null);  /* 保存为空/解析失败 → 统一返回默认 */
}

function saveDataModel(model) {
    localStorage.setItem('iot_data_model', JSON.stringify(normalizeDataModel(model)));
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
