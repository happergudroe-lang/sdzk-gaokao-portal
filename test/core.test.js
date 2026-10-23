/* core.js 单元测试 —— node test/core.test.js
   覆盖：8 态官方状态机边界 / 倒计时换算 / 信标静默与重复抑制 / 脱敏 / 身份证校验 / 风险窗口 */
'use strict';
const C = require('../core.js');
const assert = require('assert');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + e.message); }
}

const CFG = {
  fillPhase:  { start: '2026-10-24T09:00:00+08:00', end: '2026-10-30T18:00:00+08:00', dailyOpen: '09:00', dailyClose: '18:00' },
  auditPhase: { start: '2026-10-31T00:00:00+08:00', end: '2026-11-12T23:59:59+08:00' },
  feePhase:   { start: '2026-11-13T00:00:00+08:00', end: '2026-11-15T23:59:59+08:00' },
};
const T_OPEN  = C.ts(CFG.fillPhase.start);
const T_CLOSE = C.ts(CFG.fillPhase.end);
const ms = (s) => C.ts(s);

console.log('—— 官方状态机（8 态）——');
t('开闸前 → not_started', () => {
  const s = C.officialState(CFG, ms('2026-10-23T20:00:00+08:00'), null);
  assert.strictEqual(s.code, 'not_started');
});
t('填报期工作日 10:00 + 未探测 → planned_unverified（不谎称开放）', () => {
  const s = C.officialState(CFG, ms('2026-10-26T10:00:00+08:00'), null);
  assert.strictEqual(s.code, 'planned_unverified');
});
t('填报期 10:00 + 探测成功 → open_verified', () => {
  const s = C.officialState(CFG, ms('2026-10-26T10:00:00+08:00'), { ok: true, at: ms('2026-10-26T10:00:00+08:00') });
  assert.strictEqual(s.code, 'open_verified');
});
t('填报期 10:00 + 探测失败 → check_failed（不谎称关闭）', () => {
  const s = C.officialState(CFG, ms('2026-10-26T10:00:00+08:00'), { ok: false, at: ms('2026-10-26T10:00:00+08:00') });
  assert.strictEqual(s.code, 'check_failed');
});
t('填报期内 07:59 → daily_closed（今日尚未开放）', () => {
  const s = C.officialState(CFG, ms('2026-10-26T07:59:00+08:00'), null);
  assert.strictEqual(s.code, 'daily_closed');
  assert.ok(s.detail.indexOf('今日') >= 0);
});
t('09:00:00 整点边界 → 进入窗口（planned_unverified）', () => {
  const s = C.officialState(CFG, ms('2026-10-26T09:00:00+08:00'), null);
  assert.strictEqual(s.code, 'planned_unverified');
});
t('18:00:00 整点边界 → 仍在窗口内（含端点）', () => {
  const s = C.officialState(CFG, ms('2026-10-26T18:00:00+08:00'), null);
  assert.strictEqual(s.code, 'planned_unverified');
});
t('18:00:01 → daily_closed（今日已关闭，提示明日）', () => {
  const s = C.officialState(CFG, ms('2026-10-26T18:00:01+08:00'), null);
  assert.strictEqual(s.code, 'daily_closed');
  assert.ok(s.detail.indexOf('明日') >= 0);
});
t('填报结束 18:00:00 之后第二天 → ended', () => {
  const s = C.officialState(CFG, ms('2026-10-31T00:00:01+08:00'), null);
  assert.strictEqual(s.code, 'ended');
});
t('配置损坏 → config_error（绝不猜）', () => {
  const s = C.officialState({ fillPhase: { start: 'not-a-date', end: '' } }, Date.now(), null);
  assert.strictEqual(s.code, 'config_error');
});

