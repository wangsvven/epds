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
      const qty = Number(row && row.thisQty) || 0;
      if (qty <= 0) return;
      const d = dayPart(h.arrivalDate) || dayPart(h.at) || dayPart(r.confirmedAt) || dayPart(r.reqDate);
      if (!d) return; // 没有可用日期的事件不参与回放（迁移已保证新库都有）
      out.push({ date: d, kind: 'in', qty, refNo: r.reqNo || '', self: false, at: timePart(h.at) || timePart(r.confirmedAt) });
    });
  });
  (DB.materialOutbound || []).forEach(o => {
    if (!o || o.deleted || o.status !== '有效') return;
    const it = (o.items || []).find(x => x && x.materialId === materialId);
    if (!it) return;
    const d = dayPart(o.outDate);
    const qty = Number(it.qty) || 0;
    if (d && qty > 0) out.push({ date: d, kind: 'out', qty, refNo: o.outNo || '', self: false, at: timePart(o.createdAt) });
    (o.returns || []).forEach(x => {
      const row = (x && x.rows || []).find(y => y && y.materialId === materialId);
      const rq = Number(row && row.qty) || 0;
      if (rq <= 0) return;
      const rd = dayPart(x.returnDate) || d;
      if (!rd) return;
      out.push({ date: rd, kind: 'in', qty: rq, refNo: o.outNo || '', self: false, at: timePart(x.at) });
    });
  });
  return out;
}
/* ---------- 期初回补（只读派生，不写库） ----------
 * 期初余额是迁移那一刻的冻结快照：迁移前已存在的领料单/出库单已被折算进 openingAvailable。
 * 这些单据之后被作废（删除只发生在作废之后）时，opening 不会自己变，而它们也不再产生事件，
 * 于是「截至日回放」与「当前聚合（qtyArrived − 有效出库净额）」永久分叉：
 *   作废迁移前的出库单 → 聚合补回、回放仍扣（回放偏低，极端情况给出负数可用）
 *   作废迁移前的领料单 → 聚合冲销、回放仍计（回放偏高）
 * 这里在读取时把差额算回来，时间口径与 eventsOf 同源：
 *   出库：迁移前已存在（createdAt ≤ openingAt）且迁移后作废 → + 当时的净额（qty − 当时已归还）
 *   领料：迁移前已入库（history.at ≤ openingAt）且迁移后作废 → − 当时的入库合计
 *
 * 安全阀：只有「期初能被迁移口径解释」时才回补，即
 *   openingAvailable === max(0, 已到(openingAt) − 有效出库净额(openingAt))
 * 解释不通（期初来自别的数据源：老账、数据搬家、手工改库）一律不回补，沿用原值，
 * 这类不一致交 P0-4 只读报告，不在库存算法里猜。
 *
 * 全程只读、不改任何字段：存量库换上新代码即自动归位，不需要数据迁移。
 */
