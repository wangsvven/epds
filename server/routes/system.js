/* ========== routes/system ========== */
/* 用户、设置、人员、通讯录、登录、初始化状态、健康检查与登录背景图；首页直出注入背景 CSS。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('xlsx');
const ROOT = path.join(__dirname, '..', '..');
// 当前版本号：实时读 package.json（前端页脚展示用，避免前端写死；发布升版后刷新即跟随）
function pkgVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || ''); }
  catch (e) { return ''; }
}
const { resolveSurveyTemplate } = require('../core/doc-templates');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB, DEFAULT_LOGIN_BG, LEGACY_LOGIN_BG_MAP, USER_GROUPS } = require('../core/db');
const {
  genId, nowISO, fmtNow, aliveFilter, parseCNDate, parseCSVBuffer, repairUploadName
} = require('../core/util');
const {
  TOKENS, isAdmin, passwordStrong, userGroupOf, writeModulesOf
} = require('../core/auth');

function registerPublic() {
// ---------- 认证 ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const id = String(username || '').trim();
  // 支持登录名或邮箱登录
  const user = DB.users.find(u => (u.username === id || u.email === id) && u.password === password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const token = crypto.randomBytes(24).toString('hex');
  TOKENS[token] = user.username;
  saveDB();
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, username: user.username } });
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: DB.settings.systemName }));
// favicon：避免浏览器默认请求 /favicon.ico 触发 404 控制台错误
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- 登录页公开配置（无需登录：登录页需在鉴权前取背景图 / 系统名） ----------
app.get('/api/public-config', (req, res) => {
  res.json({
    systemName: DB.settings.systemName || '',
    companyName: DB.settings.companyName || '',
    loginBg: DB.settings.loginBg || DEFAULT_LOGIN_BG,
    version: pkgVersion()
  });
});
// 本地上传的登录页背景（无需登录；仅允许读取 data/uploads/login-bg 目录，防目录穿越）
app.get('/api/login-bg/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name) return res.status(400).json({ error: '参数错误' });
  const file = path.join(ROOT, 'data', 'uploads', 'login-bg', name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '背景不存在' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
});

}

function registerAuthed() {
app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u.id, name: u.name, role: userGroupOf(u), rawRole: u.role, username: u.username,
      isAdmin: isAdmin(req),
      permissions: { group: userGroupOf(u), writeModules: writeModulesOf(u) }
    },
    tenant: DB.tenant, settings: DB.settings
  });
});

// ---------- 账号（登录账号列表） ----------
app.get('/api/users', (req, res) => {
  res.json(DB.users.map(u => ({
    id: u.id, username: u.username, loginName: u.loginName || u.username, email: u.email || '',
    name: u.name, role: u.role, userGroup: userGroupOf(u), phone: u.phone || '',
    createdAt: u.createdAt, status: (u.status || 'active') === 'disabled' ? '停用' : '启用',
    isSelf: u.username === req.user.username
  })));
});

app.post('/api/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可新增账号' });
  const b = req.body || {};
  const loginName = String(b.loginName || b.username || '').trim();
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim();
  const password = String(b.password || '').trim();
  const userGroup = USER_GROUPS.includes(b.userGroup) ? b.userGroup : '班组长';
  if (!loginName) return res.status(400).json({ error: '请填写登录名' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!password) return res.status(400).json({ error: '请填写密码' });
  if (password.length < 8 || password.length > 32) return res.status(400).json({ error: '密码需为 8-32 位' });
  if (!passwordStrong(password)) return res.status(400).json({ error: '密码需包含大写/小写/数字/符号中的至少三类' });
  if (DB.users.some(u => u.username === loginName)) return res.status(400).json({ error: '该登录名已存在' });
  if (DB.users.some(u => u.email === email)) return res.status(400).json({ error: '该邮箱已被使用' });
  const user = {
    id: genId('u'), username: loginName, loginName, email, name,
    phone: String(b.phone || ''), password, role: userGroup, userGroup,
    createdAt: nowISO(), status: 'active'
  };
  DB.users.push(user);
  saveDB();
  res.json({ id: user.id, username: loginName, loginName, email, name, phone: user.phone, role: user.role, userGroup, status: 'active' });
});

app.put('/api/users/:id', (req, res) => {
  const u = DB.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '未找到用户' });
  const b = req.body || {};
  const adm = isAdmin(req);
  if (!adm && u.username !== req.user.username) return res.status(403).json({ error: '无权修改其他账号' });
  if (b.name !== undefined) u.name = String(b.name);
  if (b.phone !== undefined) u.phone = String(b.phone || '');
  if (b.email !== undefined) u.email = String(b.email || '').trim();
  if (b.password) {
    const pwd = String(b.password);
    if (pwd.length < 8 || pwd.length > 32) return res.status(400).json({ error: '密码需为 8-32 位' });
    if (!passwordStrong(pwd)) return res.status(400).json({ error: '密码需包含大写/小写/数字/符号中的至少三类' });
    u.password = pwd;
  }
  if (b.status && (adm || u.username !== req.user.username)) u.status = b.status === 'disabled' ? 'disabled' : 'active';
  if (adm && b.userGroup && u.username !== 'admin' && USER_GROUPS.includes(b.userGroup)) { u.userGroup = b.userGroup; u.role = u.userGroup; }
  saveDB();
  res.json({ id: u.id, username: u.username, loginName: u.loginName || u.username, email: u.email || '', name: u.name, role: u.role, userGroup: u.userGroup, phone: u.phone, status: u.status });
});

app.delete('/api/users/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可删除账号' });
  const idx = DB.users.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到用户' });
  if (DB.users[idx].username === 'admin') return res.status(400).json({ error: '内置超级用户不可删除' });
  DB.users.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// ---------- 作业人员：导入/导出（需在通用 CRUD 之前注册，避免被 GET /:id 拦截） ----------
// 模板列（按位置）：0 姓名 / 1 身份证号 / 2 电话号码 / 3 身份 / 4 班组 / 5 证件类型 / 6 准入有效期
const WORKER_ID_RE = /^\d{17}[\dXx]$/;
const WORKER_PHONE_RE = /^1\d{10}$/;
const WORKER_IDENTITY_OPTIONS = ['技工（计入高处作业人员）', '民工', '其他技工（不计入高处作业人员）'];


app.post('/api/workers/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    if (/\.csv$/i.test(req.file.originalname || '')) {
      rows = parseCSVBuffer(req.file.buffer);
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }
    const errors = [];
    const parsed = [];
    rows.forEach((r, i) => {
      if (i === 0) return; // 跳过表头
      const name = String(r[0] || '').trim();
      const idNumber = String(r[1] || '').trim();
      const phone = String(r[2] || '').trim();
      const identity = String(r[3] || '').trim();
      const team = String(r[4] || '').trim();
      const certTypes = String(r[5] || '').trim();
      const validRaw = String(r[6] || '').trim();
      if (!name && !idNumber && !phone && !validRaw) return; // 空行
      if (!name) errors.push(`第${i + 1}行：姓名为空`);
      if (idNumber && !WORKER_ID_RE.test(idNumber)) errors.push(`第${i + 1}行：身份证号格式错误（需18位，末位可为X）`);
      if (phone && !WORKER_PHONE_RE.test(phone)) errors.push(`第${i + 1}行：手机号格式错误（需11位手机号）`);
      if (identity && !WORKER_IDENTITY_OPTIONS.includes(identity)) errors.push(`第${i + 1}行：身份选项无效`);
      let validStart = '', validEnd = '';
      if (validRaw) {
        // 支持「2026-10-09 - 2026-11-18」「2026年10月9日至2026年11月18日」「2026/10/9」等写法
        const parts = validRaw.split(/\s+[-–—~]\s+|\s*至\s*|\s*到\s*/).map(s => s.trim()).filter(Boolean);
        const dates = parts.map(parseCNDate);
        if (dates.length === 1 && dates[0]) { validStart = dates[0]; validEnd = dates[0]; }
        else if (dates.length >= 2 && dates[0] && dates[1]) {
          if (dates[1] < dates[0]) errors.push(`第${i + 1}行：准入有效期结束日期不得早于开始日期`);
          validStart = dates[0]; validEnd = dates[1];
        }
        else errors.push(`第${i + 1}行：准入有效期格式错误`);
      }
      parsed.push({
        name, idNumber, phone, identity, team,
        certTypes: certTypes ? certTypes.split(/[、,，;；\/\s]+/).filter(Boolean) : [],
        validStart, validEnd
      });
    });
    if (errors.length) {
      return res.status(400).json({ error: `存在格式错误，整批不导入。${errors.slice(0, 5).join('；')}${errors.length > 5 ? `……共${errors.length}处错误` : ''}` });
    }
    const added = parsed.map(p => ({
      id: genId('w'), createdAt: nowISO(),
      name: p.name, idNumber: p.idNumber, phone: p.phone,
      identity: p.identity, team: p.team, certTypes: p.certTypes,
      validStart: p.validStart, validEnd: p.validEnd, status: '已准入',
      deleted: false
    }));
    DB.workers.push(...added);
    saveDB();
    res.json({ ok: true, added: added.length });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

