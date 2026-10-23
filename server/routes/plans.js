/* ========== routes/plans ========== */
/* 计划管理：作业计划（导入 / 导出 / 班组长当日计划工作量）与 plans、borrowWorks、workPlans 集合 CRUD。 */
const xlsx = require('xlsx');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO } = require('../core/util');

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
    rows.forEach((r, i) => {
      if (i === 0) return; // 表头
      const pName = String(r[0] || '').trim();
      const pType = String(r[1] || '').trim();
      const start = String(r[5] || '').trim();
      const end = String(r[6] || '').trim();
      if (!pName && !pType && !start && !end) return; // 空行
      const rowNo = i + 1;
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
app.get('/api/workPlans/export', (req, res) => {
  const type = String(req.query.type || '');
  const list = DB.workPlans.filter(p => !type || p.planType === type);
  const aoa = [['作业计划名称', '工作内容', '计划类型', '关联项目', '作业班组', '班组长', '计划开始', '计划结束', '工作票类型', '电压等级', '变电站/线路', '工作负责人', '状态']];
  list.forEach(p => aoa.push([p.name, p.content, p.planType, p.project, p.team, p.leader, p.startDate, p.endDate, p.ticketType, p.voltage, p.station, p.chargePerson, p.status]));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), '作业计划');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="workPlans_export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
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

// 计划相关集合走通用 CRUD（逻辑删除；须晚于上面 /import /export /:id/quantities 注册）
['plans', 'borrowWorks', 'workPlans'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
