/* 手机窄屏布局验证：开场第二幕居中 + 字段对照卡/五步走两行式 */
const { chromium } = require('playwright-core');
const BASE = process.env.BASE || 'http://127.0.0.1:8971';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(7000);
  await p.screenshot({ path: 'assets/m-splash.png' });
  await p.evaluate(() => document.querySelector('.xj-skip').click());
  await p.click('#xjEnter', { force: true });
  await p.waitForTimeout(900);
  await p.evaluate(() => { if (typeof setView === 'function') setView('info', document.querySelector('[data-v="info"]')); });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const hd = [...document.querySelectorAll('.group-hd')].find(g => g.textContent.indexOf('五步走') >= 0);
    if (hd) hd.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await p.waitForTimeout(800);
  await p.screenshot({ path: 'assets/m-steps.png' });
  const y1 = await p.evaluate(() => {
    const rows = document.querySelectorAll('.row');
    for (const r of rows) if (r.textContent.indexOf('报考类型') >= 0) { r.scrollIntoView({ block: 'center', behavior: 'instant' }); break; }
    return window.scrollY;
  });
  console.log('fields scrollY=' + y1);
  await p.waitForTimeout(800);
  await p.screenshot({ path: 'assets/m-fields.png' });
  /* 志愿 tab：教学 + 大学图鉴 */
  await p.evaluate(() => {
    const seg = document.getElementById('seg');
    if (typeof setView === 'function') setView('plan', seg.querySelector('[data-v="plan"]'));
    window.scrollTo(0, 0);
  });
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'assets/m-plan.png' });
  await p.evaluate(() => {
    const g = [...document.querySelectorAll('#v-plan .group-hd')].find(x => x.textContent.indexOf('顶流大学') >= 0);
    if (g) g.scrollIntoView({ block: 'start', behavior: 'instant' });
  });
  await p.waitForTimeout(500);
  await p.screenshot({ path: 'assets/m-plan2.png' });
  /* v-info 顶部总览 */
  await p.evaluate(() => {
    const seg = document.getElementById('seg');
    setView('info', seg.querySelector('[data-v="info"]'));
    window.scrollTo(0, 0);
  });
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'assets/m-info-top.png' });
  await browser.close();
  console.log('手机截图完成');
})().catch(e => { console.error(e); process.exit(1); });
