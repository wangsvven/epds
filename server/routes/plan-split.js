/* ========== routes/plan-split ==========
 * 周计划拆分：预览 / 执行 / 撤销 三个接口。
 * 注册顺序：必须在 routes/plans.js 的 workPlans 通用 CRUD 之前（server.js 中先 require 本文件）。
 *
 * 口径（用户 2026-11-10 定版）：
 *   - 子计划沿用父计划的勘察编号与工作票编号，不生成子编号；
 *   - 子计划状态 = 未执行；父计划不改名，收缩为第一天，子计划名 = 原名 +「（M月D日）」；
 *   - 父计划有勘察记录时给每个子计划各复制一份（生成文档/图纸/压缩包不复制）；
 *   - 撤销受子计划状态、拆分后编辑（updatedAt ≠ createdAt，含工程量时间戳）、
 *     以及勘察是否为本批克隆/是否被编辑三条约束。
 */
const app = require('../core/app');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO } = require('../core/util');
const crypto = require('crypto');
const { isDistPowerTicketType, allocateWorkTicketNos } = require('../core/plan-ticket-no');
const {
  parseDailyContent, parseDayItems, dayList, dayRange, mdLabel, mergeQuantities, QTY_FIELDS
} = require('../core/plan-split');

/* 拆分快照字段：撤销时原样恢复 */
const SNAP_FIELDS = ['startDate', 'endDate', 'content', 'shadowContent'].concat(QTY_FIELDS);
/* 子计划不继承的字段（生成物随计划走，不复制；工程量时间戳属父计划） */
const CHILD_DROP_FIELDS = ['splitSnapshot', 'generatedFiles', 'drawings', 'materialPackage', 'package',
  'quantitiesUpdatedAt', 'quantitiesUpdatedBy'];