app.get('/api/workers/export', (req, res) => {
  const header = ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'];
  const rows = DB.workers.filter(aliveFilter()).map(w => [
    w.name || '', w.idNumber || '', w.phone || '', w.identity || '', w.team || '',
    (w.certTypes || []).join('、'),
    w.validStart ? (w.validStart + (w.validEnd ? ' - ' + w.validEnd : '')) : '',
    w.status || '已准入'
  ]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([header, ...rows]), '作业人员名单');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="workers.xlsx"');
  res.send(buf);
});

// ---------- 外部通讯录：导入/导出（同样须在通用 CRUD 之前注册） ----------
// 字段：部门 dept / 姓名 name / 职务 post / 手机 phone / 移动短号 shortNo
// 兼容旧字段：unit → 部门、remark → 备注
const CONTACT_HEADER_MAP = {
  '部门': 'dept', '单位': 'dept', '姓名': 'name', '职务': 'post',
  '手机': 'phone', '电话': 'phone', '手机号': 'phone',
  '移动短号': 'shortNo', '短号': 'shortNo', '备注': 'remark'
};
function contactDept(c) { return c.dept || c.unit || ''; }

app.get('/api/contacts/export', (req, res) => {
  const header = ['部门', '姓名', '职务', '手机', '移动短号'];
  const rows = DB.contacts.filter(aliveFilter()).map(c => [
    contactDept(c), c.name || '', c.post || '', c.phone || '', c.shortNo || ''
  ]);
  const wb = xlsx.utils.book_new();
  // sheet 名固定为「员工」，导出文件可直接再次导入
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([header, ...rows]), '员工');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.xlsx"');
  res.send(buf);
});

