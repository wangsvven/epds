/* ========== routes/material-transfers ========== */
/* 材料「项目间调拨」（PLAN v2.2：一张单多行明细）
 * 一条记录 = 一次跨项目移动，可含多行材料（items[]）；库存效应全部由记录派生，不写材料行字段。
 * 状态机：草稿 → 已生效 →（借调所有行补满）已结清；已生效 → 已撤销。
 * 补回与作废补回都**按行**（itemId），每行各自记 returns[] 与未还余额。
 * 不走通用 CRUD 工厂：全部校验与状态转换都在本文件，写处理器内禁止 await。
 * 取号：DB-YYYYMMDD-NNNN，复用 core/doc-no 的 nextDocNo。 */
const app = require('../core/app');
const { DB, saveDB } = require('../core/db');
const { genId, fmtNow, bjStr } = require('../core/util');
const { roundQty, replayAvailability, availableAsOf, availableWithTransfers, timePart } = require('../core/material-calc');
const { nextDocNo, cmpDocNoTopToday } = require('../core/doc-no');

/* ---------- 业务日期（与 routes/materials 同口径） ---------- */
const BIZ_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKFILL_DAYS = 30;
function todayBizDate() { return bjStr().slice(0, 10); }
function isBizDate(s) {
  const v = String(s == null ? '' : s);
  if (!BIZ_DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
function shiftBizDate(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function bizDateError(label, val, reason) {
  if (!isBizDate(val)) return label + '格式应为 YYYY-MM-DD';
  const today = todayBizDate();
  if (val > today) return label + '不能晚于今天（' + today + '）';
  const limit = shiftBizDate(today, -BACKFILL_DAYS);
  if (val < limit && !String(reason == null ? '' : reason).trim()) {
    return label + '早于 ' + limit + '（超过 ' + BACKFILL_DAYS + ' 天），必须填写补录原因';
  }
  return '';
}
const dateTagOf = d => String(d || '').replace(/-/g, '');

/* ---------- 集合惰性初始化 ---------- */
function transfers() {
  if (!Array.isArray(DB.materialTransfers)) DB.materialTransfers = [];
  return DB.materialTransfers;
}

/* ---------- 派生量（读时算，不落库） ---------- */
function itemReturnedQty(it) {
  let q = 0;
  (it.returns || []).forEach(r => { if (r && !r.voided) q += Number(r.qty) || 0; });
  return roundQty(q);
}
function itemOutstandingQty(it) {
  return roundQty((Number(it.qty) || 0) - itemReturnedQty(it));
}
function recordReturnedQty(t) {
  let q = 0;
  (t.items || []).forEach(it => { q += itemReturnedQty(it); });
  return roundQty(q);
}
function recordOutstandingQty(t) {
  if (t.kind !== '借调') return 0;
  let q = 0;
  (t.items || []).forEach(it => { q += itemOutstandingQty(it); });
  return roundQty(q);
}
/* 借调整单是否所有行都补满 */
function allSettled(t) {
  return (t.items || []).every(it => itemOutstandingQty(it) <= 1e-9);
}
function itemView(it) {
  return Object.assign({}, it, { returnedQty: itemReturnedQty(it), outstandingQty: itemOutstandingQty(it) });
}
function viewOf(t) {
  return Object.assign({}, t, {
    items: (t.items || []).map(itemView),
    returnedQty: recordReturnedQty(t),
    outstandingQty: recordOutstandingQty(t),
  });
}

/* 调拨前后对比量（详情页用）
 * 口径：按业务日当天核算，**排除本单产生的事件（含其补回）**，得到「若没有这笔单」的余额；
 *       调出后 = 调出前 − 本单数量，调入后 = 调入前 + 本单数量。
 *       只反映这一笔调拨带来的变化，不含当天其它出入库的叠加差异（那些已在两侧余额里体现）。
 * available === null（业务日早于期初日）表示不可核算，前端显示 —。 */
function compareOfTransfer(t) {
  // 已撤销：本单不产生库存事件，谈「调拨前后」没有意义（会显示成好像真的调走了）→ 不给对比量
  if (t.status === '已撤销') return (t.items || []).map(it => ({ id: it.id, qty: roundQty(it.qty), voided: true }));
  const no = String(t.transferNo || '');
  const day = String(t.transferDate || '');
  // 已生效用落库时刻做同日切口，同日多笔互不干扰；草稿无时刻 → 按当日末预估
  const cutoff = timePart(t.effectedAtSec || t.effectedAt) || '';
  const val = (v) => (v === null || v === undefined ? null : roundQty(v));
  return (t.items || []).map(it => {
    const qty = roundQty(it.qty);
    const bf = val(availableAsOf(it.fromMaterialId, day, no || undefined, cutoff).available);
    const bt = val(availableAsOf(it.toMaterialId, day, no || undefined, cutoff).available);
    return {
      id: it.id,
      qty,
      fromBefore: bf, fromAfter: bf === null ? null : roundQty(bf - qty),
      toBefore: bt, toAfter: bt === null ? null : roundQty(bt + qty),
    };
  });
}

/* 净出库（与 routes/materials 的 outboundStats 同口径） */
function netOutboundOf(materialId) {
  let taken = 0, returned = 0;
  (DB.materialOutbound || []).forEach(o => {
    if (!o || o.deleted || o.status !== '有效') return;
    (o.items || []).forEach(it => {
      if (!it || it.materialId !== materialId) return;
      taken += Number(it.qty) || 0;
      returned += Number(it.returned) || 0;
    });
  });
  return roundQty(taken - returned);
}

/* ---------- 回放失败（与 routes/materials 同构；refs 带 type） ---------- */
function refOf(no) {
  const s = String(no || '');
  if (s.indexOf('OUT-') === 0) return { type: 'outbound', outNo: s };
  if (s.indexOf('LL-') === 0) return { type: 'requisition', reqNo: s };
  if (s.indexOf('DB-') === 0) return { type: 'transfer', transferNo: s };
  return { type: 'other', refNo: s };
}
function replayFail(res, m, rp, what) {
  const desc = (m && (m.description || m.code)) || '';
  const who = rp.self ? (what || '本单') : (rp.refNo || '历史单据');
  const verb = rp.kind === 'out' ? '出库' : '入库';
  const tail = rp.self ? (who + ' ' + rp.qty) : (who + ' ' + verb + ' ' + rp.qty);
  const msg = '补录后 ' + rp.firstNegativeDate + ' 物料「' + desc + '」可用库存将为负（当时可用 '
    + rp.available + '，' + tail + '）';
  const refs = rp.refNo ? [refOf(rp.refNo)] : [];
  return res.status(400).json({
    error: msg, date: rp.firstNegativeDate,
    materialId: m ? m.id : '', code: (m && m.code) || '', description: desc,
    available: rp.available, qty: rp.qty, refs
  });
}

/* ---------- 对齐与结构校验（OP-1 / Q8，逐行） ---------- */
const normDesc = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
const KINDS = ['调拨', '借调'];
const EDITABLE = ['kind', 'fromProject', 'toProject', 'items', 'transferDate', 'transferDateReason', 'reason'];

function matOf(id) {
  const s = String(id == null ? '' : id).trim();
  if (!s) return null;
  return (DB.materials || []).find(x => x && x.id === s && !x.deleted) || null;
}

/* 校验草稿输入（items 逐行）：
 * { kind, fromProject, toProject, items:[{id?, fromMaterialId, toMaterialId, qty}], transferDate, transferDateReason, reason }
 * 返回 { error } 或 { fields, rows:[{from,to,qty}] } */
function checkDraft(input) {
  const kind = String(input.kind == null ? '' : input.kind);
  if (KINDS.indexOf(kind) < 0) return { error: '类型必须是「调拨」或「借调」' };

  const fromProject = String(input.fromProject == null ? '' : input.fromProject).trim();
  const toProject = String(input.toProject == null ? '' : input.toProject).trim();
  if (!fromProject) return { error: '请选择调出项目' };
  if (!toProject) return { error: '请选择调入项目' };
  if (fromProject === toProject) return { error: '调出项目与调入项目不能相同' };

  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) return { error: '请至少添加一行调拨材料' };

  const fields = [];
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] || {};
    const label = '第 ' + (i + 1) + ' 行';
    const from = matOf(raw.fromMaterialId);
    if (!from) return { error: label + '：调出材料行不存在或已删除' };
    const to = matOf(raw.toMaterialId);
    if (!to) return { error: label + '：调入材料行不存在（请先在调入项目台账建行）' };
    if (String(from.project || '') !== fromProject) return { error: label + '：调出项目与调出材料行归属不一致（应以材料行为准）' };
    if (String(to.project || '') !== toProject) return { error: label + '：调入项目与调入材料行归属不一致（应以材料行为准）' };
    if (seen.has(from.id)) return { error: label + '：同一张单里同一调出材料行只能出现一次' };
    seen.add(from.id);
    if (String(from.code || '') !== String(to.code || '')) {
      return { error: label + '：两侧材料编码不一致（' + (from.code || '空') + ' / ' + (to.code || '空') + '），不能调拨' };
    }
    if (String(from.unit || '') !== String(to.unit || '')) {
      return { error: label + '：两侧单位不一致（' + (from.unit || '空') + ' / ' + (to.unit || '空') + '），系统不做单位换算' };
    }
    const df = normDesc(from.description), dt = normDesc(to.description);
    if (df !== dt) {
      return { error: label + '：两侧材料描述不一致：调出「' + String(from.description || '') + '」／调入「' + String(to.description || '') + '」。请先在台账统一描述后再调拨' };
    }
    const qty = roundQty(Number(raw.qty));
    if (!(qty > 0)) return { error: label + '：数量必须大于 0' };
    fields.push({
      id: String(raw.id || '').trim() || genId('mti'),
      fromMaterialId: from.id, toMaterialId: to.id,
      code: String(from.code || ''), description: String(from.description || ''), unit: String(from.unit || ''),
      qty,
      returns: Array.isArray(raw.returns) ? raw.returns : [],
    });
    rows.push({ from, to, qty });
  }

  const transferDate = String(input.transferDate == null ? '' : input.transferDate).trim();
  const dErr = bizDateError('调拨日期', transferDate, input.transferDateReason);
  if (dErr) return { error: dErr };

  const reason = String(input.reason == null ? '' : input.reason).trim();
  if (!reason) return { error: '请填写调拨原因' };

  return {
    rows,
    fields: {
      kind, fromProject, toProject, items: fields,
      transferDate, transferDateReason: String(input.transferDateReason == null ? '' : input.transferDateReason).trim(),
      reason,
    },
  };
}

