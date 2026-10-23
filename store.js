/* ==================================================================
   store.js —— 本机资料存储层（零安装核心：IndexedDB 优先）
   优先级：IndexedDB → localStorage 降级（隐私模式/旧浏览器）
   自动迁移：首次读取发现 localStorage 旧数据 → 写入 IDB 并清除旧键
   上层语义不变：存取一个对象（可能含 mode:'enc' 密文），明文不出本机
   ================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SdzkStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DB_NAME = 'sdzk-db', DB_VER = 1, SN = 'kv', KEY = 'sdzk-info', LKEY = 'sdzk-info';
  var memoryFallback = null;   // 注入式后端（测试用）：{ get, set, del }，均可选 Promise
  var dbp = null;              // 打开的 IDB promise

  function idbAvailable() {
    try { return typeof indexedDB !== 'undefined' && !!indexedDB.open; }
    catch (e) { return false; }
  }
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains(SN)) db.createObjectStore(SN);
      };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error || new Error('idb open fail')); };
      rq.onblocked = function () { rej(new Error('idb blocked')); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return openDB().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(SN, mode), st = t.objectStore(SN), done = false;
        function finish(v) { if (!done) { done = true; res(v); } }
        Promise.resolve().then(function () { return fn(st); })
          .then(function (v) { t.oncomplete = function () { finish(v); }; if (t.readyState === 'done') finish(v); })
          .catch(function (e) { try { t.abort(); } catch (_) {} if (!done) { done = true; rej(e); } });
        t.onerror = function () { if (!done) { done = true; rej(t.error || new Error('idb tx fail')); } };
        t.onabort = function () { if (!done) { done = true; rej(t.error || new Error('idb tx abort')); } };
      });
    });
  }
  function req(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('idb req fail')); };
    });
  }

  /* ---- 后端选择 ---- */
  function backend() {
    if (memoryFallback) return memoryFallback;
    if (idbAvailable()) return 'idb';
    if (typeof localStorage !== 'undefined') return 'ls';
    return 'none';
  }
  function lsGet() { try { return JSON.parse(localStorage.getItem(LKEY) || 'null'); } catch (e) { return null; } }
  function lsSet(v) { localStorage.setItem(LKEY, JSON.stringify(v)); }
  function lsDel() { localStorage.removeItem(LKEY); }

  /* 迁移：IDB 可用且 IDB 为空、localStorage 有旧数据 → 搬过去并清旧键 */
  function migrate() {
    if (backend() !== 'idb') return Promise.resolve(false);
    return tx('readonly', function (st) { return req(st.get(KEY)); })
      .then(function (v) {
        if (v != null) return false;
        var old = lsGet();
        if (!old) return false;
        return tx('readwrite', function (st) { st.put(old, KEY); }).then(function () {
          try { lsDel(); } catch (e) {}
          return true;
        });
      })
      .catch(function () { return false; });
  }

  return {
    KEY: KEY,
    /* 当前使用后端名（供能力矩阵如实展示）：'idb' | 'ls' | 'memory' | 'none' */
    backendName: function () {
      var b = backend();
      return b === 'idb' ? 'IndexedDB' : (b === 'ls' ? 'localStorage（降级）' : (b === 'none' ? '不可用' : '内存（测试）'));
    },
    _use: function (fb) { memoryFallback = fb; dbp = null; },
    ready: function () { return migrate(); },
    get: function () {
      var b = backend();
      if (b === 'idb') return tx('readonly', function (st) { return req(st.get(KEY)); })
        .then(function (v) { return v == null ? null : v; })
        .catch(function () { return lsGet(); });
      if (b === 'ls') return Promise.resolve(lsGet());
      if (memoryFallback) return Promise.resolve(memoryFallback.get ? memoryFallback.get() : memoryFallback.data || null);
      return Promise.resolve(null);
    },
    set: function (v) {
      var b = backend();
      if (b === 'idb') return tx('readwrite', function (st) { st.put(v, KEY); }).catch(function (e) { lsSet(v); });
      if (b === 'ls') { try { lsSet(v); return Promise.resolve(); } catch (e) { return Promise.reject(e); } }
      if (memoryFallback) {
        if (memoryFallback.set) return Promise.resolve(memoryFallback.set(v));
        memoryFallback.data = v; return Promise.resolve();
      }
      return Promise.reject(new Error('无可用存储'));
    },
    del: function () {
      var b = backend();
      if (b === 'idb') return tx('readwrite', function (st) { st.delete(KEY); }).catch(function () { try { lsDel(); } catch (e) {} });
      if (b === 'ls') { lsDel(); return Promise.resolve(); }
      if (memoryFallback) {
        if (memoryFallback.del) return Promise.resolve(memoryFallback.del());
        memoryFallback.data = null; return Promise.resolve();
      }
      return Promise.resolve();
    }
  };
});