app.post('/api/contacts/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    if (/\.csv$/i.test(req.file.originalname || '')) {
      rows = parseCSVBuffer(req.file.buffer);
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      // 优先取名为「员工」的 sheet，否则取第一个
      const sheetName = wb.SheetNames.find(n => String(n).trim() === '员工') || wb.SheetNames[0];
      const ws = sheetName ? wb.Sheets[sheetName] : null;
      if (!ws) return res.status(400).json({ error: '文件中没有可读取的工作表' });
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }
    if (!rows.length) return res.status(400).json({ error: '文件内容为空' });

    // 识别表头行：首个含已知表头文字的行；识别不到则按位置解析（部门/姓名/职务/手机/移动短号）
    let headerIdx = -1, idxMap = null;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const cells = (rows[i] || []).map(c => String(c || '').trim());
      const hit = cells.filter(c => CONTACT_HEADER_MAP[c]);
      if (hit.length >= 2) {
        headerIdx = i; idxMap = {};
        cells.forEach((c, ci) => { const f = CONTACT_HEADER_MAP[c]; if (f && idxMap[f] === undefined) idxMap[f] = ci; });
        break;
      }
    }
    const fields = ['dept', 'name', 'post', 'phone', 'shortNo'];
    if (!idxMap) { idxMap = {}; fields.forEach((f, i) => { idxMap[f] = i; }); }

    const errors = [];
    const parsed = [];
    rows.forEach((r, i) => {
      if (i <= headerIdx) return;
      const get = f => String((idxMap[f] !== undefined && r[idxMap[f]] !== undefined) ? r[idxMap[f]] : '').trim();
      const dept = get('dept'), name = get('name'), post = get('post'), phone = get('phone'), shortNo = get('shortNo');
      if (!dept && !name && !post && !phone && !shortNo) return; // 空行
      if (!name) { errors.push(`第${i + 1}行：姓名为空`); return; }
      parsed.push({ dept, name, post, phone, shortNo });
    });
    if (errors.length) {
      return res.status(400).json({ error: `存在错误，整批不导入。${errors.slice(0, 5).join('；')}${errors.length > 5 ? `……共${errors.length}处` : ''}` });
    }
    if (!parsed.length) return res.status(400).json({ error: '未解析到有效联系人（姓名列不能为空）' });

    // 覆盖式导入：整表替换为本次导入的通讯录
    const replaced = DB.contacts.filter(c => !c.deleted).length;
    DB.contacts = [];
    const added = parsed.map(p => ({
      id: genId('c'), createdAt: nowISO(),
      dept: p.dept, name: p.name, post: p.post, phone: p.phone, shortNo: p.shortNo,
      deleted: false
    }));
    DB.contacts.push(...added);
    saveDB();
    res.json({ ok: true, imported: added.length, replaced });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 设置 ----------
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => {
  DB.settings = { ...DB.settings, ...req.body };
  saveDB();
  res.json(DB.settings);
});

