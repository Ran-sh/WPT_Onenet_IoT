/**
 * OneNet WPT Monitor Service
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

class OneNetService {
    static async getLatestData() {
        var config = getOneNetConfig();
        try {
            if (!config.TOKEN) return this.getMockData();

            var url = config.BASE_URL + '/thingmodel/query-device-property?product_id=' + config.PRODUCT_ID + '&device_name=' + config.DEVICE_NAME;
            var statusUrl = config.BASE_URL + '/device/detail?product_id=' + config.PRODUCT_ID + '&device_name=' + config.DEVICE_NAME;

            var results = await Promise.all([
                fetch(url, { method: 'GET', headers: { 'Authorization': config.TOKEN } }),
                fetch(statusUrl, { method: 'GET', headers: { 'Authorization': config.TOKEN } }).catch(function() { return null; })
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
                var newData = {};
                for (var k in cachedData) { if (cachedData.hasOwnProperty(k)) newData[k] = cachedData[k]; }
                for (var k2 in data) { if (data.hasOwnProperty(k2)) newData[k2] = data[k2]; }
                localStorage.setItem('iot_latest_data', JSON.stringify(newData));

                /* 历史记录: 每分钟一条, 最多 1440 */
                var historyData = safeJSONParse(localStorage.getItem('iot_history_data'), []);
                var d = new Date();
                var timeStr = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
                var fullTimeStr = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + timeStr + ':' + ('0' + d.getSeconds()).slice(-2);
                if (historyData.length === 0 || historyData[historyData.length - 1].time !== timeStr) {
                    historyData.push({ time: timeStr, fullTime: fullTimeStr, timestamp: Date.now(), data: {} });
                    var last = historyData[historyData.length - 1].data;
                    for (var dk in data) { if (data.hasOwnProperty(dk)) last[dk] = data[dk]; }
                    if (historyData.length > 1440) historyData.shift();
                    localStorage.setItem('iot_history_data', JSON.stringify(historyData));
                }
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
            return data;
        } catch (error) {
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
        var retries = 3;
        var UNRECOVERABLE = [401, 403];
        var model = typeof getDataModel === 'function' ? getDataModel() : { sensors: [], controls: [] };
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

        while (retries > 0) {
            try {
                var response = await fetch(config.BASE_URL + '/thingmodel/set-device-property', {
                    method: 'POST',
                    headers: { 'Authorization': config.TOKEN, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ product_id: config.PRODUCT_ID, device_name: config.DEVICE_NAME, params: mappedParams })
                });
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
        return false;
    }
}
