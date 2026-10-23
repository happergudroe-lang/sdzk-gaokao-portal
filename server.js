/* =====================================================================
   山东高考报名面板 · 服务端
   - 静态托管 index.html / sw.js / manifest / 用户脚本
   - Web Push（RFC 8291 aes128gcm 加密 + RFC 8292 VAPID 签名）
     依据开源标准实现（web-push-libs/web-push 同协议），零第三方依赖
   - 到点（2026-10-24 09:00 +08:00）自动向全部订阅者推送开闸提醒
   ===================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STORE = path.join(ROOT, 'push-store.json');

/* 开闸时刻 */
const T_OPEN = new Date('2026-10-24T09:00:00+08:00').getTime();
/* 提醒不烦人：只推两条 —— 开闸时 + 填报截止前 24h（10-29 18:00） */
const T_LASTCALL = new Date('2026-10-29T18:00:00+08:00').getTime();

/* ---------------- 存储（文件持久化，重启不丢） ----------------
   subs: 推送订阅（endpoint+keys，不含任何个人资料）
   reminders: 用户自定义提醒 { id, endpoint, at, note, sent }
     —— 只存时间与备注文本（≤40字），不存身份证/姓名/手机号 */
let store = { vapid: null, subs: [], sentOpen: false, sentLastCall: false, reminders: [],
  official: { hash: null, checkedAt: null, status: 'unknown', title: '', publishedAt: '' } };
try { store = Object.assign(store, JSON.parse(fs.readFileSync(STORE, 'utf8'))); } catch (e) {}
function save() { try { fs.writeFileSync(STORE, JSON.stringify(store)); } catch (e) { console.error('save fail', e.message); } }

/* ---------------- 官方配置（可更新，不写死前端） ---------------- */
const CONFIG_PATH = path.join(ROOT, 'config.json');
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('[config] 读取失败', e.message); return null; }
}

/* ---------------- base64url 工具 ---------------- */
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ---------------- VAPID P-256 密钥 ---------------- */
if (!store.vapid) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey(null, 'uncompressed');   // 0x04 || X || Y
  const priv = ecdh.getPrivateKey();                      // 32B
  store.vapid = {
    publicKeyBase64url: b64u(pub),
    privateJwk: { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: b64u(priv) },
  };
  save();
  console.log('[vapid] 新密钥已生成并持久化');
}
const vapidPub = store.vapid.publicKeyBase64url;
const vapidPrivKey = crypto.createPrivateKey({ key: store.vapid.privateJwk, format: 'jwk' });

/* ES256 JWT 签名：DER → raw r||s */
function derToRaw(der) {
  let i = 2;
  const read = () => { i++; const len = der[i++]; let r = der.slice(i, i + len); i += len;
    while (r.length < 32) r = Buffer.concat([Buffer.alloc(1), r]);
    return r.length > 32 ? r.slice(r.length - 32) : r; };
  const r = read(); const s = read();
  return Buffer.concat([r, s]);
}
function vapidHeaders(endpoint) {
  const origin = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:sdzk-portal@users.noreply.github.com' }));
  const input = header + '.' + payload;
  const sig = derToRaw(crypto.sign('sha256', Buffer.from(input), vapidPrivKey));
  return {
    Authorization: 'vapid ' + input + '.' + b64u(sig),
    'Crypto-Key': 'p256ecdsa=' + vapidPub,
  };
}