// 首次使用初始化向导：返回各基础设置的完成度
app.get('/api/init-status', (req, res) => {
  const myWorkers = (DB.workers || []).filter(aliveFilter());
  const workers = myWorkers.length;
  // 「班组与施工人员」完成条件：至少一位施工人员已归属班组
  const workersWithTeam = myWorkers.filter(w => !!(w.team && String(w.team).trim())).length;
  const contacts = (DB.contacts || []).filter(aliveFilter()).length;
  const haz = (DB.documents && DB.documents.hazardLibrary) || [];
  const survey = !!resolveSurveyTemplate();
  res.json({
    initialized: !!(DB.settings && DB.settings.initialized),
    companyName: (DB.settings && DB.settings.companyName) || '',
    workers,
    workersWithTeam,
    contacts,
    hazardLibrary: haz.length,
    surveyTemplate: survey
  });
});

// ---------- 登录页背景：本地上传（管理员）→ data/uploads/login-bg/ ----------
app.post('/api/settings/login-bg', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const name = req.file.originalname || '';
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(name)) return res.status(400).json({ error: '仅支持 JPG / PNG / WebP / GIF 图片' });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: '图片不超过 10MB' });
    const upDir = path.join(ROOT, 'data', 'uploads', 'login-bg');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
    // 清理上一次上传的背景文件（预设图在 public/ 内，不受影响）
    const old = DB.settings.loginBg;
    if (old && old.startsWith('/api/login-bg/')) {
      try { fs.unlinkSync(path.join(upDir, path.basename(old))); } catch (e) {}
    }
    const diskName = 'bg_' + Date.now() + '_' + name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(upDir, diskName), req.file.buffer);
    DB.settings.loginBg = '/api/login-bg/' + diskName;
    // 新图重置旋转角，避免沿用上一张图的旋转
    DB.settings.loginBgRotate = 0;
    // 前端通过 canvas 生成的 LQIP / 平均色（用于首帧占位，避免黑闪）
    const lqip = String((req.body && req.body.lqip) || '');
    const avg = String((req.body && req.body.avg) || '');
    DB.settings.loginBgMeta = {
      url: DB.settings.loginBg,
      lqip: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{20,200000}$/.test(lqip) ? lqip : '',
      avg: /^#[0-9a-fA-F]{3,8}$/.test(avg) ? avg : ''
    };
    saveDB();
    res.json({ ok: true, loginBg: DB.settings.loginBg, meta: DB.settings.loginBgMeta });
  } catch (e) { res.status(500).json({ error: '上传失败：' + e.message }); }
});

// 回填/更新当前背景的占位元数据（LQIP + 平均色），用于旧上传图或前端补算
app.put('/api/settings/login-bg/meta', (req, res) => {
  try {
    const lqip = String((req.body && req.body.lqip) || '');
    const avg = String((req.body && req.body.avg) || '');
    const okLqip = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{20,200000}$/.test(lqip) ? lqip : '';
    const okAvg = /^#[0-9a-fA-F]{3,8}$/.test(avg) ? avg : '';
    if (!okLqip && !okAvg) return res.status(400).json({ error: '缺少有效的 lqip / avg' });
    DB.settings.loginBgMeta = { url: DB.settings.loginBg, lqip: okLqip, avg: okAvg };
    saveDB();
    res.json({ ok: true, meta: DB.settings.loginBgMeta });
  } catch (e) { res.status(500).json({ error: '更新失败：' + e.message }); }
});

// 删除自定义背景：删磁盘文件并恢复为默认预设
app.delete('/api/settings/login-bg', (req, res) => {
  try {
    const cur = DB.settings.loginBg || '';
    if (cur.startsWith('/api/login-bg/')) {
      const upDir = path.join(ROOT, 'data', 'uploads', 'login-bg');
      try { fs.unlinkSync(path.join(upDir, path.basename(cur))); } catch (e) {}
    }
    DB.settings.loginBg = DEFAULT_LOGIN_BG;
    DB.settings.loginBgMode = 'cover';
    DB.settings.loginBgRotate = 0;
    DB.settings.loginBgMeta = null;
    saveDB();
    res.json({ ok: true, loginBg: DB.settings.loginBg, loginBgMode: DB.settings.loginBgMode, loginBgRotate: 0 });
  } catch (e) { res.status(500).json({ error: '删除失败：' + e.message }); }
});

