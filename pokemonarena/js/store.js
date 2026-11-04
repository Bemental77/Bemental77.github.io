// pokemonarena/js/store.js -- where profiles live in the browser: IndexedDB behind an adapter, with a twin for Node.
//
// Pure ES module (browser + Node 24). No server exists: everything is in the visitor's IndexedDB database
// 'pokemonarena'. This module owns four things:
//
//   1. ADAPTERS. A tiny async interface (open / close / transact) with two implementations: createIdbAdapter() (real
//      IndexedDB) and createMemoryAdapter() (a Map-backed twin that copies values with structuredClone, serialises
//      read-write transactions and rolls back on error, so it has the same semantics a Node test needs). ADAPTER_CONTRACT
//      at the bottom is the shared list of behaviours both must show; Node runs it against the memory adapter and
//      pokemonarena/dev/idb_smoke.html runs the SAME cases against real IndexedDB in headless Chrome.
//   2. A FUNCTIONAL STORAGE PROBE at boot: write a random token, read it back, compare, delete it, confirm it is gone.
//      `typeof indexedDB` is not a capability check (Chrome reports it in private/blocked modes where the first write
//      throws). If open or the probe fails the store runs MEMORY-ONLY and the sticky `notSaved` flag stays true for the
//      session: the UI must keep showing "not saved" and offer Export.
//   3. PROFILES: one JSON document per profile, saved with a COMPARE-AND-SWAP on `rev` inside one read-write
//      transaction, a history ring of the last 5 replaced revisions, a quarantine for what could not be loaded, an
//      automatic backup before an import overwrites anything, migration on load (with the old revision kept in history),
//      and read-only handling of documents saved by a NEWER build (never rewritten, never down-converted).
//   4. MULTI-TAB: a BroadcastChannel announces saves; a stale tab learns of it (isStale / 'external' event). The CAS, not
//      the broadcast, is what guarantees two tabs cannot overwrite each other.
//
// DATABASE LAYOUT (version 1; object stores and their key paths):
//   profiles        'id'     one document per profile
//   profileHistory  'hkey'   `${id}:${rev padded to 10}`, value { hkey, id, rev, savedAt, reason, doc }
//   meta            'key'    { key, value }   active profile, lastBackupAt, autoBackup:<id>, persistGranted, ...
//   quarantine      'qid'    { qid, at, profileId, kind, index, raw, problems }
//   keys            'id'     { id (= '<profile id>:<key id>'), profileId, keyId, privateKey (a non-extractable CryptoKey), publicKeyJwk, createdAt }
// Upgrades are a switch(oldVersion) with fall-through (see upgrade()).
//
// TRANSACTION RULE. Inside transact(names, mode, fn) the function may only await the tx.* calls: awaiting anything else
// lets IndexedDB auto-commit the transaction underneath you. Compute first, then write.

import {
  SCHEMA_VERSION, checkProfile, openProfileDocument, createProfile, buildExport, defaultDeps, newId, planImport, recordMatch, resetRecord,
} from './profile.js';

export const DB_NAME = 'pokemonarena';
export const DB_VERSION = 1;
export const STORES = Object.freeze({ profiles: 'id', profileHistory: 'hkey', meta: 'key', quarantine: 'qid', keys: 'id' });
export const HISTORY_KEEP = 5;
export const CHANNEL_NAME = 'pokemonarena-sync';