/* 期初边界：涉及的材料行有 openingDate 时，业务日不得早于它 */
function openingBoundaryError(ok, day) {
  for (let i = 0; i < ok.rows.length; i++) {
    const r = ok.rows[i];
    const pairs = [['调出行', r.from], ['调入行', r.to]];
    for (let k = 0; k < pairs.length; k++) {
      const label = pairs[k][0], m = pairs[k][1];
      const od = String(m.openingDate || '').slice(0, 10);
      if (od && day < od) {
        return '第 ' + (i + 1) + ' 行' + label + '「' + (m.description || m.code) + '」已设期初日 ' + od + '，业务日期不能早于期初日（期初之前无法核算）';
      }
    }
  }
  return '';
}

/* saveDB 失败 → 撤销内存变更并返回 500 */
function saveOrRollback(res, undo) {
  try {
    saveDB();
    return true;
  } catch (e) {
    try { undo(); } catch (e2) {}
    res.status(500).json({ error: '保存失败，数据未变更（' + (e && e.message ? e.message : '写盘错误') + '）' });
    return false;
  }
}

/* ================= 列表 ================= */
app.get('/api/materialTransfers', (req, res) => {
  const project = String(req.query.project || '').trim();
  const direction = String(req.query.direction || 'all').trim();
  const kind = String(req.query.kind || '').trim();
  const status = String(req.query.status || '').trim();
  const outstandingOnly = String(req.query.outstandingOnly || '') === '1';
  const today = todayBizDate();

  let list = transfers().filter(t => t && !t.deleted);
  if (project) {
    if (direction === 'in') list = list.filter(t => t.toProject === project);
    else if (direction === 'out') list = list.filter(t => t.fromProject === project);
    else list = list.filter(t => t.fromProject === project || t.toProject === project);
  }
  if (kind) list = list.filter(t => t.kind === kind);
  if (status) list = list.filter(t => t.status === status);
  if (outstandingOnly) list = list.filter(t => t.kind === '借调' && recordOutstandingQty(t) > 0);

  list = list.slice().sort((a, b) => {
    const an = String(a.transferNo || ''), bn = String(b.transferNo || '');
    if (!an || !bn) {
      const ad = String(a.transferDate || ''), bd = String(b.transferDate || '');
      const at = ad === today, bt = bd === today;
      if (at !== bt) return at ? -1 : 1;
      if (ad !== bd) return ad < bd ? -1 : 1;
      if (an && !bn) return -1;
      if (!an && bn) return 1;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    }
    return cmpDocNoTopToday(an, bn, today);
  });
  res.json(list.map(viewOf));
});