function findPlan(id) {
  const p = (DB.workPlans || []).find(x => x.id === id);
  if (!p || p.deleted) return null;
  return p;
}
function dateOf(v) { return String(v == null ? '' : v).slice(0, 10); }
function isCrossDay(p) { return dateOf(p.endDate) > dateOf(p.startDate); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function pick(o, keys) {
  const r = {};
  keys.forEach(k => { if (o[k] !== undefined) r[k] = o[k]; });
  return r;
}
function qtyToText(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return String(Number(n.toFixed(3)));
}
function applyQty(target, q) {
  QTY_FIELDS.forEach(k => { target[k] = qtyToText(q ? q[k] : ''); });
}

/* 勘察克隆：深拷贝本体、重发危险点 id、打批次标记、时间戳刷新；父记录不动 */
function cloneSurvey(src, batchId, now) {
  const s = clone(src);
  s.splitBatchId = batchId;
  s.createdAt = now;
  s.updatedAt = now;
  if (Array.isArray(s.hazardPoints)) {
    s.hazardPoints = s.hazardPoints.map(h => Object.assign({}, h, { id: genId('hz') }));
  }
  return s;
}

/* preview / split 的前置：存在 → 周计划 → 非子计划 → 未拆分 → 未执行 → 跨天
 * 注：「已拆分」的父计划因收缩成第一天会先命中「单日」，故批次判断必须早于跨天判断。 */
function precheckSplit(p, res) {
  if (!p) { res.status(404).json({ error: '未找到计划' }); return false; }
  if (p.planType !== '周计划') { res.status(400).json({ error: '仅周计划支持拆分' }); return false; }
  if (p.parentPlanId) { res.status(400).json({ error: '子计划不能再次拆分' }); return false; }
  if (p.splitBatchId) { res.status(409).json({ error: '该计划已拆分，如需调整请先撤销拆分' }); return false; }
  if (p.status !== '未执行') { res.status(400).json({ error: '仅「未执行」状态的周计划支持拆分操作' }); return false; }
  if (!isCrossDay(p)) { res.status(400).json({ error: '单日计划无需拆分' }); return false; }
  return true;
}

/* ---------- Step 6：勘察判别 / 版本摘要 / 规范化（只读，不落库、不占号） ---------- */

/* §2.3 勘察判别：仅「字段缺失或 undefined」可拆；非空普通对象 → 已勘察；其余存在情形一律异常。
 * 不使用 !survey（会误放行 null / false / 0 / 空串），不以时间戳或编号非空代替勘察判定，
 * 也不改动勘察 UI 自身的「已勘察」判定。 */
function surveyTypeLabel(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}
function classifySplitSurvey(survey) {
  if (survey === undefined) return { decision: 'allow' };
  if (survey !== null && typeof survey === 'object' && !Array.isArray(survey)) {
    const proto = Object.getPrototypeOf(survey);
    const plain = proto === Object.prototype || proto === null;
    if (plain && Object.keys(survey).length > 0) return { decision: 'block_surveyed' };
    return { decision: 'block_anomalous', message: '勘察字段为空对象或非普通对象，无法判断是否已勘察，请先核对该计划的勘察记录' };
  }
  return { decision: 'block_anomalous', message: '勘察字段类型异常（' + surveyTypeLabel(survey) + '），无法判断是否已勘察，请先核对该计划的勘察记录' };
}

/* 稳定序列化：对象键排序、数组保序，保证同输入同串（三段摘要共用） */
function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
function digestOf(v) { return crypto.createHash('sha256').update(stableStringify(v)).digest('hex'); }
function qtyTuple(q) {
  return QTY_FIELDS.map(k => String((q || {})[k] == null ? '' : (q || {})[k]));
}

/* §2.3 预览版本：v1:<源摘要>:<规范化days摘要>:<拟号摘要>
 * 源值与最终 days 分别绑定（不得只绑 days）；不使用 updatedAt（勘察 PUT 不刷新它）。 */
function computeSplitPreviewVersion(input) {
  const b = input || {};
  const src = {
    id: String(b.id == null ? '' : b.id),
    startDate: String(b.startDate == null ? '' : b.startDate),
    endDate: String(b.endDate == null ? '' : b.endDate),
    content: String(b.content == null ? '' : b.content),
    quantities: qtyTuple(b.quantities),
    ticketType: String(b.ticketType == null ? '' : b.ticketType),
    surveyNo: String(b.surveyNo == null ? '' : b.surveyNo),
    workTicketNo: String(b.workTicketNo == null ? '' : b.workTicketNo),
    surveyDecision: String(b.surveyDecision == null ? '' : b.surveyDecision),
    splitBatchId: String(b.splitBatchId == null ? '' : b.splitBatchId),
    parentPlanId: String(b.parentPlanId == null ? '' : b.parentPlanId)
  };
  const daysNorm = (b.days || []).map(d => ({
    date: String(d.date == null ? '' : d.date),
    content: String(d.content == null ? '' : d.content),
    quantities: qtyTuple(d.quantities)
  }));
  const nosNorm = (b.days || []).map(d => ({
    date: String(d.date == null ? '' : d.date),
    workTicketNo: String(d.workTicketNo == null ? '' : d.workTicketNo),
    surveyNo: String(d.surveyNo == null ? '' : d.surveyNo)
  }));
  return 'v1:' + digestOf(src) + ':' + digestOf(daysNorm) + ':' + digestOf(nosNorm);
}

/* 提交稿 days 规范化：沿用执行拆分时的既有校验（日期格式 / 越界 / 重复 / 内容为空 / 缺日 / 工量合并） */
function normalizeSubmittedDays(input, expected) {
  const errors = [];
  const byDate = {};
  input.forEach((d, i) => {
    const date = dateOf(d && d.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push('第 ' + (i + 1) + ' 行日期格式不正确'); return; }
    if (expected.indexOf(date) < 0) { errors.push('日期 ' + date + ' 不在计划日期范围内'); return; }
    if (byDate[date]) { errors.push('日期 ' + date + ' 重复'); return; }
    const content = String((d && d.content) == null ? '' : d.content).trim();
    if (!content) { errors.push('日期 ' + date + ' 内容为空'); return; }
    byDate[date] = { date, content, quantities: mergeQuantities({}, (d && d.quantities) || {}) };
  });
  expected.forEach(date => { if (!byDate[date]) errors.push('工作内容缺少计划日期：' + date); });
  if (errors.length) return { ok: false, errors };
  const days = expected.map(d => byDate[d]);
  // 条目照内容重建（与文本解析同一套 core 规则），供预览展示
  let prevItems = [];
  days.forEach(d => { const items = parseDayItems(d.content, prevItems); d.items = items; prevItems = items; });
  return { ok: true, days };
}

/* ---------- 预览：只解析校验与拟号，不落库、不占号、不保存预览态 ---------- */
app.post('/api/workPlans/:id/split/preview', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  if (p.planType !== '周计划') return res.status(400).json({ error: '仅周计划支持拆分' });
  // 已拆门禁（原记录 / 子记录）先于勘察门禁：子记录带克隆勘察，须先报 ALREADY_SPLIT
  if (p.parentPlanId || p.splitBatchId) {
    return res.status(409).json({ ok: false, error: 'ALREADY_SPLIT', message: '该计划已拆分或为拆分产生的子计划，不能再次拆分' });
  }
  const sc = classifySplitSurvey(p.survey);
  if (sc.decision === 'block_surveyed') {
    return res.status(409).json({ ok: false, error: 'SURVEY_EXISTS', message: '该计划已有勘察记录，不能拆分；如需调整请先处理勘察记录' });
  }
  if (sc.decision === 'block_anomalous') {
    return res.status(409).json({ ok: false, error: 'SURVEY_ANOMALOUS', message: sc.message });
  }
  // 既有拆分前置条件（与执行拆分一致，本步不新建状态机）
  if (p.status !== '未执行') return res.status(400).json({ error: '仅「未执行」状态的周计划支持拆分操作' });
  if (!isCrossDay(p)) return res.status(400).json({ error: '单日计划无需拆分' });

  const b = req.body || {};
  const has = k => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
  if (has('content') && has('days')) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'content 与 days 不能同时提供' });
  }
  const expected = dayList(p.startDate, p.endDate);
  let norm;
  if (has('days')) {
    // 显式 days 即以此为准：null / 非数组不得静默退回源内容解析
    if (!Array.isArray(b.days)) {
      return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'days 必须是数组（如仅按文本预览请改用 content）' });
    }
    norm = normalizeSubmittedDays(b.days, expected);
    if (!norm.ok) return res.status(400).json({ error: '拆分校验未通过', errors: norm.errors });
  } else {
    const content = has('content') ? String(b.content) : String(p.content || '');
    const r = parseDailyContent(content, p.startDate, p.endDate);
    if (!r.ok) return res.json({ ok: false, errors: r.errors, days: [] });
    norm = { ok: true, days: r.days.map(d => ({ date: d.date, content: d.content, items: d.items, quantities: d.quantities })) };
  }

  // 三条路径统一：先按日期升序归一（文本解析可能按出现顺序乱序），再标首日 / 拟号 / 摘要
  norm.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (norm.days.length < 2) return res.status(400).json({ error: '单日计划无需拆分' });

  const srcNo = String(p.workTicketNo == null ? '' : p.workTicketNo);
  const srcSurveyNo = String(p.surveyNo == null ? '' : p.surveyNo);
  const dist = isDistPowerTicketType(p.ticketType);
  // 预演拟号：仅配电非首日；号池不排除源记录（首日保留的源号仍算占用）
  let planned = [];
  if (dist && norm.days.length > 1) {
    const allocated = allocateWorkTicketNos({
      items: norm.days.slice(1).map(d => ({ ticketType: p.ticketType, yearMonth: String(d.date).slice(0, 7).replace('-', '') })),
      records: DB.workPlans
    });
    if (!allocated.ok) return res.status(400).json({ ok: false, error: allocated.error, message: allocated.message });
    planned = allocated.workTicketNos;
  }
  const days = norm.days.map((d, i) => {
    const rg = dayRange(d.date, p.startDate, p.endDate);
    return {
      date: d.date, start: rg.start, end: rg.end,
      content: d.content, items: d.items, quantities: d.quantities,
      isFirstDay: i === 0,
      workTicketNo: i === 0 ? srcNo : (dist ? planned[i - 1] : srcNo),   // 首日=源原号原样；线路非首日沿既有口径
      surveyNo: srcSurveyNo                                              // 各日均为源原勘察号，不为子记录新取
    };
  });
  const previewVersion = computeSplitPreviewVersion({
    id: p.id, startDate: p.startDate, endDate: p.endDate, content: p.content, quantities: p,
    ticketType: p.ticketType, surveyNo: p.surveyNo, workTicketNo: p.workTicketNo,
    surveyDecision: sc.decision, splitBatchId: p.splitBatchId, parentPlanId: p.parentPlanId, days
  });
  res.json({ ok: true, previewVersion, sourcePlanId: p.id, firstDayPlanId: p.id, days });
});