// 简单集合（直接 CRUD，须在本文件导入导出端点之后注册）
['workers', 'contacts'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
['annualPlans', 'substations', 'materialCatalog', 'teams', 'units'].forEach(c => {
  crud(c, c, { biz: false, soft: false });
});
}


// 首页直出：把当前登录页背景注入 CSS 变量 --login-bg，避免前端异步取配置造成的「闪跳先默认图」
// 同时注入 LQIP 占位图（超小模糊图）与平均色底，避免图片字节未下载完时出现「黑一下」
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
let INDEX_TPL = null;
let INDEX_MTIME = 0;
// 预设背景的 LQIP + 平均色（构建期生成，见 public/login-bg/meta.json）
let PRESET_BG_META = {};
try {
  PRESET_BG_META = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'login-bg', 'meta.json'), 'utf8'));
} catch (e) { PRESET_BG_META = {}; }
const LOGIN_BG_MODE_CSS = {
  cover: 'background-size:cover;background-repeat:no-repeat;background-position:center center;',
  contain: 'background-size:contain;background-repeat:no-repeat;background-position:center center;',
  stretch: 'background-size:100% 100%;background-repeat:no-repeat;background-position:center center;',
  tile: 'background-size:auto;background-repeat:repeat;background-position:top left;',
  center: 'background-size:auto;background-repeat:no-repeat;background-position:center center;'
};
function getLoginBgMeta(url) {
  const meta = DB.settings && DB.settings.loginBgMeta;
  if (meta && meta.url === url) return meta;
  const base = path.basename(String(url || ''));
  return PRESET_BG_META[base] || null;
}
function renderIndexHtml() {
  // 模板缓存：文件被改动（mtime 变化）时自动重新读取，避免改样式后必须重启进程
  try {
    const mtime = fs.statSync(INDEX_PATH).mtimeMs;
    if (INDEX_TPL === null || mtime !== INDEX_MTIME) { INDEX_TPL = fs.readFileSync(INDEX_PATH, 'utf8'); INDEX_MTIME = mtime; }
  } catch (e) {
    if (INDEX_TPL === null) INDEX_TPL = fs.readFileSync(INDEX_PATH, 'utf8');
  }
  const raw = String((DB.settings && DB.settings.loginBg) || DEFAULT_LOGIN_BG);
  // 仅允许站内相对路径或 http(s) 地址，剥离引号/尖括号，防注入
  const safe = raw.replace(/[\\"'<>]/g, '').replace(/\s+/g, '');
  const mode = (DB.settings && LOGIN_BG_MODE_CSS[DB.settings.loginBgMode]) ? DB.settings.loginBgMode : 'cover';
  const meta = getLoginBgMeta(safe) || {};
  const avg = /^#[0-9a-fA-F]{3,8}$/.test(String(meta.avg || '')) ? meta.avg : '#e9edf2';
  const lqip = /^data:image\//.test(String(meta.lqip || '')) ? meta.lqip : '';
  // 旋转：90/270 需交换宽高并用 translate 居中，保证旋转后仍铺满视口
  const rotate = [0, 90, 180, 270].includes(Number(DB.settings && DB.settings.loginBgRotate)) ? Number(DB.settings.loginBgRotate) : 0;
  let rotateCss = '';
  if (rotate === 90 || rotate === 270) {
    rotateCss = `.login-bg-rotate{width:100vh;width:100dvh;height:100vw;height:100dvw;inset:auto;top:50%;left:50%;transform:translate(-50%,-50%) rotate(${rotate}deg);}`;
  } else if (rotate === 180) {
    rotateCss = `.login-bg-rotate{transform:rotate(180deg);}`;
  }
  // preload 让浏览器以高优先级先取图；LQIP 与平均色保证首帧不是黑屏
  const head = [
    `<link rel="preload" as="image" href="${safe}" fetchpriority="high">`,
    `<style>:root{--login-bg:url('${safe}');--login-bg-color:${avg};${lqip ? `--login-bg-lqip:url('${lqip}');` : ''}}`,
    `.login-bg-layer{${LOGIN_BG_MODE_CSS[mode] || LOGIN_BG_MODE_CSS.cover}}`,
    `${rotateCss}</style>`
  ].join('');
  return INDEX_TPL.includes('<!--LOGIN_BG-->')
    ? INDEX_TPL.replace('<!--LOGIN_BG-->', head)
    : INDEX_TPL.replace('</head>', head + '</head>');
}

function registerPage() {
app.get(['/', '/index.html'], (req, res) => {
  try { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(renderIndexHtml()); }
  catch (e) { res.status(500).type('html').send('index render error'); }
});

}

module.exports = { registerPublic, registerAuthed, registerPage };