export class StoreError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'StoreError'; this.code = code; this.detail = detail || null; }
}
export class ConflictError extends StoreError {
  constructor(message, detail) { super('store.conflict', message, detail); this.name = 'ConflictError'; }
}
export class ReadOnlyError extends StoreError {
  constructor(message, detail) { super('store.read-only', message, detail); this.name = 'ReadOnlyError'; }
}
export class ValidationError extends StoreError {
  constructor(message, problems) { super('store.invalid', message, { problems }); this.name = 'ValidationError'; this.problems = problems; }
}
export class NotFoundError extends StoreError {
  constructor(message, detail) { super('store.not-found', message, detail); this.name = 'NotFoundError'; }
}
export class ClosedError extends StoreError {
  constructor() { super('store.closed', 'the storage connection is closed'); this.name = 'ClosedError'; }
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const hasOwn = Object.prototype.hasOwnProperty;
const describe = (e) => (e && (e.name ? e.name + ': ' : '') + (e.message || '')) || String(e);
export const historyKey = (id, rev) => `${id}:${String(rev).padStart(10, '0')}`;
const historyRange = (id) => ({ gte: `${id}:`, lt: `${id};` }); // ';' is ':' + 1

// ---------------------------------------------------------------------------------------------
// memory adapter
// ---------------------------------------------------------------------------------------------

const MEM_DBS = new Map();
function memDb(name) {
  let d = MEM_DBS.get(name);
  if (!d) { d = { stores: new Map(Object.keys(STORES).map((s) => [s, new Map()])), lock: Promise.resolve() }; MEM_DBS.set(name, d); }
  return d;
}
/** Forget a named in-memory database (test hygiene). */
export function dropMemoryDb(name) { MEM_DBS.delete(name); }

/**
 * @param {object} o  name: database name (two adapters with the same name share data, like two connections);
 *                    durable: pretend to be durable storage (default false: status.notSaved stays true);
 *                    readOnly: reject every read-write transaction.
 */
export function createMemoryAdapter({ name = 'pokemonarena-memory', durable = false, readOnly = false } = {}) {
  let closed = true;
  const a = {
    kind: 'memory', durable, readOnly,
    async open() { closed = false; memDb(name); },
    async close() { closed = true; },
    transact(names, mode, fn) {
      if (closed) return Promise.reject(new ClosedError());
      const db = memDb(name);
      const rw = mode === 'readwrite';
      if (rw && a.readOnly) return Promise.reject(new ReadOnlyError('the database is read-only'));
      const run = async () => {
        const work = new Map();
        for (const n of names) {
          if (!db.stores.has(n)) throw new Error(`NotFoundError: no object store ${n}`);
          work.set(n, new Map(db.stores.get(n)));
        }
        const st = (s) => { const m = work.get(s); if (!m) throw new Error(`NotFoundError: store ${s} is not in this transaction`); return m; };
        const keyOf = (s, v) => { const kp = STORES[s]; if (!v || typeof v !== 'object' || v[kp] === undefined) throw new Error(`DataError: value has no key ${kp}`); return v[kp]; };
        const tx = {
          async get(s, k) { return clone(st(s).get(k)); },
          async put(s, v) { if (!rw) throw new Error('ReadOnlyError: put in a readonly transaction'); const c = clone(v); st(s).set(keyOf(s, c), c); },
          async delete(s, k) { if (!rw) throw new Error('ReadOnlyError: delete in a readonly transaction'); st(s).delete(k); },
          async list(s, { gte, lt, limit } = {}) {
            const out = [];
            const keys = [...st(s).keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
            for (const k of keys) {
              if (gte !== undefined && k < gte) continue;
              if (lt !== undefined && k >= lt) continue;
              out.push(clone(st(s).get(k)));
              if (limit !== undefined && out.length >= limit) break;
            }
            return out;
          },
        };
        const result = await fn(tx);
        if (rw) for (const n of names) db.stores.set(n, work.get(n));
        return result;
      };
      const p = db.lock.then(run);
      db.lock = p.then(() => undefined, () => undefined); // a failed transaction must not wedge the queue
      return p;
    },
  };
  return a;
}

// ---------------------------------------------------------------------------------------------
// IndexedDB adapter
// ---------------------------------------------------------------------------------------------

function upgrade(db, oldVersion) {
  switch (oldVersion) { // eslint-disable-line default-case
    case 0:
      for (const [s, kp] of Object.entries(STORES)) db.createObjectStore(s, { keyPath: kp });
    // falls through: future versions add `case 1:` etc. below and never edit an earlier case
  }
}

export function createIdbAdapter({ idbFactory, name = DB_NAME, version = DB_VERSION } = {}) {
  let db = null;
  let closed = true;
  let closeRequested = false;
  const a = {
    kind: 'indexeddb', durable: true, readOnly: false, newerDatabase: false,
    async open() {
      // read the factory HERE, not when the adapter is made: a browser that blocks storage (cookies off, some privacy modes) can THROW from the
      // property read itself, and openStore() only catches what open() throws -- the page must fall back to memory, not die
      const factory = idbFactory || globalThis.indexedDB;
      if (!factory) throw new Error('indexedDB is not available');
      closeRequested = false;
      const openAt = (v) => new Promise((resolve, reject) => {
        const req = v === undefined ? factory.open(name) : factory.open(name, v);
        req.onupgradeneeded = (ev) => upgrade(req.result, ev.oldVersion);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('indexedDB.open failed'));
        req.onblocked = () => { /* another tab holds an older connection; it closes on versionchange, so just wait */ };
      });
      try { db = await openAt(version); }
      catch (e) {
        if (e && e.name === 'VersionError') { db = await openAt(undefined); a.readOnly = true; a.newerDatabase = true; }
        else throw e;
      }
      if (closeRequested) { try { db.close(); } catch (_e) { /* ignore */ } db = null; return; } // we gave up waiting (timeout) before this finished
      for (const s of Object.keys(STORES)) if (!db.objectStoreNames.contains(s)) { db.close(); db = null; throw new Error(`database ${name} has no object store ${s}`); }
      db.onversionchange = () => { try { db.close(); } catch (_e) { /* already closed */ } closed = true; };
      closed = false;
    },
    async close() { closed = true; closeRequested = true; if (db) { try { db.close(); } catch (_e) { /* ignore */ } db = null; } },
    transact(names, mode, fn) {
      if (closed || !db) return Promise.reject(new ClosedError());
      const rw = mode === 'readwrite';
      if (rw && a.readOnly) return Promise.reject(new ReadOnlyError('the database was written by a newer build and is read-only here'));
      return new Promise((resolve, reject) => {
        let tx;
        try { tx = db.transaction(names, rw ? 'readwrite' : 'readonly'); } catch (e) { reject(e); return; }
        let result, fnError = null;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(fnError || tx.error || new Error('transaction aborted'));
        tx.onerror = () => { /* onabort reports it */ };
        const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        const api = {
          get: (s, k) => wrap(tx.objectStore(s).get(k)),
          put: (s, v) => wrap(tx.objectStore(s).put(v)).then(() => undefined),
          delete: (s, k) => wrap(tx.objectStore(s).delete(k)).then(() => undefined),
          list: (s, { gte, lt, limit } = {}) => {
            let range;
            if (gte !== undefined && lt !== undefined) range = IDBKeyRange.bound(gte, lt, false, true);
            else if (gte !== undefined) range = IDBKeyRange.lowerBound(gte);
            else if (lt !== undefined) range = IDBKeyRange.upperBound(lt, true);
            return wrap(tx.objectStore(s).getAll(range, limit));
          },
        };
        let p;
        try { p = Promise.resolve(fn(api)); } catch (e) { p = Promise.reject(e); }
        p.then((r) => { result = r; }, (e) => { fnError = e; try { tx.abort(); } catch (_e) { /* already finished */ } });
      });
    },
  };
  return a;
}

// ---------------------------------------------------------------------------------------------
// the functional probe
// ---------------------------------------------------------------------------------------------

/** Write, read back, compare, delete, confirm gone -- on the adapter's own database. { ok } | { ok:false, step, error }. */
export async function probeAdapter(adapter, deps) {
  const d = deps || defaultDeps();
  const token = Array.from(d.randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
  const key = '__probe__' + token;
  let step = 'write';
  try {
    if (adapter.readOnly) { // a database written by a newer build: it can only be read, so that is what the probe proves
      step = 'read';
      await adapter.transact(['meta'], 'readonly', (tx) => tx.get('meta', key));
      return { ok: true, readOnly: true };
    }
    await adapter.transact(['meta'], 'readwrite', (tx) => tx.put('meta', { key, value: token }));
    step = 'read';
    const got = await adapter.transact(['meta'], 'readonly', (tx) => tx.get('meta', key));
    if (!got || got.value !== token) return { ok: false, step: 'compare', error: 'read back ' + JSON.stringify(got) };
    step = 'delete';
    await adapter.transact(['meta'], 'readwrite', (tx) => tx.delete('meta', key));
    step = 'verify-gone';
    const gone = await adapter.transact(['meta'], 'readonly', (tx) => tx.get('meta', key));
    if (gone !== undefined) return { ok: false, step, error: 'the probe record is still there after delete' };
    return { ok: true };
  } catch (e) {
    return { ok: false, step, error: describe(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

/**
 * Open the store. Never throws for a storage problem: it degrades to memory-only and says so in `status`.
 * opts: adapter (inject one), idbFactory, dbName, deps { now, randomBytes }, channel (false to disable, or a
 * BroadcastChannel constructor), storage (a StorageManager-like { persist, persisted }), openTimeoutMs (default 10000).
 */
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref(); // Node only: a pending guard timer must not keep a process alive
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function openStore(opts = {}) {
  const deps = { ...defaultDeps(), ...(opts.deps || {}) };
  const status = { mode: 'indexeddb', durable: true, notSaved: false, reason: null, readOnly: false, probe: null, persistence: { supported: false, requested: false, granted: null }, sync: { enabled: false, reason: null } };
  let adapter = opts.adapter || createIdbAdapter({ idbFactory: opts.idbFactory, name: opts.dbName || DB_NAME });
  const timeoutMs = opts.openTimeoutMs === undefined ? 10000 : opts.openTimeoutMs;
  try {
    // indexedDB.open() can hang forever (a blocked upgrade, a locked profile, some private modes): treat that as unavailable
    await withTimeout((async () => {
      await adapter.open();
      status.probe = await probeAdapter(adapter, deps);
      if (!status.probe.ok) throw new Error(`storage probe failed at ${status.probe.step}: ${status.probe.error}`);
    })(), timeoutMs, 'opening storage');
  } catch (e) {
    try { await adapter.close(); } catch (_e) { /* ignore */ }
    adapter = createMemoryAdapter({ name: 'memory-fallback-' + newId('f', deps) });
    await adapter.open();
    status.notSaved = true;
    status.reason = 'storage-unavailable: ' + describe(e);
    status.fellBack = true;
  }
  status.mode = adapter.kind;
  status.durable = adapter.durable !== false;
  if (!status.durable && !status.notSaved) { status.notSaved = true; status.reason = 'memory-only: this storage does not survive a reload'; }
  if (adapter.readOnly) { status.readOnly = true; status.notSaved = true; status.reason = status.reason || 'database-newer-than-app: this build can read but not write it'; }
  const BC = opts.channel === false ? null : (typeof opts.channel === 'function' ? opts.channel : globalThis.BroadcastChannel);
  const storage = opts.storage !== undefined ? opts.storage : (globalThis.navigator && globalThis.navigator.storage);
  return new ArenaStore(adapter, status, deps, BC, storage);
}

export class ArenaStore {
  constructor(adapter, status, deps, BC, storage) {
    this.adapter = adapter;
    this.deps = deps;
    this._status = status;
    this._storage = storage || null;
    this.id = newId('s', deps);
    this._listeners = new Map();
    this._seen = new Map(); // profile id -> highest rev another instance announced
    this._ch = null;
    if (BC) {
      try {
        this._ch = new BC(CHANNEL_NAME);
        this._ch.onmessage = (ev) => this._onMessage(ev.data);
        status.sync.enabled = true;
      } catch (e) { status.sync.reason = 'BroadcastChannel failed: ' + describe(e); }
    } else status.sync.reason = 'BroadcastChannel is not available';
    const self = this;
    this.keys = {
      get persistent() { return self._status.durable && !self._status.notSaved; },
      get: (id) => self._tx(['keys'], 'readonly', (tx) => tx.get('keys', id)),
      put: (id, rec) => self._tx(['keys'], 'readwrite', (tx) => tx.put('keys', { ...rec, id })),
      delete: (id) => self._tx(['keys'], 'readwrite', (tx) => tx.delete('keys', id)),
    };
  }

  /** A copy of the current storage status. `notSaved` is sticky: once true it stays true for the session. */
  get status() { return { ...this._status, persistence: { ...this._status.persistence }, sync: { ...this._status.sync } }; }

  on(event, fn) {
    const set = this._listeners.get(event) || new Set();
    set.add(fn);
    this._listeners.set(event, set);
    return () => set.delete(fn);
  }
  _emit(event, payload) { for (const fn of this._listeners.get(event) || []) { try { fn(payload); } catch (_e) { /* a listener must not break the store */ } } }
  _flagNotSaved(reason) {
    if (!this._status.notSaved || this._status.reason === null) { this._status.notSaved = true; this._status.reason = reason; this._emit('status', this.status); }
  }
  async _tx(names, mode, fn) {
    try { return await this.adapter.transact(names, mode, fn); }
    catch (e) {
      if (mode === 'readwrite' && !(e instanceof StoreError) && !(e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError)) this._flagNotSaved('write-failed: ' + describe(e));
      throw e;
    }
  }
  _announce(msg) { if (this._ch) { try { this._ch.postMessage({ ...msg, from: this.id }); } catch (_e) { /* channel closed */ } } }
  _onMessage(m) {
    if (!m || typeof m !== 'object' || m.from === this.id) return;
    if (m.t === 'saved' && typeof m.id === 'string' && Number.isInteger(m.rev)) this._seen.set(m.id, Math.max(this._seen.get(m.id) || 0, m.rev));
    this._emit('external', m);
  }
  /** True if another tab / instance announced a newer revision of this profile than the copy you hold. */
  isStale(profile) { return (this._seen.get(profile.id) || 0) > profile.rev; }

  async close() {
    if (this._ch) { try { this._ch.close(); } catch (_e) { /* ignore */ } this._ch = null; }
    await this.adapter.close();
  }

  async requestPersistence() {
    const sm = this._storage;
    const out = { supported: !!(sm && typeof sm.persist === 'function'), requested: false, granted: null, alreadyPersisted: null };
    if (out.supported) {
      try {
        if (typeof sm.persisted === 'function') out.alreadyPersisted = await sm.persisted();
        if (out.alreadyPersisted) out.granted = true;
        else { out.requested = true; out.granted = await sm.persist(); }
      } catch (e) { out.error = describe(e); }
    }
    this._status.persistence = out;
    try { await this.setMeta('persistGranted', out.granted); } catch (_e) { /* meta is best effort */ }
    return { ...out };
  }

  // ---- meta
  async getMeta(key) { const r = await this._tx(['meta'], 'readonly', (tx) => tx.get('meta', key)); return r ? r.value : undefined; }
  async setMeta(key, value) { await this._tx(['meta'], 'readwrite', (tx) => tx.put('meta', { key, value })); }
  async getActiveId() { const v = await this.getMeta('activeProfileId'); return typeof v === 'string' ? v : null; }
  async setActiveId(id) { await this.setMeta('activeProfileId', id); this._announce({ t: 'meta', key: 'activeProfileId' }); }

  // ---- profiles
  async listProfiles() {
    const docs = await this._tx(['profiles'], 'readonly', (tx) => tx.list('profiles'));
    return docs.map((d) => {
      const ok = d && typeof d === 'object' && typeof d.id === 'string';
      return {
        id: ok ? d.id : null,
        trainerName: ok && typeof d.trainerName === 'string' ? d.trainerName : null,
        rev: ok && Number.isInteger(d.rev) ? d.rev : null,
        updatedAt: ok && Number.isInteger(d.updatedAt) ? d.updatedAt : null,
        schemaVersion: ok && Number.isInteger(d.schemaVersion) ? d.schemaVersion : null,
        readOnly: ok && Number.isInteger(d.schemaVersion) && d.schemaVersion > SCHEMA_VERSION,
        corrupt: !ok || !Number.isInteger(d.schemaVersion),
      };
    });
  }

  /** Write `profile` through the CAS inside an open transaction. Returns the saved document. */
  async _commit(tx, profile, { reason, backup, allowCorrupt = false, history = true }) {
    const cur = await tx.get('profiles', profile.id);
    const exists = cur !== undefined;
    const valid = exists && cur !== null && typeof cur === 'object' && Number.isInteger(cur.rev); // a stored document with a usable rev
    if (exists && cur !== null && typeof cur === 'object' && Number.isInteger(cur.schemaVersion) && cur.schemaVersion > SCHEMA_VERSION) {
      throw new ReadOnlyError(`profile ${profile.id} was saved by a newer build and is read-only here`, { id: profile.id, schemaVersion: cur.schemaVersion });
    }
    // rev 0 means "create": legal only if nothing is stored (or only an unreadable record and the caller is repairing it)
    const conflict = profile.rev === 0 ? exists && (valid || !allowCorrupt) : !valid || cur.rev !== profile.rev;
    if (conflict) {
      throw new ConflictError(`profile ${profile.id}: expected rev ${profile.rev}, the store has ${!exists ? 'nothing' : valid ? cur.rev : 'an unreadable record'}`, { id: profile.id, expectedRev: profile.rev, actualRev: !exists ? null : valid ? cur.rev : -1, current: !exists ? null : cur });
    }
    const now = this.deps.now();
    let newRev = 1;
    if (exists && !history && valid) {
      // a write of the battle record only (recordMatch): the revision counter moves, but no history entry is made, so a run of battles cannot push the
      // revisions that hold the player's EDITS out of the ring of HISTORY_KEEP
      newRev = cur.rev + 1;
    } else if (exists) {
      const hist = await tx.list('profileHistory', historyRange(profile.id));
      const histRev = valid ? cur.rev : (hist.length ? hist[hist.length - 1].rev + 1 : 1);
      newRev = histRev + 1;
      if (backup) await tx.put('meta', { key: 'autoBackup:' + profile.id, value: { at: now, reason: backup, file: buildExport(cur, { deps: { now: () => now } }) } });
      await tx.put('profileHistory', { hkey: historyKey(profile.id, histRev), id: profile.id, rev: histRev, savedAt: now, reason, doc: cur });
      const keep = hist.filter((h) => h.rev !== histRev).concat([{ rev: histRev }]).sort((x, y) => x.rev - y.rev);
      for (const h of keep.slice(0, Math.max(0, keep.length - HISTORY_KEEP))) await tx.delete('profileHistory', historyKey(profile.id, h.rev));
    }
    const saved = clone(profile);
    saved.rev = newRev;
    saved.updatedAt = now;
    await tx.put('profiles', saved);
    return saved;
  }

  /**
   * Save with compare-and-swap. `profile.rev` must equal the stored rev (0 = create). Returns the saved copy with
   * rev + 1. Throws ConflictError (someone else saved first), ReadOnlyError (a newer build's document, or a newer
   * database), ValidationError (not a well-formed current-version profile).
   */
  async saveProfile(profile, { reason = 'save', backup = null } = {}) {
    if (profile && typeof profile === 'object' && Number.isInteger(profile.schemaVersion) && profile.schemaVersion > SCHEMA_VERSION) {
      throw new ReadOnlyError('this profile was saved by a newer build; it cannot be saved here', { schemaVersion: profile.schemaVersion });
    }
    const problems = checkProfile(profile);
    if (problems.length) throw new ValidationError('profile is not well formed: ' + problems.slice(0, 3).map((p) => `${p.code} ${p.path}`).join('; '), problems);
    const saved = await this._tx(['profiles', 'profileHistory', 'meta'], 'readwrite', (tx) => this._commit(tx, profile, { reason, backup }));
    this._announce({ t: 'saved', id: saved.id, rev: saved.rev });
    return saved;
  }

  async createProfile(init = {}) {
    const p = createProfile(init, this.deps);
    return this.saveProfile(p, { reason: 'create' });
  }

  /**
   * Read, migrate, normalise. Returns
   *   { ok:true, profile, readOnly, migratedFrom, repaired, quarantined }   (a changed document is written back, with its old
   *                                                                          revision in history, unless it is read-only)
   *   { ok:true, ..., unsaved:true, writeError }                             the same, but the write-back FAILED (a full origin, an aborted transaction): the profile is the
   *                                                                          migrated / repaired one IN MEMORY and the stored document is untouched, so the next load tries
   *                                                                          the write again. (A profile that can be read must never become unreadable because it could not
   *                                                                          be upgraded: the hub would drop it and a battle would find no profile.) `notSaved` is set as usual.
   *   { ok:false, code, message, problems }                                  (not found, or unreadable: a copy goes to quarantine)
   */
  async loadProfile(id) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await this._tx(['profiles'], 'readonly', (tx) => tx.get('profiles', id));
      if (raw === undefined) return { ok: false, code: 'store.not-found', message: `no profile ${id}`, problems: [] };
      const opened = openProfileDocument(raw, { deps: this.deps });
      if (!opened.ok) {
        const qid = newId('q', this.deps);
        try { await this._tx(['quarantine'], 'readwrite', (tx) => tx.put('quarantine', { qid, at: this.deps.now(), profileId: id, kind: 'document', index: -1, raw, problems: opened.problems })); } catch (_e) { /* best effort */ }
        return { ok: false, code: opened.code, message: opened.message, problems: opened.problems, quarantineId: qid };
      }
      if (opened.readOnly) return { ok: true, profile: opened.profile, readOnly: true, migratedFrom: null, repaired: 0, quarantined: [] };
      if (!opened.changed) return { ok: true, profile: opened.profile, readOnly: false, migratedFrom: null, repaired: 0, quarantined: [] };
      try {
        const why = opened.migratedFrom !== null ? 'migration' : 'repair'; // a history entry's reason names the action that REPLACED it
        const qs = opened.quarantined.map((q) => ({ qid: newId('q', this.deps), at: this.deps.now(), profileId: id, kind: q.kind, index: q.index, raw: q.raw, problems: q.problems }));
        const saved = await this._tx(['profiles', 'profileHistory', 'meta', 'quarantine'], 'readwrite', async (tx) => {
          for (const q of qs) await tx.put('quarantine', q);
          return this._commit(tx, opened.profile, { reason: why, backup: null, allowCorrupt: true });
        });
        this._announce({ t: 'saved', id, rev: saved.rev });
        return { ok: true, profile: saved, readOnly: false, migratedFrom: opened.migratedFrom, repaired: opened.problems.filter((p) => p.severity === 'repaired').length, quarantined: opened.quarantined };
      } catch (e) {
        if (e instanceof ConflictError) continue; // someone else saved between our read and our write-back: read again
        // a plain write failure (not a store refusal, not a programming error): hand back the document as migrated in memory; its rev is the stored one, so a later save compares correctly
        if (e instanceof StoreError || e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError) throw e;
        return { ok: true, profile: opened.profile, readOnly: false, migratedFrom: opened.migratedFrom, repaired: opened.problems.filter((p) => p.severity === 'repaired').length, quarantined: opened.quarantined, unsaved: true, writeError: e };
      }
    }
    throw new ConflictError(`profile ${id} kept changing while it was being loaded`, { id });
  }

  async deleteProfile(id) {
    const existed = await this._tx(['profiles', 'profileHistory', 'keys', 'meta', 'quarantine'], 'readwrite', async (tx) => {
      const cur = await tx.get('profiles', id);
      if (cur !== undefined && typeof cur === 'object' && Number.isInteger(cur.schemaVersion) && cur.schemaVersion > SCHEMA_VERSION) {
        throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id });
      }
      await tx.delete('profiles', id);
      for (const h of await tx.list('profileHistory', historyRange(id))) await tx.delete('profileHistory', h.hkey);
      for (const k of await tx.list('keys', historyRange(id))) await tx.delete('keys', k.id); // every key slot '<id>:<keyId>'
      await tx.delete('meta', 'autoBackup:' + id);
      const act = await tx.get('meta', 'activeProfileId');
      if (act && act.value === id) await tx.delete('meta', 'activeProfileId');
      return cur !== undefined;
    });
    this._announce({ t: 'deleted', id });
    return existed;
  }

  /**
   * Delete EVERY profile and everything stored with them: history rings, identity keys, automatic backups, the quarantine, the active-profile
   * pointer and every other meta record. One transaction, so a failure leaves the database as it was. Returns the number of profiles removed.
   * The UI asks twice before calling this; the store does not.
   */
  async deleteEverything() {
    const removed = await this._tx(Object.keys(STORES), 'readwrite', async (tx) => {
      let profiles = 0;
      for (const [s, kp] of Object.entries(STORES)) {
        const rows = await tx.list(s);
        if (s === 'profiles') profiles = rows.length;
        for (const r of rows) await tx.delete(s, r[kp]);
      }
      return profiles;
    });
    this._seen.clear();
    this._announce({ t: 'deleted', id: '*' });
    return removed;
  }

  // ---- history
  async listHistory(id) {
    const rows = await this._tx(['profileHistory'], 'readonly', (tx) => tx.list('profileHistory', historyRange(id)));
    return rows.map((h) => ({ rev: h.rev, savedAt: h.savedAt, reason: h.reason })).sort((a, b) => b.rev - a.rev);
  }
  /** Make an old revision current again as a NEW revision (rev + 1); the replaced document goes into history. */
  async restoreRevision(id, rev, { expectedRev } = {}) {
    const saved = await this._tx(['profiles', 'profileHistory', 'meta'], 'readwrite', async (tx) => {
      const h = await tx.get('profileHistory', historyKey(id, rev));
      if (!h) throw new NotFoundError(`no revision ${rev} of profile ${id} in history`, { id, rev });
      const opened = openProfileDocument(h.doc, { deps: this.deps });
      if (!opened.ok || opened.readOnly) throw new ValidationError(`revision ${rev} cannot be restored: ${opened.ok ? 'it was saved by a newer build' : opened.message}`, opened.problems || []);
      const cur = await tx.get('profiles', id);
      const curRev = cur !== undefined && cur !== null && typeof cur === 'object' && Number.isInteger(cur.rev) ? cur.rev : 0;
      if (expectedRev !== undefined && curRev !== expectedRev) throw new ConflictError(`profile ${id}: expected rev ${expectedRev}, the store has ${curRev}`, { id, expectedRev, actualRev: curRev });
      const restored = opened.profile;
      // going back to an older revision of the TEAMS must not take the battle record back with it: the record as it stands now is kept
      { const now = cur === undefined ? null : openProfileDocument(cur, { deps: this.deps }); if (now && now.ok && !now.readOnly) restored.stats = now.profile.stats; }
      restored.rev = curRev; // _commit's CAS compares against what is stored right now (0 = nothing, or an unreadable record)
      return this._commit(tx, restored, { reason: `restore-of-${rev}`, backup: null, allowCorrupt: true });
    });
    this._announce({ t: 'saved', id, rev: saved.rev });
    return saved;
  }

  // ---- the battle record
  /**
   * Fold one finished match into the profile's record, INSIDE ONE read-write transaction (read, fold, write): two tabs finishing matches at the same moment
   * cannot lose either one, and the same match id twice changes nothing (profile.js recordMatch). No history entry is made (see _commit).
   * -> { ok:true, saved (the written profile, or null for a duplicate), duplicate, callouts, before (the stats as they were) } | throws NotFoundError / ReadOnlyError / ValidationError.
   */
  async recordMatch(id, match) {
    // an old or damaged document is first brought up to date the usual way (migration / repair, the old revision in history, set-aside records in the quarantine)
    // so that the single transaction below only ever has to read a clean current-version document
    { const l = await this.loadProfile(id); if (!l.ok) { if (l.code === 'store.not-found') throw new NotFoundError(`no profile ${id}`, { id }); throw new ValidationError(`profile ${id} cannot be read: ${l.message}`, l.problems || []); }
      if (l.unsaved) throw l.writeError;         // it could not be brought up to date: nothing is written (the single transaction below would skip the migration's history entry), the next load tries again
    }
    const out = await this._tx(['profiles', 'profileHistory', 'meta'], 'readwrite', async (tx) => {
      const raw = await tx.get('profiles', id);
      if (raw === undefined) throw new NotFoundError(`no profile ${id}`, { id });
      const opened = openProfileDocument(raw, { deps: this.deps });
      if (!opened.ok) throw new ValidationError(`profile ${id} cannot be read: ${opened.message}`, opened.problems || []);
      if (opened.readOnly) throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id, schemaVersion: opened.profile.schemaVersion });
      const r = recordMatch(opened.profile, match);
      if (!r.ok) throw new ValidationError(r.message, []);
      if (r.duplicate) return { saved: null, duplicate: true, callouts: [], before: opened.profile.stats };
      r.profile.rev = Number.isInteger(raw.rev) ? raw.rev : 0;
      const saved = await this._commit(tx, r.profile, { reason: 'match', backup: null, allowCorrupt: true, history: false });
      return { saved, duplicate: false, callouts: r.callouts, before: opened.profile.stats };
    });
    if (out.saved) this._announce({ t: 'saved', id, rev: out.saved.rev });
    return { ok: true, ...out };
  }
  /** Empty the battle record of one profile (RESET RECORD). The replaced document goes into history and an automatic backup is taken first. */
  async resetRecord(id) {
    const saved = await this._tx(['profiles', 'profileHistory', 'meta'], 'readwrite', async (tx) => {
      const raw = await tx.get('profiles', id);
      if (raw === undefined) throw new NotFoundError(`no profile ${id}`, { id });
      const opened = openProfileDocument(raw, { deps: this.deps });
      if (!opened.ok) throw new ValidationError(`profile ${id} cannot be read: ${opened.message}`, opened.problems || []);
      if (opened.readOnly) throw new ReadOnlyError(`profile ${id} was saved by a newer build and is read-only here`, { id });
      const next = resetRecord(opened.profile);
      next.rev = Number.isInteger(raw.rev) ? raw.rev : 0;
      return this._commit(tx, next, { reason: 'reset-record', backup: 'pre-reset-record', allowCorrupt: true });
    });
    this._announce({ t: 'saved', id, rev: saved.rev });
    return saved;
  }

