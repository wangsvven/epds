/* ========== routes/plan-split ==========
 * 周计划拆分：预览 / 确认 两个接口（撤销端点自 Step 7 起关闭返回 410）。
 * 注册顺序：必须在 routes/plans.js 的 workPlans 通用 CRUD 之前（server.js 中先 require 本文件）。
 *
 * 口径（Step 6 预览 + Step 7 确认，沿用 2026-11-10 定版并按其演进）：
 *   - 首日保留源计划工作票号原样（含历史旧号/缺号，不强制改号）；配电非首日按各自所在月新取号，
 *     线路等非配电沿既有口径；各日共用源勘察编号，不为子记录新取号、不复制勘察对象；
 *   - 子计划状态 = 未执行；父计划不改名，收缩为第一天，子计划名 = 原名 +「（M月D日）」；
 *   - 确认须带 previewVersion + 完整 days；同版本同 days 的重复提交按精确重放返回同一结果；
 *     仅新成功拆分时在首日写 splitCommitVersion（不写 splitSnapshot，快照仅历史记录保留）；
 *   - 撤销拆分不可用（SPLIT_IRREVERSIBLE），不改动历史快照与父子关系。
 */
const app = require('../core/app');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO } = require('../core/util');
const crypto = require('crypto');
const { isDistPowerTicketType, allocateWorkTicketNos, assertDistWorkTicketNoAvailable } = require('../core/plan-ticket-no');
const {
  parseDailyContent, parseDayItems, dayList, dayRange, mdLabel, mergeQuantities, QTY_FIELDS
} = require('../core/plan-split');

/* 子计划不继承的字段（生成物随计划走，不复制；工程量时间戳属父计划） */
const CHILD_DROP_FIELDS = ['splitCommitVersion', 'splitSnapshot', 'generatedFiles', 'drawings', 'materialPackage', 'package',
  'quantitiesUpdatedAt', 'quantitiesUpdatedBy'];

function findPlan(id) {
  const p = (DB.workPlans || []).find(x => x.id === id);
  if (!p || p.deleted) return null;
  return p;
}
function dateOf(v) { return String(v == null ? '' : v).slice(0, 10); }
function isCrossDay(p) { return dateOf(p.endDate) > dateOf(p.startDate); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }
function qtyToText(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!isFinite(n)) return '';
  return String(Number(n.toFixed(3)));
}
function applyQty(target, q) {
  QTY_FIELDS.forEach(k => { target[k] = qtyToText(q ? q[k] : ''); });
}


/* 统一门禁（预览与首次确认共用）：存在 → 周计划 → 已拆(原/子) → 勘察 → 未执行 → 跨天。
 * 已拆判断早于勘察：子记录带克隆勘察，须先报 ALREADY_SPLIT；也早于跨天（父计划收缩成首日）。
 * 合法精确重放不走本门禁，由确认端点在此之前识别。 */
function assertCanSplit(p) {
  if (!p) return { ok: false, status: 404, error: '未找到计划' };
  if (p.planType !== '周计划') return { ok: false, status: 400, error: '仅周计划支持拆分' };
  if (p.parentPlanId || p.splitBatchId) {
    return { ok: false, status: 409, error: 'ALREADY_SPLIT', message: '该计划已拆分或为拆分产生的子计划，不能再次拆分' };
  }
  const sc = classifySplitSurvey(p.survey);
  if (sc.decision === 'block_surveyed') {
    return { ok: false, status: 409, error: 'SURVEY_EXISTS', message: '该计划已有勘察记录，不能拆分；如需调整请先处理勘察记录' };
  }
  if (sc.decision === 'block_anomalous') {
    return { ok: false, status: 409, error: 'SURVEY_ANOMALOUS', message: sc.message };
  }
  if (p.status !== '未执行') return { ok: false, status: 400, error: '仅「未执行」状态的周计划支持拆分操作' };
  if (!isCrossDay(p)) return { ok: false, status: 400, error: '单日计划无需拆分' };
  return { ok: true, decision: sc.decision };
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
  const gate = assertCanSplit(p);
  if (!gate.ok) {
    return res.status(gate.status).json({ ok: false, error: gate.error, ...(gate.message ? { message: gate.message } : {}) });
  }

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
    surveyDecision: gate.decision, splitBatchId: p.splitBatchId, parentPlanId: p.parentPlanId, days
  });
  res.json({ ok: true, previewVersion, sourcePlanId: p.id, firstDayPlanId: p.id, days });
});

