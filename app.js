/* =====================================================================
 *  发票 XML × 应收单 自动匹配复核 · 原型
 *  匹配复核 + 核销台账（含反核销闭环）
 *  仅前端演示：不生成会计凭证、不回写 ERP
 *  台账存储层见 store.js（Store 契约 = PRD §12.1）
 *  规则与字段口径见 docs/核销台账PRD-v1.0.md
 * ===================================================================== */

/* ---------------- 工具 ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const money = n => r2(n).toFixed(2);
const uid = p => p + Math.random().toString(36).slice(2, 9);
const norm = s => (s || '').replace(/[\s\-_]/g, '').toUpperCase();
const esc = s => String(s === undefined || s === null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 状态 ---------------- */
function seedArs() {
  const raw = [
    ['AR-A1', '北京星辰科技有限公司', '91110108MA01ABCD12', 10000, 'HT2024001', '2026-08-15'],
    ['AR-B1', '上海博远贸易有限公司', '91310115MA1K2EFG34', 5000, 'HT2024B001', '2026-08-20'],
    ['AR-B2', '上海博远贸易有限公司', '91310115MA1K2EFG34', 3000, 'HT2024B002', '2026-08-20'],
    ['AR-C1', '广州华南电子有限公司', '91440101MA5HIJK56', 5000, 'HT2024C001', '2026-08-25'],
    ['AR-D1', '深圳恒通物流有限公司', '91440300MA5LMNO78', 8000, 'HT2024D001', '2026-08-28'],
    ['AR-E1', '杭州联创网络有限公司', '91330106MA2PQRS90', 7000, 'HT2024E001', '2026-08-30'],
    ['AR-E2', '杭州联创网络有限公司', '91330106MA2PQRS90', 5000, 'HT2024E002', '2026-08-30'],
  ];
  return raw.map(([arNo, customer, customerTaxId, amount, contractNo, bizdate]) => ({
    id: uid('ar'), arNo, customer, customerTaxId, amount,
    amountMode: 'excl',
    baseWrittenOff: 0,                    // 台账之外的已核销（来自 ERP/导入的未结算口径）
    writtenOff: 0, remaining: amount, contractNo, status: '未核销',
    source: '示例', bizdate, dueDate: null, org: null,
  }));
}

let state = {
  invoices: [], ars: [],
  writeOffs: [],                          // 台账缓存（只读展示，来源 = Store）
  ledgerStats: null,
  historySource: { records: [], label: '' },   // 外部历史已结算数据源（接口 / 上传文件）
  histSync: { count: 0, total: 0, at: null },  // 台账历史结算快照同步结果
};

async function resetDemo() {
  if (!confirm('重置演示数据：将清空发票、应收单池、核销台账（含已反核销记录）与外部历史数据源，确定继续？')) return;
  await Store.clearAll();
  state.invoices = [];
  state.ars = seedArs();
  state.historySource = { records: [], label: '' };
  histRecordsSave();
  histCfg.externalLabel = '';
  histCfgSave();
  $('#xml-input').value = '';
  const arMsg = $('#ar-import-msg');
  if (arMsg) arMsg.innerHTML = '';
  woQuery.openId = null;
  woQuery.page = 1;
  await persistPools();      /* 重置后的内置示例应收单写回池存储 */
  await syncHistoryLedger(true);
  showMsg('已重置演示数据（应收单池已恢复初始余额，核销台账已清空）', 'ok');
  showWoMsg('');
  renderAll();
}

/* ---------------- 示例发票 ---------------- */
const SAMPLES = {
  A: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000001</发票号码>
  <购买方名称>北京星辰科技有限公司</购买方名称>
  <购买方纳税人识别号>91110108MA01ABCD12</购买方纳税人识别号>
  <金额>10000.00</金额>
  <备注>合同编号:HT2024001</备注>
</Invoice>`,
  B: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000002</发票号码>
  <购买方名称>上海博远贸易有限公司</购买方名称>
  <购买方纳税人识别号>91310115MA1K2EFG34</购买方纳税人识别号>
  <金额>8000.00</金额>
  <备注>合同编号:HT2024B001</备注>
</Invoice>`,
  C: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000003</发票号码>
  <购买方名称>广州华南电子有限公司</购买方名称>
  <购买方纳税人识别号>91440101MA5HIJK56</购买方纳税人识别号>
  <金额>5000.50</金额>
  <备注>合同编号:HT2024C001</备注>
</Invoice>`,
  D1: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000004</发票号码>
  <购买方名称>深圳恒通物流有限公司</购买方名称>
  <购买方纳税人识别号>91440300MA5LMNO78</购买方纳税人识别号>
  <金额>4000.00</金额>
  <备注>合同编号:HT2024D001</备注>
</Invoice>`,
  D2: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000005</发票号码>
  <购买方名称>深圳恒通物流有限公司</购买方名称>
  <购买方纳税人识别号>91440300MA5LMNO78</购买方纳税人识别号>
  <金额>4000.00</金额>
  <备注>合同编号:HT2024D001</备注>
</Invoice>`,
  E1: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000006</发票号码>
  <购买方名称>杭州联创网络有限公司</购买方名称>
  <购买方纳税人识别号>91330106MA2PQRS90</购买方纳税人识别号>
  <金额>6000.00</金额>
  <备注>合同编号:HT2024E001</备注>
</Invoice>`,
  E2: `<Invoice>
  <发票代码>044001900111</发票代码>
  <发票号码>10000007</发票号码>
  <购买方名称>杭州联创网络有限公司</购买方名称>
  <购买方纳税人识别号>91330106MA2PQRS90</购买方纳税人识别号>
  <金额>6000.00</金额>
  <备注>合同编号:HT2024E002</备注>
</Invoice>`,
};

/* ---------------- XML 解析 ----------------
 * 兼容两类来源：
 *  ① 数电票（根节点 <EInvoice>）：SellerInformation / BuyerInformation /
 *     BasicInformation / IssuItemInformation / AdditionalInformation / TaxSupervisionInfo
 *  ② 通用 <Invoice> 平铺结构（如 samples/ 下的示例）
 * 所有取值一律原样保留（含 “-”“·”“（）” 等字符）。
 * ------------------------------------------ */

/* 逻辑字段 → 候选标签名（按优先级；小写后比较） */
const INV_FIELDS = {
  code: ['invoicecode', '发票代码', 'fpdcode'],
  no: ['invoicenumber', 'invoiceno', '发票号码', 'fphm'],
  buyerName: ['buyername', '购买方名称', 'gmfmc'],
  /* ★ 数电票购买方税号字段为 BuyerIdNum */
  buyerTaxId: ['buyeridnum', 'buyertaxno', 'buyertaxid', '购买方纳税人识别号', '购买方税号', 'gmfnsrsbh', 'nsrsbh'],
  sellerName: ['sellername', '销售方名称', 'xfmc'],
  sellerTaxId: ['selleridnum', 'sellertaxno', '销售方纳税人识别号', '销售方税号', 'xfnsrsbh', 'xsfsbh'],
  /* 数电票：BasicInformation/TotalAmWithoutTax 为合计不含税金额，优先于明细行 Amount */
  amountExcl: ['totalamwithouttax', '不含税金额', 'amountexcltax', 'amountwithouttax', '合计金额', 'je', 'hjje', '金额', 'amount'],
  taxAmount: ['totaltaxam', '税额', 'taxamount', 'comtaxam', 'se'],
  amountIncl: ['totaltax-includedamount', 'totaltaxincludedamount', '价税合计'],
  issueDate: ['issuetime', '开票日期', '发票日期', 'invoicedate', 'kprq'],
  remark: ['remark', '备注', 'bz'],
};

function parseXmlDoc(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.querySelector('parsererror')) {
    throw new Error('XML 格式错误');
  }
  return doc;
}

/* 叶子节点 → { 小写标签名: 首个文本值 } */
function flatten(node) {
  const map = {};
  for (const el of node.getElementsByTagName('*')) {
    if (el.children.length) continue;
    const tag = localName(el).toLowerCase();
    const txt = (el.textContent || '').trim();
    if (txt && !(tag in map)) map[tag] = txt;      // 同名取首次出现
  }
  return map;
}

function pick(map, candidates) {
  const keys = Object.keys(map);
  for (const c of candidates) {
    const cl = c.toLowerCase();
    let k = keys.find(k => k === cl);
    if (!k) k = keys.find(k => k.includes(cl) || cl.includes(k));
    if (k) return map[k];
  }
  return null;
}

function localName(el) { return el.localName || el.nodeName || ''; }

/* 找出文档中所有「发票」根节点（取最外层，避免嵌套重复） */
function invoiceRootNodes(doc) {
  const all = [...doc.getElementsByTagName('*')]
    .filter(el => /^(einvoice|invoice|invoicedocument|发票|fp)$/i.test(localName(el)));
  return all.filter(el => !all.some(o => o !== el && o.contains(el)));
}

/* 取子元素文本（按精确标签名，大小写敏感于 XML） */
function elemText(el, name) {
  for (const c of el.getElementsByTagName('*')) if (localName(c) === name) return (c.textContent || '').trim();
  return null;
}

/* 数电票明细行：IssuItemInformation（可多行） */
function collectInvoiceItems(node) {
  const items = [];
  for (const el of node.getElementsByTagName('*')) {
    if (localName(el) !== 'IssuItemInformation') continue;
    items.push({
      name: elemText(el, 'ItemName'),
      qty: elemText(el, 'Quantity'),
      price: elemText(el, 'UnPrice'),
      amount: elemText(el, 'Amount'),
      taxRate: elemText(el, 'TaxRate'),
      taxAmount: elemText(el, 'ComTaxAm'),
      total: elemText(el, 'TotaltaxIncludedAmount'),
      taxCode: elemText(el, 'TaxClassificationCode'),
    });
  }
  return items;
}

function extractContract(remark) {
  if (!remark) return null;
  const m = remark.match(/合同\s*[编号]{0,2}\s*[：:]\s*([A-Za-z0-9\-_·]+)/);
  return m ? m[1].trim() : null;      // 原样保留（含 “-”“·” 等字符）
}

/* 从「发票节点」构造发票记录 */
function readInvoiceNode(node) {
  const map = flatten(node);

  const amount = num(pick(map, INV_FIELDS.amountExcl));
  if (amount === null || amount === undefined) throw new Error('未找到“不含税金额/合计金额”字段');

  const code = pick(map, INV_FIELDS.code) || '-';
  const no = pick(map, INV_FIELDS.no) || '-';
  const remark = pick(map, INV_FIELDS.remark) || '';
  const contractNo = extractContract(remark);
  const taxRaw = num(pick(map, INV_FIELDS.taxAmount));

  return {
    id: uid('inv'), code, no,
    buyerName: pick(map, INV_FIELDS.buyerName) || '（未知购买方）',
    buyerTaxId: pick(map, INV_FIELDS.buyerTaxId) || null,
    sellerName: pick(map, INV_FIELDS.sellerName) || null,
    sellerTaxId: pick(map, INV_FIELDS.sellerTaxId) || null,
    amount: r2(amount),
    taxAmount: taxRaw === null ? null : r2(taxRaw),
    amountIncl: (() => { const v = num(pick(map, INV_FIELDS.amountIncl)); return v === null ? null : r2(v); })(),
    issueDate: pick(map, INV_FIELDS.issueDate) || null,
    items: collectInvoiceItems(node),
    remark, contractNo, contractKey: contractNo ? norm(contractNo) : null,
    status: '待匹配',
  };
}

function parseOneInvoice(xmlText) {
  return readInvoiceNode(parseXmlDoc(xmlText).documentElement);
}

/* 支持一个文件/一段文本里含多张发票（<Invoice> / <EInvoice> 均可） */
function parseInvoices(xmlText) {
  const doc = parseXmlDoc(xmlText);
  const nodes = invoiceRootNodes(doc);
  if (!nodes.length) return [readInvoiceNode(doc.documentElement)];
  return nodes.map(readInvoiceNode);
}

/* ---------------- 导入 ---------------- */
function importText(xmlText) {
  let list;
  try { list = parseInvoices(xmlText); }
  catch (e) { return { ok: false, msg: '解析失败：' + e.message }; }

  const okList = [], blocked = [];
  for (const inv of list) {
    const dup = state.invoices.find(i => i.code === inv.code && i.no === inv.no);
    if (dup) { blocked.push(inv); continue; }
    state.invoices.push(inv);
    okList.push(inv);
  }
  /* 已存在有效核销记录的发票：导入即标记为「已核销」，避免重复核销（台账为准） */
  syncInvoiceStatusFromLedger();
  const parts = [];
  if (okList.length) {
    parts.push(`✅ 成功导入 ${okList.length} 张：` + okList.map(i => `${i.no}(${i.buyerName} ¥${money(i.amount)})`).join('、'));
    void persistPools();   /* 发票池持久化：刷新 / 换机不丢 */
  }
  if (blocked.length) parts.push(`⛔ 拦截 ${blocked.length} 张重复发票（代码+号码已存在，未进入匹配）：` + blocked.map(i => `${i.code}-${i.no}`).join('、'));
  return { ok: okList.length > 0, msg: parts.join('\n') };
}

/* =====================================================================
 *  财务应收单模板导入
 *  模板：数据模板-财务应收单.xlsx（工作表「列表数据」）
 *   第 1 行  中文字段名表头（69 列），第 2 行起为数据行
 *   列顺序可调整、可增删无关列；解析按字段名识别
 *  ★ 所有导入字段一律原样保留（含 “-”“(”“)” 等字符），
 *     不做任何裁剪；匹配用的规范化值单独存放，不覆盖原值。
 * ===================================================================== */

/* 模板列顺序（69 列，与「列表数据」表头一致） */
const AR_TEMPLATE_COLS = [
  '序号', '修改人', '单据类型', '单据状态', '往来户', '单据编号', '单据日期',
  '应收折本币', '金额折本币', '税额', '未结算折本币', '产品线.编码', '产品线.名称', '部门', '备注',
  '修改时间', '凭证号', '合同(编)号', '合同名称', '税率(%)', '结算组织', '创建人', '核销状态',
  '合同号', '备注2', '合同名称', '清算期', '客户分类', '是否确认应付', '可付款申请金额',
  '业务系统三字码', '收付款往来户', '往来类型', '税额(本位币)', '款项用途', '已结算金额',
  '已结算金额(本位币)', '关联开票金额', '未关联开票金额', '关联开票数量', '未关联开票数量',
  '结算状态', '金额', '应收金额', '汇率', 'Billing账期', 'Billing账单编号', '源单类型',
  '项目.项目编码', '项目.项目名称', '项目', '到期日', '结算业务类型', '结算业务', '款项性质',
  '账龄起算日', '结算币', '发票号码', '关联开票金额', '未关联开票金额', '期初', '当前处理人',
  '调整类型', '生成凭证', '归档', '已被冲销', '冲销单据', '备注1.名称', '款项性质.是否金额基准',
];