/* ---------------- RFC 8291 aes128gcm 载荷加密 ---------------- */
function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}
function encryptPayload(payloadStr, sub) {
  const uaPub = b64uToBuf(sub.keys.p256dh);
  const authSecret = b64uToBuf(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(null, 'uncompressed');
  const secret = ecdh.computeSecret(uaPub);
  const prk = hkdf(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const rs = 4096;
  const salt = crypto.randomBytes(16);
  const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  let padded = Buffer.concat([Buffer.from(payloadStr, 'utf8'), Buffer.from([2])]);
  const room = rs - 17 - padded.length;                 // 17 = 16 tag + 1 delimiter
  if (room < 0) throw new Error('payload too large');
  padded = Buffer.concat([padded, Buffer.alloc(Math.min(room, 32))]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.concat([
    Buffer.from([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    salt, Buffer.from([65]), asPub,
  ]);
  return Buffer.concat([head, ct]);
}

/* ---------------- 推送 ---------------- */
async function pushTo(sub, payload) {
  const body = encryptPayload(JSON.stringify(payload), sub);
  const h = vapidHeaders(sub.endpoint);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { TTL: '3600', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Urgency: 'high', ...h },
    body,
  });
  if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status };
  if (!res.ok) return { ok: false, status: res.status, err: (await res.text()).slice(0, 120) };
  return { ok: true, status: res.status };
}
async function broadcast(kind, title, body) {
  const results = [];
  for (const sub of store.subs.slice()) {
    try {
      const r = await pushTo(sub, { kind, title, body, url: './' });
      if (r.gone) { store.subs = store.subs.filter(s => s !== sub); }
      results.push({ status: r.status, ok: r.ok });
    } catch (e) { results.push({ ok: false, err: e.message.slice(0, 80) }); }
  }
  save();
  return results;
}

/* ---------------- 官方公告变更监测（只读公开页面，可信来源） ----------------
 * 抓取官网通知页正文特征做哈希对比；抓取失败如实记录"暂时无法核实"。
 * 变化时推送"变更信标"。绝不生成猜测性通知。 */
const NOTICE_URL = 'https://www.sdzk.cn/NewsInfo.aspx?NewsID=7394';
async function checkOfficialNotice() {
  const started = Date.now();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 15000);
    const res = await fetch(NOTICE_URL, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (sdzk-portal monitor)' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    const title = m ? m[1].trim() : '';
    // 以标题+正文关键段做特征，避免样式改动误报
    const bodyText = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/\s+/g, '');
    const hash = crypto.createHash('sha256').update(title + '|' + bodyText.slice(0, 20000)).digest('hex').slice(0, 16);
    const prev = store.official || {};
    /* 变更需连续两轮确认（防页面动态内容导致 hash 抖动误报） */
    const rawChanged = prev.hash && prev.hash !== hash && prev.status === 'ok';
    const changed = rawChanged && prev.pendingHash === hash;
    store.official = { hash, checkedAt: started, status: 'ok', title, publishedAt: '',
      latencyMs: Date.now() - started, pendingHash: rawChanged && !changed ? hash : null };
    save();
    console.log('[official] 核验成功 hash=%s%s', hash, changed ? '（变更已二次确认）' : (rawChanged ? '（疑似变更，待下轮确认）' : ''));
    if (changed) {
      await broadcast('change', '📢 官方公告有更新', '官网报名通知页面内容发生变化，请到 www.sdzk.cn 核实最新安排。');
    }
  } catch (e) {
    store.official = Object.assign({}, store.official, { checkedAt: started, status: 'unavailable', error: e.message.slice(0, 80) });
    save();
    console.log('[official] 暂时无法核实:', e.message.slice(0, 60));
  }
}