/* ================= 详情 ================= */
app.get('/api/materialTransfers/:id', (req, res) => {
  const t = transfers().find(x => x && x.id === req.params.id && !x.deleted);
  if (!t) return res.status(404).json({ error: '调拨单不存在' });
  const v = viewOf(t);
  const cmp = compareOfTransfer(t);
  v.items = v.items.map(it => Object.assign({}, it, { compare: cmp.find(c => c.id === it.id) || null }));
  v.compareBasis = '按业务日核算，不含本单及其补回';
  res.json(v);
});

/* ================= OP-1 新建草稿 ================= */
app.post('/api/materialTransfers', (req, res) => {
  const ok = checkDraft(req.body || {});
  if (ok.error) return res.status(400).json({ error: ok.error });

  const rec = Object.assign({
    id: genId('mt'),
    transferNo: '',
    status: '草稿',
    operator: (req.user && (req.user.name || req.user.username)) || '',
    operatorAccount: (req.user && req.user.username) || '',
    createdAt: fmtNow(),
    effectedAt: '', settledAt: '', voidedAt: '', voidReason: '',
    deleted: false,
  }, ok.fields);

  const list = transfers();
  list.push(rec);
  const saved = saveOrRollback(res, () => {
    const i = list.indexOf(rec);
    if (i >= 0) list.splice(i, 1);
  });
  if (!saved) return;
  res.json({ ok: true, data: viewOf(rec) });
});