console.log('—— 倒计时换算 ——');
t('59 秒边界：m=0 s=59', () => {
  const p = C.countdownParts(60000, 1000);
  assert.deepStrictEqual([p.m, p.s], [0, 59]);
});
t('跨天：1天2小时3分4秒', () => {
  const d = 86400e3 + 2 * 3600e3 + 3 * 60e3 + 4e3;
  const p = C.countdownParts(d, 0);
  assert.deepStrictEqual([p.d, p.h, p.m, p.s], [1, 2, 3, 4]);
});
t('已过期钳制为 0（不为负）', () => {
  const p = C.countdownParts(0, 5000);
  assert.deepStrictEqual([p.d, p.h, p.m, p.s], [0, 0, 0, 0]);
});
t('pad() 两位补零', () => {
  const p = C.countdownParts(9 * 3600e3 + 5 * 60e3 + 3e3, 0);
  assert.deepStrictEqual(p.pad(), ['00', '09', '05', '03']);
});

console.log('—— 时间信标引擎 ——');
const B = [
  { id: 'hi', type: 'open', priority: 'high', at: ms('2026-10-24T09:00:00+08:00'), title: '开闸' },
  { id: 'std', type: 'prep', priority: 'std', at: ms('2026-10-24T09:00:00+08:00'), title: '备料' },
];
const DAY = ms('2026-10-24T09:00:30+08:00');       // 触发时间后 30 秒（非静默）
const NIGHT = ms('2026-10-24T23:30:00+08:00');     // 静默期内
t('未到触发时间 → none', () => {
  const r = C.evalBeacons(B, { now: ms('2026-10-24T08:59:00+08:00'), sentLog: {} });
  assert.ok(r.every(x => x.action === 'none'));
});
t('到达 + 未提醒 → 双双 notify', () => {
  const r = C.evalBeacons(B, { now: DAY, sentLog: {} });
  assert.strictEqual(r.filter(x => x.action === 'notify').length, 2);
});
t('静默期内：std 延后 defer，high 照常 notify', () => {
  const r = C.evalBeacons(B, { now: NIGHT, sentLog: {} });
  const by = {}; r.forEach(x => by[x.id] = x);
  assert.strictEqual(by.std.action, 'defer');
  assert.strictEqual(by.hi.action, 'notify');
});
t('同日已提醒 → suppress（重复抑制）', () => {
  const r = C.evalBeacons(B, { now: ms('2026-10-24T15:00:00+08:00'), sentLog: { hi: DAY, std: DAY } });
  assert.ok(r.every(x => x.action === 'suppress'));
});
t('36h 内已提醒（跨日）→ suppress（有限重提醒）', () => {
  const r = C.evalBeacons(B, { now: ms('2026-10-25T15:00:00+08:00'), sentLog: { hi: ms('2026-10-24T20:00:00+08:00') } });
  assert.strictEqual(r.find(x => x.id === 'hi').action, 'suppress');
});
t('done 信标 → none（用户确认完成）', () => {
  const r = C.evalBeacons([{ id: 'x', at: DAY, done: true }], { now: DAY, sentLog: {} });
  assert.strictEqual(r[0].action, 'none');
});
t('静默边界：08:29 仍静默，08:30 结束', () => {
  const b = [{ id: 's', at: ms('2026-10-24T03:00:00+08:00'), priority: 'std' }];
  assert.strictEqual(C.evalBeacons(b, { now: ms('2026-10-24T08:29:00+08:00'), sentLog: {} })[0].action, 'defer');
  assert.strictEqual(C.evalBeacons(b, { now: ms('2026-10-24T08:30:00+08:00'), sentLog: {} })[0].action, 'notify');
});

console.log('—— 脱敏 ——');
t('身份证：前4+***+后4', () => {
  assert.strictEqual(C.redact('idcard', '370102200501011234'), '3701**********1234');
});
t('手机：前3+****+后4', () => {
  assert.strictEqual(C.redact('phone', '13812345678'), '138****5678');
});
t('姓名：保留姓氏', () => {
  assert.strictEqual(C.redact('name', '王小明'), '王**');
});
t('邮箱：@ 前打码', () => {
  assert.strictEqual(C.redact('email', 'abcd@qq.com'), 'ab***@qq.com');
});

