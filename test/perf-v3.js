/* V4 动画性能实测：两轮分离 —— 第一轮纯帧率测量（零截图干扰），第二轮纯截图取帧 */
const { chromium } = require('playwright-core');
const BASE = 'http://127.0.0.1:8971';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });

  /* 第一轮：动画窗口帧率（无任何截图） */
  const p1 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await p1.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p1.evaluate(() => {
    window.__frames = 0; window.__long = 0; window.__t0 = performance.now(); window.__last = 0;
    const loop = (t) => { window.__frames++; if (window.__last && t - window.__last > 32) window.__long++; window.__last = t;
      if (performance.now() - window.__t0 < 26500) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await p1.waitForTimeout(3400);
  const r1 = await p1.evaluate(() => ({ f: window.__frames, l: window.__long, d: Math.round(performance.now() - window.__t0) }));
  console.log('入场动画: 帧数=' + r1.f, '时长=' + r1.d + 'ms', 'fps≈' + (r1.f / (r1.d / 1000)).toFixed(1), '长帧(>32ms)=' + r1.l);

  /* 转场帧率：force click（呼吸循环导致元素持续微动，属正常） */
  await p1.evaluate(() => { window.__f2 = 0; window.__l2 = 0; window.__t2 = performance.now(); window.__last2 = 0;
    const l = (t) => { window.__f2++; if (window.__last2 && t - window.__last2 > 32) window.__l2++; window.__last2 = t;
      if (performance.now() - window.__t2 < 1200) requestAnimationFrame(l); }; requestAnimationFrame(l); });
  await p1.click('#xjEnter', { force: true });
  await p1.waitForTimeout(1300);
  const r2 = await p1.evaluate(() => ({ f: window.__f2, l: window.__l2 }));
  console.log('进入转场: 帧数=' + r2.f, 'fps≈' + (r2.f / 1.2).toFixed(1), '长帧=' + r2.l);
  await p1.screenshot({ path: 'assets/v3-main.png' });
  await p1.close();

  /* 第二轮：全新会话截图关键帧 */
  const p2 = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const shots = [[2400, 'v3-beams'], [7000, 'v3-crest-title'], [12500, 'v3-sheen'], [17500, 'v3-sub'], [25000, 'v3-cta']];
  let prev = 0;
  for (const [ms, name] of shots) {
    await p2.waitForTimeout(ms - prev); prev = ms;
    await p2.screenshot({ path: 'assets/' + name + '.png' });
  }
  await browser.close();
  console.log('截图完成');
})().catch(e => { console.error(e); process.exit(1); });
