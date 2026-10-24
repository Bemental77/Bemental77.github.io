import puppeteer from 'puppeteer';
const url = 'http://localhost:8090/sm64daily/', date = process.argv[2] || '2026-10-24';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio', '--no-sandbox'] });
const page = await browser.newPage();
await page.goto(url + '?test=1&date=' + date, { waitUntil: 'load' });
await page.waitForSelector('#play');
await page.evaluate(() => { const r = window.sm64DailyReady; window.sm64DailyReady = (...a) => { window.__ready = a[0]; r(...a); }; });
await page.click('#play');
await page.waitForFunction('window.__ready', { timeout: 60000 });
const out = await page.evaluate(() => { const D = Module, o = [];
  const str = p => { let t = ''; if (p > 1) for (let a = p; D.HEAPU8[a]; a++) t += String.fromCharCode(D.HEAPU8[a]); return t; };
  const modOf = i => { for (let m = 0; D._daily_debug_mod_info(m, 0) >= 0; m++) if (i >= D._daily_debug_mod_info(m, 3) && i < D._daily_debug_mod_info(m, 4)) return D._daily_debug_mod_info(m, 0); return -1; };
  for (let i = 0; i < D._daily_debug_num_parts(); i++) { const f = j => D._daily_debug_part(i, j);
    o.push([i, ['chk','box','piece','pole','fbar','obj','decor','isle'][f(3)], 'm' + modOf(i), f(0), f(1), f(2), 'hx' + f(5), 'hz' + f(6), 'top' + f(10), str(D._daily_debug_piece_name(i))].join(' ')); }
  o.push('modules ' + JSON.stringify(window.sm64DailyModules) + ' host ' + window.sm64DailyHost + ' mode ' + window.sm64DailyMode);
  return o; });
console.log(out.join('\n'));
await browser.close();
