/**
 * WPT 实时告警中心（V6.0.0）
 * 只渲染 WptAlertEngine 返回/读取的 incidents 与 summary；双端独立降级。
 */
(function () {
    var POLL_MS = 5000;
    var currentFilter = 'all';
    var currentDevice = 'all';
    var previousFocus = null;
    var pendingConfirm = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function setText(id, text) {
        var el = byId(id);
        if (el) el.textContent = text;
    }

    function statusLabel(incident) {
        if (incident.active && !incident.acknowledged) return '活动，未确认';
        if (incident.active && incident.acknowledged) return '已确认，仍活动';
        if (!incident.active && !incident.acknowledged) return '已恢复，待确认';
        return '已恢复';
    }

    function renderList(incidents) {
        var list = byId('alertsList');
        var empty = byId('alertsEmpty');
        if (!list || !empty) return;
        list.textContent = '';
        var filtered = incidents.filter(function (inc) {
            if (currentFilter === 'active' && !inc.active) return false;
            if (currentFilter === 'unacknowledged' && inc.acknowledged) return false;
            if (currentFilter === 'resolved' && inc.active) return false;
            if (currentDevice !== 'all' && inc.deviceKey !== currentDevice) return false;
            return true;
        });
        empty.hidden = filtered.length > 0;
        filtered.forEach(function (inc) {
            var li = document.createElement('li');
            li.className = 'alert-card alert-card--' + inc.severity + (inc.active ? ' alert-card--active' : ' alert-card--resolved');
            var header = document.createElement('div');
            header.className = 'alert-card__header';
            var title = document.createElement('strong');
            title.textContent = (inc.deviceKey === 'tx' ? '发射端' : '接收端') + ' · ' + inc.title;
            var severity = document.createElement('span');
            severity.className = 'alert-severity alert-severity--' + inc.severity;
            severity.textContent = inc.severity === 'critical' ? '严重' : '警告';
            header.appendChild(title);
            header.appendChild(severity);
            li.appendChild(header);
            var meta = document.createElement('p');
            meta.textContent = '开始 ' + WptUi.formatSourceTime(inc.startedAt) + ' · 最近 ' + WptUi.formatSourceTime(inc.lastSeenAt) +
                ' · 值 ' + String(inc.value) + ' / 阈值 ' + String(inc.threshold) + (inc.unit ? ' ' + inc.unit : '');
            li.appendChild(meta);
            if (inc.message) {
                var message = document.createElement('p');
                message.className = 'alert-card__message';
                message.textContent = inc.message;
                li.appendChild(message);
            }
            var footer = document.createElement('div');
            footer.className = 'alert-card__footer';
            var status = document.createElement('span');
            status.className = 'alert-status';
            status.textContent = statusLabel(inc);
            footer.appendChild(status);
            if (!inc.acknowledged) {
                var ackBtn = document.createElement('button');
                ackBtn.type = 'button';
                ackBtn.className = 'btn btn-ghost';
                ackBtn.setAttribute('data-ack-id', inc.id);
                ackBtn.textContent = '确认';
                ackBtn.addEventListener('click', function () {
                    WptAlertEngine.acknowledge(inc.id, Date.now());
                    renderAll();
                });
                footer.appendChild(ackBtn);
            }
            var historyLink = document.createElement('a');
            historyLink.href = '/history';
            historyLink.className = 'alert-history-link';
            historyLink.textContent = '查看历史';
            footer.appendChild(historyLink);
            li.appendChild(footer);
            list.appendChild(li);
        });
    }

    function renderAll() {
        var incidents = WptAlertEngine.getIncidents();
        var summary = WptAlertEngine.getSummary(incidents);
        setText('activeAlertCount', String(summary.active));
        setText('unackAlertCount', String(summary.unacknowledged));
        setText('resolvedAlertCount', String(summary.resolved));
        setText('alertsSummary', summary.active > 0
            ? '共 ' + summary.total + ' 项，活动 ' + summary.active + '，未确认 ' + summary.unacknowledged
            : '无活动报警');
        var ackAll = byId('acknowledgeAllBtn');
        var clearResolved = byId('clearResolvedBtn');
        if (ackAll) ackAll.disabled = summary.unacknowledged === 0;
        if (clearResolved) clearResolved.disabled = summary.resolved === 0;
        renderList(incidents);
    }

    async function syncAll() {
        var settled = await Promise.allSettled([
            OneNetService.getLatestData('tx'),
            OneNetService.getLatestData('rx')
        ]);
        var snapshots = {
            tx: {
                data: settled[0].status === 'fulfilled' ? settled[0].value : null,
                error: settled[0].status === 'rejected' ? settled[0].reason : null
            },
            rx: {
                data: settled[1].status === 'fulfilled' ? settled[1].value : null,
                error: settled[1].status === 'rejected' ? settled[1].reason : null
            }
        };
        var failed = settled[0].status === 'rejected' || settled[1].status === 'rejected';
        try {
            WptAlertEngine.evaluateSnapshots(snapshots, Date.now());
        } catch (e) {}
        renderAll();
        setText('alertPollStatus', failed ? 'TX/RX 数据不可用，保持现有报警' : '双端同步完成');
    }

    /* ---------- 清理对话框 ---------- */

    function openClearDialog() {
        var dialog = byId('alertClearDialog');
        if (!dialog) return;
        pendingConfirm = function () {
            closeClearDialog();
            WptAlertEngine.clearResolved();
            renderAll();
        };
        previousFocus = typeof document !== 'undefined' && document.activeElement ? document.activeElement : null;
        dialog.hidden = false;
        var cancel = byId('alertClearCancel');
        if (cancel && typeof cancel.focus === 'function') cancel.focus();
    }

    function closeClearDialog() {
        pendingConfirm = null;
        var dialog = byId('alertClearDialog');
        if (dialog) dialog.hidden = true;
        if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
        previousFocus = null;
    }

    function confirmClear() {
        if (!pendingConfirm) return;
        var action = pendingConfirm;
        closeClearDialog();
        action();
    }

    function onDialogKeydown(e) {
        if (!e) return;
        var dialog = byId('alertClearDialog');
        if (!dialog || dialog.hidden) return;
        if (e.key === 'Escape') {
            closeClearDialog();
            return;
        }
        if (e.key !== 'Tab') return;
        var cancel = byId('alertClearCancel');
        var confirm = byId('alertClearConfirm');
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
    }

    /* ---------- 初始化 ---------- */

    function init() {
        if (typeof WptUi !== 'undefined' && typeof WptUi.markActiveNavigation === 'function') {
            WptUi.markActiveNavigation();
        }
        renderAll();
        var poller = WptUi.createLifecyclePoller(syncAll, POLL_MS);
        var refreshBtn = byId('alertsRefreshBtn');
        var ackAll = byId('acknowledgeAllBtn');
        var clearResolved = byId('clearResolvedBtn');
        var deviceFilter = byId('alertDeviceFilter');
        var confirmBtn = byId('alertClearConfirm');
        var cancelBtn = byId('alertClearCancel');
        if (refreshBtn) refreshBtn.addEventListener('click', function () { poller.runNow().catch(function () {}); });
        if (ackAll) ackAll.addEventListener('click', function () {
            WptAlertEngine.acknowledgeAll(Date.now());
            renderAll();
        });
        if (clearResolved) clearResolved.addEventListener('click', openClearDialog);
        if (deviceFilter) deviceFilter.addEventListener('change', function () {
            currentDevice = deviceFilter.value;
            renderAll();
        });
        if (confirmBtn) confirmBtn.addEventListener('click', confirmClear);
        if (cancelBtn) cancelBtn.addEventListener('click', closeClearDialog);
        var filterButtons = document.querySelectorAll('[data-alert-filter]');
        for (var i = 0; i < filterButtons.length; i++) {
            filterButtons[i].addEventListener('click', function () {
                var value = this.getAttribute('data-alert-filter');
                currentFilter = value === 'active' || value === 'unacknowledged' || value === 'resolved' ? value : 'all';
                var all = document.querySelectorAll('[data-alert-filter]');
                for (var j = 0; j < all.length; j++) {
                    all[j].setAttribute('aria-pressed', all[j].getAttribute('data-alert-filter') === currentFilter ? 'true' : 'false');
                }
                renderAll();
            });
        }
        document.addEventListener('keydown', onDialogKeydown);
        if (typeof WptUi !== 'undefined' && typeof WptUi.registerServiceWorker === 'function') {
            WptUi.registerServiceWorker();
        }
        poller.start();
    }

    init();
})();
