/* ========== routes/materials ========== */
/* 材料台账（校验 / 删除依赖校验）、材料导入、出库管理、领料单，以及 material* 三个集合 CRUD。 */
const xlsx = require('xlsx');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO, aliveFilter, fmtNow, bjStr } = require('../core/util');
const { withGen, materialStatus, roundQty, replayAvailability } = require('../core/material-calc');
const { isAdmin } = require('../core/auth');
const { isWorkerAdmitted } = require('../core/worker-status');
const { docNoKey, cmpDocNo, nextDocNo } = require('../core/doc-no');

/* ---------- 业务日期（P4-1）与按业务日期取号（P4-2） ----------
 * 口径：业务日期一律 'YYYY-MM-DD'；「今天」取服务器北京时间（bjStr().slice(0,10)，含手动校时），
 * 不用进程本地时区、也不用客户端日期。录入时间仍由 fmtNow() 单独记录，两者互不替代。 */
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
// 通用校验：格式 → 不晚于今天 → 早于「今天 − 30 天」必须填补录原因。返回错误文案，通过返回 ''。
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
// 回放不通过的统一 400：说明哪天、哪个物料、哪张单导致不够、当时可用与本次数量（P4-4）
function replayFail(res, m, rp, what) {
  const desc = (m && (m.description || m.code)) || '';
  const who = rp.self ? (what || '本单') : (rp.refNo || '历史单据');
  const verb = rp.kind === 'out' ? '出库' : '入库';
  const tail = rp.self ? (who + ' ' + rp.qty) : (who + ' ' + verb + ' ' + rp.qty);
  const msg = '补录后 ' + rp.firstNegativeDate + ' 物料「' + desc + '」可用库存将为负（当时可用 '
    + rp.available + '，' + tail + '）';
  const refs = rp.refNo ? [rp.refNo.indexOf('OUT-') === 0 ? { outNo: rp.refNo } : { reqNo: rp.refNo }] : [];
  return res.status(400).json({
    error: msg, date: rp.firstNegativeDate,
    materialId: m ? m.id : '', code: (m && m.code) || '', description: desc,
    available: rp.available, qty: rp.qty, refs
  });
}
// 取号与编号规则统一在 core/doc-no：取号 = 同类型同日最小未占用流水（未删除才算占号）。
const dateTagOf = d => String(d || '').replace(/-/g, '');
function reqNoOf(reqDate) { return nextDocNo(DB.materialRequisitions, 'reqNo', 'LL-' + dateTagOf(reqDate) + '-'); }
function outNoOf(outDate) { return nextDocNo(DB.materialOutbound, 'outNo', 'OUT-' + dateTagOf(outDate) + '-'); }
/* 作废重开：correctedFrom 必须指向「存在、未删除、已作废」的同类原单（领料对领料、出库对出库）。
 * 同一原单同时只允许一张仍有效的重开单：原单 correctedBy 指向的单仍有效时拒绝并提示单号；
 * 那张重开单也已作废（或已删除）时允许再次重开，反向关联在创建成功后更新为最新一张。
 * 编号骨架与 nextDocNo 算法不在本函数内改动。 */
function resolveReopenSource(kind, input) {
  const key = String(input || '').trim();
  if (!key) return { orig: null };
  const list = kind === 'req' ? DB.materialRequisitions : DB.materialOutbound;
  const noField = kind === 'req' ? 'reqNo' : 'outNo';
  const orig = list.find(x => x && !x.deleted && (x.id === key || x[noField] === key)) || null;
  if (!orig) return { error: '要重开的原单不存在（' + key + '）' };
  if (orig.status !== '已作废') return { error: '原单尚未作废，不能重开' };
  if (orig.correctedBy) {
    const prev = list.find(x => x && x.id === orig.correctedBy && !x.deleted);
    if (prev && prev.status !== '已作废') {
      return { error: '已有重开单 ' + (prev[noField] || '') + '，请先作废那张再重开' };
    }
  }
  return { orig };
}
// 该材料「已确认入库且领料单未作废」的最早到货日（P4-1 临时门槛用；第二批回放上线后删除调用方）


// 领料单删除：仅已作废的领料单可删除（须注册在通用 CRUD 工厂之前以覆盖默认删除）
app.delete('/api/materialRequisitions/:id', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '已作废') return res.status(400).json({ error: '仅已作废的领料单可删除，请先作废' });
  rec.deleted = true; // 逻辑删除（保留记录，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});


