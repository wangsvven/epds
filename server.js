'use strict';
/**
 * 本地自托管「电网生产ERP」复刻 — 后端
 * 技术栈：Node + Express + 本地 JSON 存储（data/db.json）
 * 模块：认证 / 项目 / 计划 / 借工 / 竣工资料 / 文档中心 / 材料台账 / 设置 / 用户
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const xlsx = require('xlsx');
const app = require('./server/core/app');
const {
  aliveFilter, repairUploadName, genId, nowISO, fmtNow, fmtStamp,
  parseCNDate, parseCSVBuffer, decodeXmlEntities, unzipEntry, extractDocxText,
  crc32, buildStoreZip
} = require('./server/core/util');
const {
  DATA_DIR, DB_PATH, DB, saveDB, loadDB, seedDB, migrateDB, WT_COLLECTIONS,
  DEFAULT_LOGIN_BG, LEGACY_LOGIN_BG_MAP,
  ROLE_ADMIN, USER_GROUPS, LEGACY_GROUP_MAP, normalizeUserGroup
} = require('./server/core/db');
const { qtyGeneratedOf, qtyOutstandingOf, withGen, materialStatus, roundQty } = require('./server/core/material-calc');
const {
  TOKENS, MODULE_NAMES, ROLE_WRITE,
  isAdmin, userGroupOf, writeModulesOf, canWriteModule, moduleOfPath, passwordStrong,
  fullPath, authMiddleware
} = require('./server/core/auth');
const upload = require('./server/core/upload');
const { crud } = require('./server/core/crud');
const { resolveDocPath, resolveSurveyTemplate } = require('./server/core/doc-templates');
const { categorize } = require('./server/core/risk-category');

const PORT = process.env.PORT || 5173;
const system = require('./server/routes/system');


// 班组长可填写的「工程实际施工量」字段（计划管理 · 当日计划工作量）




system.registerPublic();

app.use('/api', authMiddleware);

system.registerAuthed();








// 领料单删除：仅已作废的领料单可删除（须注册在通用 CRUD 工厂之前以覆盖默认删除）
app.delete('/api/materialRequisitions/:id', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '已作废') return res.status(400).json({ error: '仅已作废的领料单可删除，请先作废' });
  rec.deleted = true; // 逻辑删除（保留记录，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});

require('./server/routes/projects');

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
app.get('/api/materialOutbound/orders', (req, res) => {
  const project = String(req.query.project || '');
  const list = DB.materialOutbound.filter(o => !o.deleted && (!project || o.project === project))
    .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(list);
});
app.post('/api/materialOutbound/create', (req, res) => {
  const b = req.body || {};
  const project = String(b.project || '').trim();
  const receiver = String(b.receiver || '').trim();
  if (!project) return res.status(400).json({ error: '请选择工程' });
  if (!receiver) return res.status(400).json({ error: '请选择领取人' });
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: '请勾选需要出库的材料' });
  const stats = outboundStats(project);
  const finalItems = [];
  for (const e of items) {
    const m = DB.materials.find(x => x.id === e.materialId && !x.deleted);
    if (!m || m.project !== project) return res.status(400).json({ error: '物料不存在或不属于所选工程' });
    const qty = roundQty(Number(e.qty));
    if (!(qty > 0)) return res.status(400).json({ error: '物料「' + m.description + '」出库数量必须大于 0' });
    const st = stats[m.id] || { taken: 0, returned: 0 };
    const avail = roundQty(Math.max(0, roundQty(m.qtyArrived) - roundQty(st.taken - st.returned)));
    if (qty > avail + 1e-9) return res.status(400).json({ error: '物料「' + m.description + '」本次出库 ' + qty + ' 超过可用库存 ' + avail });
    finalItems.push({ materialId: m.id, code: m.code || '', description: m.description || '', unit: m.unit || '', qty, returned: 0 });
  }
  // 单号：OUT-YYYYMMDD-NNNNNN（按当日已有单据数递增）
  const dateTag = fmtNow().slice(0, 10).replace(/-/g, '');
  const seq = DB.materialOutbound.filter(o => !o.deleted && String(o.outNo || '').startsWith('OUT-' + dateTag + '-')).length + 1;
  const rec = {
    id: genId('ob'), outNo: 'OUT-' + dateTag + '-' + String(seq).padStart(6, '0'),
    project, receiver, status: '有效', createdAt: fmtNow(),
    items: finalItems, returns: [], compensated: 0,
    deleted: false
  };
  DB.materialOutbound.unshift(rec);
  saveDB();
  res.json({ ok: true, data: rec });
});
app.put('/api/materialOutbound/:id/return', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '有效') return res.status(400).json({ error: '该出库单已作废，不能登记归还' });
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const applied = [];
  for (const r of rows) {
    const it = (rec.items || []).find(i => i.materialId === r.materialId);
    if (!it) continue;
    const qty = roundQty(Number(r.qty));
    const remaining = roundQty(it.qty - it.returned);
    if (!(qty > 0)) continue;
    if (qty > remaining + 1e-9) return res.status(400).json({ error: '物料「' + it.description + '」本次归还 ' + qty + ' 超过剩余未归还 ' + remaining });
    it.returned = roundQty(it.returned + qty);
    applied.push({ materialId: it.materialId, qty });
  }
  if (!applied.length) return res.status(400).json({ error: '请填写有效的归还数量' });
  if (!Array.isArray(rec.returns)) rec.returns = [];
  rec.returns.push({ at: fmtNow(), rows: applied });
  saveDB();
  res.json({ ok: true, data: rec });
});
app.put('/api/materialOutbound/:id/void', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '有效') return res.status(400).json({ error: '该出库单已作废，不能重复作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '作废原因不能为空' });
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

require('./server/routes/plans');


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


// 其他业务集合 CRUD（迁移中：待各 routes 模块接管后删除）
['materialRequisitions', 'materialImports', 'materialOutbound'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});

// ---------- 材料明细（工程材料清单） ----------
// 来源类型为固定枚举（与原系统一致），新增/编辑/导入均强制校验
const SOURCE_TYPES = ['ERP采购申请', '甲供材料', '库存调拨', '乙供/自购', '运检项目'];

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
function validateMaterialBody(b, { forEdit = false, oldItem = null } = {}) {
  const project = String(b.project || '').trim();
  if (!project) return '项目名称不能为空';
  if (!allSingleProjectNames().includes(project)) return '项目名称「' + project + '」与项目列表不一致，无法保存（只能选择项目列表中的工程/子项目名称）';
  const source = String(b.source || '').trim();
  if (!SOURCE_TYPES.includes(source)) return '来源类型无效，仅支持：' + SOURCE_TYPES.join(' / ');
  if (!String(b.description || '').trim()) return '物料描述不能为空';
  const qty = Number(b.qtyRequired);
  if (!isFinite(qty) || qty < 0) return '应到数量无效';
  if (forEdit && oldItem && roundQty(qty) !== roundQty(oldItem.qtyRequired) && !String(b.modifyReason || '').trim()) {
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
    qtyRequired: roundQty(b.qtyRequired), qtyArrived: roundQty(b.qtyArrived),
    unit: String(b.unit || '').trim(), code: String(b.code || '').trim(),
    orderNo: String(b.orderNo || '').trim() || '-',
    source: String(b.source).trim(), sourceNote: String(b.sourceNote || '').trim(),
    inWeeklyPlan: b.inWeeklyPlan !== false,
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
    qtyArrived: roundQty(b.qtyArrived !== undefined ? b.qtyArrived : old.qtyArrived),
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
app.post('/api/materials/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    const name = req.file.originalname || '';
    if (/\.csv$/i.test(name)) {
      const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
      rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    }
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
      if (!validNames.includes(project)) { errors.push('第' + rowNo + '行：项目名称「' + (project || '空') + '」与项目列表不一致'); return; }
      if (!SOURCE_TYPES.includes(source)) { errors.push('第' + rowNo + '行：来源类型「' + (source || '空') + '」无效（仅支持：' + SOURCE_TYPES.join(' / ') + '）'); return; }
      const qty = Number(qtyRaw);
      if (!qtyRaw || !isFinite(qty) || qty < 0) { errors.push('第' + rowNo + '行：申请数量「' + (qtyRaw || '空') + '」无效'); return; }
      parsed.push({ project, description, qty: roundQty(qty), unit: String(r[3] || '').trim(), code: String(r[4] || '').trim(), orderNo: String(r[5] || '').trim() || '-', source });
    });
    if (errors.length) {
      return res.status(400).json({ error: '导入失败，共 ' + errors.length + ' 处不一致：' + errors.slice(0, 5).join('；') + (errors.length > 5 ? '（仅显示前 5 处）' : '') });
    }
    if (!parsed.length) return res.status(400).json({ error: '模板中没有可导入的数据行' });
    const batchId = genId('im'); // 先定批次 id，材料上直接写入 importId，保证可整批删除
    const added = parsed.map(r => {
      const item = {
        id: genId('m'), createdAt: nowISO(), importId: batchId,
        project: r.project, description: r.description,
        qtyRequired: r.qty, qtyArrived: 0, qtyNotArrived: r.qty,
        unit: r.unit, code: r.code, orderNo: r.orderNo, source: r.source,
        sourceNote: '', inWeeklyPlan: true, modifyReason: '', modifiedAt: ''
      };
      item.status = materialStatus(item);
      item.deleted = false;
      DB.materials.push(item);
      return item;
    });
    // 记录导入批次（供「导入批次」页签展示）：项目归属 / 行数（总/匹配/跳过）/ 调整数 / 备注
    const projects = [...new Set(parsed.map(r => r.project))];
    const batch = {
      id: batchId, batch: 'IMP' + Date.now(), fileName: name,
      project: projects.length === 1 ? projects[0] : projects.join('、'),
      rowsTotal: parsed.length + skippedEmpty, rowsMatched: parsed.length, rowsSkipped: skippedEmpty,
      adjusted: 0, adjustments: [],
      rows: added.length, materialIds: added.map(x => x.id),
      importedBy: req.user.name, importedAt: fmtNow(), status: '成功', remark: '-',
      deleted: false
    };
    DB.materialImports.push(batch);
    saveDB();
    res.json({ ok: true, added: added.length, batch: batch.batch, data: added });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 领料单（暂存清单 → 生成领料单 → 下载 Excel → 确认入库 / 作废） ----------
// 单号规则 LL-YYYYMMDD-HHMMSS，与原系统一致
function reqNoNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return 'LL-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
// 从暂存的物料生成领料单；领料数量可任意填写（默认=可继续领料），但不能大于可继续领料
// 请求体：{ items: [{ id, qty }] }（兼容旧 { ids: [...] } = 按可继续领料全量生成）
app.post('/api/requisitions/create', (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.items) && body.items.length
    ? body.items.map(x => ({ id: x.id, qty: x.qty }))
    : (Array.isArray(body.ids) ? body.ids.map(id => ({ id })) : []);
  if (!list.length) return res.status(400).json({ error: '暂存清单为空，无法生成领料单' });
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
    id: genId('rq'), reqNo: reqNoNow(),
    projects: [...new Set(items.map(i => i.project))],
    items, createdAt: fmtNow(), status: '待入库', confirmRows: null,
    deleted: false
  };
  DB.materialRequisitions.unshift(rec);
  // 同步材料状态（已生成数量按领料单动态汇总，部分生成时剩余量仍可继续领料）
  touched.forEach(m => { m.status = materialStatus(m); });
  saveDB();
  res.json({ ok: true, data: rec });
});

// 下载领料单 Excel（格式对齐原系统样例：LL-20261009-222544.xlsx）
app.get('/api/materialRequisitions/:id/download', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  const aoa = [];
  aoa.push(['国网富顺县供电公司过渡仓代保管物资领料单', '', '', '', '', '', '']);
  aoa.push(['项目部门：', '', '', '', '', '', '']);
  aoa.push(['序号', '物料编码', '物料描述', '计量单位', '数量', '项目名称', '备注']);
  rec.items.forEach((it, i) => {
    aoa.push([String(i + 1), it.code, it.description, it.unit, it.qty, it.project, it.orderNo === '-' ? '' : it.orderNo]);
  });
  for (let i = 0; i < 5; i++) aoa.push(['', '', '', '', '', '', '']);
  aoa.push(['项目部门负责人：                                    项目部门分管领导：                                            领料人：                                      库管员：    ', '', '', '', '', '', '']);
  aoa.push(['说明：备注栏填写原订单号。', '', '', '', '', '', '']);
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: 6, r: 0 } },
    { s: { c: 0, r: 1 }, e: { c: 6, r: 1 } },
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
  if (rec.status !== '待入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单已' + rec.status + '，不能重复入库' });
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const results = (rec.confirmRows || []).map(x => ({ ...x })); // 已累计的入库记录
  const opRows = []; // 本次操作的逐条记录（写入 history，供详情展示与 Excel 下载）
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
  rec.history.push({ at: rec.confirmedAt, rows: opRows });
  saveDB();
  res.json({ ok: true, data: rec });
});

// 作废（待入库/已入库/部分到库均可作废；已入库的会冲销其已入库数量，材料状态按扣减后重新汇总）
app.put('/api/materialRequisitions/:id/void', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '待入库' && rec.status !== '已入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单已' + rec.status + '，不能作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写作废原因' });
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

require('./server/routes/documents');



// ---------- 工作票自动化配置：配置状态 ----------
// 6 项配置的就绪情况；安全信息与危险点库为全局口径（危险点库当前为全局库）
const WT_CONFIG_VERSION = 2;

app.get('/api/workticket/config-status', (req, res) => {
  const cnt = key => (DB[key] || []).filter(r => !r.deleted).length;
  const haz = (DB.documents && DB.documents.hazardLibrary) || [];
  const survey = resolveSurveyTemplate();

  const raw = [
    { key: 'rules',     title: '作业内容匹配规则', count: cnt('wtRules') },
    { key: 'tech',      title: '施工技术措施',     count: cnt('wtTechMeasures') },
    { key: 'safety',    title: '施工安全措施',     count: cnt('wtSafetyMeasures') },
    { key: 'hospitals', title: '医院联系方式',     count: cnt('wtHospitals') },
    { key: 'hazards',   title: '企业危险点库',     count: haz.length },
    { key: 'survey',    title: '现场勘察记录模板', count: survey ? 1 : 0 }
  ];
  // 每项的就绪口径与副标题文案
  const items = raw.map(it => {
    let ready = false, desc = '';
    if (it.key === 'hazards') { ready = it.count > 0; desc = ready ? ('已建立 ' + it.count + ' 条危险点') : '尚未建立危险点库'; }
    else if (it.key === 'survey') { ready = it.count > 0; desc = ready ? '已上传并通过内容检查' : '尚未上传勘察记录模板'; }
    else { ready = it.count > 0; desc = ready ? ('已配置 ' + it.count + ' 条') : '尚未配置'; }
    return { key: it.key, title: it.title, count: it.count, ready, desc };
  });
  const ready = items.every(i => i.ready);
  // 版本指纹：随 6 项配置内容变化；时间取各来源最近一次更新时间
  const snap = { v: WT_CONFIG_VERSION, c: items.map(i => i.key + ':' + i.count) };
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
  let latest = 0;
  WT_COLLECTIONS.forEach(k => (DB[k] || []).forEach(r => {
    const t = Date.parse(r.updatedAt || r.createdAt || 0);
    if (!isNaN(t) && t > latest) latest = t;
  }));
  const stamp = latest ? new Date(latest) : new Date();

  // 危险点库按 2 列布局顺序返回：左列 rules/safety/hazards，右列 tech/hospitals/survey
  const order = ['rules', 'safety', 'hazards', 'tech', 'hospitals', 'survey'];
  const ordered = order.map(k => items.find(i => i.key === k));
  res.json({
    version: WT_CONFIG_VERSION,
    versionLabel: 'v' + WT_CONFIG_VERSION,
    updatedAt: fmtStamp(stamp),
    sha256,
    ready,
    items: ordered,
    hazardCount: haz.length
  });
});

// ---------- 资料库：作业内容匹配规则等（工作票自动化配置数据）----------
// 固定活动类别（匹配类别下拉选项，来自 CT 标准口径）
const WT_FIXED_CATEGORIES = ['开挖坑洞', '组立电杆', '制作拉线', '箱变', '环网柜', '开挖电缆沟',
  '电缆 / 敷设电缆', '电缆试验', '真空开关', '刀闸', '避雷器', '高压/低压导线', '变压器', '组装金具', '拆除、撤除'];

const wtAlive = key => (DB[key] || []).filter(r => !r.deleted);
function wtRulesOf(req) {
  return wtAlive('wtRules').slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
}
// 资料库分组（含各分组条目数）与下拉选项
app.get('/api/workticket/library', (req, res) => {
  const opt = key => wtAlive(key).map(r => ({ id: r.id, name: (r.title || r.name || r.content || '').slice(0, 80), sort: (Number(r.sort) || 0) })).filter(o => o.name);
  res.json({
    groups: [
      { key: 'rules', title: '作业内容匹配规则', count: wtAlive('wtRules').length, showCount: true },
      { key: 'tech', title: '施工技术措施原文', count: wtAlive('wtTechMeasures').length, showCount: true },
      { key: 'safety', title: '施工安全措施原文', count: wtAlive('wtSafetyMeasures').length, showCount: true },
      { key: 'hospitals', title: '医院联系方式', count: wtAlive('wtHospitals').length, showCount: true },
      { key: 'emergency', title: '默认应急医院', count: 0, showCount: false }
    ],
    categories: WT_FIXED_CATEGORIES,
    techOptions: opt('wtTechMeasures'),
    safetyOptions: opt('wtSafetyMeasures'),
    emergency: DB.settings.emergencyHospital || { name: '', phone: '' }
  });
});

// ---------- 默认模板（施工技术 / 安全措施原文 快照）----------
/* 内置标准资料：assets/ct-standard.json 随代码分发（技术 49 条 / 安全 19 条通用措施原文）。
 * 全新实例（含 Docker 空卷首次启动）库里没有任何措施数据，此时「默认模板」直接回落为内置内容，
 * 保证「载入默认」开箱可用；用户一旦用「保存为默认」自行冻结过快照（savedAt 有值），则以用户快照为准。 */