function openingAdjustOf(materialId) {
  const DB = DB_();
  const mat = (DB.materials || []).find(x => x && x.id === materialId);
  const openingAt = timePart(mat && mat.openingAt);
  if (!mat || !openingAt) return 0;   // 无期初时刻（迁移后新建的材料）→ 没有冻结基数要修
  const openingDate = dayPart(mat.openingDate);
  const leT = v => { const s = timePart(v); return !!s && s <= openingAt; };
  const gtT = v => { const s = timePart(v); return !!s && s > openingAt; };
  let arrivedAtT = 0, netAtT = 0, voidedOut = 0, voidedIn = 0;
  // 领料：还原「迁移那一刻的已到」，并记下迁移后才作废的单据当时已入库的量
  (DB.materialRequisitions || []).forEach(r => {
    if (!r) return;
    if (r.status === '已作废' && !gtT(r.voidedAt)) return;  // 迁移前就作废：当时既未入已到，也未进期初
    let qtyAtT = 0;
    (r.history || []).forEach(h => {
      if (!leT(h && h.at)) return;
      const row = (h.rows || []).find(x => x && x.materialId === materialId);
      qtyAtT += Number(row && row.thisQty) || 0;
    });
    if (!(qtyAtT > 0)) return;
    arrivedAtT = roundQty(arrivedAtT + qtyAtT);
    if (r.status === '已作废') voidedIn = roundQty(voidedIn + qtyAtT);
  });
  // 出库：还原「迁移那一刻的有效出库净额」，并记下迁移后才作废的单据当时的净额
  (DB.materialOutbound || []).forEach(o => {
    if (!o) return;
    const it = (o.items || []).find(x => x && x.materialId === materialId);
    if (!it) return;
    const created = timePart(o.createdAt);
    const existedAtT = created ? created <= openingAt
      : (!!openingDate && !!dayPart(o.outDate) && dayPart(o.outDate) < openingDate); // 旧数据缺 createdAt 时按业务日兜底
    if (!existedAtT) return;                                  // 迁移后才开的单（哪怕业务日补录更早）当时不在期初
    if (o.status !== '有效' && !gtT(o.voidedAt)) return;      // 迁移前就作废：未进期初
    let returnedAtT = 0;
    (o.returns || []).forEach(x => {
      if (!leT(x && x.at)) return;                            // 迁移后才归还的不计入当时净额
      const row = (x.rows || []).find(y => y && y.materialId === materialId);
      returnedAtT += Number(row && row.qty) || 0;
    });
    const net = roundQty((Number(it.qty) || 0) - roundQty(returnedAtT));
    netAtT = roundQty(netAtT + net);
    if (o.status !== '有效') voidedOut = roundQty(voidedOut + net);
  });
  // 安全阀：期初若不能被迁移公式（migrations.js 20261111-material-opening-balance）解释，就不动
  const derived = roundQty(arrivedAtT - netAtT);
  if (roundQty(Number(mat.openingAvailable) || 0) !== Math.max(0, derived)) return 0;
  return roundQty(voidedOut - voidedIn);
}
function replayAvailability(materialId, extraEvents) {
  const DB = DB_();
  const mat = (DB.materials || []).find(x => x && x.id === materialId);
  const openingDate = dayPart(mat && mat.openingDate);
  const openingAt = timePart(mat && mat.openingAt);
  const opening = roundQty((Number(mat && mat.openingAvailable) || 0) + openingAdjustOf(materialId));
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

/* ---------- 截至某业务日的可用量（只读口径，供登记出库弹窗核算） ----------
 * 与 replayAvailability 同源：同一 eventsOf、同一期初折算规则，只是把「逐日判负」
 * 换成「累加到指定日为止」，因此不会出现两套库存口径。
 *
 * availableAsOf(materialId, date) →
 *   { materialId, available, notYetIn, beforeOpening, openingDate, missing? }
 *   - available：四位小数；beforeOpening 时为 null（期初前无法核算，不做近似）
 *   - beforeOpening：date < 该材料 openingDate
 *   - notYetIn：仅当「历史完整可信，且截至 date 既没有有效入库、也没有出库」时为 true
 *       历史完整可信的可核查依据 = 该材料带期初字段（迁移对当时全部材料写入；
 *       迁移之后新建的材料不再补写，故缺字段一律视为历史不可核查 → false）
 *       另需 openingAvailable = 0 且 openingRaw = 0（期初净余额为零，不含老账负数抵消）
 *       入库一律按未作废领料单的 history 判定，日期用与 eventsOf 相同的回退链
 *       出库按 eventsOf 的全量事件判定（含已被期初折算并入基数的那部分）：曾有出库即
 *       证明 D 之前有过库存，不得报「尚未入库」；归还必以出库为前提，不单独作判据
 *   - 本函数不读也不写任何可见状态，只做计算
 */
function inboundDatesOf(materialId) {
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
      if (d) out.push(d);
    });
  });
  return out;
}
function availableAsOf(materialId, date) {
  const DB = DB_();
  const mat = (DB.materials || []).find(x => x && x.id === materialId);
  const d = dayPart(date);
  if (!mat || !d) {
    return { materialId, available: null, notYetIn: false, beforeOpening: false, openingDate: '', missing: true };
  }
  const openingDate = dayPart(mat.openingDate);
  const openingAt = timePart(mat.openingAt);
  const openingAdj = openingAdjustOf(materialId);   // 与 replayAvailability 同一回补口径
  const opening = roundQty((Number(mat.openingAvailable) || 0) + openingAdj);
  // 期初之前：逐日库存不可核算（旧回放对期初前不判负，后端不必然兜住）→ 明确返回不可核算
  if (openingDate && d < openingDate) {
    return { materialId, available: null, notYetIn: false, beforeOpening: true, openingDate };
  }
  // 期初折算与 replayAvailability 逐字同口径：≤ openingAt 的流水已含在期初；< openingDate 的并入基数
  let base = opening;
  const events = [];
  const rawEvents = eventsOf(materialId);      // 全量事件（含已被期初折算并入基数的那部分），供 notYetIn 判据用
  rawEvents.forEach(e => {
    if (openingAt && e.at && e.at <= openingAt) return;
    if (openingDate && e.date < openingDate) {
      base = roundQty(base + (e.kind === 'in' ? e.qty : -e.qty));
      return;
    }
    events.push(e);
  });
  // 累加至 date（含当日）：同日先入后出不影响截至日终值
  let avail = base;
  events.forEach(e => {
    if (!e.date || e.date > d) return;
    avail = roundQty(avail + (e.kind === 'in' ? e.qty : -e.qty));
  });
  // notYetIn：可核查（有期初字段）且期初净额为 0 且截至日无任何有效入库，
  // 且截至日也没有出库事件 —— 曾有出库即证明 D 之前有过库存，不得报「尚未入库」
  // （归还必以出库为前提，其判据已被出库条件覆盖，不单独作为条件）
  const auditable = !!openingDate && mat.openingRaw !== undefined && mat.openingRaw !== null;
  const zeroOpening = opening === 0 && roundQty((Number(mat.openingRaw) || 0) + openingAdj) === 0;
  const noInbound = !inboundDatesOf(materialId).some(x => x <= d);
  const noOutbound = !rawEvents.some(e => e.kind === 'out' && e.date <= d);
  const notYetIn = auditable && zeroOpening && noInbound && noOutbound;
  return { materialId, available: avail, notYetIn, beforeOpening: false, openingDate };
}

module.exports = { roundQty, qtyGeneratedOf, qtyOutstandingOf, withGen, materialStatus, eventsOf, replayAvailability, availableAsOf };