// ---------- 出库管理（按工程出库 / 归还 / 作废补回） ----------
// 库存口径：可用库存 = 累计入库 − 净出库（净出库 = 有效单累计领取 − 累计归还；作废单自动补回）
function outboundStats(project) {
  const stats = {};
  DB.materialOutbound.forEach(o => {
    if (o.deleted || o.project !== project || o.status !== '有效') return;
    (o.items || []).forEach(it => {
      if (!it.materialId) return;
      const s = stats[it.materialId] || (stats[it.materialId] = { taken: 0, returned: 0 });
      s.taken = roundQty(s.taken + (Number(it.qty) || 0));
      s.returned = roundQty(s.returned + (Number(it.returned) || 0));
    });
  });
  return stats;
}
app.get('/api/materialOutbound/stock', (req, res) => {
  const project = String(req.query.project || '');
  if (!project) return res.json([]);
  const stats = outboundStats(project);
  const rows = [];
  DB.materials.filter(aliveFilter()).forEach(m => {
    if (m.project !== project) return;
    const inQty = roundQty(m.qtyArrived);
    if (inQty <= 0) return;
    const st = stats[m.id] || { taken: 0, returned: 0 };
    const net = roundQty(st.taken - st.returned);
    const available = roundQty(Math.max(0, inQty - net));
    if (available <= 0) return; // 已全部出库的材料不再出现在可出库列表
    const hasRecords = DB.materialOutbound.some(o => !o.deleted && o.project === project && (o.items || []).some(it => it.materialId === m.id));
    rows.push({ id: m.id, description: m.description, code: m.code, unit: m.unit, inQty, taken: st.taken, returned: st.returned, net, available, hasRecords });
  });
  res.json(rows);
});
// P1 出库可选关联：项目名口径与材料/计划一致（同名，或同属一个父工程 —— 父工程名与其子项目名互认）
function projectFamilyOf(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  const hit = DB.projects.find(p => !p.deleted && (String(p.name || '').trim() === n
    || (p.subProjects || []).some(s => String((s || {}).name || '').trim() === n)));
  return hit ? String(hit.name || '').trim() : '';
}
function sameProjectScope(a, b) {
  const na = String(a || '').trim();
  const nb = String(b || '').trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = projectFamilyOf(na);
  const fb = projectFamilyOf(nb);
  return !!fa && fa === fb;
}
// 该领料单对某材料的已确认入库量（confirmRows 累计）
function reqConfirmedQty(req, materialId) {
  const cr = (req.confirmRows || []).find(c => c && c.materialId === materialId);
  return roundQty(cr ? (Number(cr.thisQty) || 0) : 0);
}
// 已按此领料单净出库量（仅未删除、状态=有效的出库单：领取 − 归还）
function reqUsedQty(reqId, materialId) {
  let used = 0;
  DB.materialOutbound.forEach(o => {
    if (o.deleted || o.status !== '有效') return;
    (o.items || []).forEach(it => {
      if (!it || it.requisitionId !== reqId || it.materialId !== materialId) return;
      used = roundQty(used + roundQty((Number(it.qty) || 0) - (Number(it.returned) || 0)));
    });
  });
  return roundQty(used);
}
// P4-6：出库单默认按「出库日」倒序，同一天按单号流水倒序（补录单不再因今天录入排最前）
function byDocNoAsc(a, b) {
  const ka = docNoKey(a && a.outNo), kb = docNoKey(b && b.outNo);
  if (ka && kb) return cmpDocNo(a.outNo, b.outNo);
  const da = String((a && a.outDate) || '').slice(0, 10);
  const db = String((b && b.outDate) || '').slice(0, 10);
  if (da !== db) return da < db ? -1 : 1;
  return String((a && a.outNo) || '').localeCompare(String((b && b.outNo) || ''));
}
// 出库单读侧补关联：明细行补来源领料单号、单头补计划名称（按当前数据解析，不落库快照）
function withOutboundLinks(list) {
  const reqNoMap = {};
  DB.materialRequisitions.forEach(r => { if (r && r.id) reqNoMap[r.id] = r.reqNo || ''; });
  const planNameMap = {};
  DB.workPlans.forEach(p => { if (p && p.id) planNameMap[p.id] = p.name || ''; });
  return list.map(o => Object.assign({}, o, {
    workPlanName: o.workPlanId ? (planNameMap[o.workPlanId] || '') : '',
    items: (o.items || []).map(it => Object.assign({}, it, {
      reqNo: it.requisitionId ? (reqNoMap[it.requisitionId] || '') : ''
    }))
  }));
}
app.get('/api/materialOutbound/orders', (req, res) => {
  const project = String(req.query.project || '');
  const list = DB.materialOutbound.filter(o => !o.deleted && (!project || o.project === project))
    .slice().sort(byDocNoAsc);
  res.json(withOutboundLinks(list));
});
// P1：以该领料单为来源的出库单（含已作废，带状态标记）
app.get('/api/materialRequisitions/:id/outbounds', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  const list = DB.materialOutbound
    .filter(o => !o.deleted && (o.items || []).some(it => it && it.requisitionId === rec.id))
    .slice()
    .sort(byDocNoAsc);
  res.json(withOutboundLinks(list));
});
// P1：按计划汇总已关联出库的净出库（材料编码 + 描述维度；有效单领取 − 归还，作废单计 0）
app.get('/api/workPlans/:id/material-usage', (req, res) => {
  const plan = DB.workPlans.find(x => x.id === req.params.id && !x.deleted);
  if (!plan) return res.status(404).json({ error: '未找到计划' });
  const agg = {};
  DB.materialOutbound.forEach(o => {
    if (o.deleted || o.workPlanId !== plan.id) return;
    const valid = o.status === '有效';
    (o.items || []).forEach(it => {
      if (!it) return;
      const key = [it.code || '', it.description || ''].join('\u0001');
      const row = agg[key] || (agg[key] = {
        materialId: it.materialId || '', code: it.code || '', description: it.description || '',
        unit: it.unit || '', taken: 0, returned: 0, net: 0, outCount: 0, voidedCount: 0
      });
      if (!valid) { row.voidedCount++; return; }
      row.taken = roundQty(row.taken + (Number(it.qty) || 0));
      row.returned = roundQty(row.returned + (Number(it.returned) || 0));
      row.net = roundQty(row.taken - row.returned);
      row.outCount++;
    });
  });
  res.json(Object.keys(agg).map(k => agg[k]));
});
app.post('/api/materialOutbound/create', (req, res) => {
  const b = req.body || {};
  const project = String(b.project || '').trim();
  if (!project) return res.status(400).json({ error: '请选择工程' });
  // 领取人（P0-3）：必须是作业人员名单里「已准入」的工人，按服务器北京日期判定。
  // 带 workerId → 直接认人，落库姓名取该工人的当前姓名快照（不信任前端传来的姓名）；
  // 只带姓名 → 须与唯一一名已准入工人精确同名；项目班组长、用户库人员都不算数。
  const workerId = String(b.workerId || '').trim();
  const nameInput = String(b.receiver || '').trim();
  const todayStr = bjStr().slice(0, 10);
  let receiver = nameInput;
  if (workerId) {
    const w = DB.workers.find(x => x.id === workerId && !x.deleted);
    if (!w) return res.status(400).json({ error: '所选领取人不在已准入工人名单' });
    if (!isWorkerAdmitted(w, todayStr)) return res.status(400).json({ error: '领取人「' + w.name + '」不在已准入工人名单' });
    receiver = String(w.name || '').trim();
  } else if (!receiver) {
    return res.status(400).json({ error: '请选择领取人' });
  } else {
    const same = DB.workers.filter(x => String(x.name || '').trim() === receiver && isWorkerAdmitted(x, todayStr));
    if (!same.length) return res.status(400).json({ error: '领取人「' + receiver + '」不在已准入工人名单' });
    if (same.length > 1) return res.status(400).json({ error: '工人名单中有 ' + same.length + ' 名同名的已准入人员，请改用名单选择' });
    receiver = String(same[0].name || '').trim();
  }
  // P1：关联计划 / 作业日 / 工序（全部可选，仅在传了才校验）
  const workPlanId = String(b.workPlanId || '').trim();
  const workDate = String(b.workDate || '').trim();
  const processName = String(b.processName || '').trim();
  if (workDate && !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return res.status(400).json({ error: '作业日格式应为 YYYY-MM-DD' });
  }
  let workPlan = null;
  if (workPlanId) {
    workPlan = DB.workPlans.find(x => x.id === workPlanId && !x.deleted);
    if (!workPlan) return res.status(400).json({ error: '关联计划不存在' });
    if (!sameProjectScope(workPlan.project, project)) {
      return res.status(400).json({ error: '关联计划「' + (workPlan.name || '') + '」不属于所选工程' });
    }
    if (workDate) {
      const ps = String(workPlan.startDate || '').slice(0, 10);
      const pe = String(workPlan.endDate || '').slice(0, 10);
      if (ps && workDate < ps) return res.status(400).json({ error: '作业日 ' + workDate + ' 早于计划开始日期 ' + ps });
      if (pe && workDate > pe) return res.status(400).json({ error: '作业日 ' + workDate + ' 晚于计划结束日期 ' + pe });
    }
  }
  // P4-1：出库日期（必填，省略时默认等于已填作业日；作业日缺失或晚于今天则默认今天）
  // 注意 workDate 是作业日，可以是未来排期；出库日不能晚于今天，故未来作业日不再照抄，
  // 并在响应里带 outDateFallback / outDateHint，界面据此标出「出库日已按今天」。
  const outDateInput = String(b.outDate || '').trim();
  const outDateFallback = !outDateInput && !!workDate && workDate > todayBizDate();
  const outDate = outDateInput || ((workDate && workDate <= todayBizDate()) ? workDate : todayBizDate());
  const outDateReason = String(b.outDateReason || '').trim();
  const outDateErr = bizDateError('出库日期', outDate, outDateReason);
  if (outDateErr) return res.status(400).json({ error: outDateErr });
  // 作废重开：correctedFrom 必须指向已存在、未删除、已作废的原出库单；不满足就 400，绝不建单
  const reopen = resolveReopenSource('out', b.correctedFrom);
  if (reopen.error) return res.status(400).json({ error: reopen.error });
  const reopenOrig = reopen.orig;
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: '请勾选需要出库的材料' });
  const stats = outboundStats(project);
  const finalItems = [];
  let availErr = ''; // 累计可用不足：先记下，等回放算完再定用哪条文案（回放能给出具体是哪一天）
  for (const e of items) {
    const m = DB.materials.find(x => x.id === e.materialId && !x.deleted);
    if (!m || m.project !== project) return res.status(400).json({ error: '物料不存在或不属于所选工程' });
    const qty = roundQty(Number(e.qty));
    if (!(qty > 0)) return res.status(400).json({ error: '物料「' + m.description + '」出库数量必须大于 0' });
    const st = stats[m.id] || { taken: 0, returned: 0 };
    const avail = roundQty(Math.max(0, roundQty(m.qtyArrived) - roundQty(st.taken - st.returned)));
    const overAvail = qty > avail + 1e-9;
    if (overAvail && !availErr) availErr = '物料「' + m.description + '」本次出库 ' + qty + ' 超过可用库存 ' + avail;
    // P1：来源领料单（可选）—— 须存在/未删除/未作废/属于本项目/含此材料，且不超过该单剩余可出
    // 累计可用已经不够的行不再查领料单（反正要拒），留给回放给出「哪一天为负」的精确信息
    let reqId = '';
    const reqInput = String(e.requisitionId || '').trim();
    if (reqInput && !overAvail) {
      const reqRec = DB.materialRequisitions.find(x => x.id === reqInput && !x.deleted);
      if (!reqRec) return res.status(400).json({ error: '来源领料单不存在' });
      if (reqRec.status === '已作废') return res.status(400).json({ error: '来源领料单 ' + (reqRec.reqNo || '') + ' 已作废，不能作为出库来源' });
      const reqProjects = (Array.isArray(reqRec.projects) && reqRec.projects.length)
        ? reqRec.projects : (reqRec.items || []).map(i => i.project);
      if (!reqProjects.some(p => sameProjectScope(p, project))) {
        return res.status(400).json({ error: '来源领料单 ' + (reqRec.reqNo || '') + ' 不属于所选工程' });
      }
      if (!(reqRec.items || []).some(i => i.materialId === m.id)) {
        return res.status(400).json({ error: '来源领料单 ' + (reqRec.reqNo || '') + ' 不含物料「' + m.description + '」' });
      }
      const remain = roundQty(reqConfirmedQty(reqRec, m.id) - reqUsedQty(reqInput, m.id));
      if (qty > remain + 1e-9) {
        return res.status(400).json({ error: '物料「' + m.description + '」本次出库 ' + qty + ' 超过该领料单剩余可出 ' + remain });
      }
      reqId = reqInput;
    }
    finalItems.push({ materialId: m.id, code: m.code || '', description: m.description || '', unit: m.unit || '', qty, returned: 0, requisitionId: reqId });
  }
  // P4-4：按日回放——本单出库之后，该材料从最早业务日起每一天的可用都不得为负（第二批起唯一口径）
  for (const fi of finalItems) {
    const m = DB.materials.find(x => x.id === fi.materialId && !x.deleted);
    if (!m) continue;
    const rp = replayAvailability(fi.materialId, [{ date: outDate, kind: 'out', qty: fi.qty, self: true }]);
    if (!rp.ok) return replayFail(res, m, rp, '本单出库');
  }
  if (availErr) return res.status(400).json({ error: availErr });
  // 单号：OUT-YYYYMMDD-NNNN，日期取出库业务日（不是录入日）；流水取该日最小未占用号（删除补缺、作废不腾号）
  const rec = {
    id: genId('ob'), outNo: outNoOf(outDate),
    project, receiver, status: '有效', createdAt: fmtNow(),
    outDate, outDateReason,
    workPlanId, workDate, processName,
    items: finalItems, returns: [], compensated: 0,
    correctedFrom: reopenOrig ? reopenOrig.id : '', correctedFromNo: reopenOrig ? (reopenOrig.outNo || '') : '',
    legacy: false,
    deleted: false
  };
  DB.materialOutbound.unshift(rec);
  // 原单回写反向关联（同一次 saveDB 落盘，保证双向一致）
  if (reopenOrig) { reopenOrig.correctedBy = rec.id; reopenOrig.correctedByNo = rec.outNo; }
  saveDB();
  res.json({
    ok: true, data: withOutboundLinks([rec])[0],
    outDateFallback,
    outDateHint: outDateFallback ? '作业日 ' + workDate + ' 晚于今天，出库日已按今天（' + outDate + '）' : ''
  });
});
app.put('/api/materialOutbound/:id/return', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '有效') return res.status(400).json({ error: '该出库单已作废，不能登记归还' });
  // P4-1：归还业务日（省略默认今天；不能晚于今天、不能早于本单出库日）
  const returnDate = String((req.body || {}).returnDate || '').trim() || todayBizDate();
  const returnDateReason = String((req.body || {}).returnDateReason || '').trim();
  const returnDateErr = bizDateError('归还日期', returnDate, returnDateReason);
  if (returnDateErr) return res.status(400).json({ error: returnDateErr });
  const outDateOfRec = String(rec.outDate || '').slice(0, 10);
  if (outDateOfRec && returnDate < outDateOfRec) {
    return res.status(400).json({ error: '归还日期不能早于出库日期（' + outDateOfRec + '）' });
  }
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const plan = [];
  for (const r of rows) {
    const it = (rec.items || []).find(i => i.materialId === r.materialId);
    if (!it) continue;
    const qty = roundQty(Number(r.qty));
    const remaining = roundQty(it.qty - it.returned);
    if (!(qty > 0)) continue;
    if (qty > remaining + 1e-9) return res.status(400).json({ error: '物料「' + it.description + '」本次归还 ' + qty + ' 超过剩余未归还 ' + remaining });
    plan.push({ it, qty });
  }
  if (!plan.length) return res.status(400).json({ error: '请填写有效的归还数量' });
  // P4-4：新单归还走回放（存量单不跑，避免被历史账锁死）；归还只会增加当日可用
  if (rec.legacy !== true) {
    for (const p of plan) {
      const m = DB.materials.find(x => x.id === p.it.materialId && !x.deleted);
      if (!m) continue;
      const rp = replayAvailability(p.it.materialId, [{ date: returnDate, kind: 'in', qty: p.qty, self: true }]);
      if (!rp.ok) return replayFail(res, m, rp, '本单归还');
    }
  }
  const applied = [];
  for (const p of plan) {
    p.it.returned = roundQty(p.it.returned + p.qty);
    applied.push({ materialId: p.it.materialId, qty: p.qty });
  }
  if (!Array.isArray(rec.returns)) rec.returns = [];
  rec.returns.push({ at: fmtNow(), returnDate, returnDateReason, rows: applied });
  saveDB();
  res.json({ ok: true, data: rec });
});
app.put('/api/materialOutbound/:id/void', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '有效') return res.status(400).json({ error: '该出库单已作废，不能重复作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '作废原因不能为空' });
  // P4-4：新单作废走回放（作废=本单出库与其归还一起撤销，按净额在该出库日一次性回加；存量单不跑）
  if (rec.legacy !== true) {
    for (const it of (rec.items || [])) {
      const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
      if (!m) continue;
      const net = roundQty((Number(it.qty) || 0) - (Number(it.returned) || 0));
      if (net <= 0) continue;
      const rp = replayAvailability(it.materialId, [{ date: rec.outDate, kind: 'out', qty: -net, self: true }]);
      if (!rp.ok) return replayFail(res, m, rp, '本单作废');
    }
  }
  rec.status = '已作废';
  rec.voidReason = reason;
  rec.voidedAt = fmtNow();
  saveDB();
  res.json({ ok: true, data: rec });
});
// 出库单删除：仅已作废的出库单可删除（同领料单口径；须注册在通用 CRUD 工厂之前以覆盖默认删除）
app.delete('/api/materialOutbound/:id', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '已作废') return res.status(400).json({ error: '仅已作废的出库单可删除，请先作废' });
  rec.deleted = true; // 逻辑删除（保留记录，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});



