/**
 * OneNet WPT Monitor Service（V5.1.3）
 * 用于与 OneNet 云平台进行数据同步
 */

/* 安全: 无 console 输出, 无 token 泄露 */
function safeJSONParse(str, fallback) {
    try { return JSON.parse(str); } catch (e) { return fallback; }
}

/* 动态获取 OneNet 配置 */
function getOneNetConfig() {
    var userConfig = safeJSONParse(localStorage.getItem('iot_onenet_config'), null);
    if (userConfig && userConfig.productId && userConfig.deviceName && userConfig.token) {
        return {
            PRODUCT_ID: userConfig.productId,
            DEVICE_NAME: userConfig.deviceName,
            TOKEN: userConfig.token,
            BASE_URL: 'https://iot-api.heclouds.com'
        };
    }
    return { PRODUCT_ID: '', DEVICE_NAME: '', TOKEN: '', BASE_URL: 'https://iot-api.heclouds.com' };
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

function validateControlParams(model, params) {
    var keys = Object.keys(params || {});
    if (keys.length === 0) return false;
    return keys.every(function(key) {
        var control = model.controls.find(function(item) { return item.id === key; });
        var value = params[key];
        if (!control) return false;
        if (control.dataType === 'bool') return typeof value === 'boolean';
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

class OneNetService {
    static async getLatestData() {
        var config = getOneNetConfig();
        try {
            if (!config.TOKEN) return this.getMockData();

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

            var data = {};
            var newData = {};  /* 延迟写缓存到 _isOnline 确认后 */
            if (result.data && Array.isArray(result.data)) {
                var rawData = {};
                result.data.forEach(function(item) {
                    var val = item.value;
                    if (val === 'true') val = true;
                    else if (val === 'false') val = false;
                    else if (!isNaN(val) && val !== '') val = Number(val);
                    rawData[item.identifier] = val;
                });

                var model = typeof getDataModel === 'function' ? getDataModel() : { sensors: [], controls: [] };
                model.sensors.forEach(function(s) { if (rawData[s.cloudKey] !== undefined) { var v = rawData[s.cloudKey]; if (s.fromCloud) v = s.fromCloud(v); data[s.id] = v; } });
                model.controls.forEach(function(c) { if (rawData[c.cloudKey] !== undefined) { var v = rawData[c.cloudKey]; if (c.fromCloud) v = c.fromCloud(v); data[c.id] = v; } });

                /* 乐观锁: 3s 内下发过的属性不覆盖 */
                var cachedData = safeJSONParse(localStorage.getItem('iot_latest_data'), {});
                var controlLocks = safeJSONParse(localStorage.getItem('iot_control_locks'), {});
                var now = Date.now();
                for (var key in data) {
                    if (data.hasOwnProperty(key) && controlLocks[key] && (now - controlLocks[key] < 3000))
                        data[key] = cachedData[key];
                }
                newData = {};
                for (var k in cachedData) { if (cachedData.hasOwnProperty(k)) newData[k] = cachedData[k]; }
                for (var k2 in data) { if (data.hasOwnProperty(k2)) newData[k2] = data[k2]; }
                /* 延迟写缓存: 等在线状态确认后一并写入 (见下方) */

            }

            var isOnline = (result.data && result.data.length > 0);
            if (statusResponse && statusResponse.ok) {
                try {
                    var statusResult = await statusResponse.json();
                    if (statusResult.code === 0 && statusResult.data) {
                        var st = statusResult.data.status;
                        isOnline = (st == 1 || st == 2 || st === '在线');
                    }
                } catch (e) {}
            }
            data._isOnline = isOnline;
            /* 在线状态确认后才写缓存, 保证 _isOnline 不丢失 */
            newData._isOnline = isOnline;
            localStorage.setItem('iot_latest_data', JSON.stringify(newData));
            if (isOnline) {
                /* 历史记录使用完整日期+分钟去重, 跨天同一时刻不会被误判重复。 */
                var historyData = safeJSONParse(localStorage.getItem('iot_history_data'), []);
                var d = new Date();
                var timeStr = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
                var minuteKey = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + timeStr;
                var fullTimeStr = minuteKey + ':' + ('0' + d.getSeconds()).slice(-2);
                var previous = historyData.length ? historyData[historyData.length - 1] : null;
                var previousKey = previous ? String(previous.fullTime || '').slice(0, 16) : '';
                if (!previous || previousKey !== minuteKey) {
                    historyData.push({ time: timeStr, fullTime: fullTimeStr, timestamp: Date.now(), data: Object.assign({}, data) });
                    if (historyData.length > 1440) historyData.shift();
                    localStorage.setItem('iot_history_data', JSON.stringify(historyData));
                }
            }
            return data;
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('请求超时: 请检查网络连接');
            if (error.message === 'Failed to fetch')
                throw new Error('网络请求被拦截(请重启APP生效)');
            throw error;
        }
    }

    static getMockData() {
        var mockData = { _isMock: true };
        var model = typeof getDataModel === 'function' ? getDataModel() : { sensors: [], controls: [] };
        model.sensors.forEach(function(s) {
            var range = s.max - s.min, mid = s.min + range / 2;
            var rawVal = mid + (Math.random() * (range * 0.2) - (range * 0.1));
            var decimals = typeof getDecimals === 'function' ? getDecimals(s.dataType, s.step) : 1;
            mockData[s.id] = Number(rawVal.toFixed(decimals));
        });
        model.controls.forEach(function(c) {
            if (c.dataType === 'int32') mockData[c.id] = Math.floor(Math.random() * 100);
            else if (c.dataType === 'bool') mockData[c.id] = Math.random() > 0.5;
            else mockData[c.id] = Number((Math.random() * 100).toFixed(2));
        });
        return mockData;
    }

    static async setProperty(params) {
        var config = getOneNetConfig();
        if (!config.TOKEN || !config.PRODUCT_ID || !config.DEVICE_NAME || !params || typeof params !== 'object') return false;
        var retries = 3;
        var UNRECOVERABLE = [401, 403];
        var model = typeof getDataModel === 'function' ? getDataModel() : { sensors: [], controls: [] };
        if (!validateControlParams(model, params)) return false;
        var reverseMap = {};
        model.controls.forEach(function(c) { reverseMap[c.id] = c.cloudKey; });
        model.sensors.forEach(function(s) { reverseMap[s.id] = s.cloudKey; });
        var mappedParams = {};
        for (var key in params) {
            if (!params.hasOwnProperty(key)) continue;
            var val = params[key];
            for (var j = 0; j < model.controls.length; j++) {
                if (model.controls[j].id === key && model.controls[j].toCloud) { val = model.controls[j].toCloud(val); break; }
            }
            mappedParams[reverseMap[key] || key] = val;
        }

        /* V4.5.0: 保存重试前缓存快照, 用于最终失败时回滚 */
        var preSnapshot = localStorage.getItem('iot_latest_data');
        var preLocks    = localStorage.getItem('iot_control_locks');

        while (retries > 0) {
            try {
                var response = await fetchWithTimeout(config.BASE_URL + '/thingmodel/set-device-property', {
                    method: 'POST',
                    headers: { 'Authorization': config.TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ product_id: config.PRODUCT_ID, device_name: config.DEVICE_NAME, params: mappedParams })
                }, 10000);
                if (UNRECOVERABLE.indexOf(response.status) !== -1) return false;
                var result = await response.json();
                if (result.code === 0) {
                    var cachedData = safeJSONParse(localStorage.getItem('iot_latest_data'), {});
                    var controlLocks = safeJSONParse(localStorage.getItem('iot_control_locks'), {});
                    var now = Date.now();
                    for (var k in params) { if (params.hasOwnProperty(k)) { cachedData[k] = params[k]; controlLocks[k] = now; } }
                    localStorage.setItem('iot_latest_data', JSON.stringify(cachedData));
                    localStorage.setItem('iot_control_locks', JSON.stringify(controlLocks));
                    return true;
                }
                retries--;
                if (retries > 0) await new Promise(function(r) { setTimeout(r, 500); });
            } catch (e) {
                retries--;
                if (retries > 0) await new Promise(function(r) { setTimeout(r, 800); });
            }
        }
        /* V4.5.0: 全部重试失败 → 回滚乐观缓存, 防止界面显示未确认的过期值 */
        if (preSnapshot !== null) localStorage.setItem('iot_latest_data', preSnapshot);
        if (preLocks    !== null) localStorage.setItem('iot_control_locks', preLocks);
        return false;
    }
}
