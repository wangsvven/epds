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
const {
  parseDailyContent, dayList, dayRange, mdLabel, mergeQuantities, QTY_FIELDS
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

/* ---------- 预览：只解析校验，不落库 ---------- */
app.post('/api/workPlans/:id/split/preview', (req, res) => {
  const p = findPlan(req.params.id);
  if (!precheckSplit(p, res)) return;

  const b = req.body || {};
  const content = (b.content === undefined || b.content === null) ? String(p.content || '') : String(b.content);
  const r = parseDailyContent(content, p.startDate, p.endDate);
  const days = r.days.map(d => {
    const rg = dayRange(d.date, p.startDate, p.endDate);
    return { date: d.date, start: rg.start, end: rg.end, content: d.content, items: d.items, quantities: d.quantities };
  });
  res.json({ ok: r.ok, errors: r.errors, days });
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
