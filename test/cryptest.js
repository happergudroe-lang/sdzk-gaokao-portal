// 端到端验证：用"接收方(浏览器UA)"视角解开服务端加密的 Web Push 载荷
const crypto = require('crypto');
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const b64uToBuf = s => Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64');
function hkdf(salt, ikm, info, len){ return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len)); }

/* 1) 生成"浏览器UA"的订阅密钥对（真实 P-256） */
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const uaPub = ua.getPublicKey(null,'uncompressed');
const auth = crypto.randomBytes(16);
const sub = { keys: { p256dh: b64u(uaPub), auth: b64u(auth) } };

/* 2) 服务端加密（与 server.js 相同实现） */
function encryptPayload(payloadStr, sub){
  const uaPub = b64uToBuf(sub.keys.p256dh), authSecret = b64uToBuf(sub.keys.auth);
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(null,'uncompressed');
  const secret = ecdh.computeSecret(uaPub);
  const prk = hkdf(authSecret, secret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const rs = 4096, salt = crypto.randomBytes(16);
  const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  let padded = Buffer.concat([Buffer.from(payloadStr,'utf8'), Buffer.from([2])]);
  padded = Buffer.concat([padded, Buffer.alloc(Math.min(rs-17-padded.length, 32))]);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(padded), c.final(), c.getAuthTag()]);
  const head = Buffer.concat([Buffer.from([(rs>>>24)&255,(rs>>>16)&255,(rs>>>8)&255,rs&255]), salt, Buffer.from([65]), asPub]);
  return Buffer.concat([head, ct]);
}
const record = encryptPayload('开闸提醒：快去报名', sub);

/* 3) 结构断言 */
const rs = record.readUInt32BE(0);
const salt = record.slice(4,20), keyIdLen = record[20], asPub = record.slice(21,21+keyIdLen);
console.log('结构: rs=%d(应为4096) keyIdLen=%d(应为65) asPub头=0x%s(应为04)', rs, keyIdLen, asPub.slice(0,1).toString('hex'));

/* 4) 接收方解密回验 */
const uaEcdh = crypto.createECDH('prime256v1');
uaEcdh.setPrivateKey(crypto.createPrivateKey({ key: { kty:'EC',crv:'P-256',
  x: b64u(uaPub.slice(1,33)), y: b64u(uaPub.slice(33,65)), d: b64u(ua.getPrivateKey()) }, format:'jwk' })
  .export({ format:'der', type:'sec1' }));
const shared = uaEcdh.computeSecret(asPub);
const prk = hkdf(auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
const cek = hkdf(prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const nonce = hkdf(prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
const body = record.slice(21+keyIdLen);
const tag = body.slice(body.length-16), data = body.slice(0, body.length-16);
const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
d.setAuthTag(tag);
const out = Buffer.concat([d.update(data), d.final()]);
const padIdx = out.lastIndexOf(2);
console.log('解密明文:', JSON.stringify(out.slice(0, padIdx).toString('utf8')));
console.log(out.slice(0,padIdx).toString('utf8') === '开闸提醒：快去报名' ? '✅ Web Push 加密端到端验证通过' : '❌ 明文不一致');