console.log('—— 身份证校验 ——');
t('合法号码（校验位 4）→ ok + 出生 + 性别', () => {
  const r = C.idcardCheck('110101199003074512'.slice(0, 17) + 'X'); // 先算一个确定合法的
  // 上面拼的未必合法，改为直接验证算法一致性：
  const W = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], M = '10X98765432';
  const base = '11010119900307451';
  let sum = 0; for (let i = 0; i < 17; i++) sum += (+base[i]) * W[i];
  const valid = base + M[sum % 11];
  const rr = C.idcardCheck(valid);
  assert.strictEqual(rr.ok, true);
  assert.strictEqual(rr.birth, '1990-03-07');
  assert.ok(rr.gender === '男' || rr.gender === '女');
});
t('校验位错误 → ok=false', () => {
  const r = C.idcardCheck('110101199003074513');
  assert.strictEqual(r.ok, false);
});
t('格式错误（17 位）→ ok=false 且给出原因', () => {
  const r = C.idcardCheck('11010119900307451');
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.indexOf('格式') >= 0);
});

console.log('—— 风险窗口 ——');
t('12h 内 → high', () => {
  const now = ms('2026-10-24T09:00:00+08:00');
  const r = C.riskWindow({ at: now + 5 * 3600e3 }, now, false);
  assert.strictEqual(r.level, 'high');
});
t('用户确认完成 → done（标注非官方确认）', () => {
  const r = C.riskWindow({ at: Date.now() + 3600e3 }, Date.now(), true);
  assert.strictEqual(r.level, 'done');
  assert.ok(r.text.indexOf('非官方') >= 0);
});

console.log('—— ICS 日历导出（降级提醒）——');
t('结构完整：VCALENDAR/VERSION/PRODID', () => {
  const s = C.buildICS([{ title: '开闸', at: T_OPEN }]);
  assert.ok(s.indexOf('BEGIN:VCALENDAR') >= 0 && s.indexOf('END:VCALENDAR') >= 0);
  assert.ok(s.indexOf('VERSION:2.0') >= 0 && s.indexOf('PRODID:') >= 0);
});
t('UTC 时间换算：09:00+08:00 → 20261024T010000Z', () => {
  const s = C.buildICS([{ title: '开闸', at: T_OPEN }]);
  assert.ok(s.indexOf('DTSTART:20261024T010000Z') >= 0, s.split('\r\n').find(l => l.startsWith('DTSTART')));
});
t('每个事件带 30 分钟前 VALARM', () => {
  const s = C.buildICS([{ title: '开闸', at: T_OPEN }, { title: '截止', at: T_CLOSE }]);
  assert.strictEqual(s.split('TRIGGER:-PT30M').length - 1, 2);
  assert.strictEqual(s.split('BEGIN:VEVENT').length - 1, 2);
});
t('特殊字符转义（逗号/分号/换行）', () => {
  const s = C.buildICS([{ title: '提醒,含;逗号', desc: '第一行\n第二行', at: T_OPEN }]);
  assert.ok(s.indexOf('提醒\\,含\\;逗号') >= 0);
  assert.ok(s.indexOf('第一行\\n第二行') >= 0);
  assert.ok(s.indexOf('SUMMARY:提醒\\,含\\;逗号\r\n') >= 0);
});
t('非法事件（无时间）被跳过，不产生空 VEVENT', () => {
  const s = C.buildICS([{ title: '坏', at: NaN }, { title: '好', at: T_OPEN }]);
  assert.strictEqual(s.split('BEGIN:VEVENT').length - 1, 1);
});
t('DTEND = DTSTART + durMin', () => {
  const s = C.buildICS([{ title: '开闸', at: T_OPEN, durMin: 60 }]);
  assert.ok(s.indexOf('DTEND:20261024T020000Z') >= 0);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