// 删除导入批次（仅超级用户）：批次记录逻辑删除，且该批次导入的材料一并逻辑删除（材料明细同步消失）
// 说明：领料单/出库单的物料信息均为快照（code/description/unit/project），历史单据不受影响
app.delete('/api/materialImports/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可以删除导入批次' });
  const b = DB.materialImports.find(x => x.id === req.params.id && !x.deleted);
  if (!b) return res.status(404).json({ error: '未找到该导入批次' });
  const ids = new Set((Array.isArray(b.materialIds) && b.materialIds.length)
    ? b.materialIds
    : DB.materials.filter(m => m.importId === b.id).map(m => m.id));
  if (!ids.size) return res.status(400).json({ error: '该批次未记录关联材料（历史导入数据），无法整批删除' });
  // 嵌套校验：批次内材料若已被领料单/出库单引用，整批拒绝（避免绕过单条材料的删除校验）
  const blockedRows = DB.materials.filter(m => !m.deleted && ids.has(m.id) && materialRefsOf(m).length);
  if (blockedRows.length) {
    const agg = {};
    blockedRows.forEach(m => materialRefsOf(m).forEach(r => { agg[r.label] = (agg[r.label] || 0) + r.count; }));
    return res.status(409).json({
      error: '该批次中有 ' + blockedRows.length + ' 条材料已被其他数据引用，无法删除',
      refs: Object.keys(agg).map(label => ({ label, count: agg[label] })),
      blockedMaterials: blockedRows.length
    });
  }
  let deletedMaterials = 0;
  DB.materials.forEach(m => {
    if (m.deleted || !ids.has(m.id)) return;
    m.deleted = true; m.deletedAt = nowISO(); m.deletedBy = (req.user && (req.user.name || req.user.username)) || '';
    deletedMaterials++;
  });
  b.deleted = true;
  b.deletedAt = nowISO();
  b.deletedBy = (req.user && (req.user.name || req.user.username)) || '';
  saveDB();
  res.json({ ok: true, deletedMaterials, fileName: b.fileName });
});