  // ---- quarantine
  async listQuarantine(profileId) {
    const rows = await this._tx(['quarantine'], 'readonly', (tx) => tx.list('quarantine'));
    return rows.filter((q) => profileId === undefined || q.profileId === profileId).sort((a, b) => (a.at - b.at) || (a.index - b.index) || (a.qid < b.qid ? -1 : 1));
  }
  async clearQuarantine(qid) { await this._tx(['quarantine'], 'readwrite', (tx) => tx.delete('quarantine', qid)); }

  // ---- import
  /** The automatic backup taken before the last merge / replace of this profile: { at, reason, file } or undefined. */
  async getAutoBackup(id) { return this.getMeta('autoBackup:' + id); }

  /**
   * Apply a planImport() result. 'new' creates a profile; 'merge' / 'replace' overwrite the existing one with CAS on
   * plan.profile.rev AFTER taking an automatic backup (an export of the replaced document, kept in meta, plus the usual
   * history entry). Returns the saved profile.
   */
  async applyImport(plan) {
    if (!plan || !plan.ok) throw new ValidationError('applyImport needs a successful plan', []);
    const mode = plan.report.mode;
    if (mode === 'new') {
      const saved = await this.saveProfile(plan.profile, { reason: 'import-new' });
      return saved;
    }
    const problems = checkProfile(plan.profile);
    if (problems.length) throw new ValidationError('the planned profile is not well formed', problems);
    const saved = await this._tx(['profiles', 'profileHistory', 'meta'], 'readwrite', (tx) => this._commit(tx, plan.profile, { reason: 'import-' + mode, backup: 'pre-import-' + mode }));
    this._announce({ t: 'saved', id: saved.id, rev: saved.rev });
    return saved;
  }
  /** Convenience: parse-free plan + apply. `existing` null for mode 'new'. */
  async importProfile(incoming, mode, existing) {
    const plan = planImport(existing || null, incoming, mode, this.deps);
    if (!plan.ok) throw new ValidationError(plan.message, []);
    return { saved: await this.applyImport(plan), report: plan.report };
  }
}

