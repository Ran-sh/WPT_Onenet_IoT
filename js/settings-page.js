/**
 * WPT 设置页（V6.0.0）
 * 双端云端配置 + 本机偏好 + 精确数据维护 + 固定模型摘要。
 * 只调用核心 helper；Token 永不回填 DOM；破坏性操作必须经确认对话框。
 */
(function () {
    var DEVICE_KEYS = ['tx', 'rx'];
    var busy = { tx: false, rx: false };
    var pendingConfirm = null;
    var previousFocus = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function setStatus(deviceKey, message) {
        var el = byId(deviceKey + 'Status');
        if (el) el.textContent = message;
    }

    function setEndpointBusy(deviceKey, isBusy) {
        busy[deviceKey] = isBusy;
        ['SaveBtn', 'TestBtn', 'ClearBtn'].forEach(function (suffix) {
            var btn = byId(deviceKey + suffix);
            if (btn) btn.disabled = isBusy;
        });
    }

    /* 连接测试失败分类：只读取 error.name/error.message 做固定白名单映射，
     * 绝不把服务端/网络错误原文拼入返回值，避免泄露敏感细节。 */
    function formatConnectionTestFailure(error) {
        var name = error && typeof error === 'object' ? String(error.name || '') : '';
        var msg = error && typeof error.message !== 'undefined' ? String(error.message) : '';
        var lower = (name + ' ' + msg).toLowerCase();
        var has = function (keyword) { return lower.indexOf(keyword) !== -1; };
        if (has('401') || has('鉴权失败') || has('token')) return 'Token 无效或已过期，请重新生成并保存';
        if (has('403') || has('拒绝访问') || has('产品') || has('设备名')) return '产品或设备标识无权访问';
        if (name === 'AbortError' || has('请求超时') || has('timeout')) return '请求超时，请检查网络';
        if (has('429') || has('请求过于频繁')) return '请求过于频繁，请稍后重试';
        if (has('503') || has('服务暂不可用')) return 'OneNET 服务暂不可用';
        if (has('404') || has('服务未找到')) return '接口地址错误，请检查平台配置';
        if ((name === 'TypeError' && has('failed to fetch')) || has('network') || has('cors') || has('网络') || has('跨域')) return '网络或跨域请求失败';
        return '连接失败，请检查网络、Token 和端点配置';
    }

    /* 读取当前已保存状态：Token 输入永远保持空，仅显示提示。 */
    function refreshEndpointState(deviceKey) {
        var config = typeof getOneNetConfig === 'function' ? getOneNetConfig(deviceKey) : null;
        var defaults = typeof getDefaultOneNetEndpoint === 'function' ? getDefaultOneNetEndpoint(deviceKey) : { productId: '', deviceName: '' };
        var tokenInput = byId(deviceKey + 'Token');
        var tokenHint = byId(deviceKey + 'TokenHint');
        if (tokenInput) tokenInput.value = '';
        if (tokenHint) {
            var hintText = '未保存 Token';
            if (config && config.TOKEN) {
                var expiry = typeof getOneNetTokenExpiryMs === 'function' ? getOneNetTokenExpiryMs(config.TOKEN) : null;
                hintText = expiry !== null && expiry <= Date.now() ? '已过期，请重新生成 Token' : '已保存，留空不修改';
            }
            tokenHint.textContent = hintText;
        }
        var productInput = byId(deviceKey + 'ProductId');
        var deviceInput = byId(deviceKey + 'DeviceName');
        if (productInput) productInput.value = config && config.PRODUCT_ID ? config.PRODUCT_ID : defaults.productId;
        if (deviceInput) deviceInput.value = config && config.DEVICE_NAME ? config.DEVICE_NAME : defaults.deviceName;
    }

    async function saveConfig(deviceKey) {
        if (busy[deviceKey]) return;
        setEndpointBusy(deviceKey, true);
        try {
            var productId = byId(deviceKey + 'ProductId').value.trim();
            var deviceName = byId(deviceKey + 'DeviceName').value.trim();
            var token = byId(deviceKey + 'Token').value.trim();
            var existing = typeof getOneNetConfig === 'function' ? getOneNetConfig(deviceKey) : null;
            if (!token) {
                if (!existing || !existing.TOKEN) {
                    setStatus(deviceKey, '保存失败：未填写 Token 且该端没有已保存 Token');
                    return;
                }
                token = existing.TOKEN;
            }
            var validated = typeof validateOneNetDeviceConfig === 'function'
                ? validateOneNetDeviceConfig({ productId: productId, deviceName: deviceName, token: token })
                : { ok: false };
            if (!validated.ok) {
                setStatus(deviceKey, '保存失败：字段格式不合法');
                return;
            }
            if (typeof saveOneNetDeviceConfig !== 'function' || !saveOneNetDeviceConfig(deviceKey, validated)) {
                setStatus(deviceKey, '保存失败：浏览器存储不可用');
                return;
            }
            var tokenInput = byId(deviceKey + 'Token');
            if (tokenInput) tokenInput.value = '';
            refreshEndpointState(deviceKey);
            setStatus(deviceKey, '保存成功');
        } finally {
            setEndpointBusy(deviceKey, false);
        }
    }

    /* 测试只调用 getLatestData 做 GET 诊断，绝不发送控制命令。 */
    async function testConfig(deviceKey) {
        if (busy[deviceKey]) return;
        var config = typeof getOneNetConfig === 'function' ? getOneNetConfig(deviceKey) : null;
        if (!config || !config.TOKEN) {
            setStatus(deviceKey, '测试失败：该端未保存配置');
            return;
        }
        var expiry = typeof getOneNetTokenExpiryMs === 'function' ? getOneNetTokenExpiryMs(config.TOKEN) : null;
        if (expiry !== null && expiry <= Date.now()) {
            setStatus(deviceKey, '测试结果：Token 已过期，请重新生成并保存');
            return;
        }
        setEndpointBusy(deviceKey, true);
        try {
            var data = await OneNetService.getLatestData(deviceKey);
            var cls = WptUi.classifyEndpoint(data, null);
            setStatus(deviceKey, '测试结果：' + cls.label);
        } catch (e) {
            setStatus(deviceKey, '测试结果：' + formatConnectionTestFailure(e));
        } finally {
            setEndpointBusy(deviceKey, false);
        }
    }

    /* 可访问确认对话框：确认动作由闭包持有，取消/ESC 不执行；
     * 打开时焦点落到取消按钮，关闭后恢复到触发元素。 */
    function askConfirm(title, message, onConfirm) {
        var dialog = byId('confirmDialog');
        if (!dialog) return;
        pendingConfirm = onConfirm;
        previousFocus = typeof document !== 'undefined' && document.activeElement ? document.activeElement : null;
        var titleEl = byId('confirmDialogTitle');
        var messageEl = byId('confirmDialogMessage');
        if (titleEl) titleEl.textContent = title;
        if (messageEl) messageEl.textContent = message;
        dialog.hidden = false;
        var cancelBtn = byId('confirmDialogCancel');
        if (cancelBtn && typeof cancelBtn.focus === 'function') cancelBtn.focus();
    }

    function closeDialog() {
        pendingConfirm = null;
        var dialog = byId('confirmDialog');
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

    function deviceLabel(deviceKey) {
        return deviceKey === 'tx' ? '发射端 TX' : '接收端 RX';
    }

    function runClear(clearFn) {
        try {
            return typeof clearFn === 'function' && clearFn();
        } catch (e) {
            return false;
        }
    }

    function clearConfig(deviceKey) {
        askConfirm('清除配置', '将清除 ' + deviceLabel(deviceKey) + ' 的云端配置与本端运行数据，确认？', function () {
            var ok = runClear(function () { return clearOneNetDeviceConfig(deviceKey); });
            refreshEndpointState(deviceKey);
            setStatus(deviceKey, ok ? '已清除该端配置' : '清除失败：浏览器存储不可用');
        });
    }

    function clearRuntime(deviceKey) {
        askConfirm('清除运行数据', '将清除 ' + deviceLabel(deviceKey) + ' 的缓存、历史与日志，但保留云端凭据，确认？', function () {
            var ok = runClear(function () { return clearDeviceRuntimeData(deviceKey); });
            setStatus(deviceKey, ok ? '已清除该端运行数据' : '清除失败：浏览器存储不可用');
        });
    }

    function clearAllRuntime() {
        askConfirm('清除全部运行数据', '将清除两端缓存、历史与操作日志，但保留两端凭据、登录状态与本机偏好，确认？', function () {
            var ok = runClear(function () { return clearAllRuntimeData(); });
            var message = ok ? '已清除全部运行数据' : '清除失败：浏览器存储不可用';
            setStatus('tx', message);
            setStatus('rx', message);
        });
    }

    /* 显示按钮只切换用户当前输入，绝不回填已保存 Token；同步 aria 状态与图标。 */
    function wireTokenToggle(deviceKey) {
        var toggle = byId(deviceKey + 'TokenToggle');
        var input = byId(deviceKey + 'Token');
        var icon = byId(deviceKey + 'TokenToggleIcon');
        if (!toggle || !input) return;
        toggle.addEventListener('click', function () {
            var showing = input.type === 'password';
            input.type = showing ? 'text' : 'password';
            toggle.setAttribute('aria-pressed', showing ? 'true' : 'false');
            toggle.setAttribute('aria-label', showing ? '隐藏 Token' : '显示 Token');
            if (icon) icon.className = showing ? 'fas fa-eye-slash' : 'fas fa-eye';
        });
    }

    /* 固定模型摘要：只展示，不改写模型；全部使用 textContent/DOM 创建。 */
    function renderModelSummary(deviceKey) {
        var list = byId(deviceKey + 'ModelSummary');
        if (!list) return;
        list.textContent = '';
        var model = typeof getDataModel === 'function' ? getDataModel(deviceKey) : { sensors: [], controls: [] };
        var items = (model.sensors || []).concat(model.controls || []);
        var head = document.createElement('li');
        head.textContent = '固定字段 ' + items.length + ' 项';
        head.className = 'model-summary__head';
        list.appendChild(head);
        items.forEach(function (item) {
            var li = document.createElement('li');
            var label = document.createElement('span');
            var value = document.createElement('code');
            label.textContent = (item.name || item.id) + ' · ' + item.id;
            value.textContent = item.cloudKey + ' / ' + item.dataType;
            li.appendChild(label);
            li.appendChild(value);
            list.appendChild(li);
        });
    }

    function loadSoundPreference() {
        var toggle = byId('soundToggle');
        if (!toggle) return;
        var config = typeof readLocalObject === 'function' ? readLocalObject('iot_config') : {};
        toggle.checked = config.soundAlert !== false;
    }

    function saveSoundPreference() {
        var toggle = byId('soundToggle');
        if (!toggle) return;
        var config = typeof readLocalObject === 'function' ? readLocalObject('iot_config') : {};
        config.soundAlert = toggle.checked;
        if (typeof writeLocalJSON === 'function') writeLocalJSON('iot_config', config);
    }

    function logout() {
        askConfirm('退出登录', '确定要退出当前 Cloudflare Access 会话吗？', function () {
            window.location.replace('/cdn-cgi/access/logout');
        });
    }

    function init() {
        if (typeof WptUi !== 'undefined' && typeof WptUi.markActiveNavigation === 'function') {
            WptUi.markActiveNavigation();
        }
        DEVICE_KEYS.forEach(function (deviceKey) {
            refreshEndpointState(deviceKey);
            wireTokenToggle(deviceKey);
            /* Enter 与点击 submit 统一走表单 submit，避免 click+submit 双触发。 */
            var form = document.querySelector('form[data-settings-device="' + deviceKey + '"]');
            var testBtn = byId(deviceKey + 'TestBtn');
            var clearBtn = byId(deviceKey + 'ClearBtn');
            if (form) form.addEventListener('submit', function (e) {
                if (e && typeof e.preventDefault === 'function') e.preventDefault();
                saveConfig(deviceKey);
            });
            if (testBtn) testBtn.addEventListener('click', function () { testConfig(deviceKey); });
            if (clearBtn) clearBtn.addEventListener('click', function () { clearConfig(deviceKey); });
        });
        var txRuntimeBtn = byId('txRuntimeBtn');
        var rxRuntimeBtn = byId('rxRuntimeBtn');
        var allRuntimeBtn = byId('allRuntimeBtn');
        if (txRuntimeBtn) txRuntimeBtn.addEventListener('click', function () { clearRuntime('tx'); });
        if (rxRuntimeBtn) rxRuntimeBtn.addEventListener('click', function () { clearRuntime('rx'); });
        if (allRuntimeBtn) allRuntimeBtn.addEventListener('click', clearAllRuntime);
        var soundToggle = byId('soundToggle');
        if (soundToggle) soundToggle.addEventListener('change', saveSoundPreference);
        var confirmBtn = byId('confirmDialogConfirm');
        var cancelBtn = byId('confirmDialogCancel');
        if (confirmBtn) confirmBtn.addEventListener('click', confirmCurrent);
        if (cancelBtn) cancelBtn.addEventListener('click', closeDialog);
        /* 对话框键盘：仅打开时拦截 ESC/Tab；Tab/Shift+Tab 在两个按钮间循环。 */
        document.addEventListener('keydown', function (e) {
            if (!e) return;
            var dialog = byId('confirmDialog');
            if (!dialog || dialog.hidden) return;
            if (e.key === 'Escape') {
                closeDialog();
                return;
            }
            if (e.key !== 'Tab') return;
            var cancelBtn = byId('confirmDialogCancel');
            var confirmBtn = byId('confirmDialogConfirm');
            var active = typeof document !== 'undefined' ? document.activeElement : null;
            if (e.shiftKey) {
                if (active === confirmBtn && cancelBtn && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    cancelBtn.focus();
                } else if (confirmBtn && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    confirmBtn.focus();
                }
            } else {
                if (active === cancelBtn && confirmBtn && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    confirmBtn.focus();
                } else if (cancelBtn && typeof e.preventDefault === 'function') {
                    e.preventDefault();
                    cancelBtn.focus();
                }
            }
        });
        var logoutBtn = byId('logoutBtn');
        if (logoutBtn) logoutBtn.addEventListener('click', logout);
        renderModelSummary('tx');
        renderModelSummary('rx');
        loadSoundPreference();
    }

    init();
})();
