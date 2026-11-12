/* ========== core/material-calc ========== */
/* 材料数量与到库状态计算（数据迁移与材料接口共用）：已生成领料量、在途未入库余量、到库状态、数量四舍五入。 */
// 延迟取库：db.js 的迁移会调用 materialStatus，这里若在顶层 require('./db') 会形成循环依赖
function DB_() { return require('./db').DB; }

function roundQty(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

function qtyGeneratedOf(m) {
  let g = 0;
  DB_().materialRequisitions.forEach(r => {
    if (r.deleted || r.status === '已作废') return;
    (r.items || []).forEach(it => {
      if (it.materialId === m.id) g += Number(it.qty) || 0;
    });
  });
  return roundQty(g);
}
// 在途未入库余量 = 同空间待入库/部分到库领料单中该物料尚未入库的数量合计（用于计算可继续领料）
function qtyOutstandingOf(m) {
  let o = 0;
  DB_().materialRequisitions.forEach(r => {
    if (r.deleted) return;
    if (r.status !== '待入库' && r.status !== '部分到库') return;
    (r.items || []).forEach(it => {
      if (it.materialId !== m.id) return;
      const cr = (r.confirmRows || []).find(c => c.materialId === it.materialId);
      o += Math.max(0, (Number(it.qty) || 0) - (Number(cr && cr.thisQty) || 0));
    });
  });
  return roundQty(o);
}
function withGen(m) {
  const gen = qtyGeneratedOf(m);
  const canGen = roundQty(Math.max(0, m.qtyNotArrived - qtyOutstandingOf(m)));
  return { ...m, qtyGenerated: gen, qtyCanGen: canGen, status: materialStatus(m) };
}
function materialStatus(m) {
  if (Number(m.qtyRequired) > 0 && m.qtyArrived >= m.qtyRequired) return '全部到库';
  if (m.qtyArrived > 0) return '部分到库'; // 已有入库数量时到货情况优先（可继续领料仍按未到余量-已生成计算）
  if (qtyGeneratedOf(m) > 0) return '已生成领料单'; // 未入库但有领料单在途（剩余量仍可继续领料）
  return '未到库';
}

/* ---------- 按业务日期回放库存（P4-4） ----------
 * 口径：以材料行 id（不是编码）为准，把该材料的入库（arrivalDate）、出库（outDate）、
 * 归还（returnDate）摆到时间轴上，逐日累加，任一天可用 < 0 即拒绝。
 * 同日顺序固定为「先入库/归还，后出库」：同一天先入后出必须能过，先出后入必须被拒。
 * 作废的领料单、作废的出库单都不产生事件（其数量已经从材料账上冲销）。
 *
 * 期初余额（openingAvailable / openingDate / openingAt）：
 *   迁移那一刻按「已到 − 有效出库净额」给每条材料写死一个期初值，回放从期初起算；
 *   创建时间不晚于 openingAt 的流水已经包含在期初里，不再重复参与判定——老账里的历史负数
 *   从此不卡新单，问题留给 P0-4 报告人工处理。
 *   期初之前（业务日 < openingDate）后补的新单并入期初基数，不做负库存判定。
 *
 * 只算、不写库；extraEvents 用于把「即将写入、尚未 saveDB」的变动纳入试算：
 *   { date, kind: 'in'|'out', qty, refNo?, self?, label? }，冲销用负数 kind:'in'。
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayPart(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  return DAY_RE.test(s) ? s : '';
}
function timePart(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 16);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? s : '';
}
function eventsOf(materialId) {
  const DB = DB_();
  const out = [];
  (DB.materialRequisitions || []).forEach(r => {
    if (!r || r.deleted || r.status === '已作废') return;
    if (!(r.items || []).some(it => it && it.materialId === materialId)) return;
    (r.history || []).forEach(h => {
      const row = (h && h.rows || []).find(x => x && x.materialId === materialId);
      // P4-7：冲销行是负数，必须按代数和计入（不能因为 thisQty <= 0 就跳过）；0 无影响可跳
      const qty = Number(row && row.thisQty) || 0;
      if (!qty) return;
      const d = dayPart(h.arrivalDate) || dayPart(h.at) || dayPart(r.confirmedAt) || dayPart(r.reqDate);
      if (!d) return; // 没有可用日期的事件不参与回放（迁移已保证新库都有）
      out.push({ date: d, kind: 'in', qty, refNo: r.reqNo || '', self: false, at: timePart(h.at) || timePart(r.confirmedAt) });
    });
  });
  (DB.materialOutbound || []).forEach(o => {
    if (!o || o.deleted || o.status !== '有效') return;
    // P4-9：出库以 entries 为准（原出库 / 冲销 / 更正）。冲销对库存是正方向（kind:'in'），
    // 更正仍是出库（kind:'out'）；这样改型号时 A 的原出库与冲销同日代数和为 0，不会误判 A 为负。
    const entries = Array.isArray(o.entries) && o.entries.length ? o.entries : null;
    if (entries) {
      entries.forEach(e => {
        const row = ((e && e.rows) || []).find(x => x && x.materialId === materialId);
        const qty = Number(row && row.qty) || 0;
        if (!qty) return;
        const d = dayPart(e.outDate) || dayPart(o.outDate);
        if (!d) return;
        const at = e.kind === 'orig'
          ? (timePart(o.createdAt) || timePart(e.at))
          : (timePart(e.at) || timePart(o.createdAt));
        out.push({
          date: d,
          kind: e.direction === 'in' ? 'in' : 'out',
          qty: Math.abs(qty),
          refNo: o.outNo || '',
          self: false,
          at
        });
      });
    } else {
      // 迁移前的兜底（正常库在 20261112-outbound-entry-ids 后不会走到）
      const it = (o.items || []).find(x => x && x.materialId === materialId);
      if (it) {
        const d = dayPart(o.outDate);
        const qty = Number(it.qty) || 0;
        if (d && qty > 0) out.push({ date: d, kind: 'out', qty, refNo: o.outNo || '', self: false, at: timePart(o.createdAt) });
      }
    }
    (o.returns || []).forEach(x => {
      const row = (x && x.rows || []).find(y => y && y.materialId === materialId);
      const rq = Number(row && row.qty) || 0;
      if (rq <= 0) return;
      const rd = dayPart(x.returnDate) || dayPart(o.outDate);
      if (!rd) return;
      out.push({ date: rd, kind: 'in', qty: rq, refNo: o.outNo || '', self: false, at: timePart(x.at) });
    });
  });
  return out;
}
function replayAvailability(materialId, extraEvents) {
  const DB = DB_();
  const mat = (DB.materials || []).find(x => x && x.id === materialId);
  const openingDate = dayPart(mat && mat.openingDate);
  const openingAt = timePart(mat && mat.openingAt);
  const opening = roundQty(Number(mat && mat.openingAvailable) || 0);
  let events = eventsOf(materialId);
  (extraEvents || []).forEach(e => {
    const d = dayPart(e.date);
    const qty = Number(e.qty) || 0;
    if (!d || !qty) return;
    events.push({
      date: d, kind: e.kind === 'out' ? 'out' : 'in', qty,
      refNo: String(e.refNo || ''), self: !!e.self, label: String(e.label || ''), at: ''
    });
  });
  // 期初：截止时刻之前的流水已含在 openingAvailable 里；期初之前后补的流水并入基数（不判负）
  let base = opening;
  if (openingDate) {
    const kept = [];
    events.forEach(e => {
      if (openingAt && e.at && e.at <= openingAt) return; // 已含在期初
      if (e.date < openingDate) { base = roundQty(base + (e.kind === 'in' ? e.qty : -e.qty)); return; }
      kept.push(e);
    });
    events = kept;
  }
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'in' ? -1 : 1;
    return 0;
  });
  let avail = base, i = 0;
  while (i < events.length) {
    const date = events[i].date;
    // 当日先入（含归还、作废冲销负数）
    // P4-7：同一天的「冲销 + 更正」必须整组入账后再判负——否则 −10 与 +10 会中途判负，
    // 把「只改到货日、净额不变」这种正常更正误杀。取该组里第一个致负的事件做报错依据。
    let neg = null;
    while (i < events.length && events[i].date === date && events[i].kind === 'in') {
      const e = events[i];
      const before = avail;
      avail = roundQty(avail + e.qty);
      if (avail < -1e-9 && !neg) neg = { before, qty: Math.abs(e.qty), refNo: e.refNo, self: e.self, label: e.label };
      i++;
    }
    if (avail < -1e-9 && neg) {
      return { ok: false, firstNegativeDate: date, available: neg.before, qty: neg.qty, refNo: neg.refNo, self: neg.self, label: neg.label, kind: 'in' };
    }
    // 当日再出
    while (i < events.length && events[i].date === date && events[i].kind === 'out') {
      const e = events[i];
      const before = avail;
      avail = roundQty(avail - e.qty);
      if (avail < -1e-9) {
        return { ok: false, firstNegativeDate: date, available: before, qty: e.qty, refNo: e.refNo, self: e.self, label: e.label, kind: 'out' };
      }
      i++;
    }
  }
  return { ok: true, firstNegativeDate: '', available: avail, qty: 0, refNo: '', self: false, label: '', kind: '' };
}

module.exports = { roundQty, qtyGeneratedOf, qtyOutstandingOf, withGen, materialStatus, eventsOf, replayAvailability };
