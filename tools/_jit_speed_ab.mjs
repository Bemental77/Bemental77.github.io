// Direct CPU-throughput A/B: average retro_run wall-cost per VI frame
// (immune to the frame limiter), interpreter vs ?jit, same scene window.
import puppeteer from 'puppeteer';
const rom = process.argv[2] || 'gauntletLegends.z64';
const browser = await puppeteer.launch({ headless: 'new', executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'], protocolTimeout: 240000 });
async function run(jit) {
  const ctx = await browser.createIncognitoBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:8080/n64/?game=${rom}&autostart${jit ? '&jit' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.myApp && myApp.rivetsData.beforeEmulatorStarted === false', { timeout: 120000 });
  await new Promise(r => setTimeout(r, 20000)); // settle into the same attract scene
  await page.evaluate(() => Module._neil_frame_cost_reset());
  await new Promise(r => setTimeout(r, 20000)); // measure window
  const m = await page.evaluate(() => ({ ms: Module._neil_frame_cost_ms(), n: Module._neil_frame_cost_n() }));
  const stats = jit ? await page.evaluate(() => window.__jitStats ? window.__jitStats() : null) : null;
  await ctx.close();
  return { perFrame: m.ms / m.n, frames: m.n, stats };
}
const interp = await run(false);
const jit = await run(true);
await browser.close();
const speedup = interp.perFrame / jit.perFrame;
console.log(JSON.stringify({
  rom,
  interpPerFrameMs: Math.round(interp.perFrame * 1000) / 1000,
  jitPerFrameMs: Math.round(jit.perFrame * 1000) / 1000,
  speedupX: Math.round(speedup * 1000) / 1000,
  frames: [interp.frames, jit.frames],
}));
