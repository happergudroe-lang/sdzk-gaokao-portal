// ==UserScript==
// @name         山东高考报名 · 一键填写
// @namespace    sdzk-quickfill
// @version      2.0.0
// @description  在 wsbm.sdzk.cn 报名页一键填充报名信息、自动上传照片。高风险字段（报考类型/考生类别/政治面貌）填写前逐项确认；填完回读实际值生成校验报告。数据来自「山东高考报名面板」导出的报名数据（仅存本机）。
// @author       sdzk-portal
// @match        https://wsbm.sdzk.cn/*
// @match        http://wsbm.sdzk.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

(function () {
  'use strict';

  /* ================= 字段识别规则 =================
     按输入控件的 name / id / placeholder / 关联 label 文本做关键词匹配。
     关键词越具体越优先。risk:'high' 的字段填前必须人工确认（不可跳过）；
     label 用于校验报告展示。 */
  const RULES = [
    { k: 'name',     label:'姓名',     keys: ['考生姓名', '姓名'],                       fill: d => d.name },
    { k: 'idcard',   label:'身份证号', keys: ['身份证号', '身份证明号码', '身份证件号码', '证件号码', '身份证', '证件号'], fill: d => d.idcard },
    { k: 'phone',    label:'手机号',   keys: ['手机号码', '移动电话', '手机号', '手机', '联系电话', '联系方式', '电话'], fill: d => d.phone },
    { k: 'school',   label:'学校',     keys: ['毕业学校', '就读学校', '学校名称', '毕业中学', '学校'], fill: d => d.school },
    { k: 'studentNo',label:'学籍号',   keys: ['学籍号', '考籍号', '辅学号'],             fill: d => d.studentNo },
    { k: 'qq',       label:'QQ号',     keys: ['qq号码', 'qq号', 'qq'],                   fill: d => d.qq },
    { k: 'email',    label:'邮箱',     keys: ['电子邮箱', '电子邮件', '邮箱', '邮件'],   fill: d => d.email },
    { k: 'address',  label:'地址',     keys: ['户籍地址', '通讯地址', '家庭住址', '住址', '地址'], fill: d => d.address },
    { k: 'birth',    label:'出生日期', keys: ['出生日期', '出生年月', '出生'],           fill: d => birthFromId(d.idcard) },
    { k: 'gender',   label:'性别',     keys: ['性别'],                                   fill: d => genderFromId(d.idcard) },
    { k: 'nation',   label:'民族',     keys: ['民族'],                                   fill: d => d.nation, select: true },
    { k: 'politics', label:'政治面貌', keys: ['政治面貌'],                               fill: d => d.politics, select: true, risk: 'high' },
    { k: 'examType', label:'报考类型', keys: ['报考类型', '考试类型', '报考科类', '科类'], fill: d => d.examType, select: true, risk: 'high' },
    { k: 'category', label:'考生类别', keys: ['考生类别', '毕业生类别', '类别'],         fill: d => d.category, select: true, risk: 'high' },
    { k: 'milk',     label:'籍贯',     keys: ['籍贯'],                                   fill: d => d.nativePlace },
  ];

  /* ================= 工具 ================= */
  const idc = () => (data().idcard || '');
  function birthFromId(id) {
    if (!/^\d{17}[\dXx]$/.test(id)) return '';
    return id.slice(6, 10) + '-' + id.slice(10, 12) + '-' + id.slice(12, 14);
  }
  function genderFromId(id) {
    if (!/^\d{17}[\dXx]$/.test(id)) return '';
    return (+id[16]) % 2 === 1 ? '男' : '女';
  }
  const data = () => { try { return JSON.parse(GM_getValue('sdzkData', '{}')); } catch (e) { return {}; } };
  const saveData = d => GM_setValue('sdzkData', d);

  function norm(s) { return (s || '').replace(/\s+/g, '').toLowerCase(); }
  function labelOf(el) {
    // 关联 label 的多种方式
    let t = '';
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t += l.textContent; }
    const wrap = el.closest('label'); if (wrap) t += wrap.textContent;
    let p = el.parentElement, hop = 0;
    while (p && hop < 3) {
      const l = p.querySelector('label'); if (l && !l.contains(el)) t += l.textContent;
      t += (p.previousElementSibling && p.previousElementSibling.textContent) || '';
      p = p.parentElement; hop++;
    }
    if (el.getAttribute('aria-label')) t += el.getAttribute('aria-label');
    return norm(t);
  }
  function tagOf(el) { return norm([el.name, el.id, el.placeholder].join('|')); }
  function matchField(el) {
    const hay = tagOf(el) + '|' + labelOf(el);
    let best = null, bestLen = 0;
    for (const r of RULES) {
      for (const kw of r.keys) {
        if (hay.includes(norm(kw)) && kw.length > bestLen) { best = r; bestLen = kw.length; }
      }
    }
    return best;
  }
  function fillableInputs() {
    return Array.from(document.querySelectorAll('input, textarea, select')).filter(el => {
      const t = (el.type || '').toLowerCase();
      if (el.disabled || el.readOnly) return false;
      if (['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(t)) return false;
      if (el.tagName === 'SELECT') return true;
      return true;
    });
  }
  function fire(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }
  function setSelect(el, val) {
    if (!val) return false;
    const v = norm(val);
    for (const o of el.options) {
      if (norm(o.textContent).includes(v) || norm(o.value) === v) { el.value = o.value; return true; }
    }
    return false;
  }
  function mark(el, ok) {
    el.style.transition = 'box-shadow .25s, border-color .25s';
    el.style.boxShadow = ok ? '0 0 0 2px rgba(52,199,89,.55)' : '0 0 0 2px rgba(255,149,0,.6)';
    setTimeout(() => { el.style.boxShadow = ''; }, 2600);
  }

  /* ================= 核心动作 ================= */
  function readBack(el) {           // 填后回读真实值（不猜）
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      return o ? o.textContent.trim() : '';
    }
    return (el.value || '').trim();
  }
  function quickFill() {
    const d = data();
    if (!d.name && !d.idcard && !d.phone) { toast('还没有报名数据，先点「导入面板数据」'); return; }
    const used = new Set();
    const report = [];              // { label, status, detail }
    let ok = 0;
    for (const el of fillableInputs()) {
      if (used.has(el)) continue;
      const r = matchField(el);
      if (!r || used.has(r.k)) continue;
      const val = r.fill(d);
      if (!val) continue;
      /* 高风险字段：填前必须确认，绝不静默替用户做重大选择 */
      if (r.risk === 'high') {
        const go = confirm('【需要你确认】\n\n将把「' + r.label + '」填写为：' + val + '\n\n这直接影响你的考试方式/身份类别，填错可能无法更改。\n确认填写这一项吗？');
        if (!go) { report.push({ label: r.label, status: 'skip', detail: '用户选择不自动填（请手动选择）' }); used.add(r.k); used.add(el); continue; }
      }
      let done = false;
      if (el.tagName === 'SELECT') done = setSelect(el, val);
      else { el.value = val; done = true; }
      if (done) {
        fire(el); mark(el, true);
        used.add(r.k); used.add(el); ok++;
        const actual = readBack(el);
        const match = actual && (norm(actual).includes(norm(val)) || norm(val).includes(norm(actual)));
        report.push({ label: r.label, status: match ? 'ok' : 'check', detail: match ? '已填写并校验' : ('需核对：页面实际值「' + actual.slice(0, 24) + '」') });
      } else {
        report.push({ label: r.label, status: 'fail', detail: '下拉框里没找到「' + val + '」选项，需手动选择' });
      }
    }
    showReport(ok, report);
  }

  /* ================= 校验报告（回读真实值，可复制） ================= */
  let rptEl = null;
  function showReport(ok, report) {
    if (!rptEl) {
      rptEl = document.createElement('div');
      rptEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483640;width:min(92vw,420px);'
        + 'background:#fff;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.35);padding:18px 18px 14px;'
        + 'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1c1c1e;';
      document.documentElement.appendChild(rptEl);
    }
    const icon = { ok: '✅', check: '⚠️', fail: '❌', skip: '⏸' };
    const rows = report.length
      ? report.map(r => `<div style="display:flex;gap:8px;padding:7px 0;border-bottom:.5px solid rgba(60,60,67,.12);font-size:13px;line-height:1.45">
          <span style="flex:none">${icon[r.status]}</span>
          <span style="font-weight:600;flex:none;min-width:64px">${r.label}</span>
          <span style="color:#3c3c43">${r.detail}</span></div>`).join('')
      : '<div style="padding:10px 0;font-size:13px;color:#8e8e93">本页没有匹配到可填字段——页面结构可能不同，把字段名反馈给面板。</div>';
    rptEl.innerHTML = `
      <div style="font-size:16px;font-weight:700;margin-bottom:2px">填写校验报告</div>
      <div style="font-size:12px;color:#8e8e93;margin-bottom:8px">已填 ${ok} 项 · 值为回读页面真实结果，非预设</div>
      <div style="max-height:46vh;overflow:auto">${rows}</div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="sdzk-rpt-copy" style="flex:1;border:none;border-radius:10px;min-height:40px;font-size:14px;font-weight:600;background:rgba(0,122,255,.12);color:#007aff;cursor:pointer">复制报告</button>
        <button id="sdzk-rpt-close" style="flex:1;border:none;border-radius:10px;min-height:40px;font-size:14px;font-weight:600;background:#1c1c1e;color:#fff;cursor:pointer">关闭</button>
      </div>`;
    rptEl.querySelector('#sdzk-rpt-close').onclick = () => { rptEl.remove(); };
    rptEl.querySelector('#sdzk-rpt-copy').onclick = () => {
      const txt = '【sdzk 一键填写校验报告】\n' + report.map(r => `${icon[r.status]} ${r.label}：${r.detail}`).join('\n')
        + `\n生成时间 ${new Date().toLocaleString()}（报告只含字段状态，不含个人信息）`;
      navigator.clipboard.writeText(txt).then(() => toast('报告已复制'), () => toast('复制失败'));
    };
    toast(`已填充 ${ok} 项，回读校验完成——请人工核对后提交`);
  }

  async function quickUpload() {
    const d = data();
    if (!d.photo) { toast('面板里还没有照片'); return; }
    const inputs = Array.from(document.querySelectorAll('input[type=file]')).filter(i => !i.disabled);
    if (!inputs.length) { toast('页面上没找到文件上传框'); return; }
    const blob = await (await fetch(d.photo)).blob();
    let n = 0;
    for (const input of inputs) {
      try {
        const file = new File([blob], d.photoName || 'photo.jpg', { type: blob.type || 'image/jpeg' });
        const dt = new DataTransfer(); dt.items.add(file);
        input.files = dt.files;
        fire(input); mark(input, true); n++;
      } catch (e) { /* 某些自定义上传组件不接受脚本注入 */ }
    }
    toast(n ? ('已上传照片到 ' + n + ' 个框，请确认预览') : '上传框拒绝了注入，请手动选一次照片');
  }

  async function importFromClipboard() {
    try {
      const txt = await navigator.clipboard.readText();
      const d = JSON.parse(txt);
      if (!d || (!d.name && !d.idcard)) { toast('剪贴板内容不是面板导出的报名数据'); return; }
      saveData(d); renderSummary(); toast('导入成功 ✓ 数据只存在本机扩展里');
    } catch (e) { toast('读取剪贴板失败：' + e.message.slice(0, 40)); }
  }

  /* ================= 悬浮球 + 面板（弹簧动画） ================= */
  const host = document.createElement('div');
  host.id = 'sdzk-qf-host';
  host.style.cssText = 'position:fixed;right:14px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:2147483600;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;';
  document.documentElement.appendChild(host);
  const sh = host.attachShadow({ mode: 'closed' });

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;margin:0;padding:0}
  .fab{
    width:56px;height:56px;border-radius:50%;cursor:pointer;user-select:none;
    background:linear-gradient(145deg,#0a5cc4,#3aa8f0);color:#fff;
    display:grid;place-items:center;font-size:13px;font-weight:700;line-height:1.15;text-align:center;
    box-shadow:0 4px 16px rgba(10,92,196,.45), 0 1px 3px rgba(0,0,0,.2);
    transition:transform .12s cubic-bezier(.2,0,.2,1);
    will-change:transform;touch-action:none;
  }
  .fab:active{transform:scale(.92)}
  .panel{
    position:absolute;bottom:64px;right:0;width:264px;
    background:rgba(250,250,252,.96);backdrop-filter:blur(20px) saturate(180%);
    border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.22);
    padding:6px 0 8px;transform-origin:100% 100%;
    opacity:0;transform:scale(.8) translateY(10px);pointer-events:none;
    transition:opacity .22s cubic-bezier(.32,.72,0,1), transform .28s cubic-bezier(.32,.72,0,1);
    will-change:transform,opacity;
  }
  .panel.open{opacity:1;transform:none;pointer-events:auto}
  .hd{font-size:13px;font-weight:700;color:#3c3c43;padding:9px 14px 7px;display:flex;justify-content:space-between;align-items:center}
  .hd span{font-weight:400;color:#8e8e93;font-size:11px}
  .sum{margin:0 10px 6px;padding:7px 10px;border-radius:9px;background:rgba(0,122,255,.08);font-size:11px;color:#3c3c43;line-height:1.5}
  .it{display:flex;align-items:center;gap:9px;padding:9px 14px;font-size:13px;color:#1c1c1e;cursor:pointer;transition:background .12s}
  .it:hover{background:rgba(0,0,0,.05)}
  .it:active{background:rgba(0,0,0,.1)}
  .it svg{width:16px;height:16px;flex:none;opacity:.7}
  .it .sub{margin-left:auto;font-size:10px;color:#8e8e93}
  .warn{margin:2px 10px 4px;font-size:10px;line-height:1.5;color:#8e8e93}
  #tst{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);background:rgba(30,30,32,.92);color:#fff;font-size:12px;padding:8px 14px;border-radius:99px;opacity:0;transition:opacity .25s, transform .3s cubic-bezier(.32,.72,0,1);pointer-events:none;max-width:80vw;text-align:center}
  #tst.on{opacity:1;transform:translateX(-50%) translateY(-6px)}
  `;
  const ico = {
    fill:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M9 13l2 2l4 -4"/></svg>',
    up:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v-10"/><path d="M8 11l4 -4l4 4"/><path d="M4 19h16"/></svg>',
    imp:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3h6v3"/></svg>',
  };
  sh.innerHTML = `<style>${CSS}</style>
    <div class="fab" id="fab">一键<br>填写</div>
    <div class="panel" id="panel">
      <div class="hd">报名数据 <span id="sumT"></span></div>
      <div class="sum" id="sum">未导入</div>
      <div class="it" id="mImp">${ico.imp}导入面板数据<span class="sub">先在面板点「复制」</span></div>
      <div class="it" id="mFill">${ico.fill}一键填写表单</div>
      <div class="it" id="mUp">${ico.up}一键上传照片</div>
      <div class="it" id="mClr">${ico.clear}清除本机数据</div>
      <div class="warn">数据仅保存在本机浏览器扩展内，不上传任何服务器。报考类型/考生类别/政治面貌填前会逐项向你确认；填完自动回读生成校验报告。提交前务必人工核对。</div>
    </div>
    <div id="tst"></div>`;

  const $ = s => sh.getElementById(s);
  const panel = $('panel'), fab = $('fab'), tst = $('tst');
  let open = false;
  function toggle(v) {
    open = v === undefined ? !open : v;
    panel.classList.toggle('open', open);
    renderSummary();
  }
  fab.addEventListener('click', e => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', e => { if (open && !host.contains(e.target)) toggle(false); });
  function toast(m) { tst.textContent = m; tst.classList.add('on'); clearTimeout(tst._t); tst._t = setTimeout(() => tst.classList.remove('on'), 2600); }

  function renderSummary() {
    const d = data();
    const n = ['name', 'idcard', 'phone', 'school', 'qq', 'email', 'address', 'nation', 'politics', 'examType', 'category', 'studentNo', 'nativePlace'].filter(k => d[k]).length;
    $('sum').textContent = d.name
      ? `${d.name} ｜ 证件 ${d.idcard ? d.idcard.slice(0, 6) + '****' + d.idcard.slice(-4) : '—'} ｜ ${n} 项${d.photo ? ' ｜ 含照片' : ''}`
      : '未导入';
    $('sumT').textContent = 'GM 本机存储';
  }
  $('mImp').onclick = () => importFromClipboard();
  $('mFill').onclick = () => { quickFill(); };
  $('mUp').onclick = () => quickUpload();
  $('mClr').onclick = () => { GM_deleteValue('sdzkData'); renderSummary(); toast('已清除'); };

  /* 悬浮球拖拽（1:1 + 橡皮筋吸边） */
  let drag = null;
  fab.addEventListener('pointerdown', e => {
    fab.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, ox: 0, oy: 0, moved: false, hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
  });
  fab.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
    drag.ox = dx; drag.oy = dy;
    fab.style.transform = `translate(${dx}px,${dy}px)`;
    drag.hist.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (drag.hist.length > 5) drag.hist.shift();
  });
  const endDrag = e => {
    if (!drag) return;
    const h = drag.hist;
    const a = h[0], b = h[h.length - 1];
    const dt = Math.max((b.t - a.t) / 1000, 0.001);
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const d = drag; drag = null;
    if (!d.moved) { fab.style.transform = ''; return; }   // 是点击，不是拖拽
    /* 从当前位置弹性吸附到最近的左右边（速度交接 + 欠阻尼回弹） */
    const rect = fab.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const drift = (vx / 1000) * 0.998 / (1 - 0.998) * 0.35;
    const targetX = (cx + drift < innerWidth / 2) ? 14 : innerWidth - rect.width - 14;
    const targetY = Math.max(12, Math.min(innerHeight - rect.height - 12, rect.top + (vy / 1000) * 0.35));
    const distX = targetX - rect.left, distY = targetY - rect.top;
    const st = { x: d.ox, y: d.oy, vx: vx / 10, vy: vy / 10 };
    const w = 2 * Math.PI / 0.38, k = w * w, c = 2 * 0.8 * w, dt2 = 1 / 60;
    (function anim() {
      st.vx += (-k * (st.x - distX) - c * st.vx) * dt2;
      st.vy += (-k * (st.y - distY) - c * st.vy) * dt2;
      st.x += st.vx * dt2; st.y += st.vy * dt2;
      fab.style.transform = `translate(${st.x}px,${st.y}px)`;
      if (Math.hypot(st.x - distX, st.y - distY) > 0.6 || Math.hypot(st.vx, st.vy) > 8) requestAnimationFrame(anim);
      else { fab.style.transform = ''; positionFab(targetX, targetY); }
    })();
  };
  function positionFab(x, y) {
    fab.style.transform = '';
    host.style.right = 'auto';
    host.style.left = x + 'px';
    host.style.top = y + 'px';
    host.style.bottom = 'auto';
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);

  console.log('[sdzk-quickfill] 就绪：悬浮球已注入');
})();
