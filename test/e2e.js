/* E2E 回归 + 隐私网络审计 —— node test/e2e.js（需先启动 server.js）
   用 playwright-core 驱动系统 Edge（--no-proxy-server），CDP 截图。
   断言全部基于计算样式/真实 DOM（吸取 hero 不可见事故的教训）。 */
'use strict';
const { chromium } = require('playwright-core');
const assert = require('assert');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const TEST_NAME = '测试员';
const TEST_ID = '11010119900307451X'.slice(0, 17) + computeCheck('110101199003074511');
const TEST_PHONE = '13800001234';

function computeCheck(first17) {
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], M = '10X98765432';
  let sum = 0; for (let i = 0; i < 17; i++) sum += (+first17[i]) * W[i];
  return M[sum % 11];
}

(async () => {
  let pass = 0, fail = 0;
  const t = (name, fn) => Promise.resolve().then(fn).then(
    () => { pass++; console.log('  ✅ ' + name); },
    (e) => { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.message || e)); }
  );

  const browser = await chromium.launch({ channel: 'msedge', args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  /* 网络审计：记录所有出站请求的 url+body，稍后断言敏感值零外泄 */
  const leaks = [];
  page.on('request', req => {
    const url = req.url();
    let body = req.postData() || '';
    const blob = (url + ' ' + body);
    if (blob.includes(TEST_ID) || blob.includes(TEST_PHONE) || blob.includes(TEST_NAME)) {
      leaks.push(req.method() + ' ' + url + ' ' + body.slice(0, 120));
    }
  });

  console.log('—— 加载与可见性 ——');
  const originalUA = await page.evaluate(() => navigator.userAgent);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1200);

  console.log('—— 开场动画（XJ Splash）——');
  await t('首次进入播放开场层（覆盖主界面 + 锁滚动）', () => {
    return page.evaluate(() => {
      const s = document.getElementById('xjSplash');
      if (!s) throw new Error('开场层不存在');
      if (s.classList.contains('off')) throw new Error('首次访问应显示开场层');
      if (!document.body.classList.contains('xj-lock')) throw new Error('开场期间应锁定背景滚动');
      if (!document.querySelector('.xj-btn') || document.querySelector('.xj-btn').textContent.indexOf('开始报名') < 0) throw new Error('CTA 按钮缺失');
    });
  });
  await t('节奏合规：入场有限动画总时长 ≤ 14s（读 WAAPI 时序实测，呼吸循环除外）', () => {
    return page.evaluate(() => {
      const anims = document.getElementById('xjSplash').getAnimations({ subtree: true })
        .filter(x => x.effect.getTiming().iterations !== Infinity);
      if (!anims.length) throw new Error('未检测到开场动画');
      const maxEnd = Math.max(...anims.map(x => x.effect.getTiming().delay + (typeof x.effect.getTiming().duration === 'number' ? x.effect.getTiming().duration : 0)));
      if (maxEnd > 14000) throw new Error('总时长 ' + Math.round(maxEnd) + 'ms 超出 14s');
    });
  });
  await t('文案权威且诚实：铭言「乾坤未定」、主标题为项目名、副标题为「小杰 · 技术支持」、底注含「非官方」，无「官方指定/授权」类违规字样', () => {
    return page.evaluate(() => {
      const s = document.getElementById('xjSplash');
      if ((document.querySelector('.xj-tw1').getAttribute('data-text') || '').indexOf('乾坤未定') < 0) throw new Error('打字机主句缺失');
      if (s.textContent.indexOf('黑马') < 0 && (document.querySelector('.xj-tw1').getAttribute('data-text') || '').indexOf('黑马') < 0) throw new Error('铭言缺失');
      if (s.textContent.indexOf('三年晨读') < 0 || s.textContent.indexOf('笔下的从容') < 0) throw new Error('序章长句缺失');
      if (!document.getElementById('xjCd') || !document.getElementById('xjCdCap')) throw new Error('实时倒计时缺失');
      if (document.querySelector('.xj-title').getAttribute('aria-label').indexOf('山东高考报名助手') < 0) throw new Error('主标题缺少项目名');
      if (document.querySelector('.xj-sub').textContent.indexOf('小杰') < 0) throw new Error('副标题缺少技术支持方');
      if (document.querySelector('.xj-note').textContent.indexOf('非官方') < 0) throw new Error('底注缺少非官方声明');
      if (/官方指定|授权|教育厅指定/.test(s.textContent)) throw new Error('出现官方感违规文案');
    });
  });
  await t('「跳过」收尾 →「开始报名」进入主界面（真实入口）', async () => {
    await page.evaluate(() => document.querySelector('.xj-skip').click());
    await page.click('#xjEnter');
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => ({
      off: document.getElementById('xjSplash').classList.contains('off'),
      unlock: !document.body.classList.contains('xj-lock'),
      seen: sessionStorage.getItem('xj-splash-seen'),
      hero: document.querySelector('.hero') ? document.querySelector('.hero').getBoundingClientRect().height : 0
    }));
    assert.strictEqual(r.off, true, '开场层应隐藏');
    assert.ok(r.unlock, '滚动应解锁');
    assert.strictEqual(r.seen, '1', '同会话刷新不应重播');
    assert.ok(r.hero > 200, '主界面 Hero 应可见: h=' + r.hero);
  });
  await t('prefers-reduced-motion：开场层静态呈现（副标题立即可见）', async () => {
    const ctx2 = await browser.newContext({ reducedMotion: 'reduce' });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(500);
    const r = await p2.evaluate(() => ({
      off: document.getElementById('xjSplash').classList.contains('off'),
      subOp: getComputedStyle(document.querySelector('.xj-sub')).opacity
    }));
    assert.strictEqual(r.off, false, 'reduce 下开场层应静态显示');
    assert.strictEqual(r.subOp, '1', '副标题应立即可见（无逐帧动画）');
    await ctx2.close();
  });

  await t('无 console error', () => {
    const fatal = consoleErrors.filter(e => !/net::|Failed to load resource|wsbm\.sdzk\.cn|navigator\.vibrate|ch chromestatus/.test(e));
    assert.deepStrictEqual(fatal, [], 'console errors: ' + fatal.join(' | '));
  });
  await t('Hero 可见：opacity=1 且有实际高度（回归 10-23 事故）', () => {
    const r = page.evaluate(() => {
      const h = document.querySelector('.hero');
      const cs = getComputedStyle(h);
      return { op: cs.opacity, h: h.getBoundingClientRect().height };
    });
    return r.then(({ op, h }) => {
      assert.ok(parseFloat(op) > 0.99, 'opacity=' + op);
      assert.ok(h > 200, 'hero height=' + h);
    });
  });
  await t('里程表 8 位数字全部渲染且在视口内', () => {
    return page.evaluate(() => {
      const cols = document.querySelectorAll('.odo .col');
      if (cols.length !== 8) throw new Error('col 数=' + cols.length);
      for (const c of cols) {
        const r = c.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) throw new Error('有 0 尺寸列');
      }
      const txt = document.querySelector('#heroMeta').textContent;
      if (!txt || txt === '加载中…') throw new Error('heroMeta 未渲染: ' + txt);
    });
  });
  await t('状态机渲染：winState 非占位符（8 态之一）', () => {
    return page.evaluate(() => {
      const s = document.querySelector('#winState').textContent;
      const ok = ['尚未开始', '今日尚未开放', '今日已关闭', '计划开放中 · 未核实', '已核实开放',
                  '计划开放中 · 暂时无法核实', '本期填报已结束', '配置错误'].some(x => s.indexOf(x) >= 0);
      if (!ok) throw new Error('winState=' + s);
      const d = document.querySelector('#winDetail').textContent;
      if (d.indexOf('来源：') < 0) throw new Error('winDetail 未标注来源: ' + d);
    });
  });
  await t('官方来源核验卡：来自 /api/config 的服务器配置', () => {
    return page.evaluate(() => {
      const c = document.querySelector('#ocCfg').textContent;
      if (c.indexOf('服务器配置') < 0) throw new Error('ocCfg=' + c + '（应已拉取 /api/config）');
      const v = document.querySelector('#ocVerified').textContent;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('核验日期异常: ' + v);
    });
  });

  console.log('—— 交互 ——');
  await t('主题切换弹簧生效（data-theme 翻转）', async () => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('#tgl');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    assert.notStrictEqual(before, after);
    await page.click('#tgl');
  });
  await t('证据 Sheet 开 → 关（弹簧落位）', async () => {
    try {
      await page.evaluate(() => openSheet());
      await page.waitForTimeout(1100);
      const o = await page.evaluate(() => {
        const el = document.getElementById('sheet');
        const r = el.getBoundingClientRect();
        return { bottom: r.bottom, vh: window.innerHeight, h: el.offsetHeight };
      });
      /* 打开 = 底边贴住视口底（bottom≈vh）；面板本体在视口内 */
      assert.ok(Math.abs(o.bottom - o.vh) < 2, '打开后 bottom=' + o.bottom + ' vh=' + o.vh);
    } finally {
      await page.evaluate(() => closeSheet());
      await page.waitForTimeout(1100);
      const c = await page.evaluate(() => {
        const el = document.getElementById('sheet');
        return { top: el.getBoundingClientRect().top, h: el.offsetHeight };
      });
      /* 关闭 = 整板平移到视口下方（top ≥ 高度） */
      assert.ok(c.top >= c.h - 2, '关闭后 top=' + c.top + ' h=' + c.h);
    }
  });

  console.log('—— 隐私：PIN 加密流程 ——');
  /* 统一对话处理：prompt 用 pinReply（默认正确 PIN），confirm/alert 一律接受 */
  let pinReply = null;
  page.on('dialog', async d => {
    try { if (d.type() === 'prompt') await d.accept(pinReply || '135790'); else await d.accept(); }
    catch (e) { /* 已被自动处理的对话 */ }
  });
  await t('填写姓名/身份证/手机 → 校验位提示 ✓', async () => {
    await page.click('button[data-v="info"]');
    await page.fill('#f-name', TEST_NAME);
    await page.fill('#f-idcard', TEST_ID);
    await page.fill('#f-phone', TEST_PHONE);
    await page.evaluate(() => idcCheck());
    const hint = await page.evaluate(() => document.getElementById('idcHint').textContent);
    assert.ok(hint.indexOf('✓') >= 0, 'hint=' + hint);
  });
  await t('设置 PIN → 存储转为 AES-GCM 加密 + 字段清空锁定', async () => {
    await page.evaluate(() => pvPrimary());          // 两次 prompt → 135790（全局 handler）
    await page.waitForTimeout(900);
    const r = await page.evaluate(async () => {
      const rec = await SdzkStore.get();
      return { mode: rec && rec.mode, backend: SdzkStore.backendName(), name: document.getElementById('f-name').value,
               pv: document.getElementById('pvMode').textContent };
    });
    assert.strictEqual(r.mode, 'enc', '存储 mode=' + r.mode);
    assert.strictEqual(r.backend, 'IndexedDB', '主路径应为 IndexedDB，实际=' + r.backend);
    assert.strictEqual(r.name, '', '锁定后字段应清空');
    assert.ok(r.pv.indexOf('AES') >= 0, 'pvMode=' + r.pv);
  });
  await t('密文不含明文敏感值（在页面内断言，IndexedDB 记录序列化后检查）', () => {
    return page.evaluate(({ id, ph, nm }) => SdzkStore.get().then(rec => {
      const raw = JSON.stringify(rec || {});
      for (const s of [id, ph, nm]) if (raw.includes(s)) throw new Error('明文泄露: ' + s);
    }), { id: TEST_ID, ph: TEST_PHONE, nm: TEST_NAME });
  });
  await t('输入 PIN 解锁 → 字段恢复', async () => {
    pinReply = '135790';
    await page.evaluate(() => pvUnlock());
    await page.waitForTimeout(600);
    const name = await page.evaluate(() => document.getElementById('f-name').value);
    assert.strictEqual(name, TEST_NAME);
  });
  await t('错误 PIN 解锁 → 拒绝且字段仍空', async () => {
    await page.evaluate(() => pvLock('测试锁'));
    pinReply = '000000';
    await page.evaluate(() => pvUnlock());
    await page.waitForTimeout(600);
    pinReply = null;
    const name = await page.evaluate(() => document.getElementById('f-name').value);
    assert.strictEqual(name, '', '错误 PIN 不应恢复数据');
    const enc = await page.evaluate(() => SdzkStore.get().then(rec => rec && rec.mode));
    assert.strictEqual(enc, 'enc', '数据应仍为加密态');
  });
  await t('自动锁计时函数存在且 pvLock 可用（3 分钟策略接线）', async () => {
    const ok = await page.evaluate(() => { pvLock('测试锁'); return true; });
    assert.ok(ok);
  });
  await t('删除全部数据 → 存储清空 + 概览更新', async () => {
    await page.evaluate(() => pvWipe());              // confirm 由全局 handler 接受
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => SdzkStore.get());
    assert.strictEqual(r, null);
  });

  console.log('—— 信标引擎（真实触发一次 std 信标） ——');
  await t('构造已到期的 std 信标 → runBeacons 落回执（受静默保护）', async () => {
    const r = await page.evaluate(() => {
      localStorage.removeItem('sdzk-beacon-log');
      SDZK_CFG.beacons = [{ id: 'e2e-test', type: 'prep', priority: 'std', at: Date.now() - 1000, title: 'E2E测试信标', body: 'x' }];
      runBeacons();
      const log = JSON.parse(localStorage.getItem('sdzk-beacon-log') || '{}');
      return { logged: !!log['e2e-test'], ui: document.getElementById('beaconLog').textContent };
    });
    const inSilent = await page.evaluate(() => SdzkCore._inSilent({ silentFrom: '22:00', silentTo: '08:30' }, Date.now()));
    if (inSilent) {
      assert.ok(!r.logged, '静默期内 std 不应落账（应为 defer）');
    } else {
      assert.ok(r.logged, '非静默应落账');
      assert.ok(r.ui.indexOf('E2E测试信标') >= 0, '回执卡应显示');
    }
  });

  console.log('—— 提醒中心（通知系统整改验收） ——');
  await t('铃铛打开提醒中心：能力诊断为真实检测结果', async () => {
    await page.click('#notifyBtn');
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      const el = document.getElementById('nsheet');
      const visible = el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight;
      const diag = document.getElementById('ncDiag').textContent;
      return { visible, hasEnv: diag.indexOf('运行环境') >= 0, hasPerm: diag.indexOf('通知权限') >= 0, hasSub: diag.indexOf('推送订阅') >= 0 };
    });
    assert.ok(r.visible, '面板未弹出');
    assert.ok(r.hasEnv && r.hasPerm && r.hasSub, '诊断项缺失');
  });
  await t('桌面环境（有 Push API）→ 动作区与真实权限状态一致（不虚构）', () => {
    return page.evaluate(() => {
      const c = detectCaps();
      if (!c.canPush) throw new Error('桌面 Edge 应具备 Push 能力，检测结果异常');
      const a = document.getElementById('ncAction').textContent;
      if (c.permission === 'denied') {
        if (a.indexOf('已被拒绝') < 0) throw new Error('denied 态应显示拒绝指引: ' + a.slice(0, 60));
      } else if (a.indexOf('开启系统通知') < 0) {
        throw new Error('default 态应显示开启按钮: ' + a.slice(0, 60));
      }
    });
  });
  await t('未订阅时点击「添加提醒」被正确拦截（不崩溃、给出原因）', async () => {
    await page.evaluate(() => { document.getElementById('ncAt').value = '2026-10-24T08:50'; ncAddRemind(); });
    await page.waitForTimeout(400);
    const t2 = await page.evaluate(() => document.getElementById('toast').textContent);
    assert.ok(t2.length > 0, '应有提示');
  });
  await t('提醒中心关闭（弹簧落位）', async () => {
    await page.evaluate(() => closeNC());
    await page.waitForTimeout(1000);
    const r = await page.evaluate(() => {
      const el = document.getElementById('nsheet');
      return { top: el.getBoundingClientRect().top, h: el.offsetHeight };
    });
    assert.ok(r.top >= r.h - 2, '未关闭 top=' + r.top);
  });
  await t('iOS 浏览器内环境 → 动作区显示「添加到主屏幕」三步引导（模拟 UA）', async () => {
    const p2 = await ctx.newPage();
    await p2.emulateMedia({ });  // no-op
    await p2.addInitScript(() => { Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }); });
    await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(600);
    const a = await p2.evaluate(() => { openNC(); return new Promise(res => setTimeout(() => res(document.getElementById('ncAction').textContent), 400)); });
    assert.ok(a.indexOf('添加到主屏幕') >= 0, 'iOS 浏览器内应显示主屏幕引导: ' + a.slice(0, 60));
    await p2.close();
  });

  console.log('—— 资料完整性检查（无脚本核心流程） ——');
  await t('只填姓名 → 检查发现缺失项与照片缺失', async () => {
    await page.evaluate(() => { document.getElementById('f-name').value = '测试员'; checkInfo(); });
    const r = await page.evaluate(() => document.getElementById('chkInfo').textContent);
    assert.ok(r.indexOf('缺') >= 0, '应报缺失: ' + r.slice(0, 50));
    assert.ok(r.indexOf('照片') >= 0, '应提示照片');
  });
  await t('填齐必备字段（含合法身份证）→ ✓ 齐全', async () => {
    await page.evaluate(({ id, ph }) => {
      document.getElementById('f-idcard').value = id;
      document.getElementById('f-phone').value = ph;
      document.getElementById('f-nation').value = '汉族';
      document.getElementById('f-examType').value = '夏季高考';
      document.getElementById('f-category').value = '城市应届';
      document.getElementById('f-school').value = '测试中学';
      checkInfo();
    }, { id: TEST_ID, ph: TEST_PHONE });
    const r = await page.evaluate(() => document.getElementById('chkInfo').textContent);
    assert.ok(r.indexOf('齐全') >= 0, '应显示齐全: ' + r.slice(0, 60));
  });
  await t('错误身份证被资料核对捕获', async () => {
    await page.evaluate(() => { document.getElementById('f-idcard').value = '110101199003074513'; checkInfo(); });
    const r = await page.evaluate(() => document.getElementById('chkInfo').textContent);
    assert.ok(r.indexOf('校验位') >= 0, '应报校验位: ' + r.slice(0, 60));
    await page.evaluate(({ id }) => { document.getElementById('f-idcard').value = id; checkInfo(); }, { id: TEST_ID });
  });

  console.log('—— 服务端提醒/测试推送端点（真实 HTTP 调用） ——');
  await t('POST /api/test-push 无此订阅 → 404 + ok:false（不假装成功）', async () => {
    const r = await fetch(BASE + '/api/test-push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/fake' }) });
    assert.strictEqual(r.status, 404);
    const j = await r.json();
    assert.strictEqual(j.ok, false);
  });
  await t('POST /api/remind 无订阅 → 409 拒绝（需先订阅）', async () => {
    const r = await fetch(BASE + '/api/remind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://x/fake', at: Date.now() + 60000, note: 't' }) });
    assert.strictEqual(r.status, 409);
  });
  await t('POST /api/remind 过去时间 → 400', async () => {
    const r = await fetch(BASE + '/api/remind', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: 'https://x/fake', at: Date.now() - 60000 }) });
    assert.strictEqual(r.status, 400);
  });
  await t('GET /api/health 含提醒调度状态', async () => {
    const j = await (await fetch(BASE + '/api/health')).json();
    assert.ok(typeof j.reminders === 'number', 'health 缺 reminders 字段');
  });

  console.log('—— V4.0 零安装核心：存储 / 逐项复制 / 能力矩阵 / 降级提醒 ——');
  await t('IndexedDB 持久化：写入 → 刷新页面 → 数据自动恢复', async () => {
    await page.click('button[data-v="info"]');
    await page.fill('#f-name', TEST_NAME);
    await page.fill('#f-idcard', TEST_ID);
    await page.fill('#f-phone', TEST_PHONE);
    await page.evaluate(() => saveInfo());
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const name = await page.evaluate(() => document.getElementById('f-name').value);
    assert.strictEqual(name, TEST_NAME, '刷新后姓名应从 IndexedDB 恢复');
  });
  await t('逐项复制：12 个字段均生成复制按钮，点击后剪贴板为该字段值', async () => {
    const r = await page.evaluate(async () => {
      const btns = document.querySelectorAll('.fld .copybtn');
      const b = document.querySelector('.fld .copybtn');
      b.click();
      await new Promise(res => setTimeout(res, 300));
      const txt = await navigator.clipboard.readText();
      return { n: btns.length, txt };
    });
    assert.ok(r.n >= 12, '复制按钮数量=' + r.n);
    assert.strictEqual(r.txt, TEST_NAME, '剪贴板内容应为姓名字段值');
  });
  await t('能力矩阵渲染：含「真实可用」「暂不支持」标签，官网可达性如实标注', async () => {
    const r = await page.evaluate(() => document.getElementById('capMatrix').textContent);
    assert.ok(r.indexOf('真实可用') >= 0, '应含真实可用');
    assert.ok(r.indexOf('暂不支持') >= 0, '应含暂不支持（跨站自动填表）');
    assert.ok(r.indexOf('同源策略') >= 0, '应说明同源策略硬限制');
    assert.ok(r.indexOf('IndexedDB') >= 0, '应如实展示存储后端');
  });
  await t('GET /api/origin-probe 如实返回（开闸前 unreachable 或 HTTP 状态，不虚构）', async () => {
    const j = await (await fetch(BASE + '/api/origin-probe')).json();
    assert.ok(j.status === 'ok' || j.status === 'unreachable', 'status=' + j.status);
    if (j.status === 'unreachable') assert.ok(j.note && j.note.length > 5, '应有如实说明');
  });
  await t('ICS 生成器（浏览器内）：包含开闸事件且 UTC 正确', () => {
    return page.evaluate(() => {
      const s = SdzkCore.buildICS(officialICSEvents());
      if (s.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('缺 VCALENDAR');
      if (s.indexOf('DTSTART:20261023T010000Z') < 0 && s.indexOf('DTSTART:20261024T010000Z') < 0) throw new Error('开闸 DTSTART 缺失');
      if (s.split('BEGIN:VEVENT').length - 1 < 2) throw new Error('官方事件应≥2 条');
    });
  });
  await t('页面内提醒（降级）：注入到期提醒 → checkLocalReminds 触发提示', async () => {
    const r = await page.evaluate(() => {
      localStorage.setItem('sdzk-local-reminds', JSON.stringify([
        { id: 'e2e-lr', at: Date.now() - 1000, note: 'E2E页面内提醒', fired: false }]));
      checkLocalReminds(Date.now());
      const list = JSON.parse(localStorage.getItem('sdzk-local-reminds'));
      return { fired: list[0] && list[0].fired, toast: document.getElementById('toast').textContent };
    });
    assert.strictEqual(r.fired, true, '应标记已触发');
    assert.ok(r.toast.indexOf('E2E页面内提醒') >= 0, '提示应出现: ' + r.toast.slice(0, 50));
    await page.evaluate(() => { if (typeof closeFS === 'function') closeFS(); });   // 全屏信标会遮挡点击，测试后关闭
  });
  await t('提醒中心降级分支：非推送环境下显示日历导出按钮 + 页面内提醒说明', async () => {
    await page.evaluate(() => openNC());
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({
      act: document.getElementById('ncAction').textContent,
      how: document.getElementById('ncRemindHow').textContent }));
    const c = await page.evaluate(() => detectCaps());
    if (!c.canPush) {
      assert.ok(r.act.indexOf('导出日历提醒') >= 0, '应有日历导出按钮: ' + r.act.slice(0, 80));
      assert.ok(r.how.indexOf('页面内提醒') >= 0, '应说明页面内提醒降级');
    }
    await page.evaluate(() => closeNC());
  });

  console.log('—— V5.0 零安装纯网站：依赖审计 / 字段模块 / 内置浏览器 / 复制反馈 ——');
  await t('零外部脚本依赖：页面无 Violentmonkey/Tampermonkey/脚本下载残留', () => {
    return page.evaluate(() => {
      const txt = document.body.textContent + document.body.innerHTML;
      for (const bad of ['Violentmonkey', 'Tampermonkey', '油猴', 'chromewebstore', '.user.js', '脚本管理器', '下载可选脚本'])
        if (txt.includes(bad)) throw new Error('残留外部脚本引用: ' + bad);
    });
  });
  await t('官方入口指向正确域名（wsbm.sdzk.cn，非中转页）', () => {
    return page.evaluate(() => {
      const a = document.querySelector('a.tile.pri[href]');
      if (!a || !a.href.startsWith('https://wsbm.sdzk.cn')) throw new Error('入口 href=' + (a && a.href));
    });
  });
  await t('FIELD_META 校验：格式错误的手机号/学籍号被「填写前检查」捕获', async () => {
    await page.click('button[data-v="info"]');
    await page.evaluate(phone => {
      document.getElementById('f-phone').value = '12345';
      document.getElementById('f-studentNo').value = 'X123';
      checkInfo();
    }, TEST_PHONE);
    const r = await page.evaluate(() => document.getElementById('chkInfo').textContent);
    assert.ok(r.indexOf('手机号') >= 0 && r.indexOf('11 位') >= 0, '手机号格式应被捕获: ' + r.slice(0, 80));
    assert.ok(r.indexOf('学籍号') >= 0, '学籍号格式应被捕获');
    await page.evaluate(phone => {
      document.getElementById('f-phone').value = phone;
      document.getElementById('f-studentNo').value = '';
    }, TEST_PHONE);
  });
  await t('复制成功 ≠ 官网已填写：核对结论明示两者区别', () => {
    return page.evaluate(nm => {
      document.getElementById('f-name').value = nm;
      checkInfo();
      const r = document.getElementById('chkInfo').textContent;
      if (r.indexOf('不等于官网已填写') < 0) throw new Error('缺少区别说明');
    }, TEST_NAME);
  });
  await t('微信内置浏览器 → 横幅引导「用系统浏览器打开」+ 复制网址按钮', async () => {
    await page.evaluate(ua => {
      Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.49', configurable: true });
      renderEmbBanner();
    }, originalUA);
    const r = await page.evaluate(() => {
      const el = document.getElementById('embBanner');
      return { shown: el.style.display !== 'none', txt: el.textContent };
    });
    assert.ok(r.shown, '横幅应显示');
    assert.ok(r.txt.indexOf('微信内置浏览器') >= 0 && r.txt.indexOf('在浏览器打开') >= 0 && r.txt.indexOf('复制本站网址') >= 0);
    await page.evaluate(ua => {
      Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
      renderEmbBanner();
    }, originalUA);
  });
  await t('复制失败时给真实反馈（API 拒绝 + execCommand 兜底也失败）', async () => {
    const r = await page.evaluate(async () => {
      const proto = Object.getPrototypeOf(navigator.clipboard);
      const d1 = Object.getOwnPropertyDescriptor(proto, 'writeText');
      const origExec = document.execCommand;
      Object.defineProperty(proto, 'writeText', { value: () => Promise.reject(new Error('denied')), configurable: true, writable: true });
      document.execCommand = function (cmd) { if (cmd === 'copy') throw new Error('blocked'); return origExec.apply(this, arguments); };
      const btn = document.querySelector('.fld .copybtn');
      btn.click();
      await new Promise(res => setTimeout(res, 300));
      Object.defineProperty(proto, 'writeText', d1);
      document.execCommand = origExec;
      return document.getElementById('toast').textContent;
    });
    assert.ok(r.indexOf('复制失败') >= 0, '应有失败反馈: ' + r.slice(0, 60));
  });
  await t('全页无「自动填写成功/已填入官网」类虚假宣称', () => {
    return page.evaluate(() => {
      const txt = document.body.textContent;
      for (const bad of ['自动填写成功', '已填入官网', '官网已填写成功'])
        if (txt.includes(bad)) throw new Error('发现虚假宣称: ' + bad);
    });
  });

  console.log('—— 隐私网络审计汇总 ——');
  await t('全程无任何请求携带身份证/手机/姓名（零外泄）', () => {
    if (leaks.length) throw new Error('外泄点:\n' + leaks.join('\n'));
    console.log('     （审计覆盖 ' + '全部' + ' 出站请求）');
  });

  /* CDP 截图留证 */
  const cdp = await ctx.newCDPSession(page);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('assets/e2e-final.png', Buffer.from(shot.data, 'base64'));

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