const CT_STANDARD_FILE = path.join(__dirname, 'assets', 'ct-standard.json');
let CT_STANDARD_CACHE;
function builtinStandard() {
  if (CT_STANDARD_CACHE !== undefined) return CT_STANDARD_CACHE;
  CT_STANDARD_CACHE = null;
  try {
    if (!fs.existsSync(CT_STANDARD_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(CT_STANDARD_FILE, 'utf8'));
    const norm = arr => (Array.isArray(arr) ? arr : [])
      .map(x => ({ sort: Number(x.sort) || 0, title: String(x.title || '').trim(), content: String(x.content || '').trim() }))
      .filter(x => x.title && x.content);
    const tech = norm(d.techMeasures), safety = norm(d.safetyMeasures);
    if (tech.length || safety.length) CT_STANDARD_CACHE = { tech, safety };
  } catch (e) { console.error('  ⚠ 内置标准资料读取失败：', e.message); }
  return CT_STANDARD_CACHE;
}
function wtDefaultShape() {
  if (!DB.wtDefaultMeasures || typeof DB.wtDefaultMeasures !== 'object') DB.wtDefaultMeasures = {};
  if (!Array.isArray(DB.wtDefaultMeasures.tech)) DB.wtDefaultMeasures.tech = [];
  if (!Array.isArray(DB.wtDefaultMeasures.safety)) DB.wtDefaultMeasures.safety = [];
  if (DB.wtDefaultMeasures.savedAt === undefined) DB.wtDefaultMeasures.savedAt = '';
  if (DB.wtDefaultMeasures.cleared === undefined) DB.wtDefaultMeasures.cleared = false;
  // 未自行冻结过快照、且快照为空 → 回落内置标准资料（全新实例也能「载入默认」）
  if (!DB.wtDefaultMeasures.tech.length && !DB.wtDefaultMeasures.safety.length && !DB.wtDefaultMeasures.savedAt) {
    const b = builtinStandard();
    if (b) { DB.wtDefaultMeasures.tech = b.tech.slice(); DB.wtDefaultMeasures.safety = b.safety.slice(); }
  }
  return DB.wtDefaultMeasures;
}
const wtNormTitle = s => String(s || '').replace(/\s+/g, ' ').trim();
// 把当前「施工技术/安全措施原文」冻结为默认模板（按当前顺序与序号）
function wtSnapshotDefault() {
  const d = wtDefaultShape();
  const pick = key => wtAlive(key).slice()
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .map(r => ({ sort: Number(r.sort) || 0, title: String(r.title || '').trim(), content: String(r.content || '').trim() }))
    .filter(x => x.title && x.content);
  d.tech = pick('wtTechMeasures');
  d.safety = pick('wtSafetyMeasures');
  d.savedAt = nowISO();
  d.cleared = false;
  saveDB();
  return d;
}
// 默认配置初始快照：默认模板为空且有措施数据时，自动把当前数据冻结为默认
// （「清除」只清空列表、不动默认模板，因此这里无需再考虑重复灌入）
(function initDefaultMeasures() {
  try {
    const d = wtDefaultShape();
    if (d.tech.length || d.safety.length) return;
    if (wtAlive('wtTechMeasures').length || wtAlive('wtSafetyMeasures').length) wtSnapshotDefault();
  } catch (e) { console.error('  ⚠ 默认模板初始化失败：', e.message); }
})();

app.get('/api/workticket/measures/default', (req, res) => {
  const d = wtDefaultShape();
  // builtin=true 表示用的是随代码分发的内置标准资料（尚未被用户「保存为默认」覆盖）
  res.json({ tech: d.tech.length, safety: d.safety.length, savedAt: d.savedAt || '', builtin: !d.savedAt });
});

// 清除全部措施原文：清空「施工技术措施原文」与「施工安全措施原文」两个列表；
// 默认模板（默认配置）不受影响，之后可用「载入默认」把这些内容重新加载回来
app.post('/api/workticket/measures/clear-all', (req, res) => {
  try {
    const tech = wtAlive('wtTechMeasures').length;
    const safety = wtAlive('wtSafetyMeasures').length;
    DB.wtTechMeasures = [];
    DB.wtSafetyMeasures = [];
    saveDB();
    res.json({ ok: true, clearedTech: tech, clearedSafety: safety, tech: 0, safety: 0 });
  } catch (e) { res.status(500).json({ error: '清除失败：' + e.message }); }
});

// 以当前数据覆盖默认模板
app.post('/api/workticket/measures/default/save', (req, res) => {
  try {
    const d = wtSnapshotDefault();
    res.json({ ok: true, tech: d.tech.length, safety: d.safety.length, savedAt: d.savedAt });
  } catch (e) { res.status(500).json({ error: '保存默认模板失败：' + e.message }); }
});

// 载入默认：把默认配置补回当前列表——完全相同的条目跳过（按「标题+内容」去重，避免同名不同内容被吞），删除过的补回
app.post('/api/workticket/measures/default/load', (req, res) => {
  try {
    const d = wtDefaultShape();
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const keyOf = (title, content) => norm(title) + '\u0001' + norm(content);
    const result = {};
    const merge = (kind, coll, list) => {
      const alive = wtAlive(coll);
      // 多重集匹配：按「标题+内容」统计列表里已有多少条；默认里有几条就补到几条（含完全相同的重复条目）
      const remaining = new Map();
      alive.forEach(r => { const k = keyOf(r.title, r.content); remaining.set(k, (remaining.get(k) || 0) + 1); });
      let maxSort = alive.reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
      let added = 0, skipped = 0;
      (list || []).forEach(item => {
        const title = String(item.title || '').trim();
        const content = String(item.content || '').trim();
        if (!title || !content) { skipped++; return; }
        const key = keyOf(title, content);
        const n = remaining.get(key) || 0;
        if (n > 0) { remaining.set(key, n - 1); skipped++; return; } // 已有同款，跳过
        const s = Number(item.sort) > 0 ? Number(item.sort) : ++maxSort;
        DB[coll].push({ id: genId('wt'), deleted: false, sort: s, createdAt: nowISO(), updatedAt: nowISO(), title, content });
        added++;
      });
      result[kind] = { added, skipped };
    };
    merge('tech', 'wtTechMeasures', d.tech);
    merge('safety', 'wtSafetyMeasures', d.safety);
    saveDB();
    res.json({ ok: true, result, tech: wtAlive('wtTechMeasures').length, safety: wtAlive('wtSafetyMeasures').length });
  } catch (e) { res.status(500).json({ error: '载入默认失败：' + e.message }); }
});

app.get('/api/workticket/rules', (req, res) => res.json(wtRulesOf(req)));

function wtRulePayload(b) {
  const workType = String(b.workType || '').trim();
  const category = String(b.category || '').trim();
  const keywordsRaw = String(b.keywords || '').trim();
  if (!workType) return { error: '请填写作业类型名称' };
  if (!category && !keywordsRaw) return { error: '请选择匹配类别或填写自定义匹配词' };
  if (workType.length > 120) return { error: '作业类型名称不超过 120 字' };
  if (keywordsRaw.length > 2000) return { error: '自定义匹配词不超过 2000 字' };
  // 选了固定活动类别时，以「类别」作为匹配规则；否则用自定义匹配词（逗号/顿号/换行分隔）
  const keywords = category ? [category] : keywordsRaw.split(/[,，、;；\n\r]+/).map(x => x.trim()).filter(Boolean);
  if (!keywords.length) return { error: '请填写自定义匹配词' };
  return {
    workType,
    category,
    keywordsRaw: category ? '' : keywordsRaw,
    keywords,
    techId: String(b.techId || '').trim(),
    techName: String(b.techName || '').trim(),
    safetyId: String(b.safetyId || '').trim(),
    safetyName: String(b.safetyName || '').trim()
  };
}

app.post('/api/workticket/rules', (req, res) => {
  const p = wtRulePayload(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const maxSort = wtAlive('wtRules').reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  const row = { id: genId('wr'), deleted: false, sort: maxSort + 1, createdAt: nowISO(), updatedAt: nowISO(), ...p };
  DB.wtRules.push(row);
  saveDB();
  res.json(row);
});

app.put('/api/workticket/rules/:id', (req, res) => {
  const idx = (DB.wtRules || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const p = wtRulePayload({ ...DB.wtRules[idx], ...(req.body || {}) });
  if (p.error) return res.status(400).json({ error: p.error });
  DB.wtRules[idx] = { ...DB.wtRules[idx], ...p, updatedAt: nowISO() };
  saveDB();
  res.json(DB.wtRules[idx]);
});

app.delete('/api/workticket/rules/:id', (req, res) => {
  const idx = (DB.wtRules || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.wtRules.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 导入预览 / 导入：首表 A 列作业类型、B 列自定义匹配词、C 列施工技术措施、D 列安全措施
function parseRuleRows(buf, originalname) {
  let rows;
  if (/\.csv$/i.test(originalname || '')) rows = parseCSVBuffer(buf);
  else {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }
  const out = [], errors = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // 表头
    const workType = String(r[0] || '').trim();
    const keywordsRaw = String(r[1] || '').trim();
    const techName = String(r[2] || '').trim();
    const safetyName = String(r[3] || '').trim();
    if (!workType && !keywordsRaw && !techName && !safetyName) return;
    if (!workType) { errors.push('第' + (i + 1) + '行：作业类型为空'); return; }
    if (!keywordsRaw) { errors.push('第' + (i + 1) + '行：自定义匹配词为空'); return; }
    out.push({ workType, keywordsRaw, techName, safetyName });
  });
  return { rows: out, errors };
}
app.post('/api/workticket/rules/import-preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const r = parseRuleRows(req.file.buffer, req.file.originalname);
    res.json({ total: r.rows.length, rows: r.rows, errors: r.errors });
  } catch (e) { res.status(500).json({ error: '解析失败：' + e.message }); }
});
app.post('/api/workticket/rules/import', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  let sort = wtAlive('wtRules').reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  const added = [];
  rows.forEach(r => {
    const p = wtRulePayload({ workType: r.workType, keywords: r.keywordsRaw || r.keywords, techName: r.techName, safetyName: r.safetyName });
    if (p.error) return;
    const row = { id: genId('wr'), deleted: false, sort: ++sort, createdAt: nowISO(), updatedAt: nowISO(), ...p };
    DB.wtRules.push(row); added.push(row);
  });
  saveDB();
  res.json({ added: added.length });
});

// ---------- 资料库：施工技术措施原文 / 施工安全措施原文（同结构，kind = tech | safety） ----------
const WT_MEASURE_COLLECTIONS = { tech: 'wtTechMeasures', safety: 'wtSafetyMeasures' };
const wtMeasureColl = kind => WT_MEASURE_COLLECTIONS[String(kind || '')] || null;

function wtMeasurePayload(b) {
  const title = String(b.title || '').trim();
  const content = String(b.content || '').trim();
  if (!title) return { error: '请填写条文标题 / 关键字' };
  if (!content) return { error: '请填写措施原文' };
  if (title.length > 200) return { error: '条文标题 / 关键字不超过 200 字' };
  if (content.length > 20000) return { error: '措施原文不超过 20000 字' };
  return { title, content };
}
// 序号：显式填写（>=1）则采用；留空/非法则排到末尾
function wtPickSort(b, list) {
  const v = Number(b && b.sort);
  // 允许 1.1 / 2.3 这类分级序号（原系统截图即为此格式），保留两位小数
  if (Number.isFinite(v) && v > 0) return Math.round(v * 100) / 100;
  return Math.floor(list.reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0)) + 1;
}
const wtBySort = list => list.slice().sort((a, b) => ((Number(a.sort) || 0) - (Number(b.sort) || 0)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

app.get('/api/workticket/measures/:kind', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  res.json(wtBySort(wtAlive(key)));
});

app.post('/api/workticket/measures/:kind', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const b = req.body || {};
  const p = wtMeasurePayload(b);
  if (p.error) return res.status(400).json({ error: p.error });
  const row = { id: genId('wt'), deleted: false, sort: wtPickSort(b, wtAlive(key)), createdAt: nowISO(), updatedAt: nowISO(), ...p };
  DB[key].push(row);
  saveDB();
  res.json(row);
});

