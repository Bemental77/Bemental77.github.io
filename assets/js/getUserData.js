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

        // raw cookies string
        try { out.cookies = document.cookie; } catch (e) { out.cookiesError = String(e); }

        // parsed cookies (name -> value) and Cookie Store API if available
        try {
            out.parsedCookies = {};
            const raw = (document.cookie || '').trim();
            if (raw.length) {
                raw.split(';').forEach(c => {
                    const idx = c.indexOf('=');
                    if (idx >= 0) {
                        const k = c.slice(0, idx).trim();
                        const v = c.slice(idx + 1).trim();
                        try { out.parsedCookies[k] = decodeURIComponent(v); } catch (_) { out.parsedCookies[k] = v; }
                    } else {
                        out.parsedCookies[c.trim()] = '';
                    }
                });
            }
        } catch (e) { out.parsedCookiesError = String(e); }

        try {
            // cookieStore API (if available) for richer cookie entries (may require secure context)
            if (navigator.cookieStore && typeof navigator.cookieStore.getAll === 'function') {
                try {
                    out.cookieStore = await navigator.cookieStore.getAll().catch(err => { throw err; });
                } catch (e) {
                    // some implementations expose get() only; try to iterate parsedCookies instead
                    out.cookieStoreError = String(e);
                }
            } else if (navigator.cookieStore && typeof navigator.cookieStore.get === 'function') {
                // try to get cookies listed in parsedCookies
                try {
                    const cs = [];
                    for (const k of Object.keys(out.parsedCookies || {})) {
                        try {
                            const entry = await navigator.cookieStore.get(k).catch(()=>null);
                            if (entry) cs.push(entry);
                        } catch (_) { /* ignore individual failures */ }
                    }
                    if (cs.length) out.cookieStore = cs;
                } catch (e) { out.cookieStoreError = String(e); }
            } else {
                out.cookieStoreNote = 'navigator.cookieStore not supported';
            }
        } catch (e) { out.cookieStoreError = String(e); }

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

        // GPU (WebGL) renderer info and Battery (if available)
        try {
            try {
                const canvas = document.createElement('canvas');
                const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
                if (gl) {
                    const dbg = gl.getExtension && gl.getExtension('WEBGL_debug_renderer_info');
                    if (dbg) {
                        out.gpu = {
                            vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
                            renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                        };
                    } else {
                        out.gpu = { note: 'WEBGL_debug_renderer_info not available' };
                    }
                } else {
                    out.gpu = { note: 'WebGL not available' };
                }
            } catch (gErr) {
                out.gpuError = String(gErr);
            }

            if (navigator.getBattery) {
                try {
                    // store battery info asynchronously but include in output if available before return
                    out._batteryPending = true;
                    navigator.getBattery().then(b => {
                        out.battery = { charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
                        delete out._batteryPending;
                    }).catch(e => { out.batteryError = String(e); delete out._batteryPending; });
                } catch (bErr) {
                    out.batteryError = String(bErr);
                }
            }
        } catch (e) { out.gpuBatteryError = String(e); }

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
                        country_code: ipGeo.country_code || ipGeo.country,
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

        // Enrich geo/ip info: timezone, weather, restcountries, fallback geo provider
        try {
            await enrichIpAndCoords(out);
        } catch (e) {
            out.enrichError = String(e);
        }

        // WHOIS / RDAP / ASN enrichment and cookie attributes fallback
        try {
            await enrichWhoisAndCookies(out);
        } catch (e) {
            out.whoisError = String(e);
        }

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

    // helper: enrich with timezone (worldtimeapi), weather (open-meteo), restcountry info, geojs fallback
    async function enrichIpAndCoords(out) {
        // timezone from worldtimeapi (by IP) - no key
        try {
            const wt = await fetch('https://worldtimeapi.org/api/ip').then(r => r.ok ? r.json() : null).catch(() => null);
            if (wt && wt.timezone) out.ipTimezone = { timezone: wt.timezone, datetime: wt.datetime, utc_offset: wt.utc_offset };
        } catch (e) { out.ipTimezoneError = String(e); }

        // ensure we have coordinates (try ipLocation then geolocation)
        const lat = (out.ipLocation && parseFloat(out.ipLocation.latitude)) || (out.geolocation && out.geolocation.coords && out.geolocation.coords.latitude);
        const lon = (out.ipLocation && parseFloat(out.ipLocation.longitude)) || (out.geolocation && out.geolocation.coords && out.geolocation.coords.longitude);

        if (typeof lat === 'number' && typeof lon === 'number' && !Number.isNaN(lat) && !Number.isNaN(lon)) {
            try {
                const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true`;
                const wresp = await fetch(weatherUrl).then(r => r.ok ? r.json() : null).catch(() => null);
                if (wresp && wresp.current_weather) out.weather = wresp.current_weather;
            } catch (e) {
                out.weatherError = String(e);
            }
        } else {
            // fallback geo by IP using geojs if no coords from ipapi
            try {
                if (!out.ipLocation) {
                    const geo = await fetch('https://get.geojs.io/v1/ip/geo.json').then(r => r.ok ? r.json() : null).catch(() => null);
                    if (geo) {
                        out.ipLocation = out.ipLocation || {};
                        out.ipLocation.city = out.ipLocation.city || geo.city;
                        out.ipLocation.region = out.ipLocation.region || geo.region;
                        out.ipLocation.country = out.ipLocation.country || geo.country;
                        out.ipLocation.latitude = out.ipLocation.latitude || geo.latitude;
                        out.ipLocation.longitude = out.ipLocation.longitude || geo.longitude;
                        out.ipLocation.org = out.ipLocation.org || geo.organization;
                    }
                }
            } catch (e) { out.geojsError = String(e); }
        }

        // restcountries: enrich country metadata if we have a country code or name
        try {
            const code = out.ipLocation && (out.ipLocation.country_code || out.ipLocation.country);
            if (code) {
                // prefer alpha code lookup if it's 2 or 3 letters, otherwise try name
                let rc = null;
                if (typeof code === 'string' && code.length <= 3 && /^[A-Za-z]{2,3}$/.test(code)) {
                    rc = await fetch(`https://restcountries.com/v3.1/alpha/${encodeURIComponent(code)}`).then(r => r.ok ? r.json() : null).catch(() => null);
                } else {
                    rc = await fetch(`https://restcountries.com/v3.1/name/${encodeURIComponent(code)}?fullText=false`).then(r => r.ok ? r.json() : null).catch(() => null);
                }
                if (rc && rc.length) {
                    const c = rc[0];
                    out.countryInfo = {
                        name: c.name && (c.name.common || c.name.official),
                        cca2: c.cca2, cca3: c.cca3,
                        region: c.region, subregion: c.subregion,
                        currencies: c.currencies ? Object.keys(c.currencies) : undefined,
                        languages: c.languages ? Object.values(c.languages) : undefined,
                        population: c.population,
                        flag: c.flags && c.flags.svg
                    };
                }
            }
        } catch (e) { out.countryInfoError = String(e); }
    }

    // helper: perform RDAP/BGP and cookie-attribute attempts
    async function enrichWhoisAndCookies(out) {
        // small helper: fetch JSON with timeout
        async function fetchJsonWithTimeout(url, timeout = 8000) {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeout);
            try {
                const resp = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
                clearTimeout(t);
                if (!resp.ok) throw new Error('status ' + resp.status);
                return await resp.json();
            } catch (e) {
                clearTimeout(t);
                throw e;
            }
        }

        // WHOIS/RDAP for IP
        try {
            if (out.publicIp) {
                try {
                    // rdap.org provides generic RDAP proxy
                    try {
                        const rdapIp = await fetchJsonWithTimeout(`https://rdap.org/ip/${encodeURIComponent(out.publicIp)}`, 8000);
                        out.whois = out.whois || {};
                        out.whois.rdapIp = rdapIp;
                    } catch (e) {
                        out.whois = out.whois || {};
                        out.whois.rdapIpError = String(e);
                    }

                    // BGP/ASN details via bgpview.io (may be CORS-limited)
                    try {
                        const bgp = await fetchJsonWithTimeout(`https://api.bgpview.io/ip/${encodeURIComponent(out.publicIp)}`, 8000);
                        out.whois.bgpview = bgp;
                        // also normalize basic ASN/org if present
                        if (bgp && bgp.data && bgp.data.asns && bgp.data.asns.length) {
                            out.asn = bgp.data.asns.map(a => ({ asn: a.asn, name: a.name, country: a.country }));
                        }
                    } catch (e) {
                        out.whois.bgpviewError = String(e);
                    }

                    // fallback: ipinfo (public / limited CORS) — no key used
                    try {
                        const ipinfo = await fetchJsonWithTimeout(`https://ipinfo.io/${encodeURIComponent(out.publicIp)}/json`, 8000).catch(()=>null);
                        if (ipinfo) {
                            out.whois.ipinfo = ipinfo;
                            out.whois.org = out.whois.org || ipinfo.org;
                        }
                    } catch (e) {
                        out.whois.ipinfoError = String(e);
                    }
                } catch (e) {
                    out.whoisIpError = String(e);
                }
            }
        } catch (e) {
            out.whoisError = String(e);
        }

        // WHOIS/RDAP for domain (using page hostname)
        try {
            const host = (location && location.hostname) ? location.hostname : null;
            if (host) {
                // skip if host is an IP string equal to public IP
                const isIp = /^[0-9.:\]]+$/.test(host);
                if (!isIp) {
                    try {
                        const rdapDomain = await fetchJsonWithTimeout(`https://rdap.org/domain/${encodeURIComponent(host)}`, 8000);
                        out.whois = out.whois || {};
                        out.whois.rdapDomain = rdapDomain;
                    } catch (e) {
                        out.whois = out.whois || {};
                        out.whois.rdapDomainError = String(e);
                    }
                } else {
                    out.whoisDomainNote = 'hostname appears to be IP, skipping domain RDAP';
                }
            }
        } catch (e) {
            out.whoisDomainError = String(e);
        }

        // Cookie attributes are not exposed via document.cookie.
        // We attempted navigator.cookieStore earlier; if unavailable, provide a note and best-effort parse.
        try {
            if (!out.cookieStore && out.parsedCookies) {
                out.cookieAttributesNote = 'Cookie attributes (domain, path, secure, httpOnly, sameSite) are not accessible via document.cookie. Use Cookie Store API or server-side Set-Cookie inspection to get attributes.';
            }
        } catch (e) { out.cookieAttributesError = String(e); }
    }
})();