// ---------- 材料明细（工程材料清单） ----------
// 来源类型为固定枚举（与原系统一致），新增/编辑/导入均强制校验。
// 与 public/js/views/materials.js 的同名枚举必须保持一致；scripts/smoke.js 有逐项相等断言防漂移。
const SOURCE_TYPES = ['ERP采购申请', '甲供材料', '库存调拨', '乙供/自购', '运检项目'];

/* ---------- 存量不一致只读检测（P0-4） ----------
 * 纯只读：不写任何集合、不生成批次；权限与「删除导入批次」同口径（仅超级用户）。
 * 口径：有效出库 = 未删除且 status=有效（作废单已补回，不计）；确认入库合计 = 未删除且未作废领料单的 confirmRows 累计。
 * 处置建议只是文案，接口不提供任何一键修复/回滚入口。 */
// 有效出库按材料聚合：materialId → [{ out, item, net }]，net = 领取 − 归还（只收净占用 > 0 的行）
function activeOutByMaterial(project) {
  const map = new Map();
  DB.materialOutbound.forEach(o => {
    if (!o || o.deleted || o.status !== '有效') return;
    if (project && o.project !== project) return;
    (o.items || []).forEach(it => {
      if (!it || !it.materialId) return;
      const net = roundQty(roundQty(it.qty) - roundQty(it.returned));
      if (net <= 0) return;
      if (!map.has(it.materialId)) map.set(it.materialId, []);
      map.get(it.materialId).push({ out: o, item: it, net });
    });
  });
  return map;
}
// 确认入库累计：materialId → { sum, reqNos }
function inboundByMaterial() {
  const map = new Map();
  DB.materialRequisitions.forEach(r => {
    if (!r || r.deleted || r.status === '已作废') return;
    (r.confirmRows || []).forEach(cr => {
      if (!cr || !cr.materialId) return;
      const q = roundQty(cr.thisQty);
      if (!(q > 0)) return;
      const e = map.get(cr.materialId) || { sum: 0, reqNos: [] };
      e.sum = roundQty(e.sum + q);
      if (r.reqNo && e.reqNos.indexOf(r.reqNo) < 0) e.reqNos.push(r.reqNo);
      map.set(cr.materialId, e);
    });
  });
  return map;
}
// 已作废领料单涉及的材料：materialId → [reqNo]
function voidedReqByMaterial() {
  const map = new Map();
  DB.materialRequisitions.forEach(r => {
    if (!r || r.deleted || r.status !== '已作废') return;
    (r.items || []).forEach(it => {
      if (!it || !it.materialId) return;
      const arr = map.get(it.materialId) || [];
      if (r.reqNo && arr.indexOf(r.reqNo) < 0) arr.push(r.reqNo);
      map.set(it.materialId, arr);
    });
  });
  return map;
}
app.get('/api/materials/audit/inconsistencies', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可以查看存量不一致检测' });
  const project = String(req.query.project || '').trim();
  const todayStr = bjStr().slice(0, 10);
  const rows = [];
  const add = (type, m, docNos, qty, advice) => rows.push({
    type, project: m.project, materialId: m.id,
    code: String(m.code || ''), description: String(m.description || ''),
    docNos: docNos || [], qty: qty || {}, advice
  });
  const inbound = inboundByMaterial();
  const actives = activeOutByMaterial(project);
  const voided = voidedReqByMaterial();
  const materials = DB.materials.filter(aliveFilter()).filter(m => !project || m.project === project);

  materials.forEach(m => {
    const required = roundQty(m.qtyRequired);
    const arrived = roundQty(m.qtyArrived);
    const inb = inbound.get(m.id) || { sum: 0, reqNos: [] };
    const acts = actives.get(m.id) || [];
    const net = roundQty(acts.reduce((s, x) => s + x.net, 0));
    const outNos = [];
    acts.forEach(x => { const no = x.out.outNo || ''; if (no && outNos.indexOf(no) < 0) outNos.push(no); });
    const avail = roundQty(arrived - net);
    if (arrived > 0 && roundQty(arrived - inb.sum) !== 0) {
      add('arrived_without_inbound', m, inb.reqNos, { required, arrived, inboundSum: inb.sum, diff: roundQty(arrived - inb.sum) },
        '已到与入库记录对不上：先核对领料/入库单据，缺确认的补确认，确无来源的按实际到货补录入库或调整应到');
    }
    if (arrived > required) {
      add('arrived_gt_required', m, [], { required, arrived, over: roundQty(arrived - required) },
        '已到大于应到：核对是否应到录错（改应到需填原因），到货确有超量时调整应到');
    }
    if (required <= 0) {
      add('required_not_positive', m, [], { required },
        '应到数量不为正数：按实际需用数量修正应到（修改需填原因）');
    }
    const vreqs = voided.get(m.id) || [];
    if (vreqs.length && net > 0) {
      add('voided_req_with_active_out', m, vreqs.concat(outNos), { arrived, net },
        '领料单已作废但仍有效出库占用：先归还或作废占用出库，再核对库存');
    }
    if (avail < 0) {
      add('negative_available', m, outNos, { arrived, net, available: avail },
        '可用库存为负：先归还或作废占用出库，再视需要补录入库或调整应到');
    }
    if (net > 0 && avail <= 0) {
      add('stock_hidden_but_outbound_active', m, outNos, { arrived, net, available: avail },
        '材料在库存口径下已不显示但出库仍有效：先归还/作废出库，再核对入库是否漏记');
    }
  });

  // 领取人不是已准入工人（含查无此人）：逐材料行列出，便于按材料核对
  DB.materialOutbound.forEach(o => {
    if (!o || o.deleted || o.status !== '有效') return;
    if (project && o.project !== project) return;
    const name = String(o.receiver || '').trim();
    const ok = !!name && DB.workers.some(w => String(w.name || '').trim() === name && isWorkerAdmitted(w, todayStr));
    if (ok) return;
    const its = (o.items || []).filter(it => it && it.materialId);
    (its.length ? its : [{}]).forEach(it => {
      rows.push({
        type: 'receiver_not_admitted', project: o.project, materialId: it.materialId || '',
        code: String(it.code || ''), description: String(it.description || ''),
        docNos: [o.outNo || ''], receiver: name,
        qty: {
          qty: roundQty(it.qty), returned: roundQty(it.returned),
          net: it.qty === undefined ? 0 : roundQty(roundQty(it.qty) - roundQty(it.returned))
        },
        advice: '领取人不在已准入工人名单：新单请从名单选择；存量单据只做登记，不自动改也不作废'
      });
    });
  });

  // 同项目 + 同物料编码 + 同采购订单号 多行
  const groups = new Map();
  materials.forEach(m => {
    const code = String(m.code || '').trim();
    if (!code) return;
    const key = m.project + '\u0001' + code + '\u0001' + String(m.orderNo || '').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });
  groups.forEach(g => {
    if (g.length < 2) return;
    const orderNo = String(g[0].orderNo || '').trim();
    rows.push({
      type: 'duplicate_code_po', project: g[0].project, materialId: g[0].id,
      code: String(g[0].code || ''), description: g.map(x => String(x.description || '')).join(' / '),
      docNos: orderNo ? [orderNo] : [],
      qty: {
        count: g.length,
        rows: g.map(x => ({ id: x.id, qtyRequired: roundQty(x.qtyRequired), arrived: roundQty(x.qtyArrived) }))
      },
      advice: '同项目同编码同采购订单号存在多行：核对是否重复录入，确认重复的删除多余行或合并应到数量'
    });
  });

  res.json(rows);
});