/* ---------------- 官网可达性探测（能力矩阵数据源，结果如实缓存 30 分钟） ---------------- */
const WSBM_URL = 'https://wsbm.sdzk.cn/';
async function probeOrigin() {
  const now = Date.now();
  const prev = store.originProbe;
  if (prev && prev.status === 'ok' && now - prev.checkedAt < 30 * 60e3) return prev;
  const started = Date.now();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(WSBM_URL, { signal: ac.signal, redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (sdzk-portal probe)' } });
    clearTimeout(t);
    const h = res.headers;
    const out = {
      status: 'ok', httpStatus: res.status, checkedAt: started,
      latencyMs: Date.now() - started,
      csp: h.get('content-security-policy') ? h.get('content-security-policy').slice(0, 200) : null,
      xfo: h.get('x-frame-options') || null,
      note: 'HTTP ' + res.status + '（表单字段结构需开闸后在浏览器内核验）'
    };
    store.originProbe = out; save();
    console.log('[origin-probe] HTTP %s %dms csp=%s xfo=%s', res.status, out.latencyMs, out.csp ? '有' : '无', out.xfo || '无');
    return out;
  } catch (e) {
    const out = { status: 'unreachable', checkedAt: started, error: e.message.slice(0, 80),
      note: '暂时无法核实（官方系统当前未开放或不可达）——不虚构结果，开闸后自动重测' };
    store.originProbe = out; save();
    console.log('[origin-probe] 不可达:', e.message.slice(0, 60));
    return out;
  }
}

/* ---------------- 到点推送（每 30s 检查；官方节点全程只两条 + 用户自定义提醒） ---------------- */
async function tickReminders() {
  const now = Date.now();
  if (!store.sentOpen && now >= T_OPEN && now < T_OPEN + 6 * 3600e3) {
    store.sentOpen = true; save();
    const r = await broadcast('open', '🟢 山东高考报名已开闸', '填报通道已开放（每天 9:00–18:00）。点此直达 wsbm.sdzk.cn 快速报名。');
    console.log('[push] 开闸提醒已发', JSON.stringify(r));
  }
  if (!store.sentLastCall && now >= T_LASTCALL && now < T_LASTCALL + 6 * 3600e3) {
    store.sentLastCall = true; save();
    const r = await broadcast('lastcall', '⏳ 报名今天 18:00 截止', '还没缴报名费 = 没报名成功。抓紧最后时段。');
    console.log('[push] 截止前提醒已发', JSON.stringify(r));
  }
  /* 用户自定义提醒：由后端调度（页面可以关着）；6 小时有效期，过期自动作废 */
  let dirty = false;
  for (const r of store.reminders.slice()) {
    if (r.sent) continue;
    if (now < r.at) continue;
    if (now >= r.at + 6 * 3600e3) { r.sent = true; r.result = 'expired'; dirty = true; continue; }
    const sub = store.subs.find(s => s.endpoint === r.endpoint);
    r.sent = true; dirty = true;
    if (!sub) { r.result = 'no-sub'; continue; }
    try {
      const res = await pushTo(sub, { kind: 'custom', title: '⏰ 你的报名提醒', body: r.note || '到你设定的时间了，去核对报名进度。', url: './' });
      r.result = res.ok ? 'ok' : ('fail:' + res.status);
      if (res.gone) { store.subs = store.subs.filter(s => s !== sub); }
    } catch (e) { r.result = 'fail:' + e.message.slice(0, 40); }
  }
  if (dirty) save();
}
setInterval(() => tickReminders().catch(e => console.error('tick', e.message)), 30000);
setInterval(() => checkOfficialNotice().catch(() => {}), 30 * 60 * 1000);   // 每 30 分钟核验公告
setTimeout(() => checkOfficialNotice().catch(() => {}), 8000);              // 启动后 8s 首次核验

/* ---------------- HTTP ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.user.js': 'text/javascript; charset=utf-8', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((res, rej) => {
    let d = []; req.on('data', c => { d.push(c); if (d.length > 1e6) req.destroy(); });
    req.on('end', () => res(Buffer.concat(d).toString('utf8'))); req.on('error', rej);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/vapid') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ publicKey: vapidPub }));
    }
    if (u.pathname === '/api/config') {
      const cfg = loadConfig();
      if (!cfg) { res.writeHead(500); return res.end('{"error":"config missing"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(Object.assign({}, cfg, { officialCheck: store.official || null })));
    }
    if (u.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, subs: store.subs.length, reminders: (store.reminders || []).filter(r => !r.sent).length,
        official: store.official.status, uptime: process.uptime() }));
    }
    /* 官网可达性探测（能力矩阵用；缓存 30 分钟，失败也如实返回） */
    if (u.pathname === '/api/origin-probe') {
      const out = await probeOrigin();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(out));
    }
    /* 测试推送：向调用方指定的真实订阅立即发一条，验证端到端链路 */
    if (u.pathname === '/api/test-push' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const sub = store.subs.find(s => s.endpoint === body.endpoint);
      if (!sub) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: '该设备尚未订阅推送' })); }
      const r = await pushTo(sub, { kind: 'test', title: '✅ 测试推送成功', body: '这条通知由服务器直接发到你的设备。10-24 09:00 开闸提醒也会这样送达。', url: './' });
      if (r.gone) { store.subs = store.subs.filter(s => s !== sub); save(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(r));
    }
    /* 用户自定义提醒（仅存时间+备注文本，不收个人资料） */
    if (u.pathname === '/api/remind' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const at = Number(body.at);
      if (!Number.isFinite(at) || at < Date.now() - 60000 || at > Date.now() + 90 * 86400e3) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '提醒时间无效（须为未来 90 天内）' }));
      }
      if (!store.subs.find(s => s.endpoint === body.endpoint)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '请先开启系统通知（订阅后才能由服务器推送）' }));
      }
      const item = { id: crypto.randomBytes(8).toString('hex'), endpoint: body.endpoint, at,
        note: String(body.note || '').slice(0, 40), sent: false, createdAt: Date.now() };
      store.reminders.push(item); save();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, id: item.id, at: item.at }));
    }
    if (u.pathname === '/api/remind' && req.method === 'GET') {
      const ep = u.searchParams.get('ep') || '';
      const list = (store.reminders || []).filter(r => r.endpoint === ep)
        .map(r => ({ id: r.id, at: r.at, note: r.note, sent: r.sent, result: r.result || null }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, reminders: list }));
    }
    if (u.pathname === '/api/remind' && req.method === 'DELETE') {
      const body = JSON.parse(await readBody(req) || '{}');
      store.reminders = (store.reminders || []).filter(r => !(r.id === body.id && r.endpoint === body.endpoint));
      save();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/api/subscribe' && req.method === 'POST') {
      const sub = JSON.parse(await readBody(req));
      if (!sub || !sub.endpoint || !sub.keys) { res.writeHead(400); return res.end('bad'); }
      if (!store.subs.find(s => s.endpoint === sub.endpoint)) {
        store.subs.push({ endpoint: sub.endpoint, keys: sub.keys });
        save();
      }
      console.log('[subscribe] 共', store.subs.length, '个订阅');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, total: store.subs.length }));
    }
    if (u.pathname === '/api/unsubscribe' && req.method === 'POST') {
      const sub = JSON.parse(await readBody(req));
      store.subs = store.subs.filter(s => s.endpoint !== (sub && sub.endpoint));
      save();
      res.writeHead(200); return res.end('ok');
    }
    /* 静态文件 */
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
});