/* ================= OP-2 编辑草稿 ================= */
app.put('/api/materialTransfers/:id', (req, res) => {
  const list = transfers();
  const rec = list.find(x => x && x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '调拨单不存在' });
  if (rec.status !== '草稿') return res.status(400).json({ error: '只有草稿可以编辑（当前状态：' + rec.status + '）' });

  const b = req.body || {};
  const extra = Object.keys(b).filter(k => EDITABLE.indexOf(k) < 0);
  if (extra.length) return res.status(400).json({ error: '不允许修改字段：' + extra.join('、') });

  const merged = {
    kind: b.kind === undefined ? rec.kind : b.kind,
    fromProject: b.fromProject === undefined ? rec.fromProject : b.fromProject,
    toProject: b.toProject === undefined ? rec.toProject : b.toProject,
    items: b.items === undefined ? (rec.items || []) : b.items,
    transferDate: b.transferDate === undefined ? rec.transferDate : b.transferDate,
    transferDateReason: b.transferDateReason === undefined ? rec.transferDateReason : b.transferDateReason,
    reason: b.reason === undefined ? rec.reason : b.reason,
  };
  const ok = checkDraft(merged);
  if (ok.error) return res.status(400).json({ error: ok.error });

  const backup = JSON.parse(JSON.stringify(rec));
  Object.assign(rec, ok.fields);
  const saved = saveOrRollback(res, () => { Object.assign(rec, backup); });
  if (!saved) return;
  res.json({ ok: true, data: viewOf(rec) });
});