app.put('/api/workticket/measures/:kind/:id', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const idx = (DB[key] || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const p = wtMeasurePayload({ ...DB[key][idx], ...b });
  if (p.error) return res.status(400).json({ error: p.error });
  const sort = b.sort === undefined || String(b.sort).trim() === '' ? DB[key][idx].sort : wtPickSort(b, wtAlive(key).filter(r => r.id !== req.params.id));
  DB[key][idx] = { ...DB[key][idx], ...p, sort, updatedAt: nowISO() };
  saveDB();
  res.json(DB[key][idx]);
});

app.delete('/api/workticket/measures/:kind/:id', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const idx = (DB[key] || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB[key].splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 导入：A 列序号（可空）、B 列条文标题 / 关键字、C 列措施原文
function parseMeasureRows(buf, originalname) {
  let rows;
  if (/\.csv$/i.test(originalname || '')) rows = parseCSVBuffer(buf);
  else {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }
  const out = [], errors = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // 表头
    const wide = r.length >= 3;
    const sortRaw = wide ? rowCell(r, 0) : '';
    const title = wide ? rowCell(r, 1) : rowCell(r, 0);
    const content = wide ? rowCell(r, 2) : rowCell(r, 1);
    if (!title && !content && !sortRaw) return;
    if (!title) { errors.push('第' + (i + 1) + '行：条文标题 / 关键字为空'); return; }
    if (!content) { errors.push('第' + (i + 1) + '行：措施原文为空'); return; }
    if (title.length > 200) { errors.push('第' + (i + 1) + '行：条文标题 / 关键字超过 200 字'); return; }
    if (content.length > 20000) { errors.push('第' + (i + 1) + '行：措施原文超过 20000 字'); return; }
    out.push({ sort: wide ? sortRaw : '', title, content });
  });
  return { rows: out, errors };
}
function rowCell(r, i) { return String(r[i] === undefined || r[i] === null ? '' : r[i]).trim(); }