/* ---------- 确认拆分：版本复核 / 精确重放 / 一次 saveDB 落库 ----------
 * 拒绝路径不调用 saveDB（本次请求内存零变更）；saveDB 抛错仅保证「内存回到操作前」，
 * 不声称磁盘原子、半写安全或跨进程并发安全。 */
/* 规范化 days 的摘要段：与 preview 的版本第 2 段同源，供重放核对（不重算原预览） */
function normalizeDaysForDigest(input) {
  return (Array.isArray(input) ? input : []).map(d => ({
    date: dateOf(d && d.date),
    content: String((d && d.content) == null ? '' : d.content).trim(),
    quantities: mergeQuantities({}, (d && d.quantities) || {})
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
function daysDigestOf(list) {
  return digestOf((list || []).map(d => ({
    date: String(d.date == null ? '' : d.date),
    content: String(d.content == null ? '' : d.content),
    quantities: qtyTuple(d.quantities)
  })));
}
/* 同批子记录：同时约束 parentPlanId + splitBatchId，含软删，顺序稳定（首次与重放一致） */
function splitChildrenOf(p, batchId) {
  return (DB.workPlans || [])
    .filter(x => x && x.parentPlanId === p.id && x.splitBatchId === batchId)
    // 顺序只看不可变字段（创建时间 → id）：子记录的日期/内容可被后续编辑改动，
    // 若参与排序，首次响应与重放的 createdPlanIds 就会因改稿而错位。
    .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? -1
      : String(a.createdAt) > String(b.createdAt) ? 1
        : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

app.post('/api/workPlans/:id/split', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: '未找到计划' });
  const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};

  // 1) 版本必须为字符串（数字/数组/null 等显式非法值不得被 String() 强转后参与比对）
  if (b.previewVersion !== undefined && typeof b.previewVersion !== 'string') {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: 'previewVersion 必须是字符串' });
  }
  // 2) 精确重放：先于「已拆再拆拒绝」识别（同版本 + 同规范化 days 摘要）
  //    身份限定：URL 记录必须是本批首日（有 splitCommitVersion 且非子记录）
  const ver = typeof b.previewVersion === 'string' ? b.previewVersion : '';
  if (p.splitBatchId && p.splitCommitVersion && !p.parentPlanId && ver && ver === p.splitCommitVersion && Array.isArray(b.days)) {
    const seg = String(p.splitCommitVersion).split(':');
    if (seg.length === 4 && daysDigestOf(normalizeDaysForDigest(b.days)) === seg[2]) {
      const kids = splitChildrenOf(p, p.splitBatchId);
      return res.json({
        ok: true, replay: true, splitBatchId: p.splitBatchId,
        firstDayPlanId: p.id, createdPlanIds: kids.map(k => k.id)
      });
    }
  }

  // 2) 门禁：与预览同一实现（勘察 / 已拆 / 未执行 / 跨天）
  const gate = assertCanSplit(p);
  if (!gate.ok) {
    return res.status(gate.status).json({ ok: false, error: gate.error, ...(gate.message ? { message: gate.message } : {}) });
  }

  // 3) 载荷：必须带 previewVersion 与完整 days，不退回 content 解析
  if (!ver || !Array.isArray(b.days)) {
    return res.status(400).json({ ok: false, error: 'INVALID_INPUT', message: '确认须携带 previewVersion 与完整 days，请先预览' });
  }
  const expected = dayList(p.startDate, p.endDate);
  const norm = normalizeSubmittedDays(b.days, expected);
  if (!norm.ok) return res.status(400).json({ error: '拆分校验未通过', errors: norm.errors });
  norm.days.sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : 0));
  if (norm.days.length < 2) return res.status(400).json({ error: '单日计划无需拆分' });

  // 4) 拟号：仅配电非首日；分配池保留源记录（首日保留的源号仍占号）；excludeIds 只用于撞号断言
  const srcNo = String(p.workTicketNo == null ? '' : p.workTicketNo);
  const srcSurveyNo = String(p.surveyNo == null ? '' : p.surveyNo);
  const dist = isDistPowerTicketType(p.ticketType);
  let planned = [];
  if (dist && norm.days.length > 1) {
    const allocated = allocateWorkTicketNos({
      items: norm.days.slice(1).map(d => ({ ticketType: p.ticketType, yearMonth: String(d.date).slice(0, 7).replace('-', '') })),
      records: DB.workPlans
    });
    if (!allocated.ok) return res.status(400).json({ ok: false, error: allocated.error, message: allocated.message });
    planned = allocated.workTicketNos;
    for (let i = 0; i < planned.length; i++) {
      const chk = assertDistWorkTicketNoAvailable({
        workTicketNo: planned[i], ticketType: p.ticketType, records: DB.workPlans, excludeIds: [p.id]
      });
      if (!chk.ok) return res.status(400).json(chk);   // 兜底撞号：不应发生，发生即整次拒绝
    }
  }
  const days = norm.days.map((d, i) => {
    const rg = dayRange(d.date, p.startDate, p.endDate);
    return {
      date: d.date, start: rg.start, end: rg.end,
      content: d.content, items: d.items, quantities: d.quantities,
      isFirstDay: i === 0,
      workTicketNo: i === 0 ? srcNo : (dist ? planned[i - 1] : srcNo),
      surveyNo: srcSurveyNo
    };
  });

  // 5) 版本复核：门禁与 days 均合法但版本不符 → 409 PREVIEW_STALE
  const version = computeSplitPreviewVersion({
    id: p.id, startDate: p.startDate, endDate: p.endDate, content: p.content, quantities: p,
    ticketType: p.ticketType, surveyNo: p.surveyNo, workTicketNo: p.workTicketNo,
    surveyDecision: gate.decision, splitBatchId: p.splitBatchId, parentPlanId: p.parentPlanId, days
  });
  if (version !== ver) {
    return res.status(409).json({ ok: false, error: 'PREVIEW_STALE', message: '预览已过期（源计划或每日内容/工量已变化），请重新预览后再确认' });
  }

  // 6) 落库：父收缩首日 + 每日子记录；仅新成功拆分写 splitCommitVersion（仅首日=父记录）
  const now = nowISO();
  const batchId = genId('sp');
  const before = clone(p);
  const lenBefore = DB.workPlans.length;
  const first = days[0];

  p.splitBatchId = batchId;
  p.splitCommitVersion = version;
  p.endDate = dayRange(first.date, before.startDate, before.endDate).end;
  p.content = first.content;
  applyQty(p, first.quantities);
  p.updatedAt = now;

  days.slice(1).forEach(d => {
    const child = clone(before);
    CHILD_DROP_FIELDS.forEach(k => { delete child[k]; });
    delete child.survey;                 // 各日共用源勘察号，不复制勘察对象
    const rg = dayRange(d.date, before.startDate, before.endDate);
    child.id = genId('wp');
    child.name = String(before.name || '') + '（' + mdLabel(d.date) + '）';
    child.startDate = rg.start;
    child.endDate = rg.end;
    child.content = d.content;
    applyQty(child, d.quantities);
    child.parentPlanId = p.id;
    child.splitBatchId = batchId;
    child.workTicketNo = d.workTicketNo;
    child.surveyNo = srcSurveyNo;
    child.status = '未执行';
    child.createdAt = now;
    child.updatedAt = now;
    child.deleted = false;
    DB.workPlans.push(child);
  });

  try {
    saveDB();
  } catch (e) {
    DB.workPlans.length = lenBefore;              // 移除本次追加的子记录（仅内存还原，不声称磁盘原子/半写安全）
    const idx = DB.workPlans.indexOf(p);
    if (idx > -1) DB.workPlans[idx] = before;     // 父记录还原到操作前
    return res.status(500).json({ ok: false, error: 'SAVE_FAILED', message: '保存失败，已回滚内存记录：' + String((e && e.message) || e) });
  }
  // 首次响应与重放共用同一排序（splitChildrenOf：仅按不可变的 createdAt → id），
  // 否则「首次按创建顺序、重放按排序」会因改期改稿而错位。
  const createdIds = splitChildrenOf(p, batchId).map(k => k.id);
  return res.json({ ok: true, splitBatchId: batchId, firstDayPlanId: p.id, createdPlanIds: createdIds });
});

/* ---------- 撤销拆分：Step 7 起关闭（不读快照、不恢复任何数据） ---------- */
app.post('/api/workPlans/:id/unsplit', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: '未找到计划' });
  return res.status(410).json({
    ok: false, error: 'SPLIT_IRREVERSIBLE',
    message: '拆分不可撤销：如需调整请直接编辑各日计划，或重新创建计划'
  });
});

/* 供隔离测试直接调用（纯函数，不触库）；路由行为不变 */
module.exports = { classifySplitSurvey, computeSplitPreviewVersion };

