/* store.js 单元测试 —— node test/store.test.js
   双路径：① 注入内存后端（降级语义）；② fake-indexeddb（IndexedDB 主路径 + 迁移） */
'use strict';
const assert = require('assert');
const Store = require('../store.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '\n     ' + (e && e.message || e)); }
}

(async () => {
  console.log('—— 内存后端（注入，模拟无 IDB 环境）——');
  const mem = { data: null };
  Store._use(mem);
  await t('set → get 往返（含照片大对象）', async () => {
    const d = { name: '张三', idcard: '11010119900307451X', photo: 'data:image/jpeg;base64,AAAA' + 'x'.repeat(5000) };
    await Store.set(d);
    const got = await Store.get();
    assert.deepStrictEqual(got, d);
  });
  await t('覆盖写 → 读到新值', async () => {
    await Store.set({ mode: 'enc', salt: 'AA', iv: 'BB', ct: 'CC', at: 123 });
    const got = await Store.get();
    assert.strictEqual(got.mode, 'enc');
  });
  await t('del → get 为 null', async () => {
    await Store.del();
    assert.strictEqual(await Store.get(), null);
  });

  console.log('—— IndexedDB 主路径（fake-indexeddb）+ 旧数据迁移 ——');
  global.indexedDB = require('fake-indexeddb').indexedDB || require('fake-indexeddb');
  global.localStorage = { _m: {}, getItem(k) { return this._m[k] || null; },
    setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
  Store._use(null);   // 回到自动选择：现在有 indexedDB → 走 IDB
  await t('backendName = IndexedDB', async () => {
    assert.strictEqual(Store.backendName(), 'IndexedDB');
  });
  await t('localStorage 旧数据 → ready() 迁移进 IDB 并清旧键', async () => {
    global.localStorage.setItem('sdzk-info', JSON.stringify({ name: '李四', phone: '13900000000' }));
    const migrated = await Store.ready();
    assert.strictEqual(migrated, true, '应报告发生了迁移');
    const got = await Store.get();
    assert.strictEqual(got.name, '李四');
    assert.strictEqual(global.localStorage.getItem('sdzk-info'), null, '旧键应清除');
  });
  await t('IDB set → get 往返（密文结构）', async () => {
    const d = { mode: 'enc', salt: 'AA==', iv: 'BB==', ct: 'CC==', at: Date.now() };
    await Store.set(d);
    const got = await Store.get();
    assert.deepStrictEqual(got, d);
  });
  await t('ready() 二次调用不重复迁移（IDB 已有数据）', async () => {
    const migrated = await Store.ready();
    assert.strictEqual(migrated, false);
    const got = await Store.get();
    assert.strictEqual(got.mode, 'enc');
  });
  await t('del → 为空；再次 ready() 不会把已清空的旧数据搬回来', async () => {
    await Store.del();
    assert.strictEqual(await Store.get(), null);
    assert.strictEqual(await Store.ready(), false);
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
