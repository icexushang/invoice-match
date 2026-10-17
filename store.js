/* =====================================================================
 *  核销台账存储层 Store
 *  依据《核销台账（含反核销闭环）产品需求文档 v1.0》§12.1 实现
 *
 *  统一契约（UI 只依赖 Store，不关心底层实现）：
 *    init() / clearAll() / stats() / signature() / closedPeriods() / setPeriodClosed()
 *    listWriteOffs(query) / getWriteOff(id) / arWrittenOff() / getArBalances(arNos)
 *    createWriteOff(payload) / reverseWriteOff(id, {reasonCode, reason, bizDate})
 *    replaceHistory(records)   ← 历史已结算数据同步（数据源 → 台账快照行）
 *    savePools({invoices,ars}) / loadPools() / isPoolsReady() / setPoolsReady()
 *                              ← 发票池 / 应收单池持久化（刷新 / 换机不丢）
 *
 *  适配器（自动降级）：
 *    IndexedDB（首选） → localStorage（降级） → 内存（兜底）
 *  后端预留：设置 window.WRITEOFF_API_BASE 后自动切换为 HttpStore（PRD §12.2）
 *
 *  数据模型（对应 PRD §6）：
 *    writeoffs 台账主表（含发票/应收单快照）
 *    details   配分明细（发票 × 应收单 逐行配对，pairKey = invoiceId:arId）
 *    events    事件流水（append-only）
 *    meta      批次序号 / 已关账期间
 *
 *  台账内的两类记录（entryType）：
 *    WRITE_OFF / REVERSE  本系统的核销事实：只追加，纠错走反核销
 *    HISTORY              数据源（ERP 应收单池 / 外部接口 / 上传文件）的「历史已结算」
 *                         快照行：可随数据源刷新同步更新，不占用余额、不参与反核销
 * ===================================================================== */