app.get('/api/materials', (req, res) => res.json(DB.materials.filter(aliveFilter()).map(withGen)));
app.get('/api/materials/:id', (req, res) => {
  const it = DB.materials.find(x => x.id === req.params.id);
  if (!it || it.deleted) return res.status(404).json({ error: '未找到' });
  res.json(withGen(it));
});
// 单体工程名称 = 项目列表「工程名称」∪ 各项目下子项目名称（与项目列表联动、必须一致）
function allSingleProjectNames() {
  const names = [];
  DB.projects.forEach(p => {
    if (p.name) names.push(p.name);
    (p.subProjects || []).forEach(s => { if (s.name) names.push(s.name); });
  });
  return names;
}
// 已到数量只能由「确认入库 / 补入库」产生：新增只接受 0（或空），编辑只接受与库内现值一致。
// 领料单作废的冲销走 void 接口，不经过这里。
function validateArrivedBody(b, { forEdit = false, oldItem = null } = {}) {
  if (b.qtyArrived === undefined || b.qtyArrived === null || b.qtyArrived === '') return null;
  const cur = forEdit && oldItem ? roundQty(oldItem.qtyArrived) : 0;
  if (roundQty(b.qtyArrived) === cur) return null;
  return forEdit ? '已到数量不能手工修改，只能通过确认入库产生' : '已到数量不能手工填写，只能通过确认入库产生';
}
function validateMaterialBody(b, { forEdit = false, oldItem = null } = {}) {
  const project = String(b.project || '').trim();
  if (!project) return '项目名称不能为空';
  if (!allSingleProjectNames().includes(project)) return '项目名称「' + project + '」与项目列表不一致，无法保存（只能选择项目列表中的工程/子项目名称）';
  const source = String(b.source || '').trim();
  if (!SOURCE_TYPES.includes(source)) return '来源类型无效，仅支持：' + SOURCE_TYPES.join(' / ');
  if (!String(b.description || '').trim()) return '物料描述不能为空';
  const qty = Number(b.qtyRequired);
  const oldQty = forEdit && oldItem ? roundQty(oldItem.qtyRequired) : null;
  const qtyChanged = forEdit && oldItem ? roundQty(qty) !== oldQty : true;
  // 应到必须大于 0；编辑时只拦「改后 ≤ 0」，存量 0/负数行改其他字段不被堵死
  if (!isFinite(qty)) return forEdit ? '应到数量无效' : '应到数量必须大于 0';
  if (qtyChanged && roundQty(qty) <= 0) return '应到数量必须大于 0';
  // 编辑后已到不得大于应到（只在改应到且低于现行已到时拦）
  if (forEdit && oldItem && qtyChanged && roundQty(oldItem.qtyArrived) > roundQty(qty)) {
    return '已到 ' + roundQty(oldItem.qtyArrived) + ' 大于应到 ' + roundQty(qty) + '，请先处理入库/出库后再改应到';
  }
  const arrivedErr = validateArrivedBody(b, { forEdit, oldItem });
  if (arrivedErr) return arrivedErr;
  if (forEdit && oldItem && qtyChanged && !String(b.modifyReason || '').trim()) {
    return '修改了应到数量，必须填写「修改应到数量原因」';
  }
  return null;
}
app.post('/api/materials', (req, res) => {
  const b = req.body || {};
  const err = validateMaterialBody(b);
  if (err) return res.status(400).json({ error: err });
  const item = {
    id: genId('m'), createdAt: nowISO(),
    project: String(b.project).trim(), description: String(b.description).trim(),
    qtyRequired: roundQty(b.qtyRequired), qtyArrived: 0, // 已到只能由确认入库产生，新增恒为 0
    unit: String(b.unit || '').trim(), code: String(b.code || '').trim(),
    orderNo: String(b.orderNo || '').trim() || '-',
    source: String(b.source).trim(), sourceNote: String(b.sourceNote || '').trim(),
    inWeeklyPlan: b.inWeeklyPlan === true,   // P3-1：默认不计入周计划进度（显式勾选才计入）
    modifyReason: '', modifiedAt: ''
  };
  item.qtyNotArrived = roundQty(Math.max(0, item.qtyRequired - item.qtyArrived));
  item.status = materialStatus(item);
  item.deleted = false;
  DB.materials.push(item);
  saveDB();
  res.json(item);
});
app.put('/api/materials/:id', (req, res) => {
  const idx = DB.materials.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const old = DB.materials[idx];
  if (old.deleted) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const err = validateMaterialBody(b, { forEdit: true, oldItem: old });
  if (err) return res.status(400).json({ error: err });
  const qtyChanged = roundQty(b.qtyRequired) !== roundQty(old.qtyRequired);
  const cur = {
    ...old,
    project: String(b.project || old.project).trim(),
    description: String(b.description !== undefined ? b.description : old.description).trim(),
    qtyRequired: roundQty(b.qtyRequired !== undefined ? b.qtyRequired : old.qtyRequired),
    qtyArrived: roundQty(old.qtyArrived), // 已到只随确认入库/补入库/作废冲销变化，编辑不改写
    unit: String(b.unit !== undefined ? b.unit : old.unit).trim(),
    code: String(b.code !== undefined ? b.code : old.code).trim(),
    orderNo: String(b.orderNo !== undefined ? b.orderNo : old.orderNo).trim() || '-',
    source: String(b.source || old.source).trim(),
    sourceNote: String(b.sourceNote !== undefined ? b.sourceNote : old.sourceNote).trim(),
    inWeeklyPlan: b.inWeeklyPlan !== undefined ? b.inWeeklyPlan !== false : old.inWeeklyPlan,
    modifyReason: qtyChanged ? String(b.modifyReason || '').trim() : old.modifyReason,
    modifiedAt: qtyChanged ? fmtNow() : old.modifiedAt
  };
  cur.qtyNotArrived = roundQty(Math.max(0, cur.qtyRequired - cur.qtyArrived));
  cur.status = materialStatus(cur);
  DB.materials[idx] = cur;
  saveDB();
  res.json(cur);
});
// 材料依赖引用检查：被领料单 / 出库单引用时不允许删除
// 口径：只算未删除且未作废的单据（作废单已冲销，物料明细仍保存编码/描述/单位快照，删材料不会影响单据展示）
function materialRefsOf(m) {
  const refs = [];
  const hit = (docs) => (docs || []).filter(d => {
    if (d.deleted || d.status === '已作废') return false;
    return (d.items || []).some(it => it && it.materialId === m.id);
  });
  const reqs = hit(DB.materialRequisitions);
  if (reqs.length) refs.push({ label: '材料领料单', count: reqs.length });
  const outs = hit(DB.materialOutbound);
  if (outs.length) refs.push({ label: '材料出库单', count: outs.length });
  return refs;
}
app.delete('/api/materials/:id', (req, res) => {
  const idx = DB.materials.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const cur = DB.materials[idx];
  if (cur.deleted) return res.status(404).json({ error: '未找到' });
  // 依赖引用校验：有引用则直接拒绝（不做级联删除）
  const refs = materialRefsOf(cur);
  if (refs.length) {
    return res.status(409).json({ error: '该物料已被其他数据引用，无法删除', refs });
  }
  cur.deleted = true; // 逻辑删除（业务私有数据，重置/删除走逻辑标记）
  cur.deletedAt = nowISO();
  cur.deletedBy = (req.user && (req.user.name || req.user.username)) || '';
  saveDB();
  res.json({ ok: true });
});