/* ================= OP-3 删除草稿（逻辑删除） ================= */
app.delete('/api/materialTransfers/:id', (req, res) => {
  const rec = transfers().find(x => x && x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '调拨单不存在' });
  // 草稿可直接删；已撤销也允许删除（撤销后单据不再产生任何库存事件，删除只是从列表清理，与领料单「作废→删除」一致）
  if (rec.status !== '草稿' && rec.status !== '已撤销') {
    return res.status(400).json({ error: '只有草稿或已撤销的单据可以删除（当前状态：' + rec.status + '）' });
  }

  rec.deleted = true;
  const saved = saveOrRollback(res, () => { rec.deleted = false; });
  if (!saved) return;
  res.json({ ok: true });
});

/* ================= OP-4 生效 ================= */
app.put('/api/materialTransfers/:id/effect', (req, res) => {
  const rec = transfers().find(x => x && x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '调拨单不存在' });
  if (rec.status !== '草稿') return res.status(400).json({ error: '只有草稿可以生效（当前状态：' + rec.status + '）' });

  const ok = checkDraft(rec);
  if (ok.error) return res.status(400).json({ error: ok.error });

  const obErr = openingBoundaryError(ok, ok.fields.transferDate);
  if (obErr) return res.status(400).json({ error: obErr });

  // 聚合校验：逐行检查调出侧当前可用（同一调出材料行只允许一行，逐行判断即可）
  for (let i = 0; i < ok.rows.length; i++) {
    const r = ok.rows[i];
    const avail = availableWithTransfers(r.from, netOutboundOf(r.from.id));
    // 入库量为 0 / 可用为 0 的行不能调拨（未到货数量不参与调拨，口径与 S3 的可用量一致）
    if (roundQty(avail) <= 0) {
      const why = roundQty(r.from.qtyArrived) <= 0 ? '入库量为 0' : '可用为 0（已全部出库或调出）';
      return res.status(400).json({
        error: '第 ' + (i + 1) + ' 行：物料「' + (r.from.description || r.from.code) + '」' + why + '，不能调拨'
      });
    }
    if (roundQty(avail - r.qty) < -1e-9) {
      return res.status(400).json({
        error: '第 ' + (i + 1) + ' 行调出侧可用不足：物料「' + (r.from.description || r.from.code)
          + '」当前可用 ' + avail + '，本次调出 ' + r.qty + '（未到货数量不参与调拨）'
      });
    }
  }

  // 全历史回放：逐行注入（调出侧 out / 调入侧 in）；同一材料行仅一行，逐行判定等价于合并注入
  for (let i = 0; i < ok.rows.length; i++) {
    const r = ok.rows[i];
    const rpFrom = replayAvailability(r.from.id, [{ date: ok.fields.transferDate, kind: 'out', qty: r.qty, self: true, label: '本单调拨' }]);
    if (!rpFrom.ok) return replayFail(res, r.from, rpFrom, '本单调拨');
    const rpTo = replayAvailability(r.to.id, [{ date: ok.fields.transferDate, kind: 'in', qty: r.qty, self: true, label: '本单调拨' }]);
    if (!rpTo.ok) return replayFail(res, r.to, rpTo, '本单调拨');
  }

  const backup = JSON.parse(JSON.stringify(rec));
  rec.transferNo = nextDocNo(transfers(), 'transferNo', 'DB-' + dateTagOf(ok.fields.transferDate) + '-');
  rec.status = '已生效';
  rec.effectedAt = fmtNow();
  rec.effectedAtSec = bjStr(undefined, true);   // 秒级，供详情「调拨前后」同日排序
  const saved = saveOrRollback(res, () => { Object.assign(rec, backup); });
  if (!saved) return;
  res.json({ ok: true, data: viewOf(rec) });
});