(function (global) {
  'use strict';

  const DB_NAME = 'invoice-match-ledger';
  const DB_VERSION = 2;   /* v2：新增 invoices / ars（发票池 / 应收单池持久化） */
  const COLLECTIONS = ['writeoffs', 'details', 'events', 'meta', 'invoices', 'ars'];
  const LS_PREFIX = 'imp.ledger.';

  /* ---------------- 工具 ---------------- */
  const r2 = n => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const uid = p => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
  const ymdDash = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /* ---------------- 错误码（PRD 附录 B） ---------------- */
  const ERR = {
    IDEMPOTENT_REPLAY: 'IDEMPOTENT_REPLAY',
    AR_BALANCE_CHANGED: 'AR_BALANCE_CHANGED',
    INVOICE_ALREADY_WRITTEN: 'INVOICE_ALREADY_WRITTEN',
    ALREADY_REVERSED: 'ALREADY_REVERSED',
    PERIOD_CLOSED: 'PERIOD_CLOSED',
    FORBIDDEN: 'FORBIDDEN',
    NOT_FOUND: 'NOT_FOUND',
    INVALID: 'INVALID',
  };
  const ERR_TEXT = {
    IDEMPOTENT_REPLAY: '重复提交（幂等命中），已返回原记录',
    AR_BALANCE_CHANGED: '应收单剩余余额已被其他批次占用，请重新匹配',
    INVOICE_ALREADY_WRITTEN: '该发票已有有效核销记录，请先反核销后再核销',
    ALREADY_REVERSED: '该记录已反核销，不能重复反核销',
    PERIOD_CLOSED: '该核销所属会计期间已关账，不能直接反核销（请走红冲）',
    FORBIDDEN: '当前状态不允许该操作',
    NOT_FOUND: '核销记录不存在',
    INVALID: '数据校验失败',
  };
  const fail = (code, msg) => {
    const e = new Error(msg || ERR_TEXT[code] || code);
    e.code = code;
    return e;
  };

  /* 计入「已核销余额 / 发票唯一性 / 汇总净额」的记录：
     仅状态有效的「核销」记录；已反核销的原记录与其反向记录均不计入；
     历史已结算快照（HISTORY）来自数据源，已体现在应收单基准已核销中，同样不计入，避免重复扣减 */
  const countInBalance = h => h.status === 'VALID' && h.entryType === 'WRITE_OFF';
  const isHistory = h => h.entryType === 'HISTORY';

  /* ---------------- IDB / Promise 辅助 ---------------- */
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = t => new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });

  /* ---------------- 后端：IndexedDB ---------------- */
  function createIdbBackend() {
    let db = null;
    const open = () => new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        COLLECTIONS.forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('IndexedDB 打开失败'));
    });
    return {
      name: 'IndexedDB',
      async init() { db = await open(); },
      async all(c) { return (await reqP(db.transaction(c).objectStore(c).getAll())) || []; },
      async put(c, rec) { await reqP(db.transaction(c, 'readwrite').objectStore(c).put(rec)); },
      async putMany(c, recs) {
        if (!recs.length) return;
        const t = db.transaction(c, 'readwrite');
        const s = t.objectStore(c);
        recs.forEach(r => s.put(r));
        await txDone(t);
      },
      async delMany(c, ids) {
        if (!ids.length) return;
        const t = db.transaction(c, 'readwrite');
        const s = t.objectStore(c);
        ids.forEach(id => s.delete(id));
        await txDone(t);
      },
      async clear(c) { await reqP(db.transaction(c, 'readwrite').objectStore(c).clear()); },
    };
  }

  /* ---------------- 后端：localStorage ---------------- */
  function createLsBackend(storage) {
    const key = c => LS_PREFIX + c;
    const read = c => { try { return JSON.parse(storage.getItem(key(c)) || '[]') || []; } catch (e) { return []; } };
    const write = (c, arr) => storage.setItem(key(c), JSON.stringify(arr));
    const upsert = (arr, rec) => {
      const i = arr.findIndex(x => x.id === rec.id);
      if (i >= 0) arr[i] = rec; else arr.push(rec);
    };
    return {
      name: 'localStorage',
      async init() { COLLECTIONS.forEach(c => { if (storage.getItem(key(c)) === null) write(c, []); }); },
      async all(c) { return read(c); },
      async put(c, rec) { const arr = read(c); upsert(arr, rec); write(c, arr); },
      async putMany(c, recs) { const arr = read(c); recs.forEach(r => upsert(arr, r)); write(c, arr); },
      async delMany(c, ids) {
        const drop = new Set(ids);
        write(c, read(c).filter(r => !drop.has(r.id)));
      },
      async clear(c) { write(c, []); },
    };
  }

  /* ---------------- 后端：内存（兜底） ---------------- */
  function createMemoryBackend() {
    const mem = {};
    return {
      name: '内存（刷新即丢）',
      async init() { COLLECTIONS.forEach(c => { mem[c] = mem[c] || []; }); },
      async all(c) { return (mem[c] || []).slice(); },
      async put(c, rec) {
        mem[c] = mem[c] || [];
        const i = mem[c].findIndex(x => x.id === rec.id);
        if (i >= 0) mem[c][i] = rec; else mem[c].push(rec);
      },
      async putMany(c, recs) { for (const r of recs) await this.put(c, r); },
      async delMany(c, ids) {
        const drop = new Set(ids);
        mem[c] = (mem[c] || []).filter(r => !drop.has(r.id));
      },
      async clear(c) { mem[c] = []; },
    };
  }

  /* =====================================================================
   *  本地实现（IndexedDB / localStorage / 内存 共用同一套业务逻辑）
   * ===================================================================== */
  function createLocalStore(backend) {
    const metaGet = async k => {
      const rows = await backend.all('meta');
      const cur = rows.find(x => x.id === k);
      return cur ? cur.value : null;
    };
    const metaSet = async (k, v) => { await backend.put('meta', { id: k, value: v }); return v; };

    const store = {
      kind: 'local',
      get backendName() { return backend.name; },

      async clearAll() { for (const c of COLLECTIONS) await backend.clear(c); },

      /* ---- 发票池 / 应收单池持久化（整体替换语义） ----
         余额、已核销、发票状态等派生值不依赖此处快照：
         启动后由台账有效记录统一重算（refreshArBalances / syncInvoiceStatusFromLedger），
         池中仅需持久化导入事实（含 baseWrittenOff 数据源已结算口径与 raw 原始字段）。 */
      async savePools(pools = {}) {
        await backend.clear('invoices');
        await backend.putMany('invoices', pools.invoices || []);
        await backend.clear('ars');
        await backend.putMany('ars', pools.ars || []);
      },
      async loadPools() {
        const [invoices, ars] = await Promise.all([backend.all('invoices'), backend.all('ars')]);
        return { invoices, ars };
      },
      async isPoolsReady() { return !!(await metaGet('poolsReady')); },
      async setPoolsReady(ready) { await metaSet('poolsReady', !!ready); return !!ready; },

      /* ---- 批次号：HXyyyymmdd-001（当日递增，持久化） ---- */
      async nextBatchNo(bizDate) {
        const day = String(bizDate || ymdDash(new Date())).replace(/-/g, '');
        const map = (await metaGet('batchSeq')) || {};
        const n = (map[day] || 0) + 1;
        map[day] = n;
        await metaSet('batchSeq', map);
        return `HX${day}-${pad(n, 3)}`;
      },

      /* ---- 期间关账（PRD BR-09） ---- */
      async closedPeriods() { return (await metaGet('closedPeriods')) || []; },
      async isPeriodClosed(period) { return (await this.closedPeriods()).indexOf(String(period)) >= 0; },
      async setPeriodClosed(period, closed) {
        const list = (await this.closedPeriods()).filter(p => p !== String(period));
        if (closed) list.push(String(period));
        await metaSet('closedPeriods', list);
        return list;
      },

      /* ---- 查询 ---- */
      async allWriteOffs() {
        const rows = await backend.all('writeoffs');
        return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      },

      /* 应收单已核销额 = 有效「核销」记录的明细合计
         说明：反向记录（REVERSE）用于冲销一条已置为 REVERSED 的原记录，
         原记录已不计入，故反向记录同样不计入（否则会重复扣减）；红冲行本身带负号，仍计入 */
      async arWrittenOff() {
        const heads = await backend.all('writeoffs');
        const counted = new Set(heads.filter(countInBalance).map(h => h.writeOffId));
        const map = {};
        for (const d of await backend.all('details')) {
          if (!counted.has(d.writeOffId)) continue;
          map[d.arNo] = r2((map[d.arNo] || 0) + d.writeAmount);
        }
        return map;
      },

      async getArBalances(arNos) {
        const agg = await this.arWrittenOff();
        const out = {};
        (arNos || []).forEach(arNo => { out[arNo] = r2(agg[arNo] || 0); });
        return out;
      },

      async listWriteOffs(query = {}) {
        const heads = await this.allWriteOffs();
        const details = await backend.all('details');
        const byWo = new Map();
        details.forEach(d => {
          if (!byWo.has(d.writeOffId)) byWo.set(d.writeOffId, []);
          byWo.get(d.writeOffId).push(d);
        });

        const kw = String(query.kw || '').trim().toUpperCase();
        const rows = heads.filter(h => {
          if (query.status && h.status !== query.status) return false;
          if (query.entryType && h.entryType !== query.entryType) return false;
          if (query.method && h.method !== query.method) return false;
          if (query.from && String(h.bizDate) < String(query.from)) return false;
          if (query.to && String(h.bizDate) > String(query.to)) return false;
          if (!kw) return true;
          const text = [
            h.batchNo, h.customerName, h.contractNo, h.method, h.status, h.refBatchNo, h.reasonCode,
            ...(byWo.get(h.writeOffId) || []).flatMap(d => [d.invoiceNo, d.invoiceCode, d.arNo]),
          ].join(' ').toUpperCase();
          return text.includes(kw);
        }).map(h => Object.assign({}, h, { lineCount: (byWo.get(h.writeOffId) || []).length }));

        /* 汇总区分：本系统核销事实（valid / reversed / lines / amount）
           与数据源历史已结算快照（history / historyAmount），互不混算 */
        const agg = rows.reduce((a, h) => {
          a.count++;
          if (isHistory(h)) {
            a.history++;
            a.historyAmount = r2(a.historyAmount + h.writeOffTotal);
            return a;
          }
          if (h.status === 'VALID') a.valid++; else a.reversed++;
          if (countInBalance(h)) a.amount = r2(a.amount + h.writeOffTotal);
          a.lines += h.lineCount;
          return a;
        }, { count: 0, valid: 0, reversed: 0, lines: 0, amount: 0, history: 0, historyAmount: 0, historySyncedAt: null });

        const syncedAt = rows.filter(isHistory)
          .map(h => String(h.syncedAt || ''))
          .sort()
          .pop();
        agg.historySyncedAt = syncedAt || null;

        const size = query.size === 0 ? rows.length : (query.size || 10);
        const page = Math.max(1, query.page || 1);
        const slice = query.size === 0 ? rows : rows.slice((page - 1) * size, (page - 1) * size + size);
        return { rows: slice, total: rows.length, agg, page, size };
      },

      async getWriteOff(id) {
        const header = (await backend.all('writeoffs')).find(h => h.writeOffId === id) || null;
        if (!header) throw fail(ERR.NOT_FOUND);
        const details = (await backend.all('details')).filter(d => d.writeOffId === id).sort((a, b) => a.lineNo - b.lineNo);
        const events = (await backend.all('events')).filter(e => e.writeOffId === id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        return { header, details, events };
      },

      async stats() {
        const heads = await backend.all('writeoffs');
        const details = await backend.all('details');
        const facts = heads.filter(h => !isHistory(h));
        const hist = heads.filter(isHistory);
        const valid = facts.filter(h => h.status === 'VALID');
        return {
          count: facts.length,
          valid: valid.length,
          reversed: facts.length - valid.length,
          lines: details.length,
          netAmount: r2(facts.filter(countInBalance).reduce((s, h) => s + h.writeOffTotal, 0)),
          history: hist.length,
          historyAmount: r2(hist.reduce((s, h) => s + h.writeOffTotal, 0)),
          historySyncedAt: hist.map(h => String(h.syncedAt || '')).sort().pop() || null,
          closedPeriods: await this.closedPeriods(),
        };
      },

      /* ---- 变更指纹：供页面「自动刷新」判断是否需要重新查询（PRD FR-16） ----
         覆盖条数 / 明细行数 / 已反核销数 / 金额合计 / 最新时间，任一变化即视为台账已更新 */
      async signature() {
        const heads = await backend.all('writeoffs');
        const details = await backend.all('details');
        let maxAt = '', sum = 0, reversed = 0;
        for (const h of heads) {
          const at = String(h.createdAt || '');
          if (at > maxAt) maxAt = at;
          sum = r2(sum + h.writeOffTotal);
          if (h.status === 'REVERSED') reversed++;
        }
        return `${heads.length}|${details.length}|${reversed}|${sum.toFixed(2)}|${maxAt}`;
      },

      /* ---- 历史已结算数据同步（数据源 → 台账快照行，PRD FR-17） ----
         语义：replace —— 以数据源当前内容为准整体刷新 HISTORY 行，
               旧快照行被移除（不视为台账事实，故不违反「只追加」）。
         入参 records: [{ key, arNo, amount, bizDate, customer, customerTaxId,
                          contractNo, arAmount, settleRef, statusText, source, remark, amountMode }] */
      async replaceHistory(records = []) {
        const now = new Date();
        const olds = (await backend.all('writeoffs')).filter(isHistory).map(h => h.id);
        const seen = new Set();
        const rows = [];

        for (const r of records) {
          if (!r) continue;
          const arNo = String(r.arNo || '').trim();
          const amount = r2(r.amount);
          if (!arNo || !(amount > 0)) continue;
          const key = String(r.key || arNo);
          if (seen.has(key)) continue;
          seen.add(key);

          const bizDate = /^\d{4}-\d{2}-\d{2}$/.test(String(r.bizDate || '')) ? String(r.bizDate) : ymdDash(now);
          const at = new Date(`${bizDate}T00:00:00`);
          const writeOffId = `hist:${key}`;
          rows.push({
            id: writeOffId,
            writeOffId,
            batchNo: r.batchNo || `HIST-${pad(rows.length + 1, 3)}`,
            entryType: 'HISTORY',
            refBatchNo: null,
            status: 'VALID',
            method: r.method || '历史结算同步',
            amountMode: r.amountMode === 'incl' ? 'incl' : 'excl',
            invoiceTotal: 0,
            writeOffTotal: amount,
            diff: 0,
            customerName: r.customer || null,
            customerTaxId: r.customerTaxId || null,
            contractNo: r.contractNo || null,
            orgId: null,
            bizDate,
            period: bizDate.slice(0, 7),
            invoices: [],
            ars: [{ arId: null, arNo, customer: r.customer || null, amount: r2(r.arAmount) || amount, contractNo: r.contractNo || null }],
            idempotencyKey: key,
            reasonCode: null,
            reason: null,
            operatorId: '数据源同步',
            operatorName: '数据源同步',
            version: 1,
            createdAt: (isNaN(at.getTime()) ? now : at).toISOString(),
            createdAtText: bizDate,
            /* 历史快照专有字段（UI 展示来源与对账） */
            isDerived: true,
            syncSource: r.source || '数据源',
            settleRef: r.settleRef || null,
            sourceStatus: r.statusText || null,
            remark: r.remark || null,
            syncedAt: now.toISOString(),
            syncedAtText: now.toLocaleString('zh-CN'),
          });
        }

        await backend.delMany('writeoffs', olds);
        if (rows.length) await backend.putMany('writeoffs', rows);
        return {
          count: rows.length,
          total: r2(rows.reduce((s, r) => s + r.writeOffTotal, 0)),
          replaced: olds.length,
        };
      },

      /* ---- 生成核销记录（PRD FR-01/02/03） ---- */
      async createWriteOff(payload) {
        if (!payload || !Array.isArray(payload.pairs) || !payload.pairs.length) throw fail(ERR.INVALID, '没有可写入的配分明细');

        const heads = await backend.all('writeoffs');
        const allDetails = await backend.all('details');

        /* BR-02 幂等 */
        const replay = heads.find(h => h.idempotencyKey && h.idempotencyKey === payload.idempotencyKey);
        if (replay) {
          return { replayed: true, header: replay, details: allDetails.filter(d => d.writeOffId === replay.writeOffId) };
        }

        /* 仅「有效核销记录」占用余额与发票：已反核销的原记录及其反向记录均不占用 */
        const countedIds = new Set(heads.filter(countInBalance).map(h => h.writeOffId));
        const led = {};
        const writtenInvoices = new Set();
        allDetails.forEach(d => {
          if (!countedIds.has(d.writeOffId)) return;
          led[d.arNo] = r2((led[d.arNo] || 0) + d.writeAmount);
          writtenInvoices.add(`${d.invoiceCode}|${d.invoiceNo}`);
        });

        /* BR-06 发票唯一性 */
        for (const inv of payload.invoices || []) {
          if (writtenInvoices.has(`${inv.code}|${inv.no}`)) {
            throw fail(ERR.INVOICE_ALREADY_WRITTEN, `发票 ${inv.no} 已有有效核销记录，请先反核销`);
          }
        }

        /* BR-05 余额二次校验（不信任前端 state） */
        const amountByAr = {};
        (payload.ars || []).forEach(a => { amountByAr[a.arNo] = a.amount; });
        const addByAr = {};
        payload.pairs.forEach(p => { addByAr[p.arNo] = r2((addByAr[p.arNo] || 0) + p.writeAmount); });
        for (const arNo of Object.keys(addByAr)) {
          const amount = amountByAr[arNo];
          if (amount === undefined) continue;
          const after = r2((led[arNo] || 0) + addByAr[arNo]);
          if (after > r2(amount) + 0.001) {
            throw fail(ERR.AR_BALANCE_CHANGED,
              `应收单 ${arNo} 余额不足：已核销 ¥${r2(led[arNo] || 0).toFixed(2)} + 本次 ¥${addByAr[arNo].toFixed(2)} > 原金额 ¥${r2(amount).toFixed(2)}`);
          }
        }

        const now = new Date();
        const bizDate = payload.bizDate || ymdDash(now);
        const operatorId = payload.operatorId || '当前用户';
        const header = {
          id: '',
          writeOffId: uid('wo-'),
          batchNo: await this.nextBatchNo(bizDate),
          entryType: 'WRITE_OFF',
          refBatchNo: null,
          status: 'VALID',
          method: payload.method || '人工确认',
          amountMode: payload.amountMode || 'excl',
          invoiceTotal: r2(payload.invoiceTotal),
          writeOffTotal: r2(payload.writeOffTotal),
          diff: r2(payload.diff),
          customerName: payload.customerName || null,
          customerTaxId: payload.customerTaxId || null,
          contractNo: payload.contractNo || null,
          orgId: payload.orgId || null,
          bizDate,
          period: String(bizDate).slice(0, 7),
          invoices: payload.invoices || [],
          ars: payload.ars || [],
          idempotencyKey: payload.idempotencyKey || uid('idem-'),
          reasonCode: null,
          reason: null,
          operatorId,
          operatorName: payload.operatorName || operatorId,
          version: 1,
          createdAt: now.toISOString(),
          createdAtText: now.toLocaleString('zh-CN'),
        };
        header.id = header.writeOffId;

        const details = payload.pairs.map((p, i) => ({
          id: `${header.writeOffId}#${pad(i + 1, 3)}`,
          writeOffId: header.writeOffId,
          lineNo: i + 1,
          pairKey: `${p.invoiceId}:${p.arId}`,
          invoiceId: p.invoiceId,
          invoiceCode: p.invoiceCode,
          invoiceNo: p.invoiceNo,
          arId: p.arId,
          arNo: p.arNo,
          arAmount: r2(p.arAmount),
          arRemainingBefore: r2(p.arRemainingBefore),
          writeAmount: r2(p.writeAmount),
          arRemainingAfter: r2(p.arRemainingAfter),
          contractNo: p.contractNo || null,
          isReversal: false,
        }));

        /* BR-04 金额守恒 */
        const sumDetail = r2(details.reduce((s, d) => s + d.writeAmount, 0));
        if (Math.abs(sumDetail - header.writeOffTotal) > 0.011) {
          throw fail(ERR.INVALID, `明细合计 ¥${sumDetail.toFixed(2)} 与核销总额 ¥${header.writeOffTotal.toFixed(2)} 不一致`);
        }

        await backend.put('writeoffs', header);
        await backend.putMany('details', details);
        await backend.putMany('events', [{
          id: uid('ev-'),
          writeOffId: header.writeOffId,
          eventType: 'CREATE',
          payload: { entryType: 'WRITE_OFF', batchNo: header.batchNo, lines: details.length, total: header.writeOffTotal },
          operatorId,
          createdAt: header.createdAt,
        }]);

        return { replayed: false, header, details };
      },

      /* ---- 反核销（PRD §11，无审批） ---- */
      async reverseWriteOff(writeOffId, opts = {}) {
        const heads = await backend.all('writeoffs');
        const orig = heads.find(h => h.writeOffId === writeOffId);
        if (!orig) throw fail(ERR.NOT_FOUND);
        if (orig.status !== 'VALID' || orig.entryType !== 'WRITE_OFF') {
          throw fail(ERR.ALREADY_REVERSED, orig.status === 'REVERSED' ? undefined : '仅有效核销记录可反核销');
        }
        /* BR-07 只能反核销一次 */
        if (heads.some(h => h.entryType === 'REVERSE' && h.refBatchNo === orig.batchNo && h.status === 'VALID')) {
          throw fail(ERR.ALREADY_REVERSED);
        }
        /* BR-09 期间关账 */
        if (await this.isPeriodClosed(orig.period)) {
          throw fail(ERR.PERIOD_CLOSED, `会计期间 ${orig.period} 已关账，不能直接反核销（请走红冲）`);
        }
        if (!opts.reasonCode) throw fail(ERR.INVALID, '反核销必须选择原因码');

        const led = await this.arWrittenOff();
        const details = (await backend.all('details'))
          .filter(d => d.writeOffId === orig.writeOffId)
          .sort((a, b) => a.lineNo - b.lineNo);
        const amountByAr = {};
        (orig.ars || []).forEach(a => { amountByAr[a.arNo] = a.amount; });

        const now = new Date();
        const bizDate = opts.bizDate || ymdDash(now);
        const operatorId = opts.operatorId || '当前用户';
        const batchNo = await this.nextBatchNo(bizDate);

        const header = {
          id: '',
          writeOffId: uid('wo-'),
          batchNo,
          entryType: 'REVERSE',
          refBatchNo: orig.batchNo,
          status: 'VALID',
          method: orig.method,
          amountMode: orig.amountMode,
          invoiceTotal: r2(-orig.invoiceTotal),
          writeOffTotal: r2(-orig.writeOffTotal),
          diff: r2(-orig.diff),
          customerName: orig.customerName,
          customerTaxId: orig.customerTaxId,
          contractNo: orig.contractNo,
          orgId: orig.orgId,
          bizDate,
          period: String(bizDate).slice(0, 7),
          invoices: orig.invoices || [],
          ars: orig.ars || [],
          idempotencyKey: opts.idempotencyKey || uid('idem-'),
          reasonCode: opts.reasonCode,
          reason: opts.reason || '',
          operatorId,
          operatorName: operatorId,
          version: 1,
          createdAt: now.toISOString(),
          createdAtText: now.toLocaleString('zh-CN'),
        };
        header.id = header.writeOffId;

        /* 明细逐行取负，pairKey 保持不变（便于正反对照） */
        const revDetails = details.map((d, i) => {
          const before = r2((amountByAr[d.arNo] === undefined ? d.arAmount : amountByAr[d.arNo]) - (led[d.arNo] || 0));
          const w = r2(-d.writeAmount);
          return Object.assign({}, d, {
            id: `${header.writeOffId}#${pad(i + 1, 3)}`,
            writeOffId: header.writeOffId,
            lineNo: i + 1,
            writeAmount: w,
            arRemainingBefore: before,
            arRemainingAfter: r2(before + w),
            isReversal: true,
          });
        });

        /* 原记录置为已反核销（仅允许改状态与撤销留痕） */
        orig.status = 'REVERSED';
        orig.reversedAt = header.createdAt;
        orig.reversedBy = operatorId;
        orig.reversedReasonCode = opts.reasonCode;
        orig.reversedReason = opts.reason || '';
        orig.reversedBatchNo = batchNo;
        orig.version = (orig.version || 1) + 1;

        await backend.put('writeoffs', orig);
        await backend.put('writeoffs', header);
        await backend.putMany('details', revDetails);
        await backend.putMany('events', [
          {
            id: uid('ev-'), writeOffId: orig.writeOffId, eventType: 'REVERSE',
            payload: { reverseBatchNo: batchNo, reasonCode: opts.reasonCode, reason: opts.reason || '', total: r2(-orig.writeOffTotal) },
            operatorId, createdAt: header.createdAt,
          },
          {
            id: uid('ev-'), writeOffId: header.writeOffId, eventType: 'CREATE',
            payload: { entryType: 'REVERSE', refBatchNo: orig.batchNo, total: header.writeOffTotal, lines: revDetails.length },
            operatorId, createdAt: header.createdAt,
          },
        ]);

        return { header, details: revDetails, original: orig };
      },
    };

    return store;
  }

  /* =====================================================================
   *  后端接口预留：HttpStore（PRD §12.2）
   *  设置 window.WRITEOFF_API_BASE = 'https://host/api' 即启用
   * ===================================================================== */
  function createHttpStore(base) {
    const call = async (path, options = {}) => {
      const res = await fetch(base.replace(/\/$/, '') + path, Object.assign({
        headers: { 'Content-Type': 'application/json', 'X-Operator-Id': '当前用户' },
      }, options));
      if (!res.ok) {
        let body = {};
        try { body = await res.json(); } catch (e) { /* ignore */ }
        throw fail(body.code || ERR.INVALID, body.message || `接口错误 ${res.status}`);
      }
      return res.status === 204 ? null : res.json();
    };
    return {
      kind: 'http',
      get backendName() { return 'HTTP（后端接口）'; },
      async clearAll() { await call('/writeoffs', { method: 'DELETE' }); },
      /* 发票池 / 应收单池：PUT 整体替换、GET 全量（契约见 PRD §12.2） */
      async savePools(pools) { return call('/pools', { method: 'PUT', body: JSON.stringify(pools || {}) }); },
      async loadPools() {
        const r = await call('/pools');
        return { invoices: (r && r.invoices) || [], ars: (r && r.ars) || [] };
      },
      async isPoolsReady() {
        try { const r = await call('/pools/ready'); return !!(r && r.ready); }
        catch (e) { return false; }   /* 后端未实现该接口时按「首次使用」处理 */
      },
      async setPoolsReady() { return true; },   /* 由后端在 PUT /pools 时自行维护 */
      async signature() {
        const r = await call('/writeoffs/signature');
        return r && r.signature;
      },
      async replaceHistory(records) {
        return call('/writeoffs/history', { method: 'PUT', body: JSON.stringify({ records: records || [] }) });
      },
      async listWriteOffs(query = {}) {
        const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined && v !== null));
        return call('/writeoffs?' + qs.toString());
      },
      async getWriteOff(id) { return call(`/writeoffs/${encodeURIComponent(id)}`); },
      async createWriteOff(payload) {
        return call('/writeoffs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': payload.idempotencyKey }, body: JSON.stringify(payload) });
      },
      async reverseWriteOff(id, opts = {}) {
        return call(`/writeoffs/${encodeURIComponent(id)}/reverse`, { method: 'POST', body: JSON.stringify(opts) });
      },
      async arWrittenOff() { return call('/ars/balances'); },
      async getArBalances(arNos) { return call('/ars/balances?arNos=' + encodeURIComponent((arNos || []).join(','))); },
      async closedPeriods() { return call('/periods'); },
      async isPeriodClosed(period) { const r = await call(`/periods/${encodeURIComponent(period)}`); return !!(r && r.closed); },
      async setPeriodClosed() { throw fail(ERR.FORBIDDEN, '关账状态由后端维护，前端不可修改'); },
      async stats() { return call('/writeoffs/stats'); },
    };
  }

  /* =====================================================================
   *  对外 API：自动选择适配器
   * ===================================================================== */
  const api = {
    impl: null,
    kind: '',
    ready: false,
    ERR,
    ERR_TEXT,
    text(code) { return ERR_TEXT[code] || code; },

    async init() {
      if (this.ready) return this;
      const httpBase = global.WRITEOFF_API_BASE;
      if (httpBase) {
        this.impl = createHttpStore(httpBase);
      } else {
        let backend = null;
        if (global.indexedDB) {
          try {
            const idb = createIdbBackend();
            await idb.init();
            backend = idb;
          } catch (e) {
            console.warn('[Store] IndexedDB 不可用，降级：', e && e.message);
          }
        }
        if (!backend) {
          try {
            const probe = '__imp_probe__';
            global.localStorage.setItem(probe, '1');
            global.localStorage.removeItem(probe);
            const ls = createLsBackend(global.localStorage);
            await ls.init();
            backend = ls;
          } catch (e) {
            console.warn('[Store] localStorage 不可用，降级为内存：', e && e.message);
          }
        }
        if (!backend) {
          backend = createMemoryBackend();
          await backend.init();
        }
        this.impl = createLocalStore(backend);
      }
      this.kind = this.impl.kind;
      this.ready = true;
      return this;
    },

    get backendName() { return this.impl ? this.impl.backendName : '未初始化'; },

    listWriteOffs(q) { return this.impl.listWriteOffs(q); },
    getWriteOff(id) { return this.impl.getWriteOff(id); },
    createWriteOff(p) { return this.impl.createWriteOff(p); },
    reverseWriteOff(id, o) { return this.impl.reverseWriteOff(id, o); },
    replaceHistory(recs) { return this.impl.replaceHistory(recs); },
    signature() { return this.impl.signature(); },
    arWrittenOff() { return this.impl.arWrittenOff(); },
    getArBalances(n) { return this.impl.getArBalances(n); },
    closedPeriods() { return this.impl.closedPeriods(); },
    isPeriodClosed(p) { return this.impl.isPeriodClosed(p); },
    setPeriodClosed(p, c) { return this.impl.setPeriodClosed(p, c); },
    stats() { return this.impl.stats(); },
    clearAll() { return this.impl.clearAll(); },
    savePools(p) { return this.impl.savePools(p); },
    loadPools() { return this.impl.loadPools(); },
    isPoolsReady() { return this.impl.isPoolsReady(); },
    setPoolsReady(v) { return this.impl.setPoolsReady(v); },
  };

  global.Store = api;
  global.StoreError = fail;
})(window);