// ---------- 材料导入（真实模板：采购申请） ----------
// 模板列（按位置）：0 项目名称（单体工程名称）/ 1 短文本(物料描述) / 2 申请数量 / 3 计量单位 / 4 物料编码 / 5 采购订单号 / 6 来源类型
// 硬校验：① 项目名称必须与项目列表一致  ② 来源类型必须是固定枚举，任一行不合法则整份拒绝导入
// 材料导入：读文件 → 逐行校验。预览与正式导入共用同一套（P2：两处口径不允许漂移）
function readImportRows(file) {
  const name = file.originalname || '';
  if (/\.csv$/i.test(name)) {
    const text = file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    return text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
  }
  const wb = xlsx.read(file.buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
}
// 返回 { errors: [{ row, reason }], parsed, skippedEmpty }；errors 为全量逐行清单（不首错即停）
function validateImportRows(rows) {
  const validNames = allSingleProjectNames();
  const errors = [];
  const parsed = [];
  let skippedEmpty = 0;
  rows.forEach((r, i) => {
    if (i === 0) return; // 跳过表头
    const project = String(r[0] || '').trim();
    const description = String(r[1] || '').trim();
    const qtyRaw = String(r[2] === undefined || r[2] === null ? '' : r[2]).trim();
    const source = String(r[6] || '').trim();
    if (!project && !description && !qtyRaw) { skippedEmpty++; return; } // 空行
    const rowNo = i + 1;
    if (!validNames.includes(project)) { errors.push({ row: rowNo, reason: '项目名称「' + (project || '空') + '」与项目列表不一致' }); return; }
    if (!SOURCE_TYPES.includes(source)) { errors.push({ row: rowNo, reason: '来源类型「' + (source || '空') + '」无效（仅支持：' + SOURCE_TYPES.join(' / ') + '）' }); return; }
    const qty = Number(qtyRaw);
    if (!qtyRaw || !isFinite(qty) || qty < 0) { errors.push({ row: rowNo, reason: '申请数量「' + (qtyRaw || '空') + '」无效' }); return; }
    parsed.push({ project, description, qty: roundQty(qty), unit: String(r[3] || '').trim(), code: String(r[4] || '').trim(), orderNo: String(r[5] || '').trim() || '-', source });
  });
  return { errors, parsed, skippedEmpty };
}
// P2 试校验：同一 multipart 文件、同一套逐行校验，一次性返回全部行的错误清单；不写库、不生成批次
app.post('/api/materials/import/preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const { errors, parsed, skippedEmpty } = validateImportRows(readImportRows(req.file));
    res.json({
      ok: errors.length === 0,
      canImport: errors.length === 0 && parsed.length > 0,
      total: parsed.length + errors.length + skippedEmpty,
      validRows: parsed.length,
      skippedEmpty,
      errorCount: errors.length,
      errors: errors.map(e => ({ row: e.row, message: '第' + e.row + '行：' + e.reason })),
      note: errors.length
        ? '有 ' + errors.length + ' 行不通过校验，正式导入会整批拒绝'
        : (parsed.length ? '校验通过，可导入 ' + parsed.length + ' 行' : '模板中没有可导入的数据行')
    });
  } catch (e) { res.status(500).json({ error: '试校验失败：' + e.message }); }
});
app.post('/api/materials/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const name = req.file.originalname || '';
    const { errors, parsed, skippedEmpty } = validateImportRows(readImportRows(req.file));
    if (errors.length) {
      return res.status(400).json({
        error: '导入失败，共 ' + errors.length + ' 处不一致：'
          + errors.slice(0, 5).map(e => '第' + e.row + '行：' + e.reason).join('；')
          + (errors.length > 5 ? '（仅显示前 5 处）' : '')
      });
    }
    if (!parsed.length) return res.status(400).json({ error: '模板中没有可导入的数据行' });
    // 判重：项目 + 物料编码 + 物料描述 + 单位（材料记录无「规格」字段）。
    // 范围 = 库中未删除材料 + 本文件内先出现的行；重复行跳过，不覆盖已有材料。
    const matKey = r => [r.project, r.code, r.description, r.unit]
      .map(x => String(x == null ? '' : x).trim()).join('\u0001');
    const seenMats = new Set(DB.materials.filter(m => m && !m.deleted).map(m => matKey({
      project: m.project, code: m.code, description: m.description, unit: m.unit
    })));
    const fresh = [];
    let skipped = 0;
    parsed.forEach(r => {
      const k = matKey(r);
      if (seenMats.has(k)) { skipped++; return; }
      seenMats.add(k);
      fresh.push(r);
    });
    if (!fresh.length) {
      return res.json({ ok: true, added: 0, skipped, batch: '', data: [], note: '全部行均为重复，未生成导入批次' });
    }
    const batchId = genId('im'); // 先定批次 id，材料上直接写入 importId，保证可整批删除
    const added = fresh.map(r => {
      const item = {
        id: genId('m'), createdAt: nowISO(), importId: batchId,
        project: r.project, description: r.description,
        qtyRequired: r.qty, qtyArrived: 0, qtyNotArrived: r.qty,
        unit: r.unit, code: r.code, orderNo: r.orderNo, source: r.source,
        sourceNote: '', inWeeklyPlan: false, modifyReason: '', modifiedAt: ''   // P3-1：导入行默认不计入
      };
      item.status = materialStatus(item);
      item.deleted = false;
      DB.materials.push(item);
      return item;
    });
    // 记录导入批次（供「导入批次」页签展示）：项目归属 / 行数（总/匹配/跳过）/ 调整数 / 备注
    const projects = [...new Set(fresh.map(r => r.project))];
    const batch = {
      id: batchId, batch: 'IMP' + Date.now(), fileName: name,
      project: projects.length === 1 ? projects[0] : projects.join('、'),
      rowsTotal: parsed.length + skippedEmpty, rowsMatched: fresh.length, rowsSkipped: skippedEmpty + skipped,
      adjusted: 0, adjustments: [],
      rows: added.length, materialIds: added.map(x => x.id),
      importedBy: req.user.name, importedAt: fmtNow(), status: '成功', remark: '-',
      deleted: false
    };
    DB.materialImports.push(batch);
    saveDB();
    res.json({ ok: true, added: added.length, skipped, batch: batch.batch, data: added });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 领料单（暂存清单 → 生成领料单 → 下载 Excel → 确认入库 / 作废） ----------
// 单号规则 LL-YYYYMMDD-NNNN：日期取领料业务日 reqDate（不是录入日），NNNN 为该日 4 位补零流水（删除补缺，作废不腾号）。
// Node 单线程下 create 处理函数（算单号→入数组→saveDB）全程同步、无 await 让出，并发在 JS 层串行，
// 后到者能看到前者记录并取「最小未占用号」，同一秒并发也不会撞号；已删除记录不占号，已作废仍占号。
// 历史单已由 scripts/migrate-no4-20261031.js 全量重编为本格式，推导天然连续。
// 从暂存的物料生成领料单；领料数量可任意填写（默认=可继续领料），但不能大于可继续领料
// 请求体：{ items: [{ id, qty }], reqDate?, reqDateReason?, correctedFrom? }（兼容旧 { ids: [...] } = 按可继续领料全量生成）
// 作废重开：correctedFrom 为被重开的原领料单（id 或单号，须已作废），新单写 correctedFrom/FromNo，原单回写 correctedBy/ByNo。
app.post('/api/requisitions/create', (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.items) && body.items.length
    ? body.items.map(x => ({ id: x.id, qty: x.qty }))
    : (Array.isArray(body.ids) ? body.ids.map(id => ({ id })) : []);
  if (!list.length) return res.status(400).json({ error: '暂存清单为空，无法生成领料单' });
  // P4-1：领料日期（必填，省略默认今天；不能晚于今天；超 30 天必须填补录原因）
  const reqDate = String(body.reqDate || '').trim() || todayBizDate();
  const reqDateReason = String(body.reqDateReason || '').trim();
  const reqDateErr = bizDateError('领料日期', reqDate, reqDateReason);
  if (reqDateErr) return res.status(400).json({ error: reqDateErr });
  // 作废重开：correctedFrom 必须指向已存在、未删除、已作废的原领料单；不满足就 400，绝不建单
  const reopen = resolveReopenSource('req', body.correctedFrom);
  if (reopen.error) return res.status(400).json({ error: reopen.error });
  const orig = reopen.orig;
  const items = [];
  const skipped = [];
  const touched = [];
  for (const entry of list) {
    const m = DB.materials.find(x => x.id === entry.id && !x.deleted);
    if (!m) continue;
    const canGen = withGen(m).qtyCanGen;
    // 已全部到库 / 可继续领料为 0 的材料不允许再生成领料单
    if ((m.qtyNotArrived <= 0 && Number(m.qtyRequired) > 0) || canGen <= 0) { skipped.push(m.code || m.description || entry.id); continue; }
    let qty = entry.qty === undefined || entry.qty === '' || entry.qty === null ? canGen : Number(entry.qty);
    if (!isFinite(qty) || qty <= 0) return res.status(400).json({ error: '物料「' + (m.description || m.code) + '」领料数量无效，必须大于 0' });
    qty = roundQty(qty);
    if (qty > canGen) return res.status(400).json({ error: '物料「' + (m.description || m.code) + '」领料数量 ' + qty + ' 不能大于可继续领料 ' + canGen });
    touched.push(m);
    items.push({
      materialId: m.id, code: m.code || '-', description: m.description || '',
      unit: m.unit || '', qty, arrivedBefore: roundQty(m.qtyArrived), orderNo: m.orderNo || '-', project: m.project || ''
    });
  }
  if (!items.length) return res.status(400).json({ error: skipped.length ? '所选物料均已全部到库或无可继续领料数量，无法生成领料单' : '所选物料已不存在，无法生成领料单' });
  const rec = {
    id: genId('rq'), reqNo: reqNoOf(reqDate),
    reqDate, reqDateReason,
    projects: [...new Set(items.map(i => i.project))],
    items, createdAt: fmtNow(), status: '待入库', confirmRows: null,
    correctedFrom: orig ? orig.id : '', correctedFromNo: orig ? (orig.reqNo || '') : '',
    legacy: false,
    deleted: false
  };
  DB.materialRequisitions.unshift(rec);
  // P4-3：原单回写反向关联（同一次 saveDB 落盘，保证双向一致）
  if (orig) { orig.correctedBy = rec.id; orig.correctedByNo = rec.reqNo; }
  // 同步材料状态（已生成数量按领料单动态汇总，部分生成时剩余量仍可继续领料）
  touched.forEach(m => { m.status = materialStatus(m); });
  saveDB();
  res.json({ ok: true, data: rec });
});

