/* ========== routes/borrow ========== */
/* 借工管理：佐证图片上传/下载/删除、《用工申请审批表》生成与下载、字段前置校验，
   以及 borrowWorks 集合通用 CRUD。全部端点与校验只属于借工模块。
   本文件必须先于 routes/plans.js 加载（专用路由须早于通用 /:id 路由）。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO, safeFileName, INLINE_MIME } = require('../core/util');
const { buildBorrowDocx } = require('../core/borrow-doc');

// ==================== 借工管理（独立视图）：佐证 / 借工单生成 / 前置校验 ====================
// borrowWorks 基础增删改查走本文件末尾通用 CRUD；以下专用端点与校验须注册在其之前。
const BORROW_EVIDENCE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const BORROW_EVIDENCE_MAX = 5;
const BORROW_GEN_CATEGORY = '借工单';
const BORROW_GEN_FILE_NAME = '借工单.docx';
const BORROW_TEMPLATE_REL = 'assets/借工单模板.docx';
const BORROW_DIRECTIONS = ['我方借出', '我方借入'];
const BORROW_PROJECT_TYPES = ['抢险抢修', '运维检修', '运维值班', '相互往来'];
const BORROW_SIGN_STATUS = ['未签单', '已签单'];

function findBorrow(id) {
  const b = (DB.borrowWorks || []).find(x => x.id === id);
  if (!b || b.deleted) return null;
  return b;
}
function borrowEvidences(b) {
  if (!Array.isArray(b.evidences)) b.evidences = [];
  return b.evidences;
}
function borrowGenerated(b) {
  if (!Array.isArray(b.generatedFiles)) b.generatedFiles = [];
  return b.generatedFiles;
}
function borrowExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
}

// 佐证：上传（仅图片，每条记录上限 5，超出 400）
app.post('/api/borrowWorks/:id/evidences', upload.single('file'), (req, res) => {
  const b = findBorrow(req.params.id);
  if (!b) return res.status(404).json({ error: '未找到借工记录' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  if (BORROW_EVIDENCE_EXTS.indexOf(borrowExt(req.file.originalname)) < 0) {
    return res.status(400).json({ error: '仅支持图片（jpg/jpeg/png/gif/webp/bmp）' });
  }
  const list = borrowEvidences(b);
  if (list.length >= BORROW_EVIDENCE_MAX) return res.status(400).json({ error: '佐证最多 ' + BORROW_EVIDENCE_MAX + ' 张，请先删除后再上传' });
  const dir = path.join(ROOT, 'data', 'uploads', 'borrow', b.id);
  fs.mkdirSync(dir, { recursive: true });
  const diskName = Date.now() + '_' + safeFileName(req.file.originalname);
  fs.writeFileSync(path.join(dir, diskName), req.file.buffer);
  const item = {
    id: genId('bv'), category: '佐证',
    name: req.file.originalname, size: req.file.size,
    path: 'uploads/borrow/' + b.id + '/' + diskName, uploadedAt: nowISO()
  };
  list.push(item);
  saveDB();
  res.json(item);
});
// 佐证下载/预览（?inline=1 图片给可预览 MIME；GET 不改记录）
app.get('/api/borrowWorks/:id/evidences/:fileId/download', (req, res) => {
  const b = findBorrow(req.params.id);
  const f = b && (Array.isArray(b.evidences) ? b.evidences : []).find(x => x.id === req.params.fileId);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  const inline = req.query.inline === '1' && INLINE_MIME[borrowExt(f.name)];
  res.setHeader('Content-Type', inline || 'application/octet-stream');
  res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
// 删除佐证（记录 + 磁盘文件）
app.delete('/api/borrowWorks/:id/evidences/:fileId', (req, res) => {
  const b = findBorrow(req.params.id);
  if (!b) return res.status(404).json({ error: '未找到借工记录' });
  const list = borrowEvidences(b);
  const idx = list.findIndex(x => x.id === req.params.fileId);
  if (idx < 0) return res.status(404).json({ error: '未找到佐证' });
  const [f] = list.splice(idx, 1);
  if (f && typeof f.path === 'string' && f.path.startsWith('uploads/borrow/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', f.path)); } catch (e) {}
  }
  saveDB();
  res.json({ ok: true });
});

// 生成借工单：读 assets 模板 → 填充 → 落盘 → generatedFiles 原地覆盖同类别条目
app.post('/api/borrowWorks/:id/borrowForm/generate', (req, res) => {
  const b = findBorrow(req.params.id);
  if (!b) return res.status(404).json({ error: '未找到借工记录' });
  const tplAbs = path.join(ROOT, BORROW_TEMPLATE_REL);
  if (!fs.existsSync(tplAbs)) return res.status(400).json({ error: '借工单模板缺失（assets/借工单模板.docx）' });
  let buf;
  try {
    buf = buildBorrowDocx(fs.readFileSync(tplAbs), b).buffer;
  } catch (e) {
    return res.status(400).json({ error: '生成失败：' + e.message });
  }
  const list = borrowGenerated(b);
  const prev = list.find(x => x && x.category === BORROW_GEN_CATEGORY && typeof x.path === 'string' && x.path.startsWith('uploads/borrow/'));
  const rel = prev ? prev.path : ('uploads/borrow/' + b.id + '/' + Date.now() + '_' + safeFileName(BORROW_GEN_FILE_NAME));
  const abs2 = path.join(ROOT, 'data', rel);
  let backup = null;
  try {
    fs.mkdirSync(path.dirname(abs2), { recursive: true });
    if (prev && fs.existsSync(abs2)) backup = fs.readFileSync(abs2);
    fs.writeFileSync(abs2, buf);
  } catch (e) {
    return res.status(500).json({ error: '保存生成文件失败：' + e.message });
  }
  let item;
  const prevSnapshot = prev ? { name: prev.name, size: prev.size, uploadedAt: prev.uploadedAt } : null;
  if (prev) {
    item = prev;
    item.name = BORROW_GEN_FILE_NAME;
    item.size = buf.length;
    item.uploadedAt = nowISO();
  } else {
    item = { id: genId('bg'), category: BORROW_GEN_CATEGORY, name: BORROW_GEN_FILE_NAME, size: buf.length, path: rel, uploadedAt: nowISO() };
    list.push(item);
  }
  try {
    saveDB();
  } catch (e) {
    if (prev && prevSnapshot) {
      prev.name = prevSnapshot.name; prev.size = prevSnapshot.size; prev.uploadedAt = prevSnapshot.uploadedAt;
      if (backup) { try { fs.writeFileSync(abs2, backup); } catch (e3) {} }
    } else {
      const i = list.indexOf(item);
      if (i > -1) list.splice(i, 1);
      try { fs.unlinkSync(abs2); } catch (e2) {}
    }
    return res.status(500).json({ error: '保存生成记录失败：' + e.message });
  }
  res.json(Object.assign({}, item, { updated: !!prev }));
});
app.get('/api/borrowWorks/:id/generated/:fileId/download', (req, res) => {
  const b = findBorrow(req.params.id);
  const f = b && (Array.isArray(b.generatedFiles) ? b.generatedFiles : []).find(x => x.id === req.params.fileId);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
app.delete('/api/borrowWorks/:id/generated/:fileId', (req, res) => {
  const b = findBorrow(req.params.id);
  if (!b) return res.status(404).json({ error: '未找到借工记录' });
  const list = borrowGenerated(b);
  const idx = list.findIndex(x => x.id === req.params.fileId);
  if (idx < 0) return res.status(404).json({ error: '未找到生成资料' });
  const [f] = list.splice(idx, 1);
  if (f && typeof f.path === 'string' && f.path.startsWith('uploads/borrow/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', f.path)); } catch (e) {}
  }
  saveDB();
  res.json({ ok: true });
});

// 前置校验：只拦 POST /api/borrowWorks 与 PUT /api/borrowWorks/:id；带更多路径段的（/:id/evidences 等）一律放行
app.use((req, res, next) => {
  const isCreate = req.method === 'POST' && req.path === '/api/borrowWorks';
  const isUpdate = req.method === 'PUT' && /^\/api\/borrowWorks\/[^/]+$/.test(req.path);
  if (!isCreate && !isUpdate) return next();
  const b = req.body || {};
  const errs = [];
  ['techCount', 'workerCount', 'vehicleCount'].forEach(k => {
    if (b[k] === undefined || b[k] === null || b[k] === '') return;
    const n = Number(b[k]);
    if (!Number.isInteger(n) || n < 0) errs.push(k + ' 须为 ≥0 的整数');
  });
  const enumCheck = (k, arr, label) => {
    if (b[k] === undefined || b[k] === null || b[k] === '') return;
    if (arr.indexOf(String(b[k])) < 0) errs.push(label + ' 取值非法');
  };
  enumCheck('direction', BORROW_DIRECTIONS, '方向');
  enumCheck('projectType', BORROW_PROJECT_TYPES, '项目类型');
  enumCheck('signStatus', BORROW_SIGN_STATUS, '签单状态');
  if (errs.length) return res.status(400).json({ error: errs.join('；') });
  next();
});

// borrowWorks 通用 CRUD（逻辑删除；须晚于上面的专用端点与前置校验）
crud('borrowWorks', 'borrowWorks', { biz: true, soft: true });