/* ---------- 执行拆分：校验通过后一次 saveDB 落库 ---------- */
app.post('/api/workPlans/:id/split', (req, res) => {
  const p = findPlan(req.params.id);
  if (!precheckSplit(p, res)) return;

  const b = req.body || {};
  const input = Array.isArray(b.days) ? b.days : [];
  const expected = dayList(p.startDate, p.endDate);
  const errors = [];
  const byDate = {};
  input.forEach((d, i) => {
    const date = dateOf(d && d.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push('第 ' + (i + 1) + ' 行日期格式不正确'); return; }
    if (expected.indexOf(date) < 0) { errors.push('日期 ' + date + ' 不在计划日期范围内'); return; }
    if (byDate[date]) { errors.push('日期 ' + date + ' 重复'); return; }
    const content = String((d && d.content) == null ? '' : d.content).trim();
    if (!content) { errors.push('日期 ' + date + ' 内容为空'); return; }
    byDate[date] = { date, content, quantities: mergeQuantities({}, (d && d.quantities) || {}) };
  });
  expected.forEach(date => { if (!byDate[date]) errors.push('工作内容缺少计划日期：' + date); });
  if (errors.length) return res.status(400).json({ error: '拆分校验未通过', errors });

  const days = expected.map(d => byDate[d]);
  if (days.length < 2) return res.status(400).json({ error: '单日计划无需拆分' });

  const now = nowISO();
  const batchId = genId('sp');
  const before = clone(p);
  const first = days[0];

  // 1) 父计划：落快照 + 批次 + 收缩为第一天
  p.splitSnapshot = pick(before, SNAP_FIELDS);
  p.splitBatchId = batchId;
  p.endDate = dayRange(first.date, before.startDate, before.endDate).end;
  p.content = first.content;
  applyQty(p, first.quantities);
  p.updatedAt = now;

  // 2) 其余每天一条子计划：以拆分前记录为模板深拷贝
  const children = [];
  days.slice(1).forEach(d => {
    const child = clone(before);
    CHILD_DROP_FIELDS.forEach(k => { delete child[k]; });
    const rg = dayRange(d.date, before.startDate, before.endDate);
    child.id = genId('wp');
    child.name = String(before.name || '') + '（' + mdLabel(d.date) + '）';
    child.startDate = rg.start;
    child.endDate = rg.end;
    child.content = d.content;
    applyQty(child, d.quantities);
    child.parentPlanId = p.id;
    child.splitBatchId = batchId;
    child.status = '未执行';
    child.createdAt = now;
    child.updatedAt = now;
    child.deleted = false;
    // 3) 勘察：父计划有勘察才克隆（生成物不复制）
    if (before.survey && typeof before.survey === 'object') child.survey = cloneSurvey(before.survey, batchId, now);
    else delete child.survey;
    DB.workPlans.push(child);
    children.push(child);
  });

  saveDB();
  res.json({
    ok: true, batchId, parentId: p.id,
    children: children.map(c => ({ id: c.id, name: c.name, startDate: c.startDate, endDate: c.endDate }))
  });
});

