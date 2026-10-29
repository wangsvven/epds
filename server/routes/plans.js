/* ========== routes/plans ========== */
/* 计划管理：作业计划（导入 / 导出 / 班组长当日计划工作量 / 施工资料图纸）与 plans、borrowWorks、workPlans 集合 CRUD。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const xlsx = require('xlsx');
const ExcelJS = require('exceljs');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO } = require('../core/util');
const { resolveDocPath, resolveSurveyTemplate } = require('../core/doc-templates');
const { buildSurveyDocx } = require('../core/survey-doc');

const PLAN_QTY_FIELDS = ['wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04'];

// ---------- 作业计划（计划管理：周计划/月计划/已归档/已执行/已结算/已取消） ----------
const PLAN_TYPES = ['周计划', '月计划'];
const PLAN_STATUS = ['未执行', '已执行', '已归档', '已取消', '已结算'];
const TICKET_TYPES = ['第一种工作票', '第二种工作票', '电力线路第二种工作票', '电力电缆第二种工作票', '带电作业工作票', '动火工作票'];
const VOLTAGE_LEVELS = ['0.4kV', '10kV', '20kV', '35kV', '110kV', '220kV'];
function planItem(b) {
  const base = {
    id: b.id || genId('wp'),
    name: String(b.name || '').trim(),
    content: String(b.content || '').trim(),
    planType: PLAN_TYPES.includes(b.planType) ? b.planType : '周计划',
    project: String(b.project || '').trim(),
    team: String(b.team || '').trim(),
    leader: String(b.leader || '').trim(),
    startDate: String(b.startDate || '').trim(),
    endDate: String(b.endDate || '').trim(),
    ticketType: TICKET_TYPES.includes(b.ticketType) ? b.ticketType : (String(b.ticketType || '').trim() || '配电：配电第二种工作票'),
    voltage: VOLTAGE_LEVELS.includes(b.voltage) ? b.voltage : (String(b.voltage || '').trim() || '10kV'),
    station: String(b.station || '').trim(),
    chargePerson: String(b.chargePerson || '').trim(),
    status: PLAN_STATUS.includes(b.status) ? b.status : '未执行',
    createdAt: b.createdAt || nowISO()
  };
  // 保留新增周计划大表单的扩展字段（子项目/作业类型/专业/地址/风险因素/作业单位/班组/材料等）
  const extras = {};
  ['subProject', 'workType', 'specialty', 'dept', 'address', 'shadowContent', 'machine', 'riskLevel', 'gridRisk', 'riskFactors', 'majorRisk', 'controlMeasures', 'workUnit', 'chargePersons', 'staff', 'finishDate', 'planNote', 'teams', 'materials', 'buildCity', 'buildCounty', 'execCity', 'execCounty', 'substation', 'subcontractors', 'supervisor', 'ccUnits', 'staffText', 'teamLeader', 'staffCount', 'highStaff', 'gasTester', 'guardian', 'chargePerson', 'chargePersonPhone', 'arrivalPersons', 'safetyPatrol', 'wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04', 'outageRange', 'outageHours', 'surveyNo', 'workTicketNo'].forEach(k => {
    if (b[k] !== undefined) extras[k] = b[k];
  });
  return { ...extras, ...base };
}
app.post('/api/workPlans/import', upload.single('file'), (req, res) => {
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
    const errors = [];
    const parsed = [];
    // 按表头名称取列（不再写死列号）：原周报格式有两套——导出 48 列、内置导入模板 54 列（模板在「作业班组」后多一列「班组长」），
    // 从第 33 列起整体错开一位，只有按名称取才不会错位。子表头（当日计划工作量 / 备注）的列名在图片行 2，覆盖行 1。
    // 老格式（A=作业计划名称 B=计划类型 …）不认这两行表头，走后面的老分支。
    const HEAD = {};
    [rows[0] || [], rows[1] || []].forEach(line => line.forEach((v, i) => {
      const t = String(v == null ? '' : v).trim();
      if (t) HEAD[t] = i;
    }));
    const NEW_LAYOUT = HEAD['作业计划名称'] !== undefined && HEAD['计划开始时间'] !== undefined;
    const cellText = (r, i) => String(r[i] == null ? '' : r[i]).trim();
    const cellList = (r, i) => (cellText(r, i) ? cellText(r, i).split(/[；;]/).map(s => s.trim()).filter(Boolean) : []);
    const col = (r, name) => (HEAD[name] === undefined ? '' : cellText(r, HEAD[name]));
    const colList = (r, name) => (HEAD[name] === undefined ? [] : cellList(r, HEAD[name]));
    const DT_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;
    // 新格式没有「计划类型」列：按导入入口页签决定（周计划管理 / 月计划管理），默认周计划
    const wantType = String((req.query && req.query.planType) || '');
    rows.forEach((r, i) => {
      if (i === 0) return; // 表头
      const rowNo = i + 1;
      if (NEW_LAYOUT) {
        const pName = col(r, '作业计划名称');
        const start = col(r, '计划开始时间');
        const end = col(r, '计划结束时间');
        if (!pName && !start && !end) return; // 空行 / 第 2 行分组子表头
        if (!pName) { errors.push('第' + rowNo + '行：作业计划名称不能为空'); return; }
        if (!DT_RE.test(start)) { errors.push('第' + rowNo + '行：计划开始时间「' + (start || '空') + '」格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss'); return; }
        if (!DT_RE.test(end)) { errors.push('第' + rowNo + '行：计划结束时间「' + (end || '空') + '」格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss'); return; }
        if (end < start) { errors.push('第' + rowNo + '行：计划结束时间早于开始时间'); return; }
        parsed.push(planItem({
          name: pName,
          planType: PLAN_TYPES.includes(wantType) ? wantType : '周计划',
          workType: col(r, '作业类型'), specialty: col(r, '作业专业'), dept: col(r, '省专业管理部门'),
          startDate: start, endDate: end,
          voltage: col(r, '电压等级'), station: col(r, '变电站/线路'), address: col(r, '作业地址'),
          content: col(r, '作业内容'), ticketType: col(r, '工作票类型'),
          riskLevel: col(r, '作业风险等级'), gridRisk: col(r, '电网风险等级'), riskFactors: colList(r, '风险因素'),
          buildCity: col(r, '作业建管单位（市）'), buildCounty: col(r, '作业建管单位（县）'),
          execCity: col(r, '作业实施（施工）单位（市）'), execCounty: col(r, '作业实施（施工）单位（县）'),
          team: col(r, '作业班组'), subcontractors: colList(r, '分包单位'), supervisor: col(r, '监理单位'),
          ccUnits: colList(r, '抄送单位'),
          chargePerson: col(r, '工作负责人'), chargePersonPhone: col(r, '工作负责人联系方式'),
          staffText: col(r, '作业实施（施工）人员（不包含工作负责人）'),
          majorRisk: col(r, '重特大人身事故风险'), controlMeasures: col(r, '风险管控措施'),
          staffCount: col(r, '作业人员（共多少人）'), highStaff: col(r, '其中高处作业人员'),
          guardian: col(r, '专责监护人'), arrivalPersons: col(r, '到岗到位人员'), safetyPatrol: col(r, '安全巡查人员'),
          leader: col(r, '班组长'), teamLeader: col(r, '班组长'),   // 模板有此列，导出没有
          gasTester: col(r, '气体检测人员'), machine: col(r, '是否涉及机械施工'),
          wlPole: col(r, '杆塔（基）'), wlLine1035: col(r, '10kV/35kV线路（km/单线）'), wlCable: col(r, '电缆（千米）'),
          wlRing: col(r, '环网柜（个）'), wlVacuum: col(r, '真空开关（个）'), wlTransformer: col(r, '变压器（个）'),
          wlLine04: col(r, '0.4/0.22kV线路（km/单线）'),
          outageRange: col(r, '停电范围'), outageHours: col(r, '时户数')
        }));
        return;
      }
      const pName = cellText(r, 0);
      const pType = cellText(r, 1);
      const start = cellText(r, 5);
      const end = cellText(r, 6);
      if (!pName && !pType && !start && !end) return; // 空行
      if (!pName) { errors.push('第' + rowNo + '行：作业计划名称不能为空'); return; }
      if (!PLAN_TYPES.includes(pType)) { errors.push('第' + rowNo + '行：计划类型「' + (pType || '空') + '」无效（仅支持：周计划 / 月计划）'); return; }
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) { errors.push('第' + rowNo + '行：计划开始日期「' + (start || '空') + '」格式应为 YYYY-MM-DD'); return; }
      if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) { errors.push('第' + rowNo + '行：计划结束日期「' + (end || '空') + '」格式应为 YYYY-MM-DD'); return; }
      if (end < start) { errors.push('第' + rowNo + '行：计划结束日期早于开始日期'); return; }
      parsed.push(planItem({
        name: pName, planType: pType, project: r[2], team: r[3], leader: r[4],
        startDate: start, endDate: end, ticketType: r[7], voltage: r[8], station: r[9], chargePerson: r[10]
      }));
    });
    if (errors.length) {
      return res.status(400).json({ error: '导入失败，共 ' + errors.length + ' 处问题：' + errors.slice(0, 5).join('；') + (errors.length > 5 ? '（仅显示前 5 处）' : '') });
    }
    if (!parsed.length) return res.status(400).json({ error: '模板中没有可导入的数据行' });
    parsed.forEach(p => DB.workPlans.unshift(p));
    saveDB();
    res.json({ ok: true, added: parsed.length });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});
// ---------- 导出：对齐原周报「周计划」文件（48 列 / 两行表头 / 三处分组表头） ----------
const PLAN_XLSX_ROW1 = [
  '序号', '作业计划名称', '作业类型', '作业专业', '省专业管理部门', '计划开始时间', '计划结束时间', '电压等级',
  '变电站/线路', '作业地址', '作业内容', '工作票类型', '作业风险等级', '电网风险等级', '风险因素',
  '作业建管单位（市）', '作业建管单位（县）', '作业实施（施工）单位（市）', '作业实施（施工）单位（县）',
  '作业班组', '分包单位', '监理单位', '抄送单位', '工作负责人', '工作负责人联系方式',
  '作业实施（施工）人员（不包含工作负责人）', '重特大人身事故风险', '风险管控措施', '作业人员（共多少人）',
  '其中高处作业人员', '专责监护人', '到岗到位人员', '安全巡查人员', '作业资料审核负责人',
  '高处作业、培训交底负责人', '队伍、人员准入检查负责人', '施工机具和安全工器具检查负责人',
  '气体检测人员', '是否涉及机械施工', '当日计划工作量', '', '', '', '', '', '', '备注', ''
];
const PLAN_XLSX_ROW2 = [
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  '杆塔（基）', '10kV/35kV线路（km/单线）', '电缆（千米）', '环网柜（个）', '真空开关（个）', '变压器（个）',
  '0.4/0.22kV线路（km/单线）', '停电范围', '时户数'
];
const PLAN_XLSX_COLS = [
  8.83, 22.83, 12.83, 10.83, 16.83, 21.83, 21.83, 10.83, 18.83, 40.83, 27.83, 24.83, 14.83, 14.83, 40.83,
  20.83, 20.83, 28.83, 28.83, 12.83, 19.83, 10.83, 10.83, 12.83, 20.83, 40.83, 20.83, 40.83, 22.83, 24.83,
  12.83, 14.83, 14.83, 20.83, 26.83, 26.83, 32.83, 14.83, 18.83, 16.83, 26.83, 14.83, 14.83, 16.83, 14.83,
  27.83, 21.83, 8.83
];
function planXlsxText(v) { return v == null ? '' : String(v); }
// 数组字段（风险因素 / 分包单位 / 抄送单位）按「；」连接；字符串原样
function planXlsxJoin(v) { return Array.isArray(v) ? v.filter(x => x !== null && x !== undefined && x !== '').map(String).join('；') : planXlsxText(v); }
// 数量列：纯数字串输出为数字（与目标文件一致），其余原样；空值写空字符串
function planXlsxNum(v) {
  const s = planXlsxText(v).trim();
  if (!s) return '';
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : planXlsxText(v);
}
// 施工人员：有结构化名单（staff 数组带 name）按「姓名/电话；…」拼，否则用 staffText 原文
function planXlsxStaff(p) {
  if (Array.isArray(p.staff) && p.staff.length && p.staff.some(w => w && typeof w === 'object' && w.name)) {
    return p.staff.filter(w => w && w.name).map(w => w.name + (w.phone ? '/' + w.phone : '')).join('；');
  }
  return planXlsxText(p.staffText);
}
function planXlsxRow(p, i) {
  const charge = planXlsxText(p.chargePerson);
  return [
    i + 1, planXlsxText(p.name), planXlsxText(p.workType), planXlsxText(p.specialty), planXlsxText(p.dept),
    planXlsxText(p.startDate), planXlsxText(p.endDate), planXlsxText(p.voltage), planXlsxText(p.station),
    planXlsxText(p.address), planXlsxText(p.content), planXlsxText(p.ticketType), planXlsxText(p.riskLevel),
    planXlsxText(p.gridRisk), planXlsxJoin(p.riskFactors), planXlsxText(p.buildCity), planXlsxText(p.buildCounty),
    planXlsxText(p.execCity), planXlsxText(p.execCounty), planXlsxText(p.team), planXlsxJoin(p.subcontractors),
    planXlsxText(p.supervisor), planXlsxJoin(p.ccUnits), charge, planXlsxText(p.chargePersonPhone),
    planXlsxStaff(p), planXlsxText(p.majorRisk), planXlsxText(p.controlMeasures), planXlsxNum(p.staffCount),
    planXlsxText(p.highStaff), planXlsxText(p.guardian), planXlsxText(p.arrivalPersons), planXlsxText(p.safetyPatrol),
    // 四个「负责人」：库里无单独字段（chargePersons 恒空），按原表样本取工作负责人
    charge, charge, charge, charge,
    planXlsxText(p.gasTester), planXlsxText(p.machine),
    planXlsxNum(p.wlPole), planXlsxNum(p.wlLine1035), planXlsxNum(p.wlCable), planXlsxNum(p.wlRing),
    planXlsxNum(p.wlVacuum), planXlsxNum(p.wlTransformer), planXlsxNum(p.wlLine04),
    planXlsxText(p.outageRange), planXlsxNum(p.outageHours)
  ];
}
// 导出表下拉：与原「周计划」文件逐字对齐（7 处、内联选项、从第 3 行覆盖到末行）
// 列位：C 作业类型 / D 作业专业 / E 省专业管理部门 / H 电压等级 / L 工作票类型 /
//       M 作业风险等级 / N 电网风险等级。原表没有下拉的列一律不加。
const PLAN_XLSX_DROPS = [
  { col: 3, list: ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'] },
  { col: 4, list: ['运检', '营销'] },
  { col: 5, list: ['设备部', '产业部'] },
  { col: 8, list: ['35kV', '10kV', '0.4kV'] },
  { col: 12, list: ['配电：配电第一种工作票', '配电：配电第二种工作票', '配电：低压工作票', '线路：线路第一种工作票', '线路：线路第二种工作票'] },
  { col: 13, list: ['三级', '四级', '五级'] },
  { col: 14, list: ['无', '一级', '二级', '三级', '四级', '五级'] }
];
// 导出范围：与前端「计划管理」列表所见一致（页签 + 筛选条 + createdAt 倒序），
// 口径逐条对应 public/js/views/plans.js 的 tabList / filtered / load()
const PLAN_XLSX_SCOPES = {
  week: p => p.planType === '周计划' && !['已归档', '已取消', '已执行', '已结算'].includes(p.status),
  month: p => p.planType === '月计划' && !['已归档', '已取消', '已执行', '已结算'].includes(p.status),
  archived: p => p.planType === '月计划' && p.status === '已归档',
  executed: p => p.status === '已执行',
  settled: p => p.status === '已结算',
  canceled: p => p.planType === '周计划' && p.status === '已取消'
};
function planXlsxPick(q) {
  const scopeFn = PLAN_XLSX_SCOPES[String(q.scope || '')];
  const type = String(q.type || '');
  const txt = k => String(q[k] == null ? '' : q[k]);
  const startDate = txt('startDate'), endDate = txt('endDate');
  const name = txt('name'), content = txt('content'), team = txt('team');
  const leader = txt('leader'), ticketType = txt('ticketType');
  const noProject = txt('noProject') === '1';
  const scopeNames = txt('projectScope').split(',').filter(Boolean);
  return DB.workPlans.filter(p => {
    if (p.deleted) return false;                                   // 列表不含已删除，导出一致
    if (scopeFn && !scopeFn(p)) return false;
    if (!scopeFn && type && p.planType !== type) return false;      // 兼容旧口径 ?type=
    if (scopeNames.length && !scopeNames.includes(p.project)) return false;
    if (startDate && p.startDate < startDate) return false;
    if (endDate && p.endDate > endDate) return false;
    if (name && !String(p.name || '').includes(name)) return false;
    if (content && !String(p.content || '').includes(content)) return false;
    if (noProject && p.project) return false;
    if (team && p.team !== team) return false;
    if (leader && p.leader !== leader) return false;
    if (ticketType && p.ticketType !== ticketType) return false;
    return true;
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
app.get('/api/workPlans/export', async (req, res) => {
  try {
    const list = planXlsxPick(req.query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.columns = PLAN_XLSX_COLS.map(w => ({ width: w }));
    ws.addRow(PLAN_XLSX_ROW1);
    ws.addRow(PLAN_XLSX_ROW2);
    list.forEach((p, i) => ws.addRow(planXlsxRow(p, i)));
    // 41 个合并：A1:AM2 逐列纵向合并（39 个）+ AN1:AT1 + AU1:AV1
    for (let c = 1; c <= 39; c++) ws.mergeCells(1, c, 2, c);
    ws.mergeCells(1, 40, 1, 46);
    ws.mergeCells(1, 47, 1, 48);
    // 与原表一致：全表细边框 + 自动换行 + 垂直居中，数据行行高 100
    const lastRow = 2 + list.length;
    for (let r = 1; r <= lastRow; r++) {
      const row = ws.getRow(r);
      if (r > 2) row.height = 100;
      for (let c = 1; c <= 48; c++) {
        const cell = row.getCell(c);
        cell.font = { name: '宋体', size: 12 };
        cell.alignment = { wrapText: true, vertical: 'middle' };
        cell.border = {
          top: { style: 'thin' }, left: { style: 'thin' },
          bottom: { style: 'thin' }, right: { style: 'thin' }
        };
      }
      row.commit();
    }
    // 下拉：与原表一致，内联选项 + 从第 3 行覆盖到末行（新增行也有下拉）
    PLAN_XLSX_DROPS.forEach(d => {
      const colL = ws.getColumn(d.col).letter;
      ws.dataValidations.add(colL + '3:' + colL + '1048576', {
        type: 'list',
        allowBlank: true,
        showInputMessage: true,
        showErrorMessage: true,
        formulae: ['"' + d.list.join(',') + '"']
      });
    });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename="workPlans_export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: '导出失败：' + e.message }); }
});

// 周计划导入模板下载：assets/plan-import-template.xlsx 随代码分发（用户提供的原件）
app.get('/api/workPlans/import-template', (req, res) => {
  const f = path.join(ROOT, 'assets', 'plan-import-template.xlsx');
  if (!fs.existsSync(f)) return res.status(404).json({ error: '导入模板尚未内置：缺少 assets/plan-import-template.xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="plan-import-template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(fs.readFileSync(f));
});

// 班组长专用：仅填写「当日计划工作量」7 项（工程实际施工量）
app.put('/api/workPlans/:id/quantities', (req, res) => {
  const p = (DB.workPlans || []).find(x => x.id === req.params.id && !x.deleted);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const b = req.body || {};
  PLAN_QTY_FIELDS.forEach(k => { if (b[k] !== undefined) p[k] = String(b[k] == null ? '' : b[k]).trim(); });
  p.quantitiesUpdatedAt = nowISO();
  p.quantitiesUpdatedBy = req.user.name || req.user.username;
  saveDB();
  res.json(p);
});

// ---------- 施工资料 · 图纸（挂在计划记录上；老记录无 drawings 字段一律按空数组处理） ----------
// 命名与磁盘落盘方式沿用 routes/projects.js 的同款做法（uploads/plans/<计划id>/<时间戳>_<安全文件名>）
function planDrawings(p) {
  if (!Array.isArray(p.drawings)) p.drawings = [];
  return p.drawings;
}
function findPlan(id) {
  const p = (DB.workPlans || []).find(x => x.id === id);
  if (!p || p.deleted) return null;
  return p;
}
function planFileSafeName(name) {
  return String(name).replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_').slice(-120);
}
app.post('/api/workPlans/:id/drawings', upload.single('file'), (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const dir = path.join(ROOT, 'data', 'uploads', 'plans', p.id);
  fs.mkdirSync(dir, { recursive: true });
  const diskName = Date.now() + '_' + planFileSafeName(req.file.originalname);
  fs.writeFileSync(path.join(dir, diskName), req.file.buffer);
  const item = {
    id: genId('dw'),
    category: '图纸',
    name: req.file.originalname,
    size: req.file.size,
    path: 'uploads/plans/' + p.id + '/' + diskName,
    uploadedAt: nowISO()
  };
  planDrawings(p).push(item);
  saveDB();
  res.json(item);
});
// 下载：与 /api/projects/:id/files/:fid/download 同一套（uploads 不做静态托管，只能走接口）
// ?inline=1 时对 PDF/图片给可预览的 Content-Type，供前端「打开」用
const DRAWING_INLINE_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8'
};
app.get('/api/workPlans/:id/drawings/:fileId/download', (req, res) => {
  const p = findPlan(req.params.id);
  // 下载是只读接口：不初始化 drawings（避免 GET 顺手改记录）
  const f = p && (Array.isArray(p.drawings) ? p.drawings : []).find(x => x.id === req.params.fileId);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  const ext = String(f.name || '').split('.').pop().toLowerCase();
  const inline = req.query.inline === '1' && DRAWING_INLINE_MIME[ext];
  res.setHeader('Content-Type', inline || 'application/octet-stream');
  res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
app.delete('/api/workPlans/:id/drawings/:fileId', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const list = planDrawings(p);
  const idx = list.findIndex(x => x.id === req.params.fileId);
  if (idx < 0) return res.status(404).json({ error: '未找到图纸' });
  const [f] = list.splice(idx, 1);
  // 只删本模块目录下的文件；unlink 失败静默（记录已移除，不留脏数据）
  if (f && typeof f.path === 'string' && f.path.startsWith('uploads/plans/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', f.path)); } catch (e) {}
  }
  saveDB();
  res.json({ ok: true });
});

// ---------- 施工资料 · 资料压缩包（单包替换语义；老记录无该字段按 null 处理） ----------
// 与图纸共用落盘目录 uploads/plans/<计划id>/ 与「时间戳_安全化原名」命名
const PACKAGE_EXTS = ['.zip', '.7z', '.rar'];
const PACKAGE_MAX = 1024 * 1024; // 共享 multer 上限是 20MB，本接口自己卡 1MB
function planPackage(p) {
  const v = p && p.materialPackage;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}
function pkgExt(name) {
  const n = String(name || '');
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i).toLowerCase();
}
// 上传即替换：校验 → 写新文件 → 换记录并落盘 → 最后才删旧文件；任何一步失败旧包原样可用
app.post('/api/workPlans/:id/package', upload.single('file'), (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const name = req.file.originalname || '';
  if (!PACKAGE_EXTS.includes(pkgExt(name))) {
    return res.status(400).json({ error: '仅支持 ZIP、7z、RAR 格式的压缩包' });
  }
  if (req.file.size > PACKAGE_MAX) {
    return res.status(400).json({ error: '压缩包大小不能超过 1MB' });
  }
  // 校验全部通过后才允许动磁盘与记录
  const prev = planPackage(p);
  const oldPkg = prev ? { ...prev } : null;
  const dir = path.join(ROOT, 'data', 'uploads', 'plans', p.id);
  const diskName = Date.now() + '_' + planFileSafeName(name);
  const abs = path.join(dir, diskName);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(abs, req.file.buffer);
  } catch (e) {
    return res.status(500).json({ error: '保存压缩包失败：' + e.message });
  }
  const item = {
    id: genId('pk'),
    category: '资料压缩包',
    name,
    size: req.file.size,
    path: 'uploads/plans/' + p.id + '/' + diskName,
    uploadedAt: nowISO()
  };
  try {
    p.materialPackage = item;
    saveDB();
  } catch (e) {
    // 记录没落盘：恢复旧记录并清掉刚写的新文件，旧包保持可用
    if (oldPkg) p.materialPackage = oldPkg; else delete p.materialPackage;
    try { fs.unlinkSync(abs); } catch (e2) {}
    return res.status(500).json({ error: '保存压缩包记录失败：' + e.message });
  }
  // 新记录已落盘，才删旧文件（只删本模块目录下的，失败静默）
  if (oldPkg && typeof oldPkg.path === 'string' && oldPkg.path !== item.path && oldPkg.path.startsWith('uploads/plans/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', oldPkg.path)); } catch (e) {}
  }
  res.json(item);
});
// 下载：附件形式（压缩包不做 inline 预览）
app.get('/api/workPlans/:id/package/download', (req, res) => {
  const p = findPlan(req.params.id);
  // 只读接口：不初始化、不改记录
  const f = planPackage(p);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
app.delete('/api/workPlans/:id/package', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const f = planPackage(p);
  if (!f) return res.status(404).json({ error: '暂无资料压缩包' });
  p.materialPackage = null;
  saveDB();
  // 记录已置空，再删磁盘文件（仅本模块目录，失败静默）
  if (typeof f.path === 'string' && f.path.startsWith('uploads/plans/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', f.path)); } catch (e) {}
  }
  res.json({ ok: true });
});

// ---------- 施工资料 · 现场勘察记录（挂在计划记录上；老记录无 survey 字段按 null 处理） ----------
// 可编辑文本字段：作业分组 + 勘察单位 + 部门(班组) + 编号 + 双重名称 + 工作地点/内容 + 4.1 + 4.2 + 4.3 环境描述
const SURVEY_TEXT_FIELDS = [
  'surveyUnit', 'team', 'surveyNo', 'dualName',
  'workLocation', 'workTask', 'outageScope', 'retainedLive', 'envDesc'
];
// 4.4 / 接地线等：请求未带该键时沿用旧值，不预建空字段
// commonMeasures / recorder 不做编辑字段（生成时组装 / 取当前登录用户），但仍保留旧值不丢
const SURVEY_LOWER_FIELDS = [
  'opsMeasures', 'teamMeasures', 'commonMeasures', 'ground10', 'ground04', 'recorder'
];
// 4.3 危险点条目：归属只有四种取值，非法回落「全组」；条数上限 50
const SURVEY_HP_SCOPES = ['全组', '1小组', '2小组', '3小组'];
const SURVEY_HP_MAX = 50;
const SURVEY_GROUPINGS = ['不分小组', '分2个小组', '分3个小组'];
// 4.4 班组措施 / 10kV、0.4kV 接地线：逐行归属数组（与文本非空行按序对齐），长度上限 200
const SURVEY_SCOPE_LISTS = ['teamMeasureScopes', 'ground10Scopes', 'ground04Scopes'];
const SURVEY_SCOPE_MAX = 200;
// 勘察日期必须是真实存在的 YYYY-MM-DD
function isYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
// 归属数组清洗：非数组按空数组；超 200 截断；每项只认四种枚举，非法回落「全组」
function cleanScopeList(raw) {
  const arr = Array.isArray(raw) ? raw.slice(0, SURVEY_SCOPE_MAX) : [];
  return arr.map(v => {
    const s = String(v == null ? '' : v).trim();
    return SURVEY_HP_SCOPES.indexOf(s) > -1 ? s : '全组';
  });
}
function planSurvey(p) {
  const v = p && p.survey;
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}
// 小组清洗：最多 3 条；leader/workLocation/workTask 字符串，members 字符串数组
function cleanSurveyGroups(raw) {
  const arr = Array.isArray(raw) ? raw.slice(0, 3) : [];
  return arr.map(g => {
    const o = g || {};
    return {
      leader: String(o.leader == null ? '' : o.leader).trim(),
      members: Array.isArray(o.members) ? o.members.map(m => String(m == null ? '' : m).trim()).filter(Boolean) : [],
      workLocation: String(o.workLocation == null ? '' : o.workLocation).trim(),
      workTask: String(o.workTask == null ? '' : o.workTask).trim()
    };
  });
}
app.put('/api/workPlans/:id/survey', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const b = req.body || {};
  const prev = planSurvey(p) || {};
  const survey = {};
  // 本批文本字段：白名单收，去空白
  SURVEY_TEXT_FIELDS.forEach(k => { survey[k] = String(b[k] == null ? '' : b[k]).trim(); });
  // 4.3 及以后：只有请求显式带了才更新，否则沿用旧值（旧记录没有该键就不建）
  SURVEY_LOWER_FIELDS.forEach(k => {
    if (b[k] !== undefined) survey[k] = String(b[k] == null ? '' : b[k]).trim();
    else if (prev[k] !== undefined) survey[k] = String(prev[k] == null ? '' : prev[k]);
  });
  // 勘察日期：YYYY-MM-DD，非法 → 400；显式传空串 = 清空
  if (b.surveyDate !== undefined) {
    const sd = String(b.surveyDate == null ? '' : b.surveyDate).trim();
    if (sd && !isYmd(sd)) return res.status(400).json({ error: '勘察日期格式应为 YYYY-MM-DD，实际：' + sd });
    survey.surveyDate = sd;
  } else if (prev.surveyDate !== undefined) {
    survey.surveyDate = String(prev.surveyDate == null ? '' : prev.surveyDate);
  }
  // 逐行归属数组：显式传才更新，未传沿用旧值
  SURVEY_SCOPE_LISTS.forEach(k => {
    if (b[k] !== undefined) survey[k] = cleanScopeList(b[k]);
    else if (prev[k] !== undefined) survey[k] = cleanScopeList(prev[k]);
  });
  // 作业分组：只接受三个枚举值，非法回落「不分小组」
  const g = String(b.grouping == null ? '' : b.grouping).trim();
  survey.grouping = SURVEY_GROUPINGS.indexOf(g) > -1 ? g : '不分小组';
  survey.groups = cleanSurveyGroups(b.groups);
  // 危险点条目组（4.3）：带了才清洗校验，没带就原样保留
  if (b.hazardPoints !== undefined) {
    const raw = Array.isArray(b.hazardPoints) ? b.hazardPoints.slice(0, SURVEY_HP_MAX) : [];
    const points = [];
    for (let i = 0; i < raw.length; i++) {
      const h = raw[i] || {};
      const title = String(h.title == null ? '' : h.title).trim();
      const measure = String(h.measure == null ? '' : h.measure).trim();
      if (!title) return res.status(400).json({ error: '第 ' + (i + 1) + ' 条危险点缺少标题' });
      if (!measure) return res.status(400).json({ error: '第 ' + (i + 1) + ' 条危险点「' + title + '」缺少对应安全措施' });
      const sc = String(h.scope == null ? '' : h.scope).trim();
      points.push({
        id: h.id ? String(h.id) : genId('hz'),
        hazardId: h.hazardId ? String(h.hazardId) : '',
        title,
        situation: String(h.situation == null ? '' : h.situation).trim(),
        measure,
        scope: SURVEY_HP_SCOPES.indexOf(sc) > -1 ? sc : '全组'
      });
    }
    survey.hazardPoints = points;
  } else if (prev.hazardPoints !== undefined) {
    survey.hazardPoints = prev.hazardPoints;
  }
  // 首次创建保留原 createdAt；更新只刷新 updatedAt
  survey.createdAt = prev.createdAt || nowISO();
  survey.updatedAt = nowISO();
  p.survey = survey;
  saveDB();
  res.json(p.survey);
});

// ---------- 施工资料 · 生成资料（现场勘察记录 docx；老记录无 generatedFiles 按空数组） ----------
const GEN_CATEGORY = '现场勘察记录';
const GEN_FILE_NAME = '现场勘察记录.docx';
function planGenerated(p) {
  if (!Array.isArray(p.generatedFiles)) p.generatedFiles = [];
  return p.generatedFiles;
}
// 生成：无请求体，记录人取当前登录会话；已有同类别生成记录时原地覆盖（同一 id、同一路径），不再新增条目
app.post('/api/workPlans/:id/survey/generate', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const survey = planSurvey(p);
  if (!survey) return res.status(400).json({ error: '请先完成现场勘察记录并保存' });
  // 模板定位：documents.surveyTemplate（未关联时按文档中心已上传文件自动识别），解析基准同 resolveDocPath
  const tpl = resolveSurveyTemplate();
  const abs = tpl && resolveDocPath(tpl.path);
  if (!tpl || !abs || !fs.existsSync(abs)) {
    return res.status(400).json({ error: '未关联现场勘察记录模板，请先在文档中心上传' });
  }
  let buf;
  try {
    // 记录人默认取计划里的班组长（表单字段 teamLeader，列表展示字段 leader 同源）；没填班组长才回落当前登录用户
    const recorder = String(p.teamLeader || '').trim() || String(p.leader || '').trim()
      || req.user.name || req.user.username || '';
    buf = buildSurveyDocx(fs.readFileSync(abs), p, survey, recorder).buffer;
  } catch (e) {
    if (e && e.code === 'TPL_SLOTS') {
      return res.status(400).json({ error: e.message + '，请在文档中心上传含 ' + 17 + ' 处 XXXX 的空白现场勘察记录模板' });
    }
    return res.status(400).json({ error: '生成失败：' + e.message });
  }
  const list = planGenerated(p);
  // 已有「现场勘察记录」生成文件 → 原地覆盖（改过内容再点生成，只更新这一份，不产生新单据）
  const prev = list.find(x => x && x.category === GEN_CATEGORY && typeof x.path === 'string' && x.path.startsWith('uploads/plans/'));
  const rel = prev ? prev.path : ('uploads/plans/' + p.id + '/' + Date.now() + '_' + planFileSafeName(GEN_FILE_NAME));
  const abs2 = path.join(ROOT, 'data', rel);
  let backup = null;                       // 覆盖前的旧内容，写库失败时回滚
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
    item.name = GEN_FILE_NAME;
    item.size = buf.length;
    item.uploadedAt = nowISO();
  } else {
    item = {
      id: genId('gf'),
      category: GEN_CATEGORY,
      name: GEN_FILE_NAME,
      size: buf.length,
      path: rel,
      uploadedAt: nowISO()
    };
    list.push(item);
  }
  try {
    saveDB();
  } catch (e) {
    if (prev && prevSnapshot) {
      prev.name = prevSnapshot.name;
      prev.size = prevSnapshot.size;
      prev.uploadedAt = prevSnapshot.uploadedAt;
      if (backup) { try { fs.writeFileSync(abs2, backup); } catch (e3) {} }
    } else {
      if (!prev) {
        const i = list.indexOf(item);
        if (i > -1) list.splice(i, 1);
      }
      try { fs.unlinkSync(abs2); } catch (e2) {}
    }
    return res.status(500).json({ error: '保存生成记录失败：' + e.message });
  }
  res.json(Object.assign({}, item, { updated: !!prev }));
});
// 下载：与图纸下载同一套（uploads 不做静态托管，只能走接口）
app.get('/api/workPlans/:id/generated/:fileId/download', (req, res) => {
  const p = findPlan(req.params.id);
  // 只读接口：不初始化 generatedFiles（避免 GET 顺手改记录）
  const f = p && (Array.isArray(p.generatedFiles) ? p.generatedFiles : []).find(x => x.id === req.params.fileId);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
app.delete('/api/workPlans/:id/generated/:fileId', (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const list = planGenerated(p);
  const idx = list.findIndex(x => x.id === req.params.fileId);
  if (idx < 0) return res.status(404).json({ error: '未找到生成资料' });
  const [f] = list.splice(idx, 1);
  // 只删本模块目录下的文件；unlink 失败静默（记录已移除，不留脏数据）
  if (f && typeof f.path === 'string' && f.path.startsWith('uploads/plans/')) {
    try { fs.unlinkSync(path.join(ROOT, 'data', f.path)); } catch (e) {}
  }
  saveDB();
  res.json({ ok: true });
});

// 计划相关集合走通用 CRUD（逻辑删除；须晚于上面 /import /export /:id/quantities /:id/drawings /:id/package /:id/survey 注册）
['plans', 'borrowWorks', 'workPlans'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