app.post('/api/workticket/measures/:kind/import-preview', upload.single('file'), (req, res) => {
  if (!wtMeasureColl(req.params.kind)) return res.status(404).json({ error: '未知的措施类型' });
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const r = parseMeasureRows(req.file.buffer, req.file.originalname);
    res.json({ total: r.rows.length, rows: r.rows, errors: r.errors });
  } catch (e) { res.status(500).json({ error: '解析失败：' + e.message }); }
});
app.post('/api/workticket/measures/:kind/import', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  let sort = wtAlive(key).reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  let added = 0;
  rows.forEach(r => {
    const p = wtMeasurePayload({ title: r.title, content: r.content });
    if (p.error) return;
    const n = Number(r.sort);
    const s = Number.isFinite(n) && n > 0 ? Math.floor(n) : ++sort;
    DB[key].push({ id: genId('wt'), deleted: false, sort: s, createdAt: nowISO(), updatedAt: nowISO(), ...p });
    added++;
  });
  saveDB();
  res.json({ added });
});

// ---------- 资料库：医院联系方式 ----------
function wtHospitalPayload(b) {
  const area = String(b.area || '').trim();
  const name = String(b.name || '').trim();
  const address = String(b.address || '').trim();
  const phone = String(b.phone || '').trim();
  if (!area) return { error: '请填写作业地址匹配词' };
  if (!name) return { error: '请填写医院名称' };
  if (!address) return { error: '请填写医院地址' };
  if (!phone) return { error: '请填写联系电话' };
  if (area.length > 200) return { error: '作业地址匹配词不超过 200 字' };
  if (name.length > 100) return { error: '医院名称不超过 100 字' };
  if (address.length > 300) return { error: '医院地址不超过 300 字' };
  if (phone.length > 50) return { error: '联系电话不超过 50 字' };
  return { area, name, address, phone };
}

