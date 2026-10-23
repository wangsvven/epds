/* ========== routes/projects ========== */
/* 项目列表（资料文件、打包下载、竣工、删除依赖校验）与工程实际施工量接口。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO, aliveFilter, fmtNow, buildStoreZip } = require('../core/util');
const { resolveDocPath } = require('../core/doc-templates');

// ---------- 项目详情：资料管理（设计图纸/奥维地图/现场照片/规范图纸） ----------
// 需在通用 CRUD 之前注册：DELETE /:id 覆盖工厂版本以清理上传文件
// 项目删除：级联逻辑删除项目下全部关联业务数据（材料/计划/借工/竣工资料/领料单/出库单/资料文件）
// 须注册在通用 CRUD 工厂之前以覆盖默认删除
// ---------- 删除前置：依赖引用检查（项目） ----------
// 规则：只要还有其它业务数据引用/关联该项目（含其子项目名称），一律拒绝删除，由用户先清理引用数据
// 返回 [{ label, count }]；为空数组表示无引用、可安全删除
function projectRefsOf(p) {
  const names = [p.name].concat((p.subProjects || []).map(s => (s && s.name) || '')).filter(Boolean);
  const inNames = v => names.includes(String(v || ''));
  const refs = [];
  const add = (label, rows) => { if (rows.length) refs.push({ label, count: rows.length }); };
  add('材料清单', (DB.materials || []).filter(m => !m.deleted && inNames(m.project)));
  add('作业计划', (DB.workPlans || []).filter(w => !w.deleted && (inNames(w.project) || inNames(w.subProject))));
  add('月度计划', (DB.plans || []).filter(x => !x.deleted && (inNames(x.project) || inNames(x.subProject))));
  add('材料出库单', (DB.materialOutbound || []).filter(o => !o.deleted && inNames(o.project)));
  add('领料单', (DB.materialRequisitions || []).filter(r => {
    if (r.deleted) return false;
    if (Array.isArray(r.projects) && r.projects.some(n => inNames(n))) return true;
    return (r.items || []).some(it => inNames(it.project));
  }));
  add('借工记录', (DB.borrowWorks || []).filter(b => !b.deleted && (b.projectId === p.id || inNames(b.project))));
  add('竣工资料', (DB.completionDocuments || []).filter(c => !c.deleted && (c.projectId === p.id || inNames(c.project))));
  return refs;
}
app.delete('/api/projects/:id', (req, res) => {
  const p = DB.projects.find(x => x.id === req.params.id);
  if (!p || p.deleted) return res.status(404).json({ error: '未找到项目' });
  // 依赖引用校验：有引用则直接拒绝，不做级联删除
  const refs = projectRefsOf(p);
  if (refs.length) {
    return res.status(409).json({ error: '该项目已被其他数据引用，无法删除', refs });
  }
  p.deleted = true;
  // 项目自带资料文件随项目逻辑删除（磁盘文件保留）
  (p.files || []).forEach(f => { f.deleted = true; });
  saveDB();
  res.json({ ok: true });
});

const PROJECT_FILE_TYPES = {
  design: { label: '设计图纸', maxMB: 2 },
  map:    { label: '奥维地图', maxMB: 2 },
  photo:  { label: '现场照片', maxMB: 10 },
  spec:   { label: '规范图纸', maxMB: 3 }
};
function findProject(id, req) {
  const p = DB.projects.find(x => x.id === id);
  if (!p || p.deleted) return null;
  return p;
}
function projectFileSafeName(name) {
  return String(name).replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_').slice(-120);
}
app.post('/api/projects/:id/files', upload.single('file'), (req, res) => {
  const p = findProject(req.params.id, req);
  if (!p) return res.status(404).json({ error: '未找到项目' });
  const type = req.body.type;
  const conf = PROJECT_FILE_TYPES[type];
  if (!conf) return res.status(400).json({ error: '无效的资料类型' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  if (req.file.size > conf.maxMB * 1024 * 1024) return res.status(400).json({ error: conf.label + '单文件不超过 ' + conf.maxMB + 'MB' });
  const dir = path.join(ROOT, 'data', 'uploads', 'projects', p.id);
  fs.mkdirSync(dir, { recursive: true });
  const diskName = Date.now() + '_' + projectFileSafeName(req.file.originalname);
  fs.writeFileSync(path.join(dir, diskName), req.file.buffer);
  if (!Array.isArray(p.files)) p.files = [];
  const item = { id: genId('pf'), type, name: req.file.originalname, size: req.file.size, path: 'uploads/projects/' + p.id + '/' + diskName, uploadedAt: nowISO() };
  p.files.push(item);
  saveDB();
  res.json(item);
});
app.get('/api/projects/:id/files/:fid/download', (req, res) => {
  const p = findProject(req.params.id, req);
  const f = p && (p.files || []).find(x => x.id === req.params.fid && !x.deleted);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
app.delete('/api/projects/:id/files/:fid', (req, res) => {
  const p = findProject(req.params.id, req);
  if (!p) return res.status(404).json({ error: '未找到项目' });
  const f = (p.files || []).find(x => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: '未找到文件' });
  f.deleted = true; // 逻辑删除（保留磁盘文件，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});
// 打包下载：单个文件直接下载，多个文件打包为 ZIP（store 方式，零依赖）
app.get('/api/projects/:id/files/pack', (req, res) => {
  const p = findProject(req.params.id, req);
  const type = req.query.type;
  if (!p || !PROJECT_FILE_TYPES[type]) return res.status(400).json({ error: '无效的资料类型' });
  const list = (p.files || []).filter(f => f.type === type && !f.deleted);
  if (!list.length) return res.status(400).json({ error: '暂无可下载的' + PROJECT_FILE_TYPES[type].label });
  if (list.length === 1) {
    const fp = path.join(ROOT, 'data', list[0].path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(list[0].name) + '"');
    return fs.createReadStream(fp).pipe(res);
  }
  const entries = list.map(f => {
    const fp = path.join(ROOT, 'data', f.path);
    return { name: f.name, data: fs.existsSync(fp) ? fs.readFileSync(fp) : Buffer.alloc(0) };
  });
  const zip = buildStoreZip(entries);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(p.name + '-' + PROJECT_FILE_TYPES[type].label + '.zip') + '"');
  res.send(zip);
});
// 项目删除走通用 CRUD 工厂（逻辑删除，见下方 crud 注册）；此处不再单独物理删除
// 竣工：移入已竣工
app.put('/api/projects/:id/complete', (req, res) => {
  const p = findProject(req.params.id, req);
  if (!p) return res.status(404).json({ error: '未找到项目' });
  p.completed = true;
  saveDB();
  res.json(p);
});

// 项目集合走通用 CRUD（逻辑删除）
crud('projects', 'projects', { biz: true, soft: true });

// ---------- 工程实际施工量 ----------
const ACTUAL_WORK_TYPES = ['转运', '立杆', '放线和设备安装'];
app.get('/api/actualWorks', (req, res) => {
  const list = (DB.actualWorks || []).filter(r => !r.deleted)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
                    String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  res.json(list);
});
app.post('/api/actualWorks', (req, res) => {
  try {
    const b = req.body || {};
    const date = String(b.date || '').trim();
    const project = String(b.project || '').trim();
    // 工作类型 / 施工人员 均支持多选（数组），兼容旧版单值字符串
    const workTypes = (Array.isArray(b.workTypes) ? b.workTypes : (b.workType ? [b.workType] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    const workers = (Array.isArray(b.workers) ? b.workers : (b.worker ? [b.worker] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '请选择日期' });
    if (!project) return res.status(400).json({ error: '请选择项目名称（包）' });
    if (!workTypes.length || workTypes.some(t => !ACTUAL_WORK_TYPES.includes(t))) return res.status(400).json({ error: '请选择工作类型' });
    if (!workers.length) return res.status(400).json({ error: '请选择施工人员' });
    // 材料实际施工量：只保留数量 > 0 的项
    const items = Array.isArray(b.items) ? b.items.map(it => ({
      materialId: String((it && it.materialId) || ''),
      code: String((it && it.code) || ''),
      description: String((it && it.description) || '').trim(),
      unit: String((it && it.unit) || '').trim(),
      qty: Number(it && it.qty) || 0
    })).filter(it => it.description && it.qty > 0) : [];
    const row = {
      id: genId('aw'), date, project, workTypes, workers, items,
      submitter: (req.user && (req.user.name || req.user.username)) || '',
      submittedAt: fmtNow(), deleted: false
    };
    DB.actualWorks.push(row);
    saveDB();
    res.json(row);
  } catch (e) { res.status(500).json({ error: '提交失败：' + e.message }); }
});
app.put('/api/actualWorks/:id', (req, res) => {
  try {
    const row = (DB.actualWorks || []).find(r => r.id === req.params.id && !r.deleted);
    if (!row) return res.status(404).json({ error: '未找到' });
    const b = req.body || {};
    const date = String(b.date || '').trim();
    const project = String(b.project || '').trim();
    const workTypes = (Array.isArray(b.workTypes) ? b.workTypes : (b.workType ? [b.workType] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    const workers = (Array.isArray(b.workers) ? b.workers : (b.worker ? [b.worker] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '请选择日期' });
    if (!project) return res.status(400).json({ error: '请选择项目名称（包）' });
    if (!workTypes.length || workTypes.some(t => !ACTUAL_WORK_TYPES.includes(t))) return res.status(400).json({ error: '请选择工作类型' });
    if (!workers.length) return res.status(400).json({ error: '请选择施工人员' });
    const items = Array.isArray(b.items) ? b.items.map(it => ({
      materialId: String((it && it.materialId) || ''),
      code: String((it && it.code) || ''),
      description: String((it && it.description) || '').trim(),
      unit: String((it && it.unit) || '').trim(),
      qty: Number(it && it.qty) || 0
    })).filter(it => it.description && it.qty > 0) : [];
    row.date = date; row.project = project; row.workTypes = workTypes; row.workers = workers; row.items = items;
    row.updatedAt = fmtNow();
    row.updatedBy = (req.user && (req.user.name || req.user.username)) || '';
    saveDB();
    res.json(row);
  } catch (e) { res.status(500).json({ error: '保存失败：' + e.message }); }
});
app.delete('/api/actualWorks/:id', (req, res) => {
  const idx = (DB.actualWorks || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.actualWorks.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});
