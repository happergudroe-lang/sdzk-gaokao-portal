const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8971/', { waitUntil: 'domcontentloaded' });
  // rAF 帧统计 + 长帧检测（覆盖整个 6.5s 动画窗口）
  await page.evaluate(() => {
    window.__frames = 0; window.__long = 0; window.__t0 = performance.now();
    const loop = (t) => {
      window.__frames++;
      if (window.__last && t - window.__last > 32) window.__long++;
      window.__last = t;
      if (performance.now() - window.__t0 < 6500) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const shots = [[1300,'v3-beams'],[2100,'v3-crest-title'],[3050,'v3-sheen'],[4300,'v3-sub'],[5900,'v3-cta']];
  for (const [ms, name] of shots) {
    await page.waitForTimeout(ms - (await page.evaluate(() => performance.now() - window.__t0)));
    await page.screenshot({ path: 'assets/' + name + '.png' });
  }
  const r = await page.evaluate(() => ({ frames: window.__frames, long: window.__long, dur: Math.round(performance.now() - window.__t0) }));
  console.log('帧数=' + r.frames, '时长=' + r.dur + 'ms', 'fps≈' + (r.frames / (r.dur / 1000)).toFixed(1), '长帧(>32ms)=' + r.long);
  // 进入转场流畅度
  await page.evaluate(() => { window.__f2 = 0; window.__l2 = 0; window.__t2 = performance.now();
    const l = (t) => { window.__f2++; if (window.__last2 && t - window.__last2 > 32) window.__l2++; window.__last2 = t;
      if (performance.now() - window.__t2 < 1200) requestAnimationFrame(l); }; requestAnimationFrame(l); });
  await page.click('#xjEnter');
  await page.waitForTimeout(1300);
  const r2 = await page.evaluate(() => ({ f: window.__f2, l: window.__l2 }));
  console.log('转场: 帧数=' + r2.f, 'fps≈' + (r2.f / 1.2).toFixed(1), '长帧=' + r2.l);
  await page.screenshot({ path: 'assets/v3-main.png' });
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