app.get('/api/workticket/hospitals', (req, res) => res.json(wtBySort(wtAlive('wtHospitals'))));

app.post('/api/workticket/hospitals', (req, res) => {
  const b = req.body || {};
  const p = wtHospitalPayload(b);
  if (p.error) return res.status(400).json({ error: p.error });
  const row = { id: genId('wt'), deleted: false, sort: wtPickSort(b, wtAlive('wtHospitals')), createdAt: nowISO(), updatedAt: nowISO(), ...p };
  DB.wtHospitals.push(row);
  saveDB();
  res.json(row);
});

app.put('/api/workticket/hospitals/:id', (req, res) => {
  const idx = (DB.wtHospitals || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const p = wtHospitalPayload({ ...DB.wtHospitals[idx], ...b });
  if (p.error) return res.status(400).json({ error: p.error });
  DB.wtHospitals[idx] = { ...DB.wtHospitals[idx], ...p, updatedAt: nowISO() };
  saveDB();
  res.json(DB.wtHospitals[idx]);
});

app.delete('/api/workticket/hospitals/:id', (req, res) => {
  const idx = (DB.wtHospitals || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.wtHospitals.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 导入：A 列作业地址匹配词、B 列医院、C 列地址、D 列电话
function parseHospitalRows(buf, originalname) {
  let rows;
  if (/\.csv$/i.test(originalname || '')) rows = parseCSVBuffer(buf);
  else {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }
  const out = [], errors = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // 表头
    const area = rowCell(r, 0), name = rowCell(r, 1), address = rowCell(r, 2), phone = rowCell(r, 3);
    if (!area && !name && !address && !phone) return;
    const p = wtHospitalPayload({ area, name, address, phone });
    if (p.error) { errors.push('第' + (i + 1) + '行：' + p.error); return; }
    out.push(p);
  });
  return { rows: out, errors };
}
app.post('/api/workticket/hospitals/import-preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const r = parseHospitalRows(req.file.buffer, req.file.originalname);
    res.json({ total: r.rows.length, rows: r.rows, errors: r.errors });
  } catch (e) { res.status(500).json({ error: '解析失败：' + e.message }); }
});
app.post('/api/workticket/hospitals/import', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  let sort = wtAlive('wtHospitals').reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  let added = 0;
  rows.forEach(r => {
    const p = wtHospitalPayload(r);
    if (p.error) return;
    DB.wtHospitals.push({ id: genId('wt'), deleted: false, sort: ++sort, createdAt: nowISO(), updatedAt: nowISO(), ...p });
    added++;
  });
  saveDB();
  res.json({ added });
});