/* 逻辑字段 → 候选列名（按优先级；末项为兼容旧四段式模板的别名） */
const AR_FIELDS = {
  arNo: ['单据编号'],
  billType: ['单据类型'],
  billStatus: ['单据状态'],
  bizdate: ['单据日期'],
  customer: ['往来户', '往来户.名称', '买方名称'],
  customerCode: ['往来户.编码', 'asstact.number'],
  grossFx: ['应收折本币'],
  amountFx: ['金额折本币'],
  tax: ['税额'],
  taxFx: ['税额(本位币)'],
  unsettledFx: ['未结算折本币'],
  unsettled: ['未结算金额'],
  plCode: ['产品线.编码'],
  plName: ['产品线.名称'],
  dept: ['部门'],
  remark: ['备注'],
  modifyTime: ['修改时间'],
  voucherNo: ['凭证号'],
  contractCode: ['合同(编)号', '合同(编)号.编码'],
  contractName: ['合同名称'],
  taxRate: ['税率(%)', '税率.名称'],
  org: ['结算组织'],
  creator: ['创建人'],
  writeOffStatus: ['核销状态'],
  contractNo: ['合同号'],
  remark2: ['备注2'],
  settlePeriod: ['清算期'],
  customerClass: ['客户分类'],
  custAttrType: ['往来类型'],
  payPurpose: ['款项用途'],
  settledFx: ['已结算金额(本位币)'],
  settled: ['已结算金额'],
  linkedInvFx: ['关联开票金额'],
  unlinkedInvFx: ['未关联开票金额'],
  settleStatus: ['结算状态'],
  amount: ['金额'],
  gross: ['应收金额'],
  exchangeRate: ['汇率'],
  sourceType: ['源单类型'],
  projectCode: ['项目.项目编码'],
  projectName: ['项目.项目名称'],
  project: ['项目'],
  dueDate: ['到期日'],
  settleBizType: ['结算业务类型'],
  settleBiz: ['结算业务'],
  payProperty: ['款项性质', '款项性质.名称'],
  ageStart: ['账龄起算日'],
  currency: ['结算币', '结算币.名称'],
  invoiceNo: ['发票号码'],
  isPeriod: ['期初'],
  handler: ['当前处理人'],
  adjustType: ['调整类型'],
  reversedBy: ['冲销单据'],
  remark1Name: ['备注1.名称'],
  /* 兼容旧四段式模板（数量×单价 / 含税单价） */
  qty: ['数量', 'e_quantity'],
  unitPrice: ['单价', 'e_unitprice'],
  taxUnitPrice: ['含税单价', 'e_taxunitprice'],
};

/* 需要原样保留并展示的全部字段（用于「全部字段」明细） */
const AR_KEEP_ORDER = Object.keys(AR_FIELDS).map(k => AR_FIELDS[k][0]);

/* 表头行识别用的已知列名集合 */
const AR_KNOWN_COLS = new Set(
  Object.values(AR_FIELDS).flat().map(n => String(n).trim().toLowerCase())
);

/* ---------- 数值 / 税率 ---------- */
function num(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim().replace(/[,，\s¥￥]/g, '');
  if (!s) return null;
  let mult = 1;
  if (s.endsWith('万')) { mult = 1e4; s = s.slice(0, -1); }
  else if (s.endsWith('亿')) { mult = 1e8; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return isNaN(n) ? null : n * mult;
}
/* 'V6' / '增值税6%' → 0.06；'0.06' → 0.06 */
function parseTaxRate(v) {
  if (v === undefined || v === null) return null;
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return null;
  return n > 1 ? r2(n) / 100 : n;
}

/* ---------- 极简 XLSX 读取（零依赖：内置 ZIP 解析 + 浏览器原生 DecompressionStream） ---------- */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 DecompressionStream（需 Chrome/Edge 103+）。可先将模板另存为 CSV 再导入');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function openZip(buffer) {
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .xlsx 文件（未找到 ZIP 结构）');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const index = new Map();
  for (let i = 0; i < total && p + 46 <= u8.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nLen = dv.getUint16(p + 28, true);
    const eLen = dv.getUint16(p + 30, true);
    const cLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    index.set(dec.decode(u8.subarray(p + 46, p + 46 + nLen)), { method, size, lho });
    p += 46 + nLen + eLen + cLen;
  }
  return async function read(name) {
    const e = index.get(name);
    if (!e) return null;
    const nLen = dv.getUint16(e.lho + 26, true), eLen = dv.getUint16(e.lho + 28, true);
    const start = e.lho + 30 + nLen + eLen;
    const raw = u8.subarray(start, start + e.size);
    if (e.method === 0) return raw;
    if (e.method === 8) return await inflateRaw(raw);
    throw new Error('不支持的压缩方式（method=' + e.method + '）');
  };
}