/* ================= OP-5 借调补回（按行：itemId 必填） ================= */
app.put('/api/materialTransfers/:id/return', (req, res) => {
  const rec = transfers().find(x => x && x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '调拨单不存在' });
  if (rec.kind !== '借调') return res.status(400).json({ error: '只有借调单可以补回（调拨单无需归还）' });
  if (rec.status !== '已生效') return res.status(400).json({ error: '只有已生效的借调单可以补回（当前状态：' + rec.status + '）' });

  const b = req.body || {};
  const itemId = String(b.itemId || '').trim();
  const it = (rec.items || []).find(x => x && x.id === itemId);
  if (!it) return res.status(400).json({ error: '请选择要补回的明细行（itemId 无效）' });

  const qty = roundQty(Number(b.qty));
  if (!(qty > 0)) return res.status(400).json({ error: '补回数量必须大于 0' });

  const returned = itemReturnedQty(it);
  const rest = roundQty((Number(it.qty) || 0) - returned);
  if (roundQty(qty - rest) > 1e-9) {
    return res.status(400).json({ error: '该行补回数量超过未还余额（未还 ' + rest + '，本次 ' + qty + '）' });
  }

  const returnDate = String(b.returnDate == null ? '' : b.returnDate).trim();
  const dErr = bizDateError('补回日期', returnDate, b.returnDateReason);
  if (dErr) return res.status(400).json({ error: dErr });
  if (returnDate < String(rec.transferDate || '')) {
    return res.status(400).json({ error: '补回日期不能早于调拨日期（' + rec.transferDate + '）' });
  }
  const openReturns = (it.returns || []).filter(r => r && !r.voided);
  if (openReturns.length) {
    const last = String(openReturns[openReturns.length - 1].returnDate || '');
    if (last && returnDate < last) {
      return res.status(400).json({ error: '补回日期不能早于该行上一笔补回日期（' + last + '）' });
    }
  }

  const toMat = matOf(it.toMaterialId);
  if (!toMat) return res.status(400).json({ error: '调入材料行已删除，无法补回' });
  const toAvail = availableAsOf(it.toMaterialId, returnDate);
  if (toAvail.available !== null && roundQty(qty - toAvail.available) > 1e-9) {
    return res.status(400).json({ error: '调入侧截至 ' + returnDate + ' 可用仅 ' + toAvail.available + '，不足以补回 ' + qty });
  }

  const rpTo = replayAvailability(it.toMaterialId, [{ date: returnDate, kind: 'out', qty, self: true, label: '本单补回' }]);
  if (!rpTo.ok) return replayFail(res, toMat, rpTo, '本单补回');
  const fromMat = matOf(it.fromMaterialId);
  if (!fromMat) return res.status(400).json({ error: '调出材料行已删除，无法补回' });
  const rpFrom = replayAvailability(it.fromMaterialId, [{ date: returnDate, kind: 'in', qty, self: true, label: '本单补回' }]);
  if (!rpFrom.ok) return replayFail(res, fromMat, rpFrom, '本单补回');

  const backup = JSON.parse(JSON.stringify(rec));
  it.returns = (it.returns || []).concat([{
    at: fmtNow(), returnDate,
    returnDateReason: String(b.returnDateReason == null ? '' : b.returnDateReason).trim(),
    qty,
    by: (req.user && (req.user.name || req.user.username)) || '',
    byAccount: (req.user && req.user.username) || '',
  }]);
  if (allSettled(rec)) { rec.status = '已结清'; rec.settledAt = fmtNow(); }
  const saved = saveOrRollback(res, () => { Object.assign(rec, backup); });
  if (!saved) return;
  res.json({ ok: true, data: viewOf(rec) });
});