// ---------- 资料库：默认应急医院（单条配置，随保存即时生效） ----------
app.put('/api/workticket/emergency-hospital', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').trim();
  if (name.length > 100) return res.status(400).json({ error: '医院名称不超过 100 字' });
  if (phone.length > 50) return res.status(400).json({ error: '联系电话不超过 50 字' });
  DB.settings.emergencyHospital = { name, phone, updatedAt: nowISO() };
  saveDB();
  res.json(DB.settings.emergencyHospital);
});

// 一键载入六项 CT 标准：需要 assets/ct-standard.json（规则/技术/安全/医院四组 + 可选危险点与勘察模板）
app.post('/api/workticket/load-ct-standard', (req, res) => {
  const f = path.join(__dirname, 'assets', 'ct-standard.json');
  if (!fs.existsSync(f)) {
    return res.status(400).json({ error: '尚未内置 CT 标准资料：缺少 assets/ct-standard.json' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let n = 0;
    const push = (key, arr, map) => {
      if (!Array.isArray(arr)) return;
      let sort = wtAlive(key).reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
      arr.forEach(src => {
        const row = { id: genId('wt'), deleted: false, sort: ++sort, createdAt: nowISO(), updatedAt: nowISO(), ...map(src) };
        DB[key].push(row); n++;
      });
    };
    push('wtRules', data.rules, s => wtRulePayload({ workType: s.workType, keywords: s.keywords, category: s.category, techName: s.techName, safetyName: s.safetyName }));
    push('wtTechMeasures', data.techMeasures, s => ({ title: String(s.title || '').trim(), content: String(s.content || '').trim() }));
    push('wtSafetyMeasures', data.safetyMeasures, s => ({ title: String(s.title || '').trim(), content: String(s.content || '').trim() }));
    push('wtHospitals', data.hospitals, s => ({ area: String(s.area || '').trim(), name: String(s.name || '').trim(), phone: String(s.phone || '').trim(), address: String(s.address || '').trim() }));
    if (Array.isArray(data.hazards) && data.hazards.length && (!DB.documents.hazardLibrary || !DB.documents.hazardLibrary.length)) {
      data.hazards.forEach((h, i) => {
        if (!h || !h.hazard || !h.measure) return;
        DB.documents.hazardLibrary.push({ id: genId('h'), hazard: String(h.hazard), measure: String(h.measure), category: categorize(String(h.hazard)), sort: i });
      });
    }
    saveDB();
    res.json({ ok: true, loaded: n });
  } catch (e) { res.status(500).json({ error: '载入失败：' + e.message }); }
});

// 详细数据（供展开「企业危险点库」使用；只读列表）
app.get('/api/workticket/hazards', (req, res) => {
  const list = ((DB.documents && DB.documents.hazardLibrary) || [])
    .slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  res.json(list);
});


// ---------- 静态前端 ----------
app.use('/assets', express.static(path.join(__dirname, 'assets')));

system.registerPage();
// 登录背景图长缓存（文件名唯一，可 immutable；预设图按天缓存）
app.use('/login-bg', express.static(path.join(__dirname, 'public', 'login-bg'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
}));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  电网生产ERP（本地版）已启动`);
  console.log(`  ➜  本地访问: http://localhost:${PORT}`);
  console.log(`  ➜  默认账号: admin / admin123  (角色: 管理员)\n`);
});