const XLSX_NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EXCEL_DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function childTags(el, name) { return [...el.children].filter(c => c.localName === name); }
function xmlParse(text) {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('XML 解析失败');
  return d;
}
function xmlFirst(root, name) {
  const list = root.getElementsByTagName(name);
  if (list && list.length) return list[0];
  for (const el of root.getElementsByTagName('*')) if (el.localName === name) return el;
  return null;
}
function refToCol(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function isDateFmt(id, code) {
  if (EXCEL_DATE_IDS.has(id)) return true;
  if (!code) return false;
  const s = code.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '').replace(/\\./g, '');
  return /[yd]/i.test(s) || /\d\s*:\s*m/i.test(s);
}
function excelSerialToText(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  const p = x => String(x).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return n % 1 === 0 ? date : `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function parseSheetXml(text, shared, xfDate) {
  const doc = xmlParse(text);
  const sd = xmlFirst(doc, 'sheetData') || doc.documentElement;
  const grid = [];
  for (const row of childTags(sd, 'row')) {
    const r = parseInt(row.getAttribute('r'), 10);
    const ri = isNaN(r) ? grid.length : r - 1;
    const cells = [];
    for (const c of childTags(row, 'c')) {
      const ci = refToCol(c.getAttribute('r'));
      const t = c.getAttribute('t');
      let v = null;
      if (t === 'inlineStr') {
        const is = childTags(c, 'is')[0];
        v = is ? [...is.getElementsByTagName('t')].map(x => x.textContent).join('') : '';
      } else if (t === 's') {
        const vEl = childTags(c, 'v')[0];
        v = vEl ? (shared[+vEl.textContent] ?? '') : null;
      } else {
        const vEl = childTags(c, 'v')[0];
        if (vEl) {
          const raw = vEl.textContent;
          if (t === 'str') v = raw;
          else if (t === 'b') v = raw === '1';
          else {
            const n = parseFloat(raw);
            const sIdx = c.getAttribute('s');
            v = (!isNaN(n) && sIdx !== null && xfDate[+sIdx])
              ? excelSerialToText(n)
              : (isNaN(n) ? raw : n);
          }
        }
      }
      if (v !== null && v !== '') cells[ci] = v;
    }
    grid[ri] = cells;
  }
  for (let i = 0; i < grid.length; i++) if (!grid[i]) grid[i] = [];
  return grid;
}

async function readXlsx(buffer) {
  const read = await openZip(buffer);
  const dec = new TextDecoder('utf-8');
  const wbRaw = await read('xl/workbook.xml');
  if (!wbRaw) throw new Error('缺少 xl/workbook.xml，不是标准 Excel(.xlsx) 文件');
  const wb = xmlParse(dec.decode(wbRaw));

  const relMap = new Map();
  const relRaw = await read('xl/_rels/workbook.xml.rels');
  if (relRaw) {
    for (const r of xmlParse(dec.decode(relRaw)).getElementsByTagName('Relationship')) {
      const id = r.getAttribute('Id') || r.getAttribute('id');
      if (id) relMap.set(id, r.getAttribute('Target') || '');
    }
  }

  let shared = [];
  const ssRaw = await read('xl/sharedStrings.xml');
  if (ssRaw) {
    const ss = xmlParse(dec.decode(ssRaw));
    for (const si of ss.getElementsByTagName('si')) {
      shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
    }
  }

  let xfDate = [];
  const stRaw = await read('xl/styles.xml');
  if (stRaw) {
    const st = xmlParse(dec.decode(stRaw));
    const custom = {};
    const nfs = xmlFirst(st, 'numFmts');
    if (nfs) for (const nf of childTags(nfs, 'numFmt')) custom[+nf.getAttribute('numFmtId')] = nf.getAttribute('formatCode') || '';
    const cxs = xmlFirst(st, 'cellXfs');
    if (cxs) xfDate = childTags(cxs, 'xf').map(x => {
      const id = +(x.getAttribute('numFmtId') || 0);
      return isDateFmt(id, custom[id]);
    });
  }

  const sheets = [];
  for (const s of wb.getElementsByTagName('sheet')) {
    const rid = s.getAttribute('r:id') || s.getAttributeNS(XLSX_NS_REL, 'id');
    let target = relMap.get(rid) || '';
    if (!target) continue;
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.+\//, '');
    const raw = await read(target);
    if (!raw) continue;
    sheets.push({ name: s.getAttribute('name') || ('Sheet' + (sheets.length + 1)), rows: parseSheetXml(dec.decode(raw), shared, xfDate) });
  }
  return { sheets };
}

/* ---------- CSV ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------- 表头识别与列索引 ---------- */
function normHead(v) { return String(v === undefined || v === null ? '' : v).trim().replace(/^\*+/, '').toLowerCase(); }

/* 取前 15 行中「命中已知列名最多」的一行作为表头行；要求含 单据编号 或 往来户 */
function detectArHeader(rows) {
  let best = -1, bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    let score = 0;
    for (const v of (rows[i] || [])) if (AR_KNOWN_COLS.has(normHead(v))) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore < 3) return null;
  const cells = (rows[best] || []).map(normHead);
  if (!cells.includes('单据编号') && !cells.includes('往来户')) return null;
  return { headerRow: best, dataStart: best + 1, score: bestScore };
}
function isArSheet(rows) { return !!detectArHeader(rows); }

function buildColIndex(rows, headerRow) {
  const map = new Map();
  const hr = rows[headerRow] || [];
  for (let i = 0; i < hr.length; i++) {
    const k = normHead(hr[i]);
    if (k && !map.has(k)) map.set(k, i);   // 同名列（如两处「合同名称」）取最左列
  }
  return map;
}

/* 取原始值：不做任何裁剪，保留 “-”“(”“)” 等字符 */
function arRaw(row, colMap, key) {
  for (const name of (AR_FIELDS[key] || [])) {
    const i = colMap.get(normHead(name));
    if (i === undefined) continue;
    const v = row[i];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/* 整行原始数据：表头名 → 原样字符串，全部保留 */
function arRawRecord(row, colMap) {
  const rec = {};
  for (const [name, i] of colMap) {
    const v = row[i];
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') rec[name] = s;
  }
  return rec;
}

/* ---------- 客户档案（编码 / 名称 → 统一社会信用代码） ---------- */
const CUST_SHEET_MARKER = '统一社会信用代码';
function isCustomerSheet(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if ((rows[i] || []).some(v => String(v ?? '').trim() === CUST_SHEET_MARKER)) return true;
  }
  return false;
}
function buildCustMap(rows) {
  const map = new Map();
  let hr = -1, codeIdx = -1, nameIdx = -1, taxIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = (rows[i] || []).map(v => String(v ?? '').trim());
    const t = cells.indexOf(CUST_SHEET_MARKER);
    if (t < 0) continue;
    hr = i; taxIdx = t;
    codeIdx = cells.indexOf('编码');
    nameIdx = cells.indexOf('名称');
    break;
  }
  if (hr < 0 || codeIdx < 0 || taxIdx < 0) return map;
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const code = String(r[codeIdx] ?? '').trim().toUpperCase();
    const name = nameIdx >= 0 ? String(r[nameIdx] ?? '').trim() : '';
    const tax = String(r[taxIdx] ?? '').trim();
    if (!tax) continue;
    if (code) map.set('C:' + code, tax);
    if (name && !map.has('N:' + name)) map.set('N:' + name, tax);
  }
  return map;
}

/* ---------- 数据行 → 应收单草稿 ---------- */
/* amountMode: 'excl' 取不含税（金额）| 'incl' 取含税（应收金额） */
function buildArDocs(rows, hdr, colMap, amountMode = 'excl') {
  const docs = [];
  let skipped = 0;
  for (let i = hdr.dataStart; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row.length) continue;
    const g = k => arRaw(row, colMap, k);
    const raw = arRawRecord(row, colMap);
    const billno = g('arNo');
    const customer = g('customer');
    if (!billno && !customer) continue;

    const taxRate = parseTaxRate(g('taxRate'));
    const tax = num(g('tax'));
    const amount = num(g('amount'));            // 金额（不含税）
    const amountFx = num(g('amountFx'));        // 金额折本币
    const gross = num(g('gross'));              // 应收金额（含税）
    const grossFx = num(g('grossFx'));          // 应收折本币
    const qty = num(g('qty'));
    const unitPrice = num(g('unitPrice'));
    const taxUnitPrice = num(g('taxUnitPrice'));

    /* 主金额：按口径取，取不到再按其他字段反算 */
    let main = null, incl = null;
    if (amountMode === 'incl') {
      main = [gross, grossFx, taxUnitPrice !== null ? (qty || 1) * taxUnitPrice : null,
        amount !== null ? amount + (tax || 0) : null].find(v => v !== null && v !== undefined) ?? null;
      incl = main;
    } else {
      main = [amount, amountFx, unitPrice !== null ? (qty || 1) * unitPrice : null,
        taxUnitPrice !== null && taxRate !== null ? (qty || 1) * taxUnitPrice / (1 + taxRate) : null,
        gross !== null && taxRate !== null ? gross / (1 + taxRate) : null,
        taxUnitPrice !== null ? (qty || 1) * taxUnitPrice : null].find(v => v !== null && v !== undefined) ?? null;
      incl = gross !== null ? gross : (tax !== null && main !== null ? r2(main + tax) : main);
    }
    if (main === null || main === 0) { skipped++; continue; }

    /* 已结算 / 未结算口径（历史已结算数据来源）：
       - 「已结算金额(本位币) / 已结算金额」有值 → 直接作为数据源已结算额
       - 「未结算折本币 / 未结算金额」有值 → 剩余余额以它为准，已结算额 = 主金额 − 未结算
       - 两者都无 → 视为全额未核销（已结算 0） */
    const settled = num(g('settledFx')) ?? num(g('settled'));
    const unsettled = num(g('unsettledFx')) ?? num(g('unsettled'));
    const remaining = unsettled !== null ? unsettled : (settled !== null ? r2(main - settled) : main);
    const baseWrittenOff = settled !== null ? settled : r2(main - remaining);

    const contractNo = g('contractNo') || g('contractCode') || null;   // 原样保留，含 “-”
    docs.push({
      billno, customer,
      customerCode: g('customerCode'),
      contractNo,                                                       // 原值（展示用）
      contractName: g('contractName'),
      bizdate: g('bizdate'), dueDate: g('dueDate'),
      billType: g('billType'), billStatus: g('billStatus'),
      org: g('org'), dept: g('dept'), currency: g('currency'),
      plCode: g('plCode'), plName: g('plName'),
      purpose: g('payPurpose'), payProperty: g('payProperty'),
      writeOffStatus: g('writeOffStatus'), settleStatus: g('settleStatus'),
      sourceType: g('sourceType'), projectName: g('projectName'),
      remark: g('remark'), remark2: g('remark2'),
      creator: g('creator'), modifyTime: g('modifyTime'), voucherNo: g('voucherNo'),
      ageStart: g('ageStart'), isPeriod: g('isPeriod'), handler: g('handler'),
      invoiceNo: g('invoiceNo'), taxRate, tax,
      amount: main, incl, remaining,
      baseWrittenOff,                                                   // 数据源已结算额（历史已结算）
      raw,                                                              // 全部字段原样保留
    });
  }
  return { docs, skipped };
}

/* ---------- 模板 CSV 生成（供「下载模板 / 内置示例」复用） ---------- */
const AR_SAMPLE_CUSTOMERS = [
  ['QTAR-000001', '北京星辰科技有限公司', '91110108MA01ABCD12'],
  ['QTAR-000002', '上海博远贸易有限公司', '91310115MA1K2EFG34'],
  ['QTAR-000003', '广州华南电子有限公司', '91440101MA5HIJK56'],
  ['QTAR-000004', '深圳恒通物流有限公司', '91440300MA5LMNO78'],
  ['QTAR-000005', '杭州联创网络有限公司', '91330106MA2PQRS90'],
  ['QTAR-000006', '天津远洋物流有限公司', '91120116MA0XYZ1234'],
];

/* 内置示例：键名与「列表数据」表头一致，未列出的列留空 */
function arSampleRow(billno, customer, amount, rate, contractNo, name, date, due, remark) {
  const tax = r2(amount * rate / 100);
  return {
    '单据类型': '主营业务应收', '单据状态': '已审核', '往来户': customer, '单据编号': billno,
    '单据日期': date, '金额': amount.toFixed(2), '税额': tax.toFixed(2),
    '应收金额': r2(amount + tax).toFixed(2), '税率(%)': String(rate),
    '合同号': contractNo, '合同(编)号': contractNo, '合同名称': name,
    '到期日': due, '结算组织': '中航信移动科技有限公司', '产品线.编码': 'L14-011-YD-23',
    '产品线.名称': '主营业务收入', '部门': '不分部门', '款项用途': '服务费',
    '款项性质': '应收账款', '结算币': '人民币', '汇率': '1',
    '核销状态': '未核销', '结算状态': '未结算', '往来类型': '客户',
    '源单类型': '财务应收单', '账龄起算日': date, '创建人': '演示用户', '修改人': '演示用户',
    '备注': remark,
  };
}
/* 历史已结算示例行：数据源中「已结算金额 / 未结算折本币 / 核销状态」有值的应收单。
   导入后会自动同步为台账的「历史结算」快照行（应收单池「已核销」同步体现） */
function arSettledSampleRow(billno, customer, amount, rate, contractNo, name, date, due, remark,
                            settled, settleDate, settleNo) {
  const row = arSampleRow(billno, customer, amount, rate, contractNo, name, date, due, remark);
  const unsettled = r2(amount - settled);
  row['已结算金额'] = settled.toFixed(2);
  row['已结算金额(本位币)'] = settled.toFixed(2);
  row['未结算折本币'] = unsettled.toFixed(2);
  row['核销状态'] = unsettled <= 0.001 ? '已核销' : '部分核销';
  row['结算状态'] = unsettled <= 0.001 ? '已结算' : '部分结算';
  row['修改时间'] = settleDate;
  row['凭证号'] = settleNo;
  return row;
}

const AR_SAMPLE_DOCS = [
  arSampleRow('AR-A1', '北京星辰科技有限公司', 10000, 6, 'HT2024001', '星辰科技技术服务协议', '2026-08-15', '2026-09-14', '场景A 单对单·高置信'),  arSampleRow('AR-B1', '上海博远贸易有限公司', 5000, 6, 'HT2024B001', '博远贸易服务协议（一）', '2026-08-20', '2026-09-19', '场景B 一对多·合并开票 1/2'),
  arSampleRow('AR-B2', '上海博远贸易有限公司', 3000, 6, 'HT2024B002', '博远贸易服务协议（二）', '2026-08-20', '2026-09-19', '场景B 一对多·合并开票 2/2'),
  arSampleRow('AR-C1', '广州华南电子有限公司', 5000, 6, 'HT2024C001', '华南电子技术服务协议', '2026-08-25', '2026-09-24', '场景C 金额容差·中置信'),
  arSampleRow('AR-D1', '深圳恒通物流有限公司', 8000, 6, 'HT2024D001', '恒通物流运输服务协议', '2026-08-28', '2026-09-27', '场景D 多对一·拆分收款'),
  arSampleRow('AR-E1', '杭州联创网络有限公司', 7000, 6, 'HT2024E001', '联创网络服务协议（一）', '2026-08-30', '2026-09-29', '场景E 多对多·候选1'),
  arSampleRow('AR-E2', '杭州联创网络有限公司', 5000, 6, 'HT2024E002', '联创网络服务协议（二）', '2026-08-30', '2026-09-29', '场景E 多对多·候选2'),
  /* 含 “-” 的合同号示例：原样保留，不做任何裁剪 */
  arSampleRow('AR-L14-20260131-198704', '中免（海南）智慧零售科技有限公司', -37400.75, 6, '24-TSM348S228-CP189', '线上平台业务合作协议(中免（海南）智慧零售科技有限公司)', '2026-01-31', '2026-01-31', '冲销-AR-L14-20251231-196805'),
  /* 历史已结算（数据源口径）：导入后自动同步为台账「历史结算」行 */
  arSettledSampleRow('AR-H1', '天津远洋物流有限公司', 12000, 6, 'HT2024H001', '远洋物流运输服务框架协议', '2026-05-10', '2026-06-09', '历史已结算 部分核销（数据源已结算 5000）', 5000, '2026-06-20', 'PZ-20260620-0007'),
  arSettledSampleRow('AR-H2', '天津远洋物流有限公司', 8000, 6, 'HT2024H002', '远洋物流仓储服务协议', '2026-05-18', '2026-06-17', '历史已结算 已核销（数据源已结算 8000）', 8000, '2026-07-05', 'PZ-20260705-0012'),
];

function arTemplateCsv(docs = []) {
  const idx = new Map();
  AR_TEMPLATE_COLS.forEach((name, i) => { if (!idx.has(name)) idx.set(name, i); });
  const blank = () => new Array(AR_TEMPLATE_COLS.length).fill('');
  const rows = [AR_TEMPLATE_COLS.slice()];
  for (const d of docs) {
    const r = blank();
    for (const k of Object.keys(d)) {
      const i = idx.get(k);
      if (i === undefined) continue;
      const v = d[k];
      if (v !== undefined && v !== null && v !== '') r[i] = v;
    }
    rows.push(r);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
}

/* ---------- 导入主流程 ---------- */
async function applyArImport(sources, custSources) {
  if (!sources.length) {
    return {
      ok: false,
      msg: '未找到「财务应收单」模板表。\n请确认表头行含「单据编号」与「往来户」列（如《数据模板-财务应收单.xlsx》的「列表数据」表），\n或点击「下载导入模板」后按模板填写。',
    };
  }
  const custMap = new Map();
  let custCount = 0;
  for (const c of custSources) {
    const m = buildCustMap(c.rows);
    custCount += [...m.keys()].filter(k => k.startsWith('C:')).length;
    for (const [k, v] of m) if (!custMap.has(k)) custMap.set(k, v);
  }

  const clearFirst = !!($('#ar-clear-first') && $('#ar-clear-first').checked);
  const amountMode = ($('#ar-amount-mode') && $('#ar-amount-mode').value) || 'excl';
  if (clearFirst) state.ars = [];

  const added = [], dup = [], noTax = [], noContract = [], negative = [];
  const sheetLog = [];
  let seq = 1, skippedRows = 0;

  for (const src of sources) {
    const hdr = detectArHeader(src.rows);
    if (!hdr) continue;
    const colMap = buildColIndex(src.rows, hdr.headerRow);
    const { docs, skipped } = buildArDocs(src.rows, hdr, colMap, amountMode);
    skippedRows += skipped;
    sheetLog.push(`${src.label}：${docs.length} 张`);

    for (const d of docs) {
      const arNo = d.billno || `AR-IMP-${String(seq).padStart(4, '0')}`;
      seq++;
      if (state.ars.some(a => a.arNo === arNo)) { dup.push(arNo); continue; }

      const custTaxId = d.customerCode
        ? (custMap.get('C:' + String(d.customerCode).toUpperCase()) || null) : null;
      const taxId = custTaxId || (d.customer ? (custMap.get('N:' + d.customer) || null) : null);

      /* 合同号原样保留（含 “-”）；另存规范化值仅供匹配比较，不覆盖原值 */
      const contractNo = d.contractNo || null;
      const contractKey = contractNo ? norm(contractNo) : null;

      const amount = r2(d.amount);
      const remaining = r2(d.remaining);
      const baseWrittenOff = r2(d.baseWrittenOff);
      const ar = {
        id: uid('ar'), arNo,
        customer: d.customer || '（未知客户）',
        customerCode: d.customerCode || null,
        customerTaxId: taxId,
        amount,
        amountMode,
        baseWrittenOff,                            // 数据源已结算额（ERP 口径，台账之外）
        writtenOff: baseWrittenOff,
        remaining,
        contractNo, contractKey, status: '未核销',
        source: '模板导入',
        billType: d.billType || null, billStatus: d.billStatus || null,
        bizdate: d.bizdate || null, dueDate: d.dueDate || null,
        currency: d.currency || null, org: d.org || null,
        plCode: d.plCode || null, plName: d.plName || null,
        purpose: d.purpose || null, payProperty: d.payProperty || null,
        settleStatus: d.settleStatus || null, writeOffStatus: d.writeOffStatus || null,
        taxRate: d.taxRate, tax: d.tax,
        amountIncl: r2(d.incl), remark: d.remark || null,
        raw: d.raw,                       // 全部字段原样保留
      };
      if (!taxId) noTax.push(arNo);
      if (!contractNo) noContract.push(arNo);
      if (amount < 0) negative.push(arNo);
      state.ars.push(ar);
      added.push(ar);
    }
  }

  const sum = r2(added.reduce((s, a) => s + a.remaining, 0));
  const parts = [];
  if (custSources.length) {
    parts.push(`📇 客户档案：${custSources.map(c => c.label).join('、')}（有效税号 ${custCount} 条）`);
  }
  if (added.length) {
    const modeLabel = amountMode === 'incl' ? '含税（应收金额）' : '不含税（金额）';
    parts.push(`✅ 导入应收单 ${added.length} 张，剩余余额合计 ¥${money(sum)}${clearFirst ? '（已清空原应收单池）' : ''}`);
    parts.push(`　来源：${sheetLog.join('；')}`);
    parts.push(`　金额口径：${modeLabel}；全部字段原样保留（含 “-” 等字符，未做裁剪）`);
    parts.push(`　税号补全：${added.length - noTax.length} 张成功${noTax.length ? `，${noTax.length} 张未匹配到客户档案（降级为合同号+金额匹配）` : ''}`);
    if (noContract.length) parts.push(`　无合同号：${noContract.length} 张（降级为税号+金额匹配）`);
    if (negative.length) parts.push(`　红字/冲销（金额为负）：${negative.length} 张，不参与自动匹配`);
  }
  if (dup.length) parts.push(`⛔ 跳过 ${dup.length} 张：单据编号已存在（${dup.slice(0, 5).join('、')}${dup.length > 5 ? ' …' : ''}）`);
  if (skippedRows) parts.push(`⚠️ 另有 ${skippedRows} 行未导入：金额为空或为 0`);
  if (!added.length && !dup.length) parts.push('⚠️ 未解析出有效数据行（需「单据编号」或「往来户」+ 有效金额）。');

  /* 数据源（应收单池）已变 → 同步刷新台账中的「历史已结算」快照行 */
  const hist = await syncHistoryLedger(true);
  if (hist && hist.count) {
    parts.push(`📜 历史已结算：${hist.count} 张应收单已同步至核销台账（合计 ¥${money(hist.total)}，类型「历史结算」）`);
  }

  if (added.length) void persistPools();   /* 应收单池持久化（含 raw 原始字段与数据源已结算口径） */
  renderAll();
  return { ok: added.length > 0, msg: parts.join('\n') };
}

async function importArFiles(files) {
  const sources = [], custSources = [];
  for (const f of files) {
    const name = f.name || '';
    if (/\.xlsx$/i.test(name)) {
      const wb = await readXlsx(await f.arrayBuffer());
      for (const sh of wb.sheets) {
        if (!sh.rows.length) continue;
        const label = `${name} › ${sh.name}`;
        if (isArSheet(sh.rows)) sources.push({ label, rows: sh.rows });
        else if (isCustomerSheet(sh.rows)) custSources.push({ label, rows: sh.rows });
      }
    } else if (/\.csv$/i.test(name) || /\.txt$/i.test(name) || /^text\//.test(f.type || '')) {
      const rows = parseCsv(await f.text());
      if (isArSheet(rows)) sources.push({ label: name, rows });
      else if (isCustomerSheet(rows)) custSources.push({ label: name, rows });
    } else if (/\.xls$/i.test(name)) {
      throw new Error(`【${name}】是老版 .xls 格式，请另存为 .xlsx 或 CSV 后再导入`);
    } else {
      throw new Error(`【${name}】不支持的文件类型，请上传 .xlsx 或 .csv`);
    }
  }
  return applyArImport(sources, custSources);
}

function downloadArTemplate() {
  const csv = arTemplateCsv(AR_SAMPLE_DOCS);
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '应收单导入模板_示例.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---------------- 组合搜索（子集和，金额均为正） ---------------- */
function findCombos(pool, target, tol, maxSize = 4) {
  const res = [];
  const n = pool.length;
  const vals = pool.map(p => p.val);
  function dfs(start, chosen, sum) {
    if (chosen.length && Math.abs(sum - target) <= tol) { res.push([...chosen]); }
    if (chosen.length >= maxSize) return;
    for (let i = start; i < n; i++) {
      const ns = sum + vals[i];
      if (ns - target > tol) continue;   // 剪枝
      chosen.push(i);
      dfs(i + 1, chosen, ns);
      chosen.pop();
    }
  }
  dfs(0, [], 0);
  res.sort((a, b) => a.length - b.length || Math.abs(a.reduce((s, i) => s + vals[i], 0) - target) - Math.abs(b.reduce((s, i) => s + vals[i], 0) - target));
  return res.slice(0, 3);   // 最多展示 3 个候选组合
}

/* ---------------- 匹配引擎 ---------------- */
/* 合同号比较键：原值原样保留，仅在比较时做规范化（去空格/连字符并大写） */
const invContractKey = inv => inv.contractKey || (inv.contractNo ? norm(inv.contractNo) : null);
const arContractKey = a => a.contractKey || (a.contractNo ? norm(a.contractNo) : null);

function computeMatches() {
  const TOL_HIGH = 0.01, TOL_MAX = 1;
  const invs = state.invoices.filter(i => i.status !== '已核销' && i.status !== '异常');
  const ars = state.ars.filter(a => a.remaining > 0.001);
  const invUsed = new Set(), arUsed = new Set();
  const groups = [];

  /* --- ① 单对单 --- */
  for (const inv of invs) {
    if (invUsed.has(inv.id)) continue;
    let best = null;
    for (const a of ars) {
      if (arUsed.has(a.id)) continue;
      const taxMatch = !!(inv.buyerTaxId && a.customerTaxId && inv.buyerTaxId === a.customerTaxId);
      const ick = invContractKey(inv), ack = arContractKey(a);
      const contractMatch = !!(ick && ack && ick === ack);
      const diff = Math.abs(inv.amount - a.remaining);
      if (diff > TOL_MAX) continue;
      if (!taxMatch && !contractMatch) continue;
      const score = (taxMatch ? 2 : 0) + (contractMatch ? 1 : 0) + (diff <= TOL_HIGH ? 1 : 0) + (1 - Math.min(diff, 1));
      if (!best || score > best.score) best = { a, taxMatch, contractMatch, diff, score };
    }
    if (best) {
      const tier = (best.taxMatch && best.diff <= TOL_HIGH) ? 'high' : 'mid';
      groups.push({
        id: 'g-s-' + inv.id + '-' + best.a.id, kind: 'single', tier,
        invoices: [inv], ars: [best.a], diff: r2(inv.amount - best.a.remaining),
        note: tier === 'high'
          ? '税号一致且金额差额 ≤ 0.01 元，自动预绑定'
          : (best.taxMatch ? '税号一致但金额差额 0.01~1 元，降级中置信' : '税号缺失/不匹配，合同号+金额匹配，降级中置信'),
      });
      invUsed.add(inv.id); arUsed.add(best.a.id);
    }
  }

  /* --- ② 一对多（合并开票）：1 发票 = 多应收单 --- */
  for (const inv of invs) {
    if (invUsed.has(inv.id)) continue;
    const pool = ars.filter(a => !arUsed.has(a.id) && inv.buyerTaxId && a.customerTaxId === inv.buyerTaxId)
      .map(a => ({ a, val: a.remaining }));
    if (!pool.length) continue;
    const combos = findCombos(pool, inv.amount, TOL_MAX, 4);
    if (combos.length) {
      const pickSet = combos[0].map(i => pool[i].a);
      const sum = r2(pickSet.reduce((s, a) => s + a.remaining, 0));
      groups.push({
        id: 'g-o-' + inv.id + '-' + pickSet.map(a => a.id).join('_'), kind: 'combo1n', tier: sum - inv.amount === 0 ? 'high' : 'mid',
        invoices: [inv], ars: pickSet, diff: r2(inv.amount - sum),
        note: `自动推荐组合：1 张发票 ↔ ${pickSet.length} 张应收单，合计 ¥${money(sum)}`,
      });
      invUsed.add(inv.id); pickSet.forEach(a => arUsed.add(a.id));
    }
  }

  /* --- ③ 多对一（拆分收款）：多发票 = 1 应收单 --- */
  for (const a of ars) {
    if (arUsed.has(a.id)) continue;
    const pool = invs.filter(i => !invUsed.has(i.id) && i.buyerTaxId && a.customerTaxId === i.buyerTaxId)
      .map(i => ({ inv: i, val: i.amount }));
    if (!pool.length) continue;
    const combos = findCombos(pool, a.remaining, TOL_MAX, 4);
    if (combos.length) {
      const pickSet = combos[0].map(i => pool[i].inv);
      const sum = r2(pickSet.reduce((s, i) => s + i.amount, 0));
      groups.push({
        id: 'g-m-' + a.id + '-' + pickSet.map(i => i.id).join('_'), kind: 'combon1', tier: sum - a.remaining === 0 ? 'high' : 'mid',
        invoices: pickSet, ars: [a], diff: r2(sum - a.remaining),
        note: `自动推荐组合：${pickSet.length} 张发票 ↔ 1 张应收单，合计 ¥${money(sum)}`,
      });
      pickSet.forEach(i => invUsed.add(i.id)); arUsed.add(a.id);
    }
  }

  /* --- ④ 未匹配（含多对多候选列表） --- */
  const unmatched = [];
  for (const inv of invs) {
    if (invUsed.has(inv.id)) continue;
    const cands = ars.filter(a => !arUsed.has(a.id) &&
      ((inv.buyerTaxId && a.customerTaxId === inv.buyerTaxId) ||
        (invContractKey(inv) && arContractKey(a) && invContractKey(inv) === arContractKey(a))));
    unmatched.push({ inv, cands });
  }

  return { groups, unmatched };
}

/* =====================================================================
 *  核销台账（含反核销闭环）
 *  - 台账只追加：纠错走反核销，禁止修改/删除历史记录
 *  - 配分明细：发票 × 应收单 逐行配对（pairKey = invoiceId:arId）
 *  - 余额与状态由台账中「有效记录」重算，不依赖前端缓存
 *  规则见 docs/核销台账PRD-v1.0.md
 * ===================================================================== */

/* 反核销原因码（PRD 附录 B） */
const WO_REASONS = {
  WRONG_AR: '应收单选错',
  WRONG_INVOICE: '发票选错',
  AMOUNT_ERROR: '金额错误',
  DUP_ENTRY: '重复录入',
  OTHER: '其他',
};
const woEntryText = t => ({ WRITE_OFF: '核销', REVERSE: '反核销', RED_REVERSE: '红冲', HISTORY: '历史结算' }[t] || t);
const woStatusText = s => ({ VALID: '有效', REVERSED: '已反核销', RED_REVERSED: '已冲销' }[s] || s);

/* ③ 页查询条件（筛选 + 分页 + 展开行） */
const woQuery = { kw: '', status: '', entryType: '', method: '', from: '', to: '', page: 1, size: 10, openId: null };

const todayISO = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const amountModeNow = () => ($('#ar-amount-mode') && $('#ar-amount-mode').value) || 'excl';
const errText = e => {
  const t = e && e.code ? Store.text(e.code) : '';
  const msg = (e && e.message) || String(e);
  return t && msg && msg !== t ? `${t}：${msg}` : (t || msg);
};

function showWoMsg(text, type = 'ok') {
  const box = $('#wo-msg');
  if (!box) return;
  if (!text) { box.innerHTML = ''; return; }
  box.innerHTML = text.split('\n')
    .map(t => `<div class="m ${type === 'ok' ? 'ok' : 'err'}">${t}</div>`).join('');
}

/* ---------------- 配分算法（PRD §10：组合优先 + 顺序抵充 + 尾差归位） ---------------- */
function allocatePairs(invoices, ars) {
  /* 固定抵充顺序：发票按金额降序，应收单按到期日（无到期日取单据日期）升序，保证可复现 */
  const invList = invoices.slice().sort((a, b) => b.amount - a.amount || String(a.no).localeCompare(String(b.no)));
  const arList = ars.slice().sort((a, b) =>
    String(a.dueDate || a.bizdate || '').localeCompare(String(b.dueDate || b.bizdate || '')) || b.remaining - a.remaining);

  const cap = new Map(arList.map(a => [a.id, r2(a.remaining)]));
  const total = r2(Math.min(
    r2(invoices.reduce((s, i) => s + i.amount, 0)),
    r2(ars.reduce((s, a) => s + a.remaining, 0))));
  const pairs = [];
  let left = total;

  for (const inv of invList) {
    let need = Math.min(r2(inv.amount), left);
    for (const a of arList) {
      if (need <= 0.0001) break;
      const avail = cap.get(a.id);
      if (avail <= 0.0001) continue;
      const w = r2(Math.min(avail, need));
      if (w <= 0.0001) continue;
      pairs.push({
        lineNo: pairs.length + 1,
        invoiceId: inv.id, invoiceCode: inv.code, invoiceNo: inv.no,
        arId: a.id, arNo: a.arNo, arAmount: r2(a.amount),
        arRemainingBefore: r2(avail), writeAmount: w, arRemainingAfter: r2(avail - w),
        contractNo: a.contractNo || inv.contractNo || null,
      });
      cap.set(a.id, r2(avail - w));
      need = r2(need - w);
      left = r2(left - w);
    }
  }

  /* BR-11 尾差归位：±0.01 累积差归入核销前余额最大的一行，保证 Σ明细 = 核销总额 */
  const sum = r2(pairs.reduce((s, p) => s + p.writeAmount, 0));
  const tail = r2(total - sum);
  if (tail !== 0 && pairs.length) {
    let idx = 0;
    pairs.forEach((p, i) => { if (p.arRemainingBefore > pairs[idx].arRemainingBefore) idx = i; });
    pairs[idx].writeAmount = r2(pairs[idx].writeAmount + tail);
    pairs[idx].arRemainingAfter = r2(pairs[idx].arRemainingBefore - pairs[idx].writeAmount);
  }
  return { pairs, total };
}

/* ---------------- 构造台账记录（纯函数：构造与入库分离） ---------------- */
function buildWriteOffRecord(group, method) {
  const { pairs, total } = allocatePairs(group.invoices, group.ars);
  const invoiceTotal = r2(group.invoices.reduce((s, i) => s + i.amount, 0));
  const firstInv = group.invoices[0] || {};
  const firstAr = group.ars[0] || {};
  return {
    idempotencyKey: uid('idem-'),
    method,
    amountMode: amountModeNow(),                 // 口径随记录固化，台账内不混用
    invoiceTotal,
    writeOffTotal: total,
    diff: r2(invoiceTotal - total),
    customerName: firstInv.buyerName || firstAr.customer || null,
    customerTaxId: firstInv.buyerTaxId || firstAr.customerTaxId || null,
    contractNo: firstInv.contractNo || firstAr.contractNo || null,
    orgId: firstAr.org || null,
    bizDate: todayISO(),                         // 业务日期（会计期间归属），独立于操作时间
    operatorId: '当前用户',
    invoices: group.invoices.map(i => ({
      id: i.id, code: i.code, no: i.no, amount: r2(i.amount),
      buyerName: i.buyerName, buyerTaxId: i.buyerTaxId, contractNo: i.contractNo,
    })),
    ars: group.ars.map(a => ({
      arId: a.id, arNo: a.arNo, customer: a.customer, amount: r2(a.amount), contractNo: a.contractNo,
    })),
    pairs,
  };
}

/* ---------------- 生成核销台账（入库二次校验 + 状态回写） ---------------- */
async function confirmGroup(group, method) {
  const payload = buildWriteOffRecord(group, method);
  if (!payload.pairs.length) { alert('没有可核销的金额（发票或应收单金额为 0）'); return; }
  try {
    const res = await Store.createWriteOff(payload);
    await refreshLedger();
    void persistPools();
    showWoMsg(`✅ ${res.replayed ? '幂等命中，返回原记录' : '已生成核销台账'}：批次 ${res.header.batchNo} · ${res.header.method} · 明细 ${res.details.length} 行 · 核销 ¥${money(res.header.writeOffTotal)} · 差额 ¥${money(res.header.diff)}${res.replayed ? '' : '（可在 ③ 核销台账 查看/反核销）'}`, 'ok');
    renderAll();
  } catch (e) {
    showWoMsg('⛔ ' + errText(e), 'err');
    alert('核销失败：' + errText(e));
  }
}

/* 人工圈选 / 手动关联 */
function manualAssociate(inv, arIds, method = '人工圈选') {
  const ars = state.ars.filter(a => arIds.includes(a.id));
  if (!ars.length) { alert('请先选择要关联的应收单'); return; }
  return confirmGroup({ invoices: [inv], ars }, method);
}

/* 批量一键确认全部高置信匹配（规则页承诺的「一键/批量确认」）
   每确认一组后重新计算匹配（余额 / 发票状态已变），行为与逐组点击完全一致，
   入库仍逐笔走 Store 二次校验（发票唯一性、AR 余额、幂等），任一笔失败即中止。 */
let batchConfirming = false;
async function confirmAllHigh() {
  if (batchConfirming) return;
  batchConfirming = true;
  let done = 0, lastBatch = null, failMsg = '';
  try {
    for (let i = 0; i < 100; i++) {
      const { groups } = computeMatches();
      const g = groups.find(x => x.tier === 'high');
      if (!g) break;
      const payload = buildWriteOffRecord(g, g.kind === 'single' ? '自动高置信' : '自动推荐');
      if (!payload.pairs.length) break;
      try {
        const res = await Store.createWriteOff(payload);
        if (res.replayed) break;
        /* 每组入库后立即按台账重算发票状态与 AR 余额，再计算下一组，
           否则下一轮仍会匹配到刚核销的发票 / 应收单（与逐组点击 confirmGroup 行为一致） */
        await refreshLedger();
        lastBatch = res.header.batchNo;
        done++;
      } catch (e) { failMsg = errText(e); break; }
    }
    if (done) void persistPools();
    renderAll();
    if (done && failMsg) {
      showWoMsg(`⚠️ 已批量确认 ${done} 个高置信匹配（末批次 ${lastBatch}），随后中断：${failMsg}`, 'err');
    } else if (done) {
      showWoMsg(`✅ 已批量确认 ${done} 个高置信匹配，末批次 ${lastBatch}，台账已逐笔写入（含配分明细），可在 ③ 核销台账查看或反核销`, 'ok');
    } else if (failMsg) {
      showWoMsg('⛔ 批量确认中断：' + failMsg, 'err');
    } else {
      showWoMsg('当前没有可批量确认的高置信匹配（差额 ≤ 0.01 元的单对单 / 差额为 0 的推荐组合）', 'ok');
    }
  } finally {
    batchConfirming = false;
  }
}

/* ---------------- 反核销（PRD §11：无审批，原因码 + 留痕） ---------------- */
let pendingReverse = null;

function openReverseModal(id) {
  const w = state.writeOffs.find(x => x.writeOffId === id);
  if (!w) return;
  if (w.status !== 'VALID' || w.entryType !== 'WRITE_OFF') {
    showWoMsg('⛔ ' + Store.text('ALREADY_REVERSED'), 'err');
    return;
  }
  pendingReverse = w;
  $('#wo-modal-title').textContent = `反核销 · 批次 ${w.batchNo}`;
  $('#wo-modal-body').innerHTML = `
    <div>将生成<b>反向记录</b>（金额取负、<code>refBatchNo</code> 指向原批次），原记录置为「已反核销」，
    并回滚下列应收单余额、把发票置回「待匹配」重新参与匹配：</div>
    <ul>${(w.ars || []).map(a => `<li>${esc(a.arNo)} · ${esc(a.customer || '')} · 原金额 ¥${money(a.amount)}</li>`).join('')}</ul>
    <div class="note">本次核销 ¥${money(w.writeOffTotal)} · 业务日期 ${esc(w.bizDate)} · 会计期间 ${esc(w.period)}</div>`;
  $('#wo-reason-code').value = 'WRONG_AR';
  $('#wo-reason-text').value = '';
  $('#wo-modal').hidden = false;
}

function closeReverseModal() {
  const modal = $('#wo-modal');
  if (modal) modal.hidden = true;
  pendingReverse = null;
}

async function doReverse() {
  if (!pendingReverse) return;
  const id = pendingReverse.writeOffId;
  const reasonCode = $('#wo-reason-code').value;
  const reason = $('#wo-reason-text').value.trim();
  $('#wo-modal-ok').disabled = true;
  try {
    const res = await Store.reverseWriteOff(id, {
      reasonCode, reason, idempotencyKey: uid('idem-'), operatorId: '当前用户',
    });
    closeReverseModal();
    await refreshLedger();
    void persistPools();
    showWoMsg(`↩️ 已反核销：原批次 ${res.original.batchNo} → 反向记录 ${res.header.batchNo}（${WO_REASONS[reasonCode] || reasonCode}）· 余额已回滚，发票已回到「待匹配」`, 'ok');
    renderAll();
  } catch (e) {
    closeReverseModal();
    showWoMsg('⛔ ' + errText(e), 'err');
    alert('反核销失败：' + errText(e));
  } finally {
    $('#wo-modal-ok').disabled = false;
  }
}

/* ---------------- 台账缓存刷新：余额与状态由「有效记录」重算 ---------------- */
async function refreshLedger() {
  const { rows } = await Store.listWriteOffs({ size: 0 });
  state.writeOffs = rows;
  state.ledgerStats = await Store.stats();

  /* 发票状态：出现在有效「核销」记录中 = 已核销；反核销后自动回到「待匹配」 */
  syncInvoiceStatusFromLedger();

  await refreshArBalances();

  /* 记录本次快照指纹与刷新时间，供「自动刷新」判断台账是否已变化 */
  lastLedgerSig = await Store.signature();
  lastRefreshAt = new Date();
}

/* =====================================================================
 *  历史已结算数据同步（数据源 → 核销台账）
 *  数据源：
 *    ① 应收单池：模板导入的「已结算金额 / 未结算金额 / 核销状态」
 *    ② 外部接口：JSON 接口地址，可按间隔定时拉取
 *    ③ 上传文件：JSON / CSV，一次性导入后作为快照数据源
 *  三类记录按「应收单号」去重（外部数据源优先）后整体刷新台账中的 HISTORY 快照行；
 *  该类型行不占用应收单余额、不参与反核销，随数据源变化自动更新，
 *  等价于「网页端查数据库」式的实时台账视图。
 * ===================================================================== */
const HIST_CFG_KEY = 'imp.history.cfg';
const HIST_REC_KEY = 'imp.history.records';

/* 外部数据源的字段别名（兼容中文表头 / 英文键名）
   注意：别名字典同时覆盖「已归一化的记录字段名」，使转换具备幂等性
   （数据源记录可能已归一化后存入本机缓存，再次同步时不得丢失字段） */
const HIST_FIELDS = {
  arNo: ['应收单号', '单据编号', '单号', 'arNo', 'ar_no', 'arNumber', 'billno'],
  customer: ['客户', '往来户', '客户名称', 'customer', 'customerName'],
  customerTaxId: ['客户税号', '税号', '统一社会信用代码', 'customerTaxId', 'taxId'],
  contractNo: ['合同编号', '合同号', 'contractNo', 'contract'],
  arAmount: ['应收金额', '应收单原金额', '单据金额', 'arAmount'],
  settledAmount: ['已结算金额', '已核销金额', '结算金额', '核销金额', '历史已结算金额', 'settledAmount', 'settled', 'amount'],
  bizDate: ['结算日期', '已结算日期', '业务日期', '结算时间', 'settleDate', 'bizDate', 'date'],
  settleRef: ['结算单号', '凭证号', '清算期', '流水号', 'settleRef', 'ref', 'voucherNo'],
  statusText: ['核销状态', '结算状态', 'status', 'statusText'],
  remark: ['备注', '说明', 'remark', 'note'],
};

const HIST_CFG_DEFAULT = { poolSync: true, url: '', autoPoll: false, pollSec: 30, refreshSec: 10 };

/* 运行期状态：配置 / 定时器 / 台账变更指纹 */
let histCfg = Object.assign({}, HIST_CFG_DEFAULT);
let ledgerTimer = null, histTimer = null;
let lastLedgerSig = null, lastRefreshAt = null, ledgerTicking = false;

const histStr = v => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
/* 来源标签（URL / 文件名）长度上限：避免超长 URL 撑大台账行与提示区 */
const histLabel = v => {
  const t = String(v === undefined || v === null ? '' : v).trim();
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
};
const ymdOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const timeText = d => (d instanceof Date ? d.toLocaleTimeString('zh-CN') : '—');
const histKeyOf = arNo => 'ar:' + encodeURIComponent(String(arNo).trim().toUpperCase());

/* 各种日期写法 → YYYY-MM-DD（取不到返回空串） */
function histDate(v) {
  const s = histStr(v);
  if (!s) return '';
  const m = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : ymdOf(d);
}

function histCfgLoad() {
  try {
    const raw = localStorage.getItem(HIST_CFG_KEY);
    return raw ? Object.assign({}, HIST_CFG_DEFAULT, JSON.parse(raw)) : Object.assign({}, HIST_CFG_DEFAULT);
  } catch (e) { return Object.assign({}, HIST_CFG_DEFAULT); }
}
function histCfgSave() {
  try { localStorage.setItem(HIST_CFG_KEY, JSON.stringify(histCfg)); } catch (e) { /* 忽略容量/隐私模式错误 */ }
}
function histRecordsLoad() {
  try {
    const raw = localStorage.getItem(HIST_REC_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function histRecordsSave() {
  try { localStorage.setItem(HIST_REC_KEY, JSON.stringify(state.historySource.records.slice(0, 2000))); }
  catch (e) { /* 超出容量则仅本次会话有效 */ }
}

/* 应收单池 → 历史已结算记录（金额取数据源「已结算金额」，与应收单池「已核销」一致） */
function arHistoryRecord(a) {
  const amount = r2(a.baseWrittenOff || 0);
  if (!(amount > 0.001) || r2(a.amount) < 0) return null;
  const raw = a.raw || {};
  return {
    key: histKeyOf(a.arNo),
    arNo: a.arNo,
    customer: a.customer,
    customerTaxId: a.customerTaxId || null,
    contractNo: a.contractNo || null,
    arAmount: r2(a.amount),
    amount,
    bizDate: histDate(raw['修改时间'] || raw['清算期'] || raw['结算日期'] || a.dueDate || a.bizdate) || todayISO(),
    settleRef: histStr(raw['凭证号']) || histStr(raw['清算期']),
    statusText: histStr(raw['核销状态']) || histStr(raw['结算状态']),
    remark: histStr(raw['备注']),
    source: '应收单池同步',
    amountMode: a.amountMode === 'incl' ? 'incl' : 'excl',
  };
}

/* 外部数据源单行 → 历史已结算记录（字段名兼容中文 / 英文） */
function externalHistoryRecord(row, label) {
  const pick = k => {
    for (const name of HIST_FIELDS[k]) {
      const v = row[name];
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return null;
  };
  const arNo = histStr(pick('arNo'));
  const amount = num(pick('settledAmount'));
  if (!arNo || amount === null || !(amount > 0)) return null;
  return {
    key: histKeyOf(arNo),
    arNo,
    customer: histStr(pick('customer')),
    customerTaxId: histStr(pick('customerTaxId')),
    contractNo: histStr(pick('contractNo')),
    arAmount: num(pick('arAmount')),
    amount: r2(amount),
    bizDate: histDate(pick('bizDate')) || todayISO(),
    settleRef: histStr(pick('settleRef')),
    statusText: histStr(pick('statusText')),
    remark: histStr(pick('remark')),
    source: histLabel(label) || '外部数据源',
    amountMode: 'excl',
  };
}

/* 合并数据源 → 整体刷新台账历史结算快照行 */
async function syncHistoryLedger(silent) {
  const records = [], seen = new Set();
  const push = r => { if (r && !seen.has(r.key)) { seen.add(r.key); records.push(r); } };

  /* 外部数据源（接口 / 上传文件）优先于应收单池派生值：同一应收单号只保留一条 */
  state.historySource.records.forEach(r => push(externalHistoryRecord(r, state.historySource.label)));
  if (histCfg.poolSync) state.ars.forEach(a => push(arHistoryRecord(a)));

  let res = { count: 0, total: 0, replaced: 0 };
  try {
    res = await Store.replaceHistory(records);
  } catch (e) {
    if (!silent) showWoMsg('⛔ 历史已结算同步失败：' + errText(e), 'err');
    return null;
  }
  state.histSync = { count: res.count, total: res.total, at: new Date() };
  await refreshLedger();
  renderWriteOffs();
  renderARs();
  updateBadges();
  renderHistStatus(histMismatchLines());
  return res;
}

/* 台账「最后刷新」时间 */
function markRefreshed() {
  const el = $('#wo-last');
  if (el) el.textContent = lastRefreshAt ? `最后刷新 ${timeText(lastRefreshAt)}` : '—';
}

function renderHistStatus(lines, type = 'ok') {
  const box = $('#hist-status');
  if (!box) return;
  const s = state.histSync || { count: 0, total: 0, at: null };
  const src = state.historySource;
  const head = `数据源：${histCfg.poolSync ? '应收单池（已结算金额 / 未结算金额）' : '应收单池（已关闭）'}`
    + ` · 外部记录 ${src.records.length} 条${src.label ? `（${esc(histLabel(src.label))}）` : ''}`
    + ` · 台账历史结算快照 ${s.count} 行 / ¥${money(s.total)}`
    + (s.at ? ` · 上次同步 ${timeText(s.at)}` : '');
  box.innerHTML = [head].concat(lines || []).map(t => `<div class="m ${type}">${t}</div>`).join('');
}

/* 解析外部数据源文本（JSON：数组或 {records:[…]}；CSV：首行表头） */
function parseHistoryPayload(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('内容为空');
  if (t[0] === '{' || t[0] === '[') {
    const data = JSON.parse(t);
    const rows = Array.isArray(data) ? data : (data.records || data.data || data.items || data.rows);
    if (!Array.isArray(rows)) throw new Error('JSON 中未找到记录数组（支持数组或 {records:[…]}）');
    return rows;
  }
  const grid = parseCsv(t);
  if (!grid.length) throw new Error('CSV 内容为空');
  const hdr = grid[0].map(h => String(h === undefined || h === null ? '' : h).trim());
  return grid.slice(1)
    .filter(r => r && r.some(c => String(c === undefined || c === null ? '' : c).trim() !== ''))
    .map(r => { const o = {}; hdr.forEach((h, i) => { if (h) o[h] = r[i]; }); return o; });
}

function applyExternalRows(rows, label) {
  const recs = rows.map(o => externalHistoryRecord(o, label)).filter(Boolean);
  state.historySource.records = recs;
  state.historySource.label = label || '';
  histCfg.externalLabel = state.historySource.label;
  histCfgSave();
  histRecordsSave();
  return { total: rows.length, ok: recs.length, skipped: rows.length - recs.length };
}

async function pullHistoryRemote(quiet) {
  const url = histCfg.url.trim();
  if (!url) { if (!quiet) renderHistStatus(['⚠️ 请先填写外部数据源接口地址'], 'err'); return null; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let text;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json, text/csv, text/plain' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`接口返回 ${res.status} ${res.statusText || ''}`.trim());
      text = await res.text();
    } finally { clearTimeout(timer); }

    const rows = parseHistoryPayload(text);
    const st = applyExternalRows(rows, `接口 ${url}`);
    const sync = await syncHistoryLedger(true);
    renderHistStatus([
      `✅ 接口拉取成功：解析 ${st.total} 条 → 有效历史记录 ${st.ok} 条${st.skipped ? `，跳过 ${st.skipped} 条（缺少应收单号或已结算金额 ≤ 0）` : ''}`,
      `　台账历史结算快照已刷新为 ${sync ? sync.count : 0} 行 / ¥${money(sync ? sync.total : 0)} · ${timeText(new Date())}`,
    ].concat(histMismatchLines()));
    return st;
  } catch (e) {
    renderHistStatus([`⛔ 接口拉取失败：${esc(errText(e))}`, '　（跨域接口需允许 CORS；本地原型也可改用「上传历史已结算文件」）'], 'err');
    return null;
  }
}

/* ---------------- 数据源配置（本地持久化） ---------------- */
function syncHistCfgToUi() {
  const ck = (sel, v) => { const el = $(sel); if (el) el.checked = !!v; };
  ck('#hist-pool', histCfg.poolSync);
  ck('#hist-autopoll', histCfg.autoPoll);
  const url = $('#hist-url'); if (url) url.value = histCfg.url || '';
  const ps = $('#hist-poll-sec'); if (ps) ps.value = String(histCfg.pollSec || 30);
  const rs = $('#wo-auto'); if (rs) rs.value = String(histCfg.refreshSec || 0);
}

function readHistCfgFromUi() {
  const val = sel => { const el = $(sel); return el ? el.value : ''; };
  const chk = sel => { const el = $(sel); return !!(el && el.checked); };
  histCfg.poolSync = chk('#hist-pool');
  histCfg.autoPoll = chk('#hist-autopoll');
  histCfg.url = String(val('#hist-url') || '').trim();
  histCfg.pollSec = Number(val('#hist-poll-sec')) || 30;
  histCfg.refreshSec = Number(val('#wo-auto')) || 0;
  histCfgSave();
}

/* ---------------- 自动刷新：台账像「查数据库」一样保持最新 ----------------
   两路定时：
     ① 台账自动刷新（refreshSec）：比对变更指纹 signature()，有变化才重新查询 + 渲染
     ② 外部数据源定时拉取（pollSec）：拉取后整体刷新历史结算快照行 */
function startLedgerAutoRefresh() {
  if (ledgerTimer) { clearInterval(ledgerTimer); ledgerTimer = null; }
  const sec = Number(histCfg.refreshSec) || 0;
  markRefreshed();
  if (sec > 0) ledgerTimer = setInterval(() => tickLedger(false), sec * 1000);
}

function startHistAutoPoll() {
  if (histTimer) { clearInterval(histTimer); histTimer = null; }
  if (!histCfg.autoPoll || !histCfg.url) return;
  const sec = Math.max(5, Number(histCfg.pollSec) || 30);
  histTimer = setInterval(() => pullHistoryRemote(true), sec * 1000);
}

async function tickLedger(force) {
  if (ledgerTicking) return;
  ledgerTicking = true;
  try {
    const sig = await Store.signature();
    if (!force && sig === lastLedgerSig) { markRefreshed(); return; }
    await refreshLedger();
    renderWriteOffs();
    renderARs();
    updateBadges();
    markRefreshed();
  } catch (e) {
    /* 后台轮询失败静默处理（页面手动操作仍会给出提示） */
  } finally {
    ledgerTicking = false;
  }
}

/* 台账历史结算快照的金额口径提示：
   台账「历史结算」行以外部数据源为准；应收单池「已核销」则取模板已结算/未结算口径。
   两者不一致时给出提示（不改变任一方的计算口径，仅提示差异，便于对账） */
function histMismatchLines() {
  if (!state.historySource.records.length) return [];
  const pool = new Map(state.ars.map(a => [String(a.arNo).trim().toUpperCase(), r2(a.baseWrittenOff || 0)]));
  const bad = [];
  state.historySource.records.forEach(r => {
    const k = String(r.arNo).trim().toUpperCase();
    if (!pool.has(k)) return;
    const base = pool.get(k);
    if (Math.abs(base - r.amount) > 0.011) bad.push(`${r.arNo}（数据源 ¥${money(r.amount)} ≠ 应收单池已结算 ¥${money(base)}）`);
  });
  if (!bad.length) return [];
  return [`⚠️ ${bad.length} 条与应收单池「已结算金额」不一致，台账历史结算行以<b>外部数据源</b>为准：${esc(bad.slice(0, 5).join('、'))}${bad.length > 5 ? ' …' : ''}`];
}

/* 上传 / 拉取后的统一入口：刷新外部数据源 → 台账快照行 */
async function loadExternalHistory(rows, label) {
  const st = applyExternalRows(rows, label);
  const sync = await syncHistoryLedger(true);
  renderHistStatus([
    `✅ ${esc(histLabel(label))}：解析 ${st.total} 条 → 有效历史记录 ${st.ok} 条${st.skipped ? `，跳过 ${st.skipped} 条（缺少应收单号或已结算金额 ≤ 0）` : ''}`,
    `　台账历史结算快照已刷新为 ${sync ? sync.count : 0} 行 / ¥${money(sync ? sync.total : 0)} · ${timeText(new Date())}`,
  ].concat(histMismatchLines()));
  return st;
}

/* 发票状态由台账缓存同步（同步方法，供导入后立即调用）
   注意：反向记录（REVERSE）虽为有效记录，但其发票快照来自原记录，不能用于标记「已核销」 */
function syncInvoiceStatusFromLedger() {
  const done = new Set();
  state.writeOffs
    .filter(w => w.status === 'VALID' && w.entryType === 'WRITE_OFF')
    .forEach(w => (w.invoices || []).forEach(i => done.add(`${i.code}|${i.no}`)));
  state.invoices.forEach(inv => {
    const key = `${inv.code}|${inv.no}`;
    if (done.has(key)) inv.status = '已核销';
    else if (inv.status === '已核销') inv.status = '待匹配';
  });
}

/* 应收单余额 = 基准已核销（ERP 未结算口径） + 台账有效核销合计 */
async function refreshArBalances() {
  const led = await Store.arWrittenOff();
  state.ars.forEach(a => {
    const wrote = r2(r2(a.baseWrittenOff || 0) + r2(led[a.arNo] || 0));
    a.writtenOff = wrote <= 0.0001 ? 0 : wrote;
    a.remaining = r2(a.amount - a.writtenOff);
    a.status = a.writtenOff <= 0.001 ? '未核销' : (a.remaining <= 0.001 ? '已核销' : '部分核销');
  });
}

/* =====================================================================
 *  发票池 / 应收单池持久化（与台账同一 Store，刷新 / 换机不丢）
 *  - 只持久化「导入事实」：发票字段与异常标记、应收单原始字段（raw）与
 *    数据源已结算口径 baseWrittenOff；
 *  - 发票核销状态、应收单 writtenOff / remaining / status 均为台账派生值，
 *    启动恢复后由 refreshLedger() 依据台账有效记录统一重算，不存旧值。
 * ===================================================================== */
function persistPools() {
  if (!Store.ready) return Promise.resolve();
  return Promise.resolve()
    .then(() => Store.setPoolsReady(true))
    .then(() => Store.savePools({ invoices: state.invoices, ars: state.ars }))
    .catch(e => console.warn('[Store] 发票/应收单池持久化失败：', e && e.message));
}

/* 启动恢复：已初始化过 → 从 Store 恢复（空池也如实恢复）；首次使用 → 装入内置示例 */
async function restorePools() {
  let pools = null, ready = false;
  try {
    ready = await Store.isPoolsReady();
    if (ready) pools = await Store.loadPools();
  } catch (e) {
    console.warn('[Store] 发票/应收单池恢复失败，改用内置示例：', e && e.message);
  }
  if (ready && pools) {
    state.invoices = pools.invoices || [];
    state.ars = pools.ars || [];
  } else {
    state.invoices = [];
    state.ars = seedArs();
    await persistPools();
  }
}


function markAbnormal(inv) {
  inv.status = '异常';
  void persistPools();
  renderAll();
  showMsg(`发票 ${inv.no} 已标记为异常（作废/退票），可追溯，不自动反冲`, 'ok');
}

/* =====================================================================
 *  渲染
 * ===================================================================== */
function renderAll() {
  renderInvoices();
  renderReview();
  renderWriteOffs();          // async：内部从 Store 读取台账
  renderARs();
  updateBadges();
}

function updateBadges() {
  const { groups, unmatched } = computeMatches();
  $('#badge-pending').textContent = groups.length + unmatched.length;
  $('#badge-wo').textContent = state.writeOffs.filter(w => w.status === 'VALID' && w.entryType !== 'HISTORY').length;
}

function stClass(s) {
  return ({ '待匹配': 'pending', '待解析': 'pending', '已匹配待复核': 'matched', '未匹配': 'pending', '已核销': 'done', '异常': 'abnormal', '部分核销': 'partial', '未核销': 'pending' })[s] || 'pending';
}

function renderInvoices() {
  const tb = $('#inv-tbody');
  $('#inv-count').textContent = state.invoices.length;
  if (!state.invoices.length) { tb.innerHTML = `<tr><td colspan="8" class="empty">暂无发票，请粘贴 XML 或点击“加载全部示例发票”</td></tr>`; return; }
  tb.innerHTML = state.invoices.map(i => `
    <tr>
      <td>${esc(i.code)}</td><td>${esc(i.no)}</td><td>${esc(i.buyerName)}</td>
      <td class="mono">${i.buyerTaxId ? esc(i.buyerTaxId) : '<span class="note">无</span>'}</td>
      <td class="num">¥${money(i.amount)}</td>
      <td>${i.contractNo ? esc(i.contractNo) : '<span class="note">未提取</span>'}</td>
      <td class="note">${esc(i.issueDate) || '-'}</td>
      <td><span class="st ${stClass(i.status)}">${i.status}</span></td>
    </tr>`).join('');
}

function sideInvoices(list) {
  return list.map(i => {
    const meta = [];
    if (i.issueDate) meta.push(`开票日期 ${esc(i.issueDate)}`);
    if (i.taxAmount !== null && i.taxAmount !== undefined) meta.push(`税额 ¥${money(i.taxAmount)}`);
    if (i.amountIncl !== null && i.amountIncl !== undefined) meta.push(`价税合计 ¥${money(i.amountIncl)}`);
    const items = (i.items || []).filter(it => it.name);
    return `<div class="item">
      <div><b>发票 ${esc(i.no)}</b> <span class="k">· ${esc(i.code)}</span></div>
      <div class="k">${esc(i.buyerName)}</div>
      <div class="k">购买方税号 ${i.buyerTaxId ? esc(i.buyerTaxId) : '<span class="note">无</span>'} · 合同 ${i.contractNo ? esc(i.contractNo) : '未提取'}</div>
      ${i.sellerName ? `<div class="k">销售方 ${esc(i.sellerName)}${i.sellerTaxId ? ` · ${esc(i.sellerTaxId)}` : ''}</div>` : ''}
      ${meta.length ? `<div class="k">${meta.join(' · ')}</div>` : ''}
      ${items.length ? `<div class="k">明细 ${items.length} 行：${items.map(it => esc(it.name)).join('、')}</div>` : ''}
      <div class="diff">不含税金额 <b>¥${money(i.amount)}</b></div>
    </div>`;
  }).join('');
}
function sideArs(list) {
  return list.map(a => `<div class="item">
      <div><b>${a.arNo}</b> <span class="k">· ${a.customer}</span></div>
      <div class="k">税号 ${a.customerTaxId || '无'} · 合同 ${a.contractNo || '无'}</div>
      <div class="diff">剩余余额 <b>¥${money(a.remaining)}</b> <span class="k">/ 原 ¥${money(a.amount)}</span></div>
    </div>`).join('');
}

function diffTag(diff) {
  const cls = Math.abs(diff) <= 0.01 ? 'ok' : 'bad';
  return `<span class="diff ${cls}">差额 ¥${money(diff)}</span>`;
}

function renderReview() {
  const body = $('#review-body');
  const { groups, unmatched } = computeMatches();
  if (!groups.length && !unmatched.length) {
    body.innerHTML = `<div class="card"><div class="empty">暂无可复核内容，请先在「发票导入」页导入发票。</div></div>`;
    return;
  }
  let html = '';

  /* 批量操作条：一键确认全部高置信（差额 ≤ 0.01 的单对单 / 差额为 0 的推荐组合） */
  const highGroups = groups.filter(g => g.tier === 'high');
  if (highGroups.length) {
    const highSum = r2(highGroups.reduce((s, g) => s + g.invoices.reduce((t, i) => t + i.amount, 0), 0));
    html += `<div class="batch-bar">
      <span>检测到 <b>${highGroups.length}</b> 个高置信匹配（涉及发票 ${highGroups.reduce((n, g) => n + g.invoices.length, 0)} 张，发票金额合计 <b>¥${money(highSum)}</b>），可逐组确认，也可批量一次确认：</span>
      <button class="btn primary" data-act="confirm-all-high">一键确认全部高置信（${highGroups.length}）</button>
    </div>`;
  }

  /* 高/中置信 + 组合 */
  groups.forEach(g => {
    const cls = g.tier === 'high' ? 'high' : (g.kind === 'single' ? 'mid' : 'rec');
    const titleChip = g.tier === 'high'
      ? `<span class="chip high">高置信</span>`
      : (g.kind === 'single' ? `<span class="chip mid">中置信</span>` : `<span class="chip rec">推荐组合</span>`);
    const kindLabel = { single: '单对单', combo1n: '一对多 · 合并开票', combon1: '多对一 · 拆分收款' }[g.kind];
    const confirmBtn = g.tier === 'high'
      ? `<button class="btn primary" data-act="confirm" data-id="${g.id}">一键确认</button>`
      : `<button class="btn primary" data-act="confirm" data-id="${g.id}">确认匹配</button>`;
    const rebind = g.tier !== 'high'
      ? `<button class="btn danger" data-act="abnormal" data-id="${g.id}">标记异常</button>` : '';

    html += `<div class="group ${cls}" data-gid="${g.id}">
      <div class="group-head">
        <div class="title">${titleChip}<span class="note">${kindLabel}</span></div>
        <div>${diffTag(g.diff)}</div>
      </div>
      <div class="group-body">
        <div class="side"><h4>发票侧</h4>${sideInvoices(g.invoices)}</div>
        <div class="arrow">↔</div>
        <div class="side"><h4>应收单侧</h4>${sideArs(g.ars)}</div>
      </div>
      <div class="group-foot">
        ${confirmBtn}${rebind}
        <span class="note">${g.note}</span>
      </div>
    </div>`;
  });

  /* 未匹配 / 人工池 */
  if (unmatched.length) {
    html += `<div class="group none"><div class="group-head"><div class="title"><span class="chip none">未匹配 · 人工池</span>
      <span class="note">多对多场景不自动组合，仅列出同税号/同合同候选，请人工圈选</span></div></div>
      <div class="group-body" style="grid-template-columns:1fr">`;
    unmatched.forEach(({ inv, cands }) => {
      const opts = cands.length
        ? cands.map(a => `<option value="${a.id}">${a.arNo} · ${a.customer} · 剩余 ¥${money(a.remaining)} · 合同 ${a.contractNo}</option>`).join('')
        : `<option value="">（无同税号/同合同候选）</option>`;
      html += `<div class="item" style="margin-bottom:12px">
        <div><b>发票 ${inv.no}</b> <span class="k">· ${inv.buyerName}</span></div>
        <div class="k">税号 ${inv.buyerTaxId || '无'} · 合同 ${inv.contractNo || '未提取'} · 金额 ¥${money(inv.amount)}</div>
        <div class="candbox">
          <select multiple size="${Math.min(Math.max(cands.length, 1), 4)}" data-inv="${inv.id}">${opts}</select>
        </div>
        <div style="margin-top:8px" class="row">
          <button class="btn primary small" data-act="manual" data-inv="${inv.id}" ${cands.length ? '' : 'disabled'}>手动关联所选</button>
          <button class="btn danger small" data-act="abnormal-inv" data-inv="${inv.id}">标记异常</button>
          <span class="note">多对多时，可多次圈选分组后分别确认</span>
        </div>
      </div>`;
    });
    html += `</div></div>`;
  }
  body.innerHTML = html;
}

/* ---------------- ③ 核销台账：列表 / 明细 / 时间线 / 分页 / 导出 ---------------- */
function woStatusChip(s) {
  return `<span class="chip ${s === 'VALID' ? 'valid' : 'reversed'}">${woStatusText(s)}</span>`;
}

/* ---------------- 汇总对账报表（PRD FR-13） ----------------
   数据源：state.writeOffs（台账全量，refreshLedger 以 size:0 读取，不受当前筛选影响）
   与 state.ars（应收单池，余额由台账有效记录重算）。
   ① 按客户：有效核销净额 / 反核销发生额（负）/ 历史已结算（数据源，分列不混算）
   ② 按会计期间：核销 / 反核销（负）/ 净额（本系统核销事实）+ 历史结算
   ③ 应收单余额对账：原金额 = 已核销（数据源 + 本系统）+ 剩余余额，逐行校验（BR-04） */
function renderLedgerReport() {
  const box = $('#wo-report');
  if (!box) return;
  const rows = state.writeOffs || [];

  const custMap = new Map();
  const periodMap = new Map();
  const custRow = name => {
    const k = name || '（未知客户）';
    if (!custMap.has(k)) custMap.set(k, { name: k, valid: 0, reversed: 0, history: 0, count: 0 });
    return custMap.get(k);
  };
  const periodRow = p => {
    const k = p || '—';
    if (!periodMap.has(k)) periodMap.set(k, { period: k, write: 0, reverse: 0, history: 0 });
    return periodMap.get(k);
  };

  rows.forEach(w => {
    if (w.entryType === 'HISTORY') {
      custRow(w.customerName).history = r2(custRow(w.customerName).history + w.writeOffTotal);
      periodRow(w.period).history = r2(periodRow(w.period).history + w.writeOffTotal);
      return;
    }
    const c = custRow(w.customerName);
    c.count++;
    if (w.entryType === 'REVERSE') {
      c.reversed = r2(c.reversed + w.writeOffTotal);    /* 反向记录金额为负 */
      periodRow(w.period).reverse = r2(periodRow(w.period).reverse + w.writeOffTotal);
    } else if (w.status === 'VALID') {
      c.valid = r2(c.valid + w.writeOffTotal);
      periodRow(w.period).write = r2(periodRow(w.period).write + w.writeOffTotal);
    }
  });

  const neg = v => `<span class="${v < 0 ? 'neg' : ''}">¥${money(v)}</span>`;

  /* ① 按客户（按有效核销净额降序） */
  const custs = [...custMap.values()].sort((a, b) => (b.valid + b.reversed) - (a.valid + a.reversed) || b.history - a.history);
  const tC = custs.reduce((t, c) => {
    t.valid = r2(t.valid + c.valid); t.reversed = r2(t.reversed + c.reversed); t.history = r2(t.history + c.history); return t;
  }, { valid: 0, reversed: 0, history: 0 });
  const custHtml = custs.length ? `
    <table class="grid small">
      <thead><tr><th>客户</th><th class="num">批次</th><th class="num">有效核销净额</th><th class="num">反核销发生额</th><th class="num">历史已结算（数据源）</th></tr></thead>
      <tbody>${custs.map(c => `<tr>
        <td>${esc(c.name)}</td>
        <td class="num">${c.count}</td>
        <td class="num"><b>¥${money(c.valid)}</b></td>
        <td class="num">${neg(c.reversed)}</td>
        <td class="num">¥${money(c.history)}</td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td><b>合计</b></td><td></td><td class="num"><b>¥${money(tC.valid)}</b></td>
        <td class="num">${neg(tC.reversed)}</td><td class="num"><b>¥${money(tC.history)}</b></td></tr></tfoot>
    </table>` : '<div class="note">暂无核销 / 历史结算记录</div>';

  /* ② 按会计期间（期间升序） */
  const periods = [...periodMap.values()].sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const tP = periods.reduce((t, p) => {
    t.write = r2(t.write + p.write); t.reverse = r2(t.reverse + p.reverse); t.history = r2(t.history + p.history); return t;
  }, { write: 0, reverse: 0, history: 0 });
  const periodHtml = periods.length ? `
    <table class="grid small">
      <thead><tr><th>会计期间</th><th class="num">核销额</th><th class="num">反核销额</th><th class="num">净额</th><th class="num">历史已结算（数据源）</th></tr></thead>
      <tbody>${periods.map(p => {
        const net = r2(p.write + p.reverse);
        return `<tr>
          <td>${esc(p.period)}</td>
          <td class="num">¥${money(p.write)}</td>
          <td class="num">${neg(p.reverse)}</td>
          <td class="num"><b>¥${money(net)}</b></td>
          <td class="num">¥${money(p.history)}</td>
        </tr>`;
      }).join('')}</tbody>
      <tfoot><tr><td><b>合计</b></td><td class="num">¥${money(tP.write)}</td>
        <td class="num">${neg(tP.reverse)}</td>
        <td class="num"><b>¥${money(r2(tP.write + tP.reverse))}</b></td>
        <td class="num"><b>¥${money(tP.history)}</b></td></tr></tfoot>
    </table>` : '<div class="note">暂无核销 / 历史结算记录</div>';

  /* ③ 应收单余额对账（按应收单号升序） */
  const ars = (state.ars || []).slice().sort((a, b) => String(a.arNo).localeCompare(String(b.arNo)));
  let bad = 0;
  const tA = { amount: 0, base: 0, sys: 0, wrote: 0, remaining: 0 };
  const arRows = ars.map(a => {
    const base = r2(a.baseWrittenOff || 0);
    const sys = r2((a.writtenOff || 0) - base);
    const gap = r2(a.amount - ((a.writtenOff || 0) + (a.remaining || 0)));
    const ok = Math.abs(gap) <= 0.011;
    if (!ok) bad++;
    tA.amount = r2(tA.amount + a.amount); tA.base = r2(tA.base + base);
    tA.sys = r2(tA.sys + sys); tA.wrote = r2(tA.wrote + (a.writtenOff || 0));
    tA.remaining = r2(tA.remaining + (a.remaining || 0));
    return `<tr${ok ? '' : ' class="row-bad"'}>
      <td>${esc(a.arNo)}</td>
      <td>${esc(a.customer || '')}</td>
      <td class="num">¥${money(a.amount)}</td>
      <td class="num">¥${money(base)}</td>
      <td class="num">¥${money(sys)}</td>
      <td class="num"><b>¥${money(a.writtenOff || 0)}</b></td>
      <td class="num">¥${money(a.remaining || 0)}</td>
      <td class="ctr">${ok ? '<span class="ok-mark">✓ 平衡</span>' : `<span class="bad-mark">⚠ 差 ¥${money(gap)}</span>`}</td>
    </tr>`;
  }).join('');
  const totalGap = r2(tA.amount - (tA.wrote + tA.remaining));
  const arHtml = ars.length ? `
    <div class="table-wrap" style="max-height:320px">
      <table class="grid small">
        <thead><tr><th>应收单号</th><th>客户</th><th class="num">原金额</th><th class="num">数据源已结算</th>
          <th class="num">本系统核销</th><th class="num">已核销合计</th><th class="num">剩余余额</th><th class="ctr">对账校验</th></tr></thead>
        <tbody>${arRows}</tbody>
        <tfoot><tr><td><b>合计（${ars.length} 张）</b></td><td></td>
          <td class="num">¥${money(tA.amount)}</td><td class="num">¥${money(tA.base)}</td>
          <td class="num">¥${money(tA.sys)}</td><td class="num"><b>¥${money(tA.wrote)}</b></td>
          <td class="num"><b>¥${money(tA.remaining)}</b></td>
          <td class="ctr">${Math.abs(totalGap) <= 0.011 ? '<span class="ok-mark">✓ 全部平衡</span>' : `<span class="bad-mark">⚠ 差 ¥${money(totalGap)}</span>`}</td>
        </tr></tfoot>
      </table>
    </div>
    <div class="note" style="margin-top:6px">
      口径：已核销合计 = 数据源已结算（模板 <code>已结算金额 / 未结算金额</code>，台账「历史结算」行）+ 本系统有效核销净额；
      ${bad ? `<b class="bad-mark">${bad} 张应收单对账不平（原金额 ≠ 已核销 + 剩余余额），请核查。</b>` : '全部应收单行对账平衡（容差 0.01 元）。'}
    </div>` : '<div class="note">应收单池为空</div>';

  box.innerHTML = `
    <div class="report-grid">
      <div class="report-block"><div class="raw-head">按客户汇总</div>${custHtml}</div>
      <div class="report-block"><div class="raw-head">按会计期间汇总</div>${periodHtml}</div>
    </div>
    <div class="report-block" style="margin-top:12px">
      <div class="raw-head">应收单余额对账表（BR-04：原金额 = 已核销 + 剩余余额）</div>
      ${arHtml}
    </div>`;
}



async function renderWriteOffs() {
  const body = $('#wo-body');
  if (!body) return;
  const pager = $('#wo-pager');
  const summary = $('#wo-summary');
  const count = $('#wo-count');
  const backend = $('#wo-backend');
  if (backend) backend.textContent = '存储：' + Store.backendName;
  renderLedgerReport();   /* 汇总对账基于台账全量快照 state.writeOffs，与当前筛选无关 */

  try {
    const { rows, total, agg, page, size } = await Store.listWriteOffs({
      kw: woQuery.kw, status: woQuery.status, entryType: woQuery.entryType, method: woQuery.method,
      from: woQuery.from, to: woQuery.to, page: woQuery.page, size: woQuery.size,
    });

    if (count) count.textContent = agg.valid;
    if (summary) {
      summary.innerHTML = `共 <b>${agg.count}</b> 个批次（有效 <b>${agg.valid}</b> · 已反核销 <b>${agg.reversed}</b>`
        + (agg.history ? ` · 历史结算快照 <b>${agg.history}</b>` : '')
        + `）`
        + ` · 配分明细 <b>${agg.lines}</b> 行 · 有效核销净额 <b>¥${money(agg.amount)}</b>`
        + (agg.history ? ` · 历史已结算（数据源）<b>¥${money(agg.historyAmount)}</b>` : '')
        + ` · 只追加不删除，纠错走反核销`;
    }

    if (!total) {
      body.innerHTML = `<tr><td colspan="13" class="empty">当前筛选条件下暂无核销记录。<br>
        在「匹配复核」页确认匹配后生成；导入应收单后，模板中的「已结算金额 / 未结算金额」会自动同步为「历史结算」行。<br>
        （台账仅保存在本机，请定期导出留档）</td></tr>`;
      if (pager) pager.innerHTML = '';
      return;
    }

    let html = '';
    for (const w of rows) {
      const open = woQuery.openId === w.writeOffId;
      const isHist = w.entryType === 'HISTORY';
      const revBtn = (w.status === 'VALID' && w.entryType === 'WRITE_OFF')
        ? `<button class="btn danger small" data-wo-act="reverse" data-id="${w.writeOffId}">反核销</button>` : '';
      const typeChip = w.entryType === 'REVERSE' ? '<span class="chip entry-rev">反</span> '
        : (isHist ? '<span class="chip entry-hist">历史</span> ' : '');
      html += `<tr class="wo-row clickable" data-id="${w.writeOffId}">
        <td><b>${esc(w.batchNo)}</b>${w.refBatchNo ? `<div class="note">← ${esc(w.refBatchNo)}</div>` : ''}${isHist && w.syncSource ? `<div class="note">${esc(w.syncSource)}</div>` : ''}</td>
        <td>${typeChip}${woEntryText(w.entryType)}</td>
        <td>${esc(w.bizDate)}<div class="note">${esc(w.period)}</div></td>
        <td>${esc(w.customerName || '-')}</td>
        <td>${w.contractNo ? esc(w.contractNo) : '<span class="note">无</span>'}</td>
        <td>${esc(w.method)}<div class="note">${w.amountMode === 'incl' ? '含税' : '不含税'}</div></td>
        <td class="num">${(w.invoices || []).length}</td>
        <td class="num">${w.lineCount || 0}</td>
        <td class="num"><b>¥${money(w.writeOffTotal)}</b></td>
        <td class="num"><span class="diff ${Math.abs(w.diff) <= 0.01 ? 'ok' : 'bad'}">¥${money(w.diff)}</span></td>
        <td>${woStatusChip(w.status)}${isHist ? '<div class="note">数据源快照</div>' : ''}</td>
        <td>${esc(w.operatorName || w.operatorId)}<div class="note">${esc(w.createdAtText || '')}</div></td>
        <td>${revBtn || (isHist ? '<span class="note">—</span>' : '')}</td>
      </tr>`;
      if (open) html += `<tr class="wo-detail"><td colspan="13">${await woDetailHtml(w)}</td></tr>`;
    }
    body.innerHTML = html;
    if (pager) pager.innerHTML = woPagerHtml(page, size, total);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="13" class="empty">台账读取失败：${esc(errText(e))}</td></tr>`;
  }
}

async function woDetailHtml(w) {
  if (w.entryType === 'HISTORY') return woHistoryDetailHtml(w);
  const { details, events } = await Store.getWriteOff(w.writeOffId);
  const reason = w.reasonCode
    ? `<div class="note">反核销原因：${esc(WO_REASONS[w.reasonCode] || w.reasonCode)}${w.reason ? ' · ' + esc(w.reason) : ''}</div>` : '';
  const revInfo = w.status === 'REVERSED'
    ? `<div class="note strike">该记录已被反核销${w.reversedBatchNo ? `（反向批次 ${esc(w.reversedBatchNo)}）` : ''}${w.reversedReasonCode ? `，原因：${esc(WO_REASONS[w.reversedReasonCode] || w.reversedReasonCode)}` : ''}</div>`
    : '';
  const invs = (w.invoices || []).map(i => `<div class="item">
      <div><b>发票 ${esc(i.no)}</b> <span class="k">· ${esc(i.code)}</span></div>
      <div class="k">${esc(i.buyerName || '')} · 税号 ${esc(i.buyerTaxId || '无')} · 合同 ${esc(i.contractNo || '未提取')}</div>
      <div class="diff">不含税金额 <b>¥${money(i.amount)}</b></div>
    </div>`).join('');
  const tl = events.map(e => `<li class="${e.eventType === 'REVERSE' ? 'rev' : ''}">
      <div><b>${e.eventType === 'REVERSE' ? '反核销' : '生成核销'}</b>
        <span class="tl-t">${esc(new Date(e.createdAt).toLocaleString('zh-CN'))} · ${esc(e.operatorId || '')}</span></div>
      <div class="tl-t">${esc(JSON.stringify(e.payload || {}))}</div>
    </li>`).join('');

  return `<div class="wo-detail-grid">
    <div>
      <div class="raw-head">配分明细（发票 × 应收单 逐行配对，共 ${details.length} 行；pairKey = invoiceId:arId）</div>
      <table class="grid small">
        <thead><tr><th>#</th><th>发票</th><th>应收单</th><th>合同</th>
          <th class="num">应收单原金额</th><th class="num">核销前余额</th><th class="num">本次核销</th><th class="num">核销后余额</th><th>红字</th></tr></thead>
        <tbody>${details.map(d => `<tr>
          <td>${d.lineNo}</td>
          <td>${esc(d.invoiceNo)}<div class="note">${esc(d.invoiceCode)}</div></td>
          <td>${esc(d.arNo)}</td>
          <td>${esc(d.contractNo || '-')}</td>
          <td class="num">¥${money(d.arAmount)}</td>
          <td class="num">¥${money(d.arRemainingBefore)}</td>
          <td class="num"><b>¥${money(d.writeAmount)}</b></td>
          <td class="num">¥${money(d.arRemainingAfter)}</td>
          <td>${d.isReversal ? '是' : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
      ${reason}${revInfo}
    </div>
    <div>
      <div class="raw-head">发票集合</div>
      ${invs || '<div class="note">无</div>'}
      <div class="raw-head" style="margin-top:12px">事件时间线（append-only）</div>
      <ul class="timeline">${tl || '<li class="tl-t">无事件</li>'}</ul>
    </div>
  </div>`;
}

/* 历史已结算（数据源快照）详情：无配分明细、无事件流水，展示来源与对账字段 */
function woHistoryDetailHtml(w) {
  const ar = (w.ars || [])[0] || {};
  const kv = [
    ['记录类型', '历史结算（数据源快照，非本系统核销事实）'],
    ['数据来源', w.syncSource || '数据源'],
    ['结算单号 / 凭证号', w.settleRef || '—'],
    ['数据源核销状态', w.sourceStatus || '—'],
    ['应收单号', ar.arNo || '—'],
    ['应收单原金额', '¥' + money(ar.amount)],
    ['已结算金额', '¥' + money(w.writeOffTotal)],
    ['结算业务日期', w.bizDate + '（会计期间 ' + w.period + '）'],
    ['同步时间', w.syncedAtText || '—'],
    ['备注', w.remark || '—'],
  ];
  return `<div class="wo-detail-grid">
    <div>
      <div class="raw-head">历史已结算快照（随数据源自动刷新）</div>
      <div class="kv">${kv.map(([k, v]) => `<div class="kv-i"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`).join('')}</div>
      <div class="note" style="margin-top:8px">
        该行由数据源（应收单池的「已结算金额 / 未结算金额」、外部接口或上传文件）同步生成：
        每次同步按数据源当前内容整体刷新，<b>不占用应收单余额</b>（余额口径已体现在应收单的「已核销」中），
        也<b>不参与反核销</b>；如需更正请修正数据源后重新同步。
      </div>
    </div>
    <div>
      <div class="raw-head">应收单</div>
      <div class="item">
        <div><b>${esc(ar.arNo || '—')}</b> <span class="k">· ${esc(w.customerName || '')}</span></div>
        <div class="k">合同 ${esc(w.contractNo || '未提取')} · 税号 ${esc(w.customerTaxId || '无')}</div>
        <div class="diff">数据源已结算 <b>¥${money(w.writeOffTotal)}</b></div>
      </div>
      <div class="raw-head" style="margin-top:12px">说明</div>
      <div class="note">历史快照行不写入事件流水（append-only 事件仅记录本系统核销 / 反核销动作）。</div>
    </div>
  </div>`;
}

function woPagerHtml(page, size, total) {  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return `<span>共 ${total} 条</span>`;
  const mk = (p, label, disabled, active) =>
    `<button data-page="${p}" ${disabled ? 'disabled' : ''} class="${active ? 'active' : ''}">${label}</button>`;
  let html = mk(Math.max(1, page - 1), '上一页', page <= 1, false);
  for (let p = 1; p <= pages; p++) {
    if (pages > 7 && p !== 1 && p !== pages && Math.abs(p - page) > 1) {
      if (p === 2 || p === pages - 1) html += '<span>…</span>';
      continue;
    }
    html += mk(p, p, false, p === page);
  }
  html += mk(Math.min(pages, page + 1), '下一页', page >= pages, false);
  html += `<span>共 ${total} 条</span>`;
  return html;
}

/* ---------------- 台账导出（当前筛选条件，明细行级） ---------------- */
function downloadText(text, filename) {
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

async function exportWo() {
  try {
    const { rows } = await Store.listWriteOffs({
      kw: woQuery.kw, status: woQuery.status, entryType: woQuery.entryType, method: woQuery.method,
      from: woQuery.from, to: woQuery.to, size: 0,
    });
    if (!rows.length) { showWoMsg('当前筛选条件下没有可导出的记录', 'err'); return; }

    const head = ['批次号', '关联批次', '类型', '状态', '业务日期', '会计期间', '来源', '金额口径', '客户', '客户税号',
      '合同编号', '操作人', '创建时间', '反核销原因码', '反核销说明',
      '发票代码', '发票号码', '应收单号', '应收单原金额', '核销前余额', '本次核销', '核销后余额', '红字行'];
    const lines = [head.join(',')];
    for (const w of rows) {
      const { details } = await Store.getWriteOff(w.writeOffId);
      const common = [
        w.batchNo, w.refBatchNo || '', woEntryText(w.entryType), woStatusText(w.status), w.bizDate, w.period,
        w.method, w.amountMode === 'incl' ? '含税' : '不含税', w.customerName || '', w.customerTaxId || '',
        w.contractNo || '', w.operatorName || w.operatorId, w.createdAtText || w.createdAt,
        w.reasonCode || '', w.reason || '',
      ];
      if (!details.length) {
        const arNo = ((w.ars || [])[0] || {}).arNo || '';
        lines.push([...common, '', '', arNo, '', '', w.writeOffTotal, '', ''].map(csvCell).join(','));
        continue;
      }
      for (const d of details) {
        lines.push([...common,
          d.invoiceCode, d.invoiceNo, d.arNo, d.arAmount, d.arRemainingBefore, d.writeAmount, d.arRemainingAfter,
          d.isReversal ? '是' : '',
        ].map(csvCell).join(','));
      }
    }
    downloadText(lines.join('\r\n'), `核销台账_${todayISO()}.csv`);
    showWoMsg(`✅ 已导出 ${rows.length} 个批次（明细行级，含已反核销记录）`, 'ok');
  } catch (e) {
    showWoMsg('⛔ 导出失败：' + errText(e), 'err');
  }
}

const arExpanded = new Set();

function renderARs() {
  const tb = $('#ar-tbody');
  $('#ar-count').textContent = state.ars.length;
  if (!state.ars.length) { tb.innerHTML = `<tr><td colspan="10" class="empty">应收单池为空，请在上方按模板导入，或点击「重置演示数据」恢复示例应收单</td></tr>`; return; }
  tb.innerHTML = state.ars.map(a => {
    const open = arExpanded.has(a.id);
    const hasRaw = a.raw && Object.keys(a.raw).length;
    const caret = hasRaw ? `<span class="caret">${open ? '▾' : '▸'}</span> ` : '';
    const detail = (open && hasRaw)
      ? `<tr class="ar-detail"><td colspan="10">
           <div class="raw-head">全部导入字段（原样保留，未做裁剪）· 共 ${Object.keys(a.raw).length} 项</div>
           <div class="kv">${Object.entries(a.raw).map(([k, v]) =>
             `<div class="kv-i"><span class="kv-k">${esc(k)}</span><span class="kv-v">${esc(v)}</span></div>`).join('')}</div>
         </td></tr>`
      : '';
    return `<tr class="ar-row${hasRaw ? ' clickable' : ''}" data-ar-id="${a.id}">
      <td>${caret}${esc(a.arNo)}</td><td>${esc(a.customer)}</td>
      <td class="mono">${a.customerTaxId ? esc(a.customerTaxId) : '<span class="note">无</span>'}</td>
      <td class="note">${esc(a.bizdate) || '-'}</td>
      <td class="num">¥${money(a.amount)}</td>
      <td class="num">¥${money(a.writtenOff)}</td>
      <td class="num"><b>¥${money(a.remaining)}</b></td>
      <td>${a.contractNo ? esc(a.contractNo) : '<span class="note">无</span>'}</td>
      <td><span class="chip none">${esc(a.source || '示例')}</span></td>
      <td><span class="st ${stClass(a.status)}">${a.status}</span></td>
    </tr>${detail}`;
  }).join('');
}

/* ---------------- 提示 ---------------- */
function showMsg(text, type = 'ok') {
  const box = $('#import-msg');
  const cls = type === 'ok' ? 'ok' : 'err';
  box.innerHTML = text.split('\n').map(t => `<div class="m ${cls}">${t}</div>`).join('');
}

function showArMsg(text, type = 'ok') {
  const box = $('#ar-import-msg');
  if (!box) return;
  const cls = type === 'ok' ? 'ok' : 'err';
  box.innerHTML = text.split('\n').map(t => `<div class="m ${cls}">${t}</div>`).join('');
}

/* =====================================================================
 *  事件绑定
 * ===================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  /* Tabs */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    $$('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $('#panel-' + t.dataset.tab).classList.add('active');
    /* 切到台账页：立即按指纹重查一次，保证看到的是最新数据 */
    if (t.dataset.tab === 'writeoff') tickLedger(false);
  }));

  /* 重置 */
  $('#btn-reset').addEventListener('click', resetDemo);

  /* 解析导入 */
  $('#btn-parse').addEventListener('click', () => {
    const txt = $('#xml-input').value.trim();
    if (!txt) { showMsg('请先粘贴 XML 内容', 'err'); return; }
    const res = importText(txt);
    showMsg(res.msg, res.ok ? 'ok' : 'err');
    renderAll();
  });

  /* 文件导入 */
  $('#file-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    const msgs = [];
    for (const f of files) {
      const text = await f.text();
      const res = importText(text);
      msgs.push(`【${f.name}】\n${res.msg}`);
    }
    showMsg(msgs.join('\n'), 'ok');
    e.target.value = '';
    renderAll();
  });

  /* 加载全部示例 */
  $('#btn-samples').addEventListener('click', () => {
    const msgs = [];
    ['A', 'B', 'C', 'D1', 'D2', 'E1', 'E2'].forEach(k => {
      const res = importText(SAMPLES[k]);
      msgs.push(res.msg);
    });
    showMsg(msgs.join('\n'), 'ok');
    renderAll();
  });

  /* 重复导入测试 */
  $('#btn-dup-test').addEventListener('click', () => {
    const res = importText(SAMPLES.A);
    showMsg('重复导入测试结果：\n' + res.msg, res.ok ? 'ok' : 'err');
    renderAll();
  });

  $('#btn-rematch').addEventListener('click', () => { renderAll(); showMsg('已按当前状态重新匹配', 'ok'); });

  /* ---- 财务应收单模板导入 ---- */
  const arPanel = $('#panel-ar');
  arPanel.addEventListener('click', e => {
    const btn = e.target.closest('button[data-ar-act]');
    if (!btn) return;
    if (btn.dataset.arAct === 'template') downloadArTemplate();
    if (btn.dataset.arAct === 'clear') {
      state.ars = [];
      arExpanded.clear();
      void persistPools();    /* 清空状态持久化：刷新后仍为空，不回退为内置示例 */
      showArMsg('已清空应收单池', 'ok');
      renderAll();
      /* 数据源清空 → 台账中的历史结算快照行同步移除 */
      syncHistoryLedger(true);
    }
  });

  /* 点击应收单行展开 / 收起「全部原始字段」 */
  $('#ar-tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr.ar-row.clickable');
    if (!tr) return;
    const id = tr.dataset.arId;
    if (arExpanded.has(id)) arExpanded.delete(id); else arExpanded.add(id);
    renderARs();
  });

  $('#ar-file-input').addEventListener('change', async e => {
    const files = [...e.target.files];
    if (!files.length) return;
    showArMsg(`⏳ 正在解析 ${files.map(f => f.name).join('、')} …`);
    await new Promise(r => setTimeout(r, 30));
    try {
      const res = await importArFiles(files);
      showArMsg(res.msg, res.ok ? 'ok' : 'err');
    } catch (err) {
      showArMsg('导入失败：' + err.message, 'err');
    }
    e.target.value = '';
  });

  $('#btn-ar-sample').addEventListener('click', async () => {
    showArMsg('⏳ 正在加载内置示例（按模板结构生成）…');
    await new Promise(r => setTimeout(r, 30));
    try {
      const rows = parseCsv(arTemplateCsv(AR_SAMPLE_DOCS));
      const custRows = [['序号', '编码', '名称', '统一社会信用代码'], ...AR_SAMPLE_CUSTOMERS.map((c, i) => [i + 1, c[0], c[1], c[2]])];
      const res = await applyArImport([{ label: '内置示例 · 财务应收单模板', rows }], [{ label: '内置示例 · 客户档案', rows: custRows }]);
      showArMsg(res.msg, res.ok ? 'ok' : 'err');
    } catch (err) {
      showArMsg('加载示例失败：' + err.message, 'err');
    }
  });

  /* 复核区事件委托 */
  $('#review-body').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'confirm-all-high') { confirmAllHigh(); return; }
    const { groups } = computeMatches();

    if (act === 'confirm') {
      const g = groups.find(x => x.id === btn.dataset.id);
      if (g) confirmGroup(g, g.kind === 'single' ? (g.tier === 'high' ? '自动高置信' : '人工确认') : '自动推荐');
    } else if (act === 'abnormal') {
      const g = groups.find(x => x.id === btn.dataset.id);
      if (g) { g.invoices.forEach(i => i.status = '异常'); void persistPools(); renderAll(); }
    } else if (act === 'manual') {
      const invId = btn.dataset.inv;
      const inv = state.invoices.find(i => i.id === invId);
      const sel = $(`select[data-inv="${invId}"]`);
      const ids = [...sel.selectedOptions].map(o => o.value).filter(Boolean);
      if (!ids.length) { alert('请先在上方候选列表中选择应收单'); return; }
      manualAssociate(inv, ids, '人工圈选');
    } else if (act === 'abnormal-inv') {
      const inv = state.invoices.find(i => i.id === btn.dataset.inv);
      if (inv) markAbnormal(inv);
    }
  });

  /* ---- ③ 核销台账：筛选 / 分页 / 展开明细 / 反核销 / 导出 ---- */
  const woFilterIds = ['#wo-kw', '#wo-status', '#wo-entry', '#wo-method', '#wo-from', '#wo-to', '#wo-size'];
  const syncWoQuery = () => {
    woQuery.kw = $('#wo-kw').value.trim();
    woQuery.status = $('#wo-status').value;
    woQuery.entryType = $('#wo-entry').value;
    woQuery.method = $('#wo-method').value;
    woQuery.from = $('#wo-from').value;
    woQuery.to = $('#wo-to').value;
    woQuery.size = Number($('#wo-size').value) || 10;
    woQuery.page = 1;
  };
  woFilterIds.forEach(sel => {
    const el = $(sel);
    if (!el) return;
    ['input', 'change'].forEach(ev => el.addEventListener(ev, () => { syncWoQuery(); renderWriteOffs(); }));
  });
  $('#wo-refresh').addEventListener('click', () => tickLedger(true));
  $('#wo-export').addEventListener('click', exportWo);
  $('#wo-pager').addEventListener('click', e => {
    const btn = e.target.closest('button[data-page]');
    if (!btn || btn.disabled) return;
    woQuery.page = Number(btn.dataset.page) || 1;
    renderWriteOffs();
  });
  $('#wo-body').addEventListener('click', e => {
    const rev = e.target.closest('button[data-wo-act="reverse"]');
    if (rev) { e.stopPropagation(); openReverseModal(rev.dataset.id); return; }
    const row = e.target.closest('tr.wo-row');
    if (!row) return;
    woQuery.openId = woQuery.openId === row.dataset.id ? null : row.dataset.id;
    renderWriteOffs();
  });
  $('#wo-modal-cancel').addEventListener('click', closeReverseModal);
  $('#wo-modal-ok').addEventListener('click', doReverse);
  $('#wo-modal').addEventListener('click', e => { if (e.target.id === 'wo-modal') closeReverseModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#wo-modal').hidden) closeReverseModal(); });

  /* ---- 历史已结算数据源：同步开关 / 接口拉取 / 上传文件 / 自动刷新 ---- */
  ['#hist-pool', '#hist-autopoll', '#hist-poll-sec', '#hist-url'].forEach(sel => {
    const el = $(sel);
    if (!el) return;
    ['change', 'blur'].forEach(ev => el.addEventListener(ev, async () => {
      readHistCfgFromUi();
      startHistAutoPoll();
      if (ev === 'change') await syncHistoryLedger(true);
    }));
  });

  const woAuto = $('#wo-auto');
  if (woAuto) woAuto.addEventListener('change', () => {
    readHistCfgFromUi();
    startLedgerAutoRefresh();
    renderHistStatus([`自动刷新间隔：${histCfg.refreshSec > 0 ? histCfg.refreshSec + ' 秒' : '已关闭'}`]);
  });

  const histPull = $('#hist-pull');
  if (histPull) histPull.addEventListener('click', async () => {
    readHistCfgFromUi();
    startHistAutoPoll();
    histPull.disabled = true;
    try { await pullHistoryRemote(false); } finally { histPull.disabled = false; }
  });

  const histFile = $('#hist-file');
  if (histFile) histFile.addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const rows = parseHistoryPayload(await f.text());
      await loadExternalHistory(rows, `文件 ${f.name}`);
    } catch (err) {
      renderHistStatus([`⛔ 文件解析失败：${esc(errText(err))}`, '　支持 JSON（数组或 {records:[…]}）与 CSV（首行表头：应收单号, 已结算金额, 结算日期 …）'], 'err');
    }
  });

  const histSyncBtn = $('#hist-sync');
  if (histSyncBtn) histSyncBtn.addEventListener('click', async () => {
    readHistCfgFromUi();
    const res = await syncHistoryLedger(true);
    renderHistStatus([
      `🔄 已按当前数据源同步台账历史结算快照：${res ? res.count : 0} 行 / ¥${money(res ? res.total : 0)}`,
      `　${res && res.replaced ? `替换旧快照 ${res.replaced} 行 · ` : ''}应收单池 ${state.ars.length} 张 · 外部记录 ${state.historySource.records.length} 条`,
    ]);
  });

  const histClear = $('#hist-clear');
  if (histClear) histClear.addEventListener('click', async () => {
    state.historySource = { records: [], label: '' };
    histCfg.externalLabel = '';
    histCfgSave();
    histRecordsSave();
    await syncHistoryLedger(true);
    renderHistStatus(['🧹 已清除外部历史数据源（应收单池同步记录保留）']);
  });

  /* 页面重新可见 / 其他标签页写入台账 → 立即按指纹重查 */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tickLedger(false); });
  window.addEventListener('storage', e => {
    if (String((e && e.key) || '').indexOf('imp.') === 0) tickLedger(false);
  });

  /* 初始化：加载台账存储层与历史数据源 → 恢复演示应收单 → 同步历史快照 → 由台账重算余额与状态 */
  histCfg = histCfgLoad();
  syncHistCfgToUi();
  state.historySource = { records: histRecordsLoad(), label: histCfg.externalLabel || '' };
  await Store.init();
  $('#wo-backend').textContent = '存储：' + Store.backendName;
  await restorePools();      /* 恢复已持久化的发票池 / 应收单池；首次使用装入内置示例 */
  await syncHistoryLedger(true);   /* 台账有效记录重算发票状态与应收单余额 / 水位 */
  renderAll();
  startLedgerAutoRefresh();
  startHistAutoPoll();
});
