const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:8971/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3300);
  await page.screenshot({ path: 'assets/logo-crest.png', clip: { x: 60, y: 150, width: 270, height: 340 } });
  await browser.close();
  console.log('ok');
})().catch(e => { console.error(e); process.exit(1); });