/* ---------- 撤销拆分 ---------- */
app.post('/api/workPlans/:id/unsplit', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  if (p.planType !== '周计划') return res.status(400).json({ error: '仅周计划支持拆分操作' });
  if (!p.splitBatchId) return res.status(409).json({ error: '该计划未拆分，无需撤销' });
  if (!p.splitSnapshot) return res.status(409).json({ error: '拆分快照缺失，无法自动恢复，请人工处理' });

  const batchId = p.splitBatchId;
  const children = (DB.workPlans || []).filter(x => !x.deleted && x.parentPlanId === p.id && x.splitBatchId === batchId);
  const blocks = [];
  children.forEach(c => {
    if (c.status !== '未执行') { blocks.push(c.name + '：状态为「' + (c.status || '空') + '」'); return; }
    if (c.updatedAt && c.createdAt && c.updatedAt !== c.createdAt) { blocks.push(c.name + '：拆分后被编辑过'); return; }
    if (c.quantitiesUpdatedAt) { blocks.push(c.name + '：拆分后修改过工程量'); return; }
    const sv = c.survey;
    if (sv && typeof sv === 'object') {
      // 先判「被编辑」再判批次：PUT /survey 会按白名单重建勘察对象（批次标记随之消失），
      // 若先判批次，任何一次改勘察都会误报成「已有独立勘察记录」。
      if (sv.createdAt && sv.updatedAt && sv.updatedAt !== sv.createdAt) { blocks.push(c.name + '：勘察记录被编辑过'); return; }
      if (sv.splitBatchId !== batchId) { blocks.push(c.name + '：已有独立勘察记录'); return; }
    }
  });
  if (blocks.length) {
    return res.status(409).json({ error: '无法撤销拆分：子计划已被改动，请逐条处理后再试', blocks });
  }

  const now = nowISO();
  const snap = p.splitSnapshot;
  SNAP_FIELDS.forEach(k => { if (snap[k] !== undefined) p[k] = snap[k]; });
  delete p.splitBatchId;
  delete p.splitSnapshot;
  p.updatedAt = now;
  children.forEach(c => { c.deleted = true; c.updatedAt = now; });

  saveDB();
  res.json({ ok: true, removed: children.length });
});

/* 供隔离测试直接调用（纯函数，不触库）；路由行为不变 */
module.exports = { classifySplitSurvey, computeSplitPreviewVersion };

