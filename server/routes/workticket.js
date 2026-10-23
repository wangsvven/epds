/* ========== routes/workticket ========== */
/* 工作票自动化配置：配置状态、资料库（匹配规则 / 技术·安全措施原文 / 医院 / 默认应急医院）与 CT 标准载入。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xlsx = require('xlsx');
const ROOT = path.join(__dirname, '..', '..');

const app = require('../core/app');
const upload = require('../core/upload');
const { DB, saveDB, WT_COLLECTIONS } = require('../core/db');
const { genId, nowISO, fmtStamp, parseCSVBuffer } = require('../core/util');
const { resolveSurveyTemplate } = require('../core/doc-templates');
const { categorize } = require('../core/risk-category');

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
const CT_STANDARD_FILE = path.join(ROOT, 'assets', 'ct-standard.json');
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
  const f = path.join(ROOT, 'assets', 'ct-standard.json');
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
