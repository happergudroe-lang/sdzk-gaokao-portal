/* =====================================================================
   SdzkCore — 核心纯逻辑层（倒计时换算 / 官方状态机 / 时间信标评估 / 脱敏）
   同构模块：浏览器挂 window.SdzkCore，Node 直接 require。
   所有函数无副作用、无 DOM、无网络，可独立单元测试。
   ===================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SdzkCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var pad2 = function (n) { return String(n).padStart(2, '0'); };

  /* ---------------- 配置解析 ---------------- */
  /* cfg.fillPhase = {start,end,dailyOpen:"09:00",dailyClose:"18:00"} 等
     返回绝对毫秒时间戳；解析失败返回 null，绝不抛错、绝不猜 */
  function ts(s) {
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  function dailyBoundary(baseDayTs, hm, tzOffsetMin) {
    // 用本地时区把 "HH:MM" 落到 baseDayTs 所在自然日
    var d = new Date(baseDayTs);
    var p = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
    if (!p) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +p[1], +p[2], 0, 0).getTime();
  }

  /* ---------------- 官方状态机（8 态） ----------------
   * probe: null（未探测）| { ok:true, at } | { ok:false, at }
   * 返回 { code, level, text, detail }
   * level: danger | warn | ok | muted
   */
  function officialState(cfg, now, probe) {
    var f = cfg.fillPhase || {};
    var start = ts(f.start), end = ts(f.end);
    if (start === null || end === null) {
      return { code: 'config_error', level: 'warn', text: '配置错误', detail: '官方时间配置无法解析，请更新配置' };
    }
    if (now < start) {
      return { code: 'not_started', level: 'muted', text: '尚未开始',
        detail: '计划 ' + fmtDT(start) + ' 开放（以官方系统实际为准）' };
    }
    if (now > end) {
      return { code: 'ended', level: 'muted', text: '本期填报已结束',
        detail: '填报期已于 ' + fmtDT(end) + ' 结束' };
    }
    // 在填报期内：判断每日窗口
    var dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    var dayTs = dayStart.getTime();
    var open = dailyBoundary(dayTs, f.dailyOpen), close = dailyBoundary(dayTs, f.dailyClose);
    if (open === null || close === null) {
      return { code: 'config_error', level: 'warn', text: '配置错误', detail: '每日开放时间配置无法解析' };
    }
    var inWindow = now >= open && now <= close;

    if (!inWindow) {
      var nextOpen = now < open ? open : dailyBoundary(dayTs + 86400e3, f.dailyOpen);
      return { code: 'daily_closed', level: 'warn', text: now < open ? '今日尚未开放' : '今日已关闭',
        detail: (now < open ? '今日 ' : '明日 ') + (f.dailyOpen) + ' 开放 · 还剩 ' + fmtDur(nextOpen - now) };
    }
    // 在窗口内：结合探测结果
    if (!probe) {
      return { code: 'planned_unverified', level: 'warn', text: '计划开放中 · 未核实',
        detail: '已到计划开放时间，尚未完成连通性探测。点「立即探测」核实。' };
    }
    if (probe.ok) {
      return { code: 'open_verified', level: 'ok', text: '已核实开放',
        detail: '探测于 ' + fmtDT(probe.at) + ' 收到服务器响应' };
    }
    // 计划内但探测失败：不谎称官方关闭
    return { code: 'check_failed', level: 'warn', text: '计划开放中 · 暂时无法核实',
      detail: '探测未获响应（' + fmtDT(probe.at) + '）。可能是高峰拥堵，不代表官方关闭，稍后重试。' };
  }

  /* ---------------- 时间换算（严格边界） ---------------- */
  function countdownParts(targetMs, now) {
    var s = Math.max(0, Math.floor((targetMs - now) / 1000));
    return {
      d: Math.floor(s / 86400),
      h: Math.floor((s % 86400) / 3600),
      m: Math.floor((s % 3600) / 60),
      s: s % 60,
      pad: function () { return [pad2(this.d), pad2(this.h), pad2(this.m), pad2(this.s)]; }
    };
  }
  function fmtDur(ms) {
    if (ms < 0) return '已过期';
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400); s %= 86400;
    var h = Math.floor(s / 3600); s %= 3600;
    var m = Math.floor(s / 60);
    if (d > 0) return d + ' 天 ' + h + ' 小时';
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒';
    return s + ' 秒';
  }
  function fmtDT(ms) {
    var d = new Date(ms);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /* ---------------- 时间信标评估引擎 ----------------
   * beacons: [{ id, type:'open'|'prep'|'risk'|'change'|'done'|'silent', at, priority:'high'|'std'|'low', title, body, url, cond? }]
   * ctx: { now, silentFrom:"22:00", silentTo:"08:30",
   *        sentLog:{ [id]: lastNotifiedTs }, checklistDone:bool, fieldsReady:bool, officialOk:bool|null }
   * 返回 actions: [{ id, action:'notify'|'defer'|'suppress'|'none', reason, strength }]
   * 规则透明可解释；静默期 defer（绝不积压轰炸：静默结束仅评估一次、每信标每日至多 1 条）
   */
  function inSilent(ctx, now) {
    var f = ctx.silentFrom || '22:00', t = ctx.silentTo || '08:30';
    var d = new Date(now);
    var mk = function (hm) { var p = /^(\d{1,2}):(\d{2})$/.exec(hm); return p ? (+p[1]) * 60 + (+p[2]) : 0; };
    var cur = d.getHours() * 60 + d.getMinutes();
    var a = mk(f), b = mk(t);
    return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);
  }
  function evalBeacons(beacons, ctx) {
    var now = ctx.now || Date.now();
    var sent = ctx.sentLog || {};
    var out = [];
    beacons.forEach(function (b) {
      var last = sent[b.id] || 0;
      var sameDay = last && new Date(last).toDateString() === new Date(now).toDateString();
      if (!b.at || now < b.at) { out.push({ id: b.id, action: 'none', reason: '未到触发时间' }); return; }
      if (b.type === 'done' || b.done) { out.push({ id: b.id, action: 'none', reason: '已由用户确认完成' }); return; }
      if (sameDay) { out.push({ id: b.id, action: 'suppress', reason: '今日已提醒过（重复抑制）' }); return; }
      if (now - last > 36 * 3600e3 || !last) {
        if (inSilent(ctx, now) && b.priority !== 'high') {
          out.push({ id: b.id, action: 'defer', reason: '静默时段内，延后到静默结束' });
          return;
        }
        out.push({ id: b.id, action: 'notify', strength: b.priority || 'std', reason: '到达触发时间且未提醒' });
        return;
      }
      out.push({ id: b.id, action: 'suppress', reason: '36 小时内已提醒（有限重提醒）' });
    });
    return out;
  }

  /* ---------------- 风险窗口 ---------------- */
  function riskWindow(item, now, userDone) {
    if (userDone) return { level: 'done', text: '已完成（用户确认，非官方确认）' };
    if (!item.at) return { level: 'unknown', text: '状态未知' };
    var left = item.at - now;
    if (left < 0) return { level: 'expired', text: '已过期' };
    if (left < 12 * 3600e3) return { level: 'high', text: '高风险 · 剩 ' + fmtDur(left) };
    if (left < 72 * 3600e3) return { level: 'watch', text: '需要关注 · 剩 ' + fmtDur(left) };
    return { level: 'low', text: '低风险 · 剩 ' + fmtDur(left) };
  }

  /* ---------------- 脱敏 ---------------- */
  function redact(key, val) {
    var s = String(val == null ? '' : val);
    if (!s) return '';
    if (key === 'idcard') return s.length >= 10 ? s.slice(0, 4) + '**********' + s.slice(-4) : '******';
    if (key === 'phone') return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : '***';
    if (key === 'email') { var i = s.indexOf('@'); return i > 1 ? s.slice(0, 2) + '***' + s.slice(i) : '***'; }
    if (key === 'address') return s.slice(0, 6) + '…';
    if (key === 'name') return s.length <= 1 ? s : s[0] + '*'.repeat(Math.max(1, s.length - 1));
    return s.length > 10 ? s.slice(0, 4) + '…' : s;
  }

  /* ---------------- 身份证校验 ---------------- */
  function idcardCheck(id) {
    id = String(id || '').toUpperCase();
    if (!/^\d{17}[\dX]$/.test(id)) return { ok: false, reason: '格式不符（18 位，末位可为 X）' };
    var W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], M = '10X98765432', sum = 0;
    for (var i = 0; i < 17; i++) sum += (+id[i]) * W[i];
    var ok = M[sum % 11] === id[17];
    return {
      ok: ok,
      reason: ok ? '校验通过' : '校验位不符，请核对',
      birth: id.slice(6, 10) + '-' + id.slice(10, 12) + '-' + id.slice(12, 14),
      gender: (+id[16]) % 2 === 1 ? '男' : '女'
    };
  }

  /* ---------------- ICS 日历导出（降级提醒：导出 ≠ 实时推送） ----------------
     events: [{ title, desc, at( epoch ms ), durMin( 可选, 默认 30 ) }]
     输出 RFC 5545 文本：UTC 时间(Z 后缀)，开闸类事件带 30 分钟前 VALARM 弹窗。 */
  function icsEsc(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }
  function icsUTC(ms) {
    var d = new Date(ms);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' +
           p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  }
  function buildICS(events, opts) {
    opts = opts || {};
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0',
      'PRODID:-//sdzk-portal//remind//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    (events || []).forEach(function (e, i) {
      if (!e || !isFinite(e.at)) return;
      var dur = (e.durMin || 30) * 60000;
      lines.push('BEGIN:VEVENT');
      lines.push('UID:sdzk-' + e.at + '-' + i + '@sdzk-portal.local');
      lines.push('DTSTAMP:' + icsUTC(opts.now || Date.now()));
      lines.push('DTSTART:' + icsUTC(e.at));
      lines.push('DTEND:' + icsUTC(e.at + dur));
      lines.push('SUMMARY:' + icsEsc(e.title || '提醒'));
      if (e.desc) lines.push('DESCRIPTION:' + icsEsc(e.desc));
      lines.push('BEGIN:VALARM');
      lines.push('TRIGGER:-PT30M');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + icsEsc(e.title || '提醒'));
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  return {
    ts: ts, dailyBoundary: dailyBoundary, officialState: officialState,
    countdownParts: countdownParts, fmtDur: fmtDur, fmtDT: fmtDT,
    evalBeacons: evalBeacons, riskWindow: riskWindow, redact: redact, idcardCheck: idcardCheck,
    buildICS: buildICS,
    _inSilent: inSilent
  };
});
