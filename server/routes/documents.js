/* ========== routes/documents ========== */
/* 文档中心（分类/文件/模板替换/预览下载）与企业危险点库（含 Excel 导入解析），以及竣工资料集合 CRUD。 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const ROOT = path.join(__dirname, '..', '..');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO, aliveFilter, fmtNow, parseCSVBuffer, repairUploadName } = require('../core/util');
const { resolveDocPath } = require('../core/doc-templates');
const { categorize } = require('../core/risk-category');

// 危险点库统一导入：首个工作表 A 列危险点、C 列控制措施；按「危险点+措施」去重
function importHazardRows(rows) {
  const list = (rows || []).slice(1)
    .map(r => [String(r[0] || '').trim(), String(r[2] || '').trim()])
    .filter(([a, b]) => a || b);
  const existing = new Set(DB.documents.hazardLibrary.map(h => h.hazard + '||' + h.measure));
  let maxSort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1);
  let added = 0, skipped = 0;
  for (const [hazard, measure] of list) {
    if (!hazard || !measure) { skipped++; continue; }
    const key = hazard + '||' + measure;
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    DB.documents.hazardLibrary.push({ id: genId('h'), hazard, measure, category: categorize(hazard), sort: ++maxSort });
    added++;
  }
  return { added, skipped, total: list.length };
}
// 解析 Excel/CSV 缓冲区并入库（文档中心「危险点」分类上传/移入时自动解析）
function parseHazardFromBuffer(buffer, name) {
  const nm = String(name || '');
  let rows;
  if (/\.csv$/i.test(nm)) rows = parseCSVBuffer(buffer);
  else if (/\.(xlsx|xls)$/i.test(nm)) {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  } else {
    return { unsupported: true, added: 0, skipped: 0, total: 0 };
  }
  const r = importHazardRows(rows);
  saveDB();
  return r;
}
// 解析已上传的文档文件并入库
function parseHazardFromFile(file) {
  const abs = resolveDocPath(file && file.path);
  if (!abs || !fs.existsSync(abs)) return { error: '文件不存在，无法解析', added: 0, skipped: 0 };
  return parseHazardFromBuffer(fs.readFileSync(abs), (file && file.name) || '');
}

function seedHazardLibraryFromNorm() {
  try {
    const f = path.join(__dirname, 'assets', '危险点.xlsx');
    if (!fs.existsSync(f)) return;
    const wb = xlsx.readFile(f);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }).slice(1);
    const existing = new Set(DB.documents.hazardLibrary.map(h => h.hazard + '||' + h.measure));
    let maxSort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1);
    let n = 0;
    for (const r of rows) {
      const hazard = String(r[0] || '').trim();
      const measure = String(r[2] || '').trim();
      if (!hazard || !measure) continue;
      const key = hazard + '||' + measure;
      if (existing.has(key)) continue;
      existing.add(key);
      DB.documents.hazardLibrary.push({ id: genId('h'), hazard, measure, category: categorize(hazard), sort: ++maxSort });
      n++;
    }
    if (n) console.log(`  ➜  已从规范文件灌入企业危险点库 ${n} 条`);
  } catch (e) { console.error('  ⚠ 危险点库从规范文件灌入失败：', e.message); }
}
if (DB.documents && DB.documents.hazardLibrary) {
  // 危险点库不再自动从「assets/危险点.xlsx」灌入：全新实例保持为空，由用户手动录入或 Excel 导入
  // 仅补填老数据缺失的 category 字段
  let patched = false;
  DB.documents.hazardLibrary.forEach(h => {
    if (h.category === undefined) { h.category = categorize(h.hazard || ''); patched = true; }
  });
  if (patched) saveDB();
}

// ---------- 文档中心 ----------

app.get('/api/documents', (req, res) => {
  const docs = { ...DB.documents, files: (DB.documents.files || []).filter(f => !f.deleted) };
  res.json(docs);
});

// 更新文档中心顶层元数据（分类列表 / 固定模板名称、上传人、时间；不改动 path）
app.put('/api/documents', (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.categories)) DB.documents.categories = b.categories;
    if (b.surveyTemplate && typeof b.surveyTemplate === 'object') {
      DB.documents.surveyTemplate = { ...DB.documents.surveyTemplate, ...b.surveyTemplate, path: DB.documents.surveyTemplate.path };
    }
    saveDB();
    res.json(DB.documents);
  } catch (e) { res.status(500).json({ error: '更新失败：' + e.message }); }
});

// 上传真实文件（单文件 ≤20MB）→ data/uploads/
app.post('/api/documents/files', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    if (req.file.size > 20 * 1024 * 1024) return res.status(400).json({ error: '单文件不超过 20MB' });
    const upDir = path.join(ROOT, 'data', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
    const id = genId('f');
    const safe = (req.file.originalname || 'file').replace(/[\\/:*?"<>|]/g, '_');
    const rel = 'uploads/' + id + '_' + safe;
    fs.writeFileSync(path.join(ROOT, 'data', rel), req.file.buffer);
    const file = {
      id, category: req.body.category || '规范文件', name: req.file.originalname,
      size: req.file.size, uploader: req.user.name, uploadedAt: fmtNow(), path: rel
    };
    DB.documents.files.push(file);
    saveDB();
    // 上传到「危险点」分类：Excel/CSV 自动解析入企业危险点库（A列危险点、C列控制措施，去重）
    let hazardImport = null;
    if (file.category === '危险点') {
      try { hazardImport = parseHazardFromBuffer(req.file.buffer, file.name); }
      catch (e) { hazardImport = { error: e.message, added: 0, skipped: 0 }; }
    }
    res.json({ ...file, hazardImport });
  } catch (e) { res.status(500).json({ error: '上传失败：' + e.message }); }
});

// 替换固定系统文件：现场勘察记录模板.docx（固定文件不可移动/删除，只能替换）
app.post('/api/documents/template/replace', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    if (req.file.size > 20 * 1024 * 1024) return res.status(400).json({ error: '单文件不超过 20MB' });
    const name = req.file.originalname || '';
    if (!/\.docx$/i.test(name)) return res.status(400).json({ error: '仅支持替换为 .docx 文件' });
    const upDir = path.join(ROOT, 'data', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
    // 清理上一次替换产生的旧文件
    const old = DB.documents.surveyTemplate && DB.documents.surveyTemplate.path;
    if (old && old.startsWith('uploads/')) { try { fs.unlinkSync(path.join(ROOT, 'data', old)); } catch (e) {} }
    const rel = 'uploads/st_' + Date.now() + '_' + name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(ROOT, 'data', rel), req.file.buffer);
    const meta = { name, uploader: req.user.name, uploadedAt: fmtNow(), path: rel, size: req.file.size };
    DB.documents.surveyTemplate = { ...DB.documents.surveyTemplate, ...meta };
    const idx = DB.documents.files.findIndex(f => f.id === 'st1');
    if (idx >= 0) DB.documents.files[idx] = { ...DB.documents.files[idx], ...meta };
    saveDB();
    res.json(DB.documents.surveyTemplate);
  } catch (e) { res.status(500).json({ error: '替换失败：' + e.message }); }
});

// 移动到（改分类）/ 改名
app.put('/api/documents/files/:id', (req, res) => {
  const idx = DB.documents.files.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  if (DB.documents.files[idx].fixed) return res.status(400).json({ error: '固定系统文件不可移动' });
  const before = DB.documents.files[idx];
  const updated = { ...before, ...req.body, id: req.params.id };
  DB.documents.files[idx] = updated;
  saveDB();
  // 移入「危险点」分类：若为 Excel/CSV，自动解析入企业危险点库
  let hazardImport = null;
  if (updated.category === '危险点' && before.category !== '危险点') {
    try { hazardImport = parseHazardFromFile(updated); }
    catch (e) { hazardImport = { error: e.message, added: 0, skipped: 0 }; }
  }
  res.json({ ...updated, hazardImport });
});

app.delete('/api/documents/files/:id', (req, res) => {
  const idx = DB.documents.files.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  if (DB.documents.files[idx].fixed) return res.status(400).json({ error: '固定系统文件不可删除' });
  const f = DB.documents.files[idx];
  if (f.path && f.path.startsWith('uploads/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', f.path)); } catch (e) {}
  }
  DB.documents.files.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 下载：真实文件直接下发；演示记录下发占位内容
app.get('/api/documents/files/:id/download', (req, res) => {
  const f = DB.documents.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '未找到' });
  let p = null;
  if (f.path && f.path.startsWith('assets/')) p = path.join(ROOT, f.path);
  if (f.path && f.path.startsWith('uploads/')) p = path.join(ROOT, 'data', f.path);
  if (p && fs.existsSync(p)) {
    return res.download(p, f.name);
  }
  const content = Buffer.from(`${f.name}\n分类：${f.category}\n上传人：${f.uploader}\n上传时间：${f.uploadedAt}\n（本地演示版未存储该文件的真实内容）`, 'utf8');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(content);
});

// 预览：xlsx→表格；docx→提取文本；pdf→浏览器打开链接；其他→不支持
app.get('/api/documents/files/:id/preview', (req, res) => {
  const f = DB.documents.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '未找到' });
  let p = null;
  if (f.path && f.path.startsWith('assets/')) p = path.join(ROOT, f.path);
  if (f.path && f.path.startsWith('uploads/')) p = path.join(ROOT, 'data', f.path);
  if (!p || !fs.existsSync(p)) {
    return res.json({ kind: 'unsupported', name: f.name, message: '该文件为演示登记记录，未存储真实内容，请下载后查看。' });
  }
  const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  try {
    if (['xlsx', 'xls'].includes(ext.toLowerCase())) {
      const wb = xlsx.readFile(p);
      const sheets = wb.SheetNames.map(n => {
        const rows = xlsx.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false });
        return { name: n, rows };
      });
      return res.json({ kind: 'xlsx', name: f.name, sheets });
    }
    if (ext.toLowerCase() === 'docx') {
      const lines = extractDocxText(fs.readFileSync(p));
      return res.json({ kind: 'docx', name: f.name, lines });
    }
    if (ext.toLowerCase() === 'pdf') {
      return res.json({ kind: 'pdf', name: f.name, url: '/api/documents/files/' + f.id + '/download' });
    }
    return res.json({ kind: 'unsupported', name: f.name, message: '该文件类型暂不支持预览，请下载后查看。' });
  } catch (e) { res.status(500).json({ error: '预览失败：' + e.message }); }
});

// ---------- 企业危险点库（对齐截图：危险点/控制措施/排序） ----------
app.post('/api/documents/hazard', (req, res) => {
  const b = req.body || {};
  const hazard = String(b.hazard || '').trim();
  const measure = String(b.measure || '').trim();
  if (!hazard) return res.status(400).json({ error: '请填写危险点' });
  if (!measure) return res.status(400).json({ error: '请填写控制措施' });
  if (hazard.length > 1000) return res.status(400).json({ error: '危险点不超过 1000 字' });
  if (measure.length > 4000) return res.status(400).json({ error: '控制措施不超过 4000 字' });
  let sort = (b.sort === '' || b.sort === null || b.sort === undefined) ? null : Number(b.sort);
  if (sort === null || isNaN(sort)) {
    sort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1) + 1;
  }
  const category = b.category ? String(b.category).trim() : categorize(hazard);
  const h = { id: genId('h'), hazard, measure, category, sort };
  DB.documents.hazardLibrary.push(h);
  saveDB();
  res.json(h);
});

app.put('/api/documents/hazard/:id', (req, res) => {
  const idx = DB.documents.hazardLibrary.findIndex(h => h.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const hazard = String(b.hazard ?? DB.documents.hazardLibrary[idx].hazard).trim();
  const measure = String(b.measure ?? DB.documents.hazardLibrary[idx].measure).trim();
  if (!hazard) return res.status(400).json({ error: '请填写危险点' });
  if (!measure) return res.status(400).json({ error: '请填写控制措施' });
  let sort = (b.sort === '' || b.sort === null || b.sort === undefined) ? DB.documents.hazardLibrary[idx].sort : Number(b.sort);
  if (isNaN(sort)) sort = DB.documents.hazardLibrary[idx].sort;
  const category = b.category === undefined ? undefined : String(b.category || '').trim();
  DB.documents.hazardLibrary[idx] = { ...DB.documents.hazardLibrary[idx], hazard, measure, sort, ...(category === undefined ? {} : { category }) };
  saveDB();
  res.json(DB.documents.hazardLibrary[idx]);
});

app.delete('/api/documents/hazard/:id', (req, res) => {
  const idx = DB.documents.hazardLibrary.findIndex(h => h.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.documents.hazardLibrary.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 危险点导入：首个工作表 A列危险点、C列控制措施；最多 1000 行、2MB；相同危险点和措施自动跳过
app.post('/api/documents/hazard/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: '文件超过 2MB 限制' });
    let rows;
    if (/\.csv$/i.test(req.file.originalname || '')) {
      rows = parseCSVBuffer(req.file.buffer);
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    }
    const data = rows.slice(1)
      .map(r => [String(r[0] || '').trim(), String(r[2] || '').trim()])
      .filter(([a, b]) => a || b);
    if (data.length > 1000) return res.status(400).json({ error: '超过最多 1000 行的限制' });
    const { added, skipped } = importHazardRows(rows);
    saveDB();
    res.json({ ok: true, added, skipped });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// 竣工资料集合走通用 CRUD（逻辑删除）
crud('completionDocuments', 'completionDocuments', { biz: true, soft: true });