// P3-4 领料单导出标题的「单位」取值：项目所属单位专用字段 → 项目 substation（属地供电所）
// → 系统设置企业名称 → ''（兜底为「物资领料单」）。
// 注：现行项目记录的字段集里没有「所属单位」专用字段（见 projects 集合），这里只做存在性兼容读取，取不到即跳过。
function requisitionUnitName(rec) {
  const names = [];
  (rec.projects || []).forEach(n => names.push(n));
  (rec.items || []).forEach(it => { if (it && it.project) names.push(it.project); });
  const uniq = [...new Set(names.map(x => String(x || '').trim()).filter(Boolean))];
  for (const n of uniq) {
    const p = DB.projects.find(x => !x.deleted && (String(x.name || '').trim() === n
      || (x.subProjects || []).some(s => String((s || {}).name || '').trim() === n)));
    if (!p) continue;
    const unit = String(p.unitName || p.unit || '').trim();
    if (unit) return unit;
    const sub = String(p.substation || '').trim();
    if (sub) return sub;
  }
  return String((DB.settings || {}).companyName || '').trim();
}
// 下载领料单 Excel（格式对齐原系统样例：LL-20261009-222544.xlsx）
app.get('/api/materialRequisitions/:id/download', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  const aoa = [];
  const docUnit = requisitionUnitName(rec);
  aoa.push([(docUnit ? docUnit + '过渡仓代保管物资领料单' : '物资领料单'), '', '', '', '', '', '']);
  aoa.push(['项目部门：', '', '', '', '', '', '']);
  // P4-6：补领料日期与单号（单号日期即开单日，两者都应能在打印表上看到）
  aoa.push(['领料日期：' + (rec.reqDate || '') + '　　领料单号：' + (rec.reqNo || '') + (rec.correctedFromNo ? '　　重开自：' + rec.correctedFromNo : ''), '', '', '', '', '', '']);
  aoa.push(['序号', '物料编码', '物料描述', '计量单位', '数量', '项目名称', '备注']);
  rec.items.forEach((it, i) => {
    aoa.push([String(i + 1), it.code, it.description, it.unit, it.qty, it.project, it.orderNo === '-' ? '' : it.orderNo]);
  });
  // 按次列出入库历史（每一次 confirm 一块，整单一个到货日；待入库单不虚构）
  const hist = Array.isArray(rec.history) ? rec.history : [];
  if (hist.length) {
    aoa.push(['', '', '', '', '', '', '']);
    aoa.push(['入库记录（按次）', '', '', '', '', '', '']);
    aoa.push(['到货日期', '物料描述', '本次数量', '录入时间', '', '', '']);
    hist.forEach(h => {
      const day = String((h && h.arrivalDate) || (h && h.at) || '').slice(0, 10);
      const at = String((h && h.at) || '');
      (h.rows || []).forEach(r => {
        const it = rec.items.find(x => x.materialId === r.materialId) || {};
        aoa.push([day, it.description || '', r.thisQty, at, '', '', '']);
      });
    });
  }
  for (let i = 0; i < 5; i++) aoa.push(['', '', '', '', '', '', '']);
  aoa.push(['项目部门负责人：                                    项目部门分管领导：                                            领料人：                                      库管员：    ', '', '', '', '', '', '']);
  aoa.push(['说明：备注栏填写原订单号。', '', '', '', '', '', '']);
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: 6, r: 0 } },
    { s: { c: 0, r: 1 }, e: { c: 6, r: 1 } },
    { s: { c: 0, r: 2 }, e: { c: 6, r: 2 } },
    { s: { c: 0, r: aoa.length - 2 }, e: { c: 6, r: aoa.length - 2 } },
    { s: { c: 0, r: aoa.length - 1 }, e: { c: 6, r: aoa.length - 1 } }
  ];
  ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 34 }, { wch: 14 }];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + rec.reqNo + '.xlsx"');
  res.send(buf);
});