/* 自检：用真实生成的密钥对做一次加密+解密往返（aes128gcm 结构头 rs|salt|keyid|ct） */
(async function selfTest() {
  try {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const fake = {
      endpoint: 'https://self-test.invalid/push',
      keys: { p256dh: b64u(ua.getPublicKey(null, 'uncompressed')), auth: b64u(crypto.randomBytes(16)) },
    };
    const plaintext = '自检消息 ' + Date.now();
    const out = encryptPayload(plaintext, fake);
    const rs = out.readUInt32BE(0);
    if (rs !== 4096 || out[20] !== 65) throw new Error('头部结构异常 rs=' + rs + ' keyid=' + out[20]);
    /* 解密往返：用同一个服务端临时密钥复现解密，验证内容一致 */
    const salt = out.slice(4, 20);
    const asPub = out.slice(21, 86);
    const ct = out.slice(86);
    const secret = ua.computeSecret(asPub);
    const prk = hkdf(b64uToBuf(fake.keys.auth), secret, Buffer.concat([Buffer.from('WebPush: info\0'), b64uToBuf(fake.keys.p256dh), asPub]), 32);
    const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
    const dc = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    dc.setAuthTag(ct.slice(-16));
    const dec = Buffer.concat([dc.update(ct.slice(0, -16)), dc.final()]).toString('utf8').replace(/\x02[\s\S]*$/, '');
    if (dec !== plaintext) throw new Error('解密内容不一致');
    console.log('[self-test] aes128gcm 加密往返通过（rs=4096 keyid=65）');
  } catch (e) { console.error('[self-test] 失败:', e.message); }
})();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sdzk-portal] listening on :${PORT} ｜ 订阅数 ${store.subs.length}`);
  console.log(`[sdzk-portal] 开闸推送时刻 ${new Date(T_OPEN).toISOString()}`);
});
