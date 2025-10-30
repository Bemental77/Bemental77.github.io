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

        // Chrome / client-hints (userAgentData) and Chrome-specific globals
        try {
            if (navigator.userAgentData) {
                out.userAgentData = { mobile: navigator.userAgentData.mobile, brands: navigator.userAgentData.brands || navigator.userAgentData.fullVersionList };
                try {
                    // high-entropy values require async call and may be limited by browser
                    out.userAgentDataHighEntropy = await navigator.userAgentData.getHighEntropyValues(['architecture', 'model', 'platform', 'platformVersion', 'uaFullVersion']);
                } catch (e) { out.userAgentDataHighEntropyError = String(e); }
            }
            out.chrome = { present: !!window.chrome, hasRuntime: !!(window.chrome && window.chrome.runtime), hasWebstore: !!(window.chrome && window.chrome.webstore) };
        } catch (e) { out.userAgentDataError = String(e); }

        // Intl/timezone/locales and media-query preferences
        try {
            const intlOpts = Intl.DateTimeFormat().resolvedOptions();
            out.intl = { timeZone: intlOpts.timeZone, locale: intlOpts.locale || navigator.language, numberingSystem: intlOpts.numberingSystem };
            out.mediaQueries = {
                prefersColorScheme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
                prefersReducedMotion: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
            };
        } catch (e) { out.intlError = String(e); }

        // Cookie Store API, Credential Management API presence
        try {
            out.apis = { cookieStore: !!navigator.cookieStore, credentials: !!navigator.credentials, clipboard: !!navigator.clipboard };
        } catch (e) { out.apisError = String(e); }

        // Document fonts info (FontFaceSet) - availability/status only (not full installed font list)
        try {
            if (document.fonts && document.fonts.size !== undefined) {
                out.fonts = Array.from(document.fonts).map(f => ({ family: f.family, status: f.status }));
            }
        } catch (e) { out.fontsError = String(e); }

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

                // if coords obtained, do a reverse-geocode lookup (OpenStreetMap Nominatim)
                try {
                    if (out.geolocation && out.geolocation.coords && typeof out.geolocation.coords.latitude === 'number') {
                        const lat = out.geolocation.coords.latitude;
                        const lon = out.geolocation.coords.longitude;
                        const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
                        // Abortable fetch with short timeout
                        const controller = new AbortController();
                        const t = setTimeout(() => controller.abort(), 8000);
                        const r = await fetch(nomUrl, { headers: { 'Accept': 'application/json', 'User-Agent': 'getUserData/1.0' }, signal: controller.signal });
                        clearTimeout(t);
                        if (r.ok) {
                            const nom = await r.json();
                            out.geolocation.address = nom.address || nom.display_name || nom;
                            out.geolocation.display_name = nom.display_name;
                        } else {
                            out.geolocation.addressError = `nominatim status ${r.status}`;
                        }
                    }
                } catch (e) {
                    out.geolocationAddressError = String(e);
                }
            }
        } catch (e) { out.geolocationError = String(e); }

        try {
            const ipRes = await fetch('https://api.ipify.org?format=json').then(r => r.json());
            out.publicIp = ipRes.ip;
            // lookup IP location via ipapi.co (no key required for basic info)
            try {
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), 8000);
                const ipGeoResp = await fetch(`https://ipapi.co/${encodeURIComponent(out.publicIp)}/json/`, { signal: controller.signal });
                clearTimeout(t);
                if (ipGeoResp.ok) {
                    const ipGeo = await ipGeoResp.json();
                    out.ipLocation = {
                        ip: out.publicIp,
                        city: ipGeo.city,
                        region: ipGeo.region,
                        country: ipGeo.country_name || ipGeo.country,
                        latitude: ipGeo.latitude || ipGeo.lat,
                        longitude: ipGeo.longitude || ipGeo.lon,
                        org: ipGeo.org || ipGeo.org,
                        postal: ipGeo.postal,
                        timezone: ipGeo.timezone
                    };
                } else {
                    out.ipLocationError = `ipapi status ${ipGeoResp.status}`;
                }
            } catch (e) {
                out.ipLocationError = String(e);
            }
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