// 确认入库 / 补入库：无异常 → 本次入库=剩余未入库数量；有异常 → 按行传入实际本次入库数量与异常原因
// 待入库首录入库；「部分到库」（存在异常缺库）的领料单可再次补入库，confirmRows 按物料累计入库数量
app.put('/api/materialRequisitions/:id/confirm', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '待入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单' + rec.status + '，不能重复入库' });
  // P4-1：到货日期按次整单——一次 confirm 只认一个 arrivalDate，写在本次 history 条目上；
  // rows[] 上若带日期一律忽略（不按行生效，也不为此报错）。必须满足 领料日期 ≤ 到货日期 ≤ 今天。
  const arrivalDate = String((req.body || {}).arrivalDate || '').trim() || todayBizDate();
  const arrivalReason = String((req.body || {}).arrivalReason || '').trim();
  const arrivalErr = bizDateError('到货日期', arrivalDate, arrivalReason);
  if (arrivalErr) return res.status(400).json({ error: arrivalErr });
  const reqDateOfRec = String(rec.reqDate || '').slice(0, 10);
  if (reqDateOfRec && arrivalDate < reqDateOfRec) {
    return res.status(400).json({ error: '到货日期不能早于领料日期（' + reqDateOfRec + '）' });
  }
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const results = (rec.confirmRows || []).map(x => ({ ...x })); // 已累计的入库记录
  const plan = []; // 先算后写：校验全部通过再动库，避免写到一半被回放拒绝
  for (const it of rec.items) {
    const prev = results.find(x => x.materialId === it.materialId);
    const done = prev ? (Number(prev.thisQty) || 0) : 0;
    const remaining = roundQty(Math.max(0, it.qty - done));
    const r = rows.find(x => x.materialId === it.materialId) || {};
    let qty = r.thisQty === undefined || r.thisQty === '' ? remaining : Number(r.thisQty);
    if (!isFinite(qty) || qty < 0) return res.status(400).json({ error: '物料「' + it.description + '」本次入库数量无效' });
    if (qty > remaining) return res.status(400).json({ error: '物料「' + it.description + '」本次入库数量不能大于未入库数量（剩余 ' + remaining + '）' });
    qty = roundQty(qty);
    const reason = String(r.reason || '').trim();
    const cum = roundQty(done + qty);
    // 仍有未入库数量即视为异常，须有异常原因（本次填写或沿用上次）
    const abnormal = cum < it.qty - 1e-9;
    if (abnormal && !reason && !(prev && prev.reason)) return res.status(400).json({ error: '物料「' + it.description + '」仍有未入库数量，必须填写异常原因' });
    plan.push({ it, qty, reason, cum, abnormal, prev });
  }
  // P4-4：新单（legacy !== true）的确认入库走按日回放；存量单补入库不跑，避免被历史账锁死
  if (rec.legacy !== true) {
    for (const p of plan) {
      if (!(p.qty > 0)) continue;
      const m = DB.materials.find(x => x.id === p.it.materialId && !x.deleted);
      if (!m) continue;
      const rp = replayAvailability(p.it.materialId, [{ date: arrivalDate, kind: 'in', qty: p.qty, self: true }]);
      if (!rp.ok) return replayFail(res, m, rp, '本单入库');
    }
  }
  const opRows = []; // 本次操作的逐条记录（写入 history，供详情展示与 Excel 下载）
  for (const p of plan) {
    const it = p.it, qty = p.qty, reason = p.reason, cum = p.cum, abnormal = p.abnormal, prev = p.prev;
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
    if (m && qty > 0) {
      m.qtyArrived = roundQty(m.qtyArrived + qty);
      m.qtyNotArrived = roundQty(Math.max(0, m.qtyRequired - m.qtyArrived));
      m.requisitionId = null; // 本次领料流程结束（已入库），状态回归按数量计算
      m.status = materialStatus(m);
      if (abnormal) { m.abnormalNote = reason || (prev && prev.reason) || ''; m.modifiedAt = fmtNow(); }
    }
    if (prev) { prev.thisQty = cum; prev.abnormal = abnormal; prev.reason = abnormal ? (reason || prev.reason) : ''; }
    else results.push({ materialId: it.materialId, thisQty: cum, abnormal, reason });
    opRows.push({ materialId: it.materialId, thisQty: qty, abnormal, reason });
  }
  // 全部物料累计入库数量均达到领料数量 → 已入库；否则部分到库（可继续补入库）
  const allFull = rec.items.every(it => {
    const cr = results.find(x => x.materialId === it.materialId);
    return cr && (Number(cr.thisQty) || 0) >= it.qty - 1e-9;
  });
  rec.status = allFull ? '已入库' : '部分到库';
  rec.confirmRows = results;
  rec.confirmedAt = fmtNow();
  // 每次入库/补入库操作均记录历史（详情展开逐条展示 + Excel 领料单附带入库记录）
  if (!Array.isArray(rec.history)) rec.history = [];
  rec.history.push({ at: rec.confirmedAt, arrivalDate, arrivalReason, rows: opRows });
  saveDB();
  res.json({ ok: true, data: rec });
});

// 作废前试算：冲销后可用 =（当前已到 − 本单该行累计入库量）− 该材料有效出库净额
// 净额口径复用 outboundStats（仅未删除、状态=有效的出库单，领取 − 归还）；任一行 < 0 整单拒绝。
// 未入库行（deduct = 0）不改变库存，不参与试算；待入库单因此天然不受影响。
function voidAvailabilityCheck(rec) {
  let bad = false;
  const refs = [];
  const statsCache = {};
  (rec.items || []).forEach(it => {
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
    if (!m) return;
    const cr = (rec.confirmRows || []).find(c => c.materialId === it.materialId);
    const deduct = roundQty(cr ? (Number(cr.thisQty) || 0) : 0);
    if (deduct <= 0) return;
    const arrivedAfter = roundQty((Number(m.qtyArrived) || 0) - deduct);
    if (!statsCache[m.project]) statsCache[m.project] = outboundStats(m.project);
    const st = statsCache[m.project][m.id] || { taken: 0, returned: 0 };
    const net = roundQty(st.taken - st.returned);
    const availableAfter = roundQty(arrivedAfter - net);
    if (availableAfter >= -1e-9) return;
    bad = true;
    // 列出占用该材料（净出库 > 0）的有效出库单，供前端逐条展示
    DB.materialOutbound.forEach(o => {
      if (o.deleted || o.status !== '有效') return;
      (o.items || []).forEach(oi => {
        if (!oi || oi.materialId !== m.id) return;
        const qty = roundQty(oi.qty);
        const returned = roundQty(oi.returned);
        const oNet = roundQty(qty - returned);
        if (oNet <= 0) return;
        refs.push({
          outNo: o.outNo || '', outboundId: o.id, materialId: m.id,
          code: oi.code || m.code || '', description: oi.description || m.description || '',
          qty, returned, net: oNet, availableAfter, receiver: o.receiver || ''
        });
      });
    });
  });
  return { bad, refs };
}
// 作废（待入库/已入库/部分到库均可作废；已入库的会冲销其已入库数量，材料状态按扣减后重新汇总）
app.put('/api/materialRequisitions/:id/void', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '待入库' && rec.status !== '已入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单' + rec.status + '，不能作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写作废原因' });
  // 冲销不得把可用库存冲成负数（否则料从库存消失、而出库单仍然占用）
  const chk = voidAvailabilityCheck(rec);
  if (chk.bad) {
    return res.status(400).json({ error: '作废后可用库存将为负，请先归还或作废占用的出库单', refs: chk.refs });
  }
  // P4-4：新单作废在 P0-2 之后还要过按日回放（把本单历次入库从时间轴上撤掉，看中间某天会不会为负）。
  // 存量单（legacy: true）只走 P0-2，不跑回放——旧账本来就可能对不上，否则永远作废不了。
  if (rec.legacy !== true) {
    for (const it of (rec.items || [])) {
      const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
      if (!m) continue;
      const evs = [];
      (rec.history || []).forEach(h => {
        const row = (h.rows || []).find(x => x && x.materialId === it.materialId);
        const q = Number(row && row.thisQty) || 0;
        if (q <= 0) return;
        evs.push({ date: h.arrivalDate || h.at, kind: 'in', qty: -q, self: true });
      });
      if (!evs.length) continue;
      const rp = replayAvailability(it.materialId, evs);
      if (!rp.ok) return replayFail(res, m, rp, '本单作废');
    }
  }
  rec.status = '已作废';
  // 按领料单明细恢复材料状态（待入库作废时 confirmRows 为空，也要解除「已生成领料单」锁定）
  (rec.items || []).forEach(it => {
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
    if (!m) return;
    const cr = (rec.confirmRows || []).find(c => c.materialId === it.materialId);
    const deduct = cr ? (Number(cr.thisQty) || 0) : 0;
    if (deduct > 0) {
      m.qtyArrived = roundQty(Math.max(0, m.qtyArrived - deduct));
      m.qtyNotArrived = roundQty(Math.max(0, m.qtyRequired - m.qtyArrived));
    }
    m.requisitionId = null;
    m.status = materialStatus(m);
  });
  rec.voidedAt = fmtNow();
  rec.voidReason = reason;
  rec.voidDeduct = roundQty((rec.confirmRows || []).reduce((s, r) => s + (Number(r.thisQty) || 0), 0));
  saveDB();
  res.json({ ok: true, data: rec });
});

// 材料相关集合走通用 CRUD（逻辑删除；须晚于上面各具体的 /:id 删除路由注册）
['materialRequisitions', 'materialImports', 'materialOutbound'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
