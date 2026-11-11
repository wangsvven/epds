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
 * 归还（returnDate）摆到时间轴上，从涉及的最早业务日起逐日累加，任一天可用 < 0 即拒绝。
 * 同日顺序固定为「先入库/归还，后出库」：同一天先入后出必须能过，先出后入必须被拒。
 * 作废的领料单、作废的出库单都不产生事件（其数量已经从材料账上冲销）。
 * 只算、不写库；extraEvents 用于把「即将写入、尚未 saveDB」的变动纳入试算：
 *   { date, kind: 'in'|'out', qty, refNo?, self?, label? }，冲销用负数 kind:'in'。
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayPart(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  return DAY_RE.test(s) ? s : '';
}
function eventsOf(materialId) {
  const DB = DB_();
  const out = [];
  (DB.materialRequisitions || []).forEach(r => {
    if (!r || r.deleted || r.status === '已作废') return;
    if (!(r.items || []).some(it => it && it.materialId === materialId)) return;
    (r.history || []).forEach(h => {
      const row = (h && h.rows || []).find(x => x && x.materialId === materialId);
      const qty = Number(row && row.thisQty) || 0;
      if (qty <= 0) return;
      const d = dayPart(h.arrivalDate) || dayPart(h.at) || dayPart(r.confirmedAt) || dayPart(r.reqDate);
      if (!d) return; // 没有可用日期的事件不参与回放（迁移已保证新库都有）
      out.push({ date: d, kind: 'in', qty, refNo: r.reqNo || '', self: false });
    });
  });
  (DB.materialOutbound || []).forEach(o => {
    if (!o || o.deleted || o.status !== '有效') return;
    const it = (o.items || []).find(x => x && x.materialId === materialId);
    if (!it) return;
    const d = dayPart(o.outDate);
    const qty = Number(it.qty) || 0;
    if (d && qty > 0) out.push({ date: d, kind: 'out', qty, refNo: o.outNo || '', self: false });
    (o.returns || []).forEach(x => {
      const row = (x && x.rows || []).find(y => y && y.materialId === materialId);
      const rq = Number(row && row.qty) || 0;
      if (rq <= 0) return;
      const rd = dayPart(x.returnDate) || d;
      if (!rd) return;
      out.push({ date: rd, kind: 'in', qty: rq, refNo: o.outNo || '', self: false });
    });
  });
  return out;
}
function replayAvailability(materialId, extraEvents) {
  const events = eventsOf(materialId);
  (extraEvents || []).forEach(e => {
    const d = dayPart(e.date);
    const qty = Number(e.qty) || 0;
    if (!d || !qty) return;
    events.push({
      date: d, kind: e.kind === 'out' ? 'out' : 'in', qty,
      refNo: String(e.refNo || ''), self: !!e.self, label: String(e.label || '')
    });
  });
  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === 'in' ? -1 : 1;
    return 0;
  });
  let avail = 0, i = 0;
  while (i < events.length) {
    const date = events[i].date;
    // 当日先入（含归还、作废冲销负数）
    while (i < events.length && events[i].date === date && events[i].kind === 'in') {
      const e = events[i];
      const before = avail;
      avail = roundQty(avail + e.qty);
      if (avail < -1e-9) {
        return { ok: false, firstNegativeDate: date, available: before, qty: Math.abs(e.qty), refNo: e.refNo, self: e.self, label: e.label, kind: 'in' };
      }
      i++;
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