/* ================= OP-8 作废补回（按行；只作用于该行最近一笔未作废） ================= */
app.put('/api/materialTransfers/:id/return/void', (req, res) => {
  const rec = transfers().find(x => x && x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '调拨单不存在' });
  if (rec.kind !== '借调') return res.status(400).json({ error: '只有借调单有补回记录' });
  if (rec.status !== '已生效' && rec.status !== '已结清') {
    return res.status(400).json({ error: '当前状态不可作废补回（' + rec.status + '）' });
  }
  const b = req.body || {};
  const reason = String(b.reason == null ? '' : b.reason).trim();
  if (!reason) return res.status(400).json({ error: '请填写作废原因' });

  const itemId = String(b.itemId || '').trim();
  let it = null;
  if (itemId) it = (rec.items || []).find(x => x && x.id === itemId) || null;
  if (!it) {
    // 未指定行：在所有「有未作废补回」的行里取最近一笔（returnDate + at 最大）所属的行
    let best = null;
    (rec.items || []).forEach(x => {
      (x.returns || []).forEach(r => {
        if (!r || r.voided) return;
        const key = String(r.returnDate || '') + ' ' + String(r.at || '');
        if (!best || key > best.key) best = { key, it: x };
      });
    });
    it = best ? best.it : null;
  }
  if (!it) return res.status(400).json({ error: '没有可作废的补回记录' });

  let idx = -1;
  (it.returns || []).forEach((r, i) => { if (r && !r.voided) idx = i; });
  if (idx < 0) return res.status(400).json({ error: '该行没有可作废的补回记录' });

  const r = it.returns[idx];
  const qty = roundQty(Number(r.qty));
  const rd = String(r.returnDate || '').slice(0, 10);

  const fromMat = matOf(it.fromMaterialId);
  if (!fromMat) return res.status(400).json({ error: '调出材料行已删除，无法作废补回' });
  const rpFrom = replayAvailability(it.fromMaterialId, [{ date: rd, kind: 'out', qty, self: true, label: '作废该笔补回' }]);
  if (!rpFrom.ok) return replayFail(res, fromMat, rpFrom, '作废该笔补回');
  const toMat = matOf(it.toMaterialId);
  if (!toMat) return res.status(400).json({ error: '调入材料行已删除，无法作废补回' });
  const rpTo = replayAvailability(it.toMaterialId, [{ date: rd, kind: 'in', qty, self: true, label: '作废该笔补回' }]);
  if (!rpTo.ok) return replayFail(res, toMat, rpTo, '作废该笔补回');

  const backup = JSON.parse(JSON.stringify(rec));
  r.voided = true;
  r.voidedAt = fmtNow();
  r.voidReason = reason;
  r.voidedBy = (req.user && (req.user.name || req.user.username)) || '';
  // 已结清但作废后重新出现未还 → 退回已生效
  if (rec.status === '已结清' && !allSettled(rec)) { rec.status = '已生效'; rec.settledAt = ''; }
  const saved = saveOrRollback(res, () => { Object.assign(rec, backup); });
  if (!saved) return;
  res.json({ ok: true, data: viewOf(rec) });
});

/* ================= OP-6 撤销（整单） ================= */
app.put('/api/materialTransfers/:id/void', (req, res) => {
  const rec = transfers().find(x => x && x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '调拨单不存在' });
  if (rec.status !== '已生效') return res.status(400).json({ error: '只有已生效的调拨单可以撤销（当前状态：' + rec.status + '）' });

  const reason = String((req.body || {}).reason == null ? '' : (req.body || {}).reason).trim();
  if (!reason) return res.status(400).json({ error: '请填写撤销原因' });

  if (rec.kind === '借调' && recordReturnedQty(rec) > 0) {
    return res.status(400).json({ error: '该借调单已有补回记录，不能整单撤销；请继续补回至结清，或先作废补回记录' });
  }

  const day = String(rec.transferDate || '');
  for (let i = 0; i < (rec.items || []).length; i++) {
    const it = rec.items[i];
    const fromMat = matOf(it.fromMaterialId);
    if (!fromMat) return res.status(400).json({ error: '第 ' + (i + 1) + ' 行调出材料行已删除，无法撤销' });
    const toMat = matOf(it.toMaterialId);
    if (!toMat) return res.status(400).json({ error: '第 ' + (i + 1) + ' 行调入材料行已删除，无法撤销' });
    const qty = roundQty(Number(it.qty));
    const rpFrom = replayAvailability(it.fromMaterialId, [{ date: day, kind: 'in', qty, self: true, label: '撤销本单' }]);
    if (!rpFrom.ok) return replayFail(res, fromMat, rpFrom, '撤销本单');
    const rpTo = replayAvailability(it.toMaterialId, [{ date: day, kind: 'out', qty, self: true, label: '撤销本单' }]);
    if (!rpTo.ok) return replayFail(res, toMat, rpTo, '撤销本单');
  }

  const backup = { status: rec.status, voidedAt: rec.voidedAt, voidReason: rec.voidReason };
  rec.status = '已撤销';
  rec.voidedAt = fmtNow();
  rec.voidReason = reason;
  const saved = saveOrRollback(res, () => Object.assign(rec, backup));
  if (!saved) return;
  res.json({ ok: true, data: viewOf(rec) });
});

module.exports = { transfers };
