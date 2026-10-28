/* ========== routes/materials ========== */
/* 材料台账（校验 / 删除依赖校验）、材料导入、出库管理、领料单，以及 material* 三个集合 CRUD。 */
const xlsx = require('xlsx');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO, aliveFilter, fmtNow } = require('../core/util');
const { withGen, materialStatus, roundQty } = require('../core/material-calc');
const { isAdmin } = require('../core/auth');

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
// 单号规则 LL-YYYYMMDD-NNNN：NNNN 为当天 4 位补零流水号（从 0001 起，只增不减）
// 流水号从已落库的领料单推导，不新增字段；Node 单线程下 create 处理函数（计算单号→入数组→saveDB）全程同步、无 await 让出，
// 并发请求在 JS 层串行，后到者能看到前者记录并取 max+1，故同一秒并发也不会撞号；
// 扫描含已作废/已删除记录，确保单号不回收复用；仅计 4 位新格式后缀，旧 6 位 HHMMSS 后缀不计入（避免开局被带成 120506 而非 0001）。
// 领料单号：当日 YYYYMMDD-流水（3 位起、当日有效，如 20261028-001）
// 流水只统计「新格式当日单号」：前缀为当日 YYYYMMDD- 且余下全为数字；旧 LL-YYYYMMDD-NNNN 前缀不同、天然隔离，不解析
function reqNoNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const prefix = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-';
  let max = 0;
  for (const r of DB.materialRequisitions) {
    const no = r && r.reqNo;
    if (typeof no !== 'string' || no.indexOf(prefix) !== 0) continue;
    const suf = no.slice(prefix.length);
    if (/^\d+$/.test(suf)) { const n = parseInt(suf, 10); if (n > max) max = n; }
  }
  // 超过 999 时位数自然增长（1000、1001…），不截断、不封顶
  return prefix + String(max + 1).padStart(3, '0');
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

// 材料相关集合走通用 CRUD（逻辑删除；须晚于上面各具体的 /:id 删除路由注册）
['materialRequisitions', 'materialImports', 'materialOutbound'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