// ---------------------------------------------------------------------------------------------
// the adapter contract: behaviours every adapter must show. Node runs it on the memory adapter; the IndexedDB smoke page
// runs the same cases on real IndexedDB. Each case returns true or a string saying what was wrong.
// ctx = { make(name) -> a NEW opened adapter on the database `name`, destroy(name) -> forget the database }
// ---------------------------------------------------------------------------------------------

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let uniq = 0;
const dbn = (tag) => `contract-${tag}-${(uniq++).toString(36)}-${Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
async function withDb(ctx, tag, fn) {
  const name = dbn(tag);
  const a = await ctx.make(name);
  try { return await fn(a, name); } finally { try { await a.close(); } catch (_e) { /* ignore */ } try { await ctx.destroy(name); } catch (_e) { /* ignore */ } }
}
const rw = (a, names, fn) => a.transact(names, 'readwrite', fn);
const ro = (a, names, fn) => a.transact(names, 'readonly', fn);

export const ADAPTER_CONTRACT = [
  { name: 'contract/put-get-roundtrip-and-copy-semantics', run: (ctx) => withDb(ctx, 'rt', async (a) => {
    const v = { key: 'k', value: { n: [1, 2, { z: null }], s: 'x', big: 2 ** 40, bytes: new Uint8Array([1, 2, 3]) } };
    await rw(a, ['meta'], (tx) => tx.put('meta', v));
    v.value.n[0] = 99; // mutating the original after put must not change what is stored
    const got = await ro(a, ['meta'], (tx) => tx.get('meta', 'k'));
    if (!got || got.value.n[0] !== 1 || got.value.n[2].z !== null || got.value.big !== 2 ** 40) return 'stored value changed or lost: ' + JSON.stringify(got);
    if (!(got.value.bytes instanceof Uint8Array) || got.value.bytes.length !== 3 || got.value.bytes[2] !== 3) return 'Uint8Array did not survive';
    got.value.n[0] = 77; // mutating a read must not change the store
    const again = await ro(a, ['meta'], (tx) => tx.get('meta', 'k'));
    return again.value.n[0] === 1 ? true : 'a mutated read leaked into the store';
  }) },
  { name: 'contract/missing-key-is-undefined', run: (ctx) => withDb(ctx, 'miss', async (a) => {
    const g = await ro(a, ['meta'], (tx) => tx.get('meta', 'nope'));
    return g === undefined ? true : 'got ' + JSON.stringify(g);
  }) },
  { name: 'contract/put-replaces-and-delete-removes', run: (ctx) => withDb(ctx, 'del', async (a) => {
    await rw(a, ['meta'], async (tx) => { await tx.put('meta', { key: 'k', value: 1 }); await tx.put('meta', { key: 'k', value: 2 }); });
    const v = await ro(a, ['meta'], (tx) => tx.get('meta', 'k'));
    if (!v || v.value !== 2) return 'put did not replace: ' + JSON.stringify(v);
    await rw(a, ['meta'], (tx) => tx.delete('meta', 'k'));
    await rw(a, ['meta'], (tx) => tx.delete('meta', 'never-existed'));
    const g = await ro(a, ['meta'], (tx) => tx.get('meta', 'k'));
    return g === undefined ? true : 'delete left the record';
  }) },
  { name: 'contract/list-is-key-ordered-with-range-and-limit', run: (ctx) => withDb(ctx, 'list', async (a) => {
    await rw(a, ['profileHistory'], async (tx) => { for (const k of ['b:2', 'a:3', 'b:1', 'c:1', 'b:10']) await tx.put('profileHistory', { hkey: k, id: k[0], rev: 0 }); });
    const all = (await ro(a, ['profileHistory'], (tx) => tx.list('profileHistory'))).map((x) => x.hkey);
    if (!same(all, ['a:3', 'b:1', 'b:10', 'b:2', 'c:1'])) return 'order ' + JSON.stringify(all);
    const b = (await ro(a, ['profileHistory'], (tx) => tx.list('profileHistory', { gte: 'b:', lt: 'b;' }))).map((x) => x.hkey);
    if (!same(b, ['b:1', 'b:10', 'b:2'])) return 'range ' + JSON.stringify(b);
    const lim = (await ro(a, ['profileHistory'], (tx) => tx.list('profileHistory', { limit: 2 }))).map((x) => x.hkey);
    return same(lim, ['a:3', 'b:1']) ? true : 'limit ' + JSON.stringify(lim);
  }) },
  { name: 'contract/transaction-sees-its-own-writes', run: (ctx) => withDb(ctx, 'ryw', async (a) => {
    const r = await rw(a, ['meta'], async (tx) => { await tx.put('meta', { key: 'k', value: 5 }); return (await tx.get('meta', 'k')).value; });
    return r === 5 ? true : 'saw ' + r;
  }) },
  { name: 'contract/error-rolls-back-every-write-and-propagates', run: (ctx) => withDb(ctx, 'rb', async (a) => {
    await rw(a, ['meta'], (tx) => tx.put('meta', { key: 'keep', value: 'old' }));
    let caught = null;
    try {
      await rw(a, ['meta', 'profiles'], async (tx) => {
        await tx.put('meta', { key: 'keep', value: 'new' });
        await tx.put('meta', { key: 'extra', value: 1 });
        await tx.put('profiles', { id: 'p1' });
        throw new Error('boom-contract');
      });
    } catch (e) { caught = e; }
    if (!caught || !String(caught.message).includes('boom-contract')) return 'the error did not propagate: ' + (caught && caught.message);
    const keep = await ro(a, ['meta'], (tx) => tx.get('meta', 'keep'));
    const extra = await ro(a, ['meta'], (tx) => tx.get('meta', 'extra'));
    const p1 = await ro(a, ['profiles'], (tx) => tx.get('profiles', 'p1'));
    if (!keep || keep.value !== 'old') return 'an overwritten value was not rolled back: ' + JSON.stringify(keep);
    if (extra !== undefined || p1 !== undefined) return 'a new record survived the rollback';
    return true;
  }) },
  { name: 'contract/read-modify-write-is-serialised-no-lost-update', run: (ctx) => withDb(ctx, 'rmw', async (a) => {
    await rw(a, ['meta'], (tx) => tx.put('meta', { key: 'n', value: 0 }));
    const inc = () => rw(a, ['meta'], async (tx) => { const c = await tx.get('meta', 'n'); await tx.put('meta', { key: 'n', value: c.value + 1 }); });
    await Promise.all(Array.from({ length: 25 }, inc));
    const n = (await ro(a, ['meta'], (tx) => tx.get('meta', 'n'))).value;
    return n === 25 ? true : `25 concurrent increments produced ${n}`;
  }) },
  { name: 'contract/second-connection-sees-committed-data', run: (ctx) => withDb(ctx, 'two', async (a, name) => {
    const b = await ctx.make(name);
    try {
      await rw(a, ['meta'], (tx) => tx.put('meta', { key: 'shared', value: 'hello' }));
      const g = await ro(b, ['meta'], (tx) => tx.get('meta', 'shared'));
      if (!g || g.value !== 'hello') return 'the second connection saw ' + JSON.stringify(g);
      await rw(b, ['meta'], (tx) => tx.put('meta', { key: 'shared', value: 'again' }));
      const h = await ro(a, ['meta'], (tx) => tx.get('meta', 'shared'));
      return h && h.value === 'again' ? true : 'the first connection saw ' + JSON.stringify(h);
    } finally { await b.close(); }
  }) },
  { name: 'contract/readonly-transaction-rejects-writes', run: (ctx) => withDb(ctx, 'ro', async (a) => {
    let threw = false;
    try { await ro(a, ['meta'], (tx) => tx.put('meta', { key: 'k', value: 1 })); } catch (_e) { threw = true; }
    const g = await ro(a, ['meta'], (tx) => tx.get('meta', 'k'));
    if (g !== undefined) return 'a readonly transaction wrote the record';
    return threw ? true : 'a readonly transaction accepted a write without error';
  }) },
  { name: 'contract/unknown-store-rejects', run: (ctx) => withDb(ctx, 'unk', async (a) => {
    try { await ro(a, ['nope'], (tx) => tx.get('nope', 'k')); } catch (_e) { return true; }
    return 'a transaction on an unknown store succeeded';
  }) },
  { name: 'contract/closed-adapter-rejects', run: (ctx) => withDb(ctx, 'cl', async (a, name) => {
    const b = await ctx.make(name);
    await b.close();
    try { await ro(b, ['meta'], (tx) => tx.get('meta', 'k')); } catch (_e) { return true; }
    return 'a closed adapter still ran a transaction';
  }) },
  { name: 'contract/non-extractable-cryptokey-survives-the-keys-store', run: (ctx) => withDb(ctx, 'ck', async (a) => {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return true; // not testable without WebCrypto
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await rw(a, ['keys'], (tx) => tx.put('keys', { id: 'p1', privateKey: kp.privateKey, publicKeyJwk: null, createdAt: 1 }));
    const got = await ro(a, ['keys'], (tx) => tx.get('keys', 'p1'));
    const k = got && got.privateKey;
    if (!k || k.type !== 'private' || k.extractable !== false) return 'the key came back as ' + (k && `${k.type}/extractable=${k.extractable}`);
    const data = new Uint8Array([1, 2, 3]);
    const sig = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, data);
    return (await globalThis.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, data)) ? true : 'the stored key signs, but the signature does not verify with the original public key';
  }) },
];

/** Run ADAPTER_CONTRACT. Returns [{ name, ok, detail }]. Never throws. */
export async function runAdapterContract(ctx, cases = ADAPTER_CONTRACT) {
  const out = [];
  for (const c of cases) {
    let r;
    try { r = await c.run(ctx); } catch (e) { r = 'threw ' + describe(e); }
    out.push({ name: c.name, ok: r === true, detail: r === true ? '' : String(r) });
  }
  return out;
}
