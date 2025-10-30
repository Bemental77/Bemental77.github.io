(function () {
    async function gatherUserInfo() {
        const out = {};
        try {
            const nav = navigator || {};
            out.navigator = {
                userAgent: nav.userAgent,
                platform: nav.platform,
                languages: nav.languages,
                language: nav.language,
                vendor: nav.vendor,
                hardwareConcurrency: nav.hardwareConcurrency,
                deviceMemory: nav.deviceMemory,
                cookieEnabled: nav.cookieEnabled,
                online: nav.onLine
            };
        } catch (e) { out.navigatorError = String(e); }

        try {
            const s = screen || {};
            out.screen = {
                width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight,
                colorDepth: s.colorDepth, pixelDepth: s.pixelDepth, orientation: (s.orientation && s.orientation.type) || s.orientation
            };
        } catch (e) { out.screenError = String(e); }

        out.location = { href: location.href, origin: location.origin, pathname: location.pathname, search: location.search };
        out.referrer = document.referrer;

        try { out.cookies = document.cookie; } catch (e) { out.cookiesError = String(e); }

        out.localStorage = {}; out.sessionStorage = {};
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                out.localStorage[k] = localStorage.getItem(k);
            }
        } catch (e) { out.localStorageError = String(e); }

        try {
            out.plugins = Array.from(navigator.plugins || []).map(p => p.name);
            out.mimeTypes = Array.from(navigator.mimeTypes || []).map(m => ({ type: m.type, description: m.description }));
        } catch (e) { out.pluginsError = String(e); }

        try {
            const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            if (c) out.connection = { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData };
        } catch (e) { out.connectionError = String(e); }

        try {
            const navEntries = performance.getEntriesByType('navigation') || [];
            out.performance = navEntries[0] || performance.timing || {};
        } catch (e) { out.performanceError = String(e); }

        try {
            if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                const devices = await navigator.mediaDevices.enumerateDevices();
                out.mediaDevices = devices.map(d => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }));
            }
        } catch (e) { out.mediaDevicesError = String(e); }

        try {
            out.permissions = {};
            const perms = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read'];
            for (const p of perms) {
                try {
                    if (navigator.permissions && navigator.permissions.query) {
                        const res = await navigator.permissions.query({ name: p });
                        out.permissions[p] = res.state;
                    }
                } catch (inner) {
                    out.permissions[p] = String(inner);
                }
            }
        } catch (e) { out.permissionsError = String(e); }

        try {
            if (navigator.geolocation) {
                out.geolocation = await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve({ error: 'timeout' }), 10000);
                    navigator.geolocation.getCurrentPosition(
                        (pos) => { clearTimeout(timer); resolve({ coords: pos.coords, timestamp: pos.timestamp }); },
                        err => { clearTimeout(timer); resolve({ error: err.message || err.code }); },
                        { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 }
                    );
                });
            }
        } catch (e) { out.geolocationError = String(e); }

        try {
            const ipRes = await fetch('https://api.ipify.org?format=json').then(r => r.json());
            out.publicIp = ipRes.ip;
        } catch (e) { out.publicIpError = String(e); }

        return out;
    }

    function show(obj, targetId = 'lookyPre') {
        const pre = document.getElementById(targetId);
        if (!pre) return;
        pre.textContent = JSON.stringify(obj, null, 2);
        pre.scrollTop = 0;
    }

    async function gatherAndShow(targetId) {
        const pre = document.getElementById(targetId || 'lookyPre');
        if (pre) pre.textContent = 'Collecting... (some items require permission)';
        const info = await gatherUserInfo();
        show(info, targetId || 'lookyPre');
        return info;
    }

    // expose API
    window.getUserData = {
        gatherUserInfo,
        gatherAndShow
    };
})();