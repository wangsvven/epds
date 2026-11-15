/* ========== routes/plans ========== */
/* 计划管理（周计划）：导入 / 导出 / 班组长当日计划工作量 / 施工资料图纸 / 勘察单生成，
   以及 plans、workPlans 集合通用 CRUD。
   月计划 xlsx 导出见 routes/monthPlans.js，借工管理见 routes/borrow.js；
   两者的专用路由都必须注册在通用 CRUD（含 GET /api/workPlans/:id）之前，故在 server.js 中先于本文件加载。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const xlsx = require('xlsx');
const ExcelJS = require('exceljs');

const app = require('../core/app');
const upload = require('../core/upload');
const { crud } = require('../core/crud');
const { DB, saveDB } = require('../core/db');
const { genId, nowISO, bjStr, safeFileName, INLINE_MIME } = require('../core/util');
const { resolveDocPath, resolveSurveyTemplate } = require('../core/doc-templates');
const { buildSurveyDocx } = require('../core/survey-doc');
// Step 3 / 5A：配电工作票号取号、编辑判别与共享校验（Step 2 纯模块，本文件不另写一套规则）
const { isDistPowerTicketType, allocateWorkTicketNo, assertDistWorkTicketNoAvailable, classifyPlanTicketEdit } = require('../core/plan-ticket-no');

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
    const rowNos = [];   // 与 parsed 同步：记录每个解析行在文件中的行号，供 Step 5B 报错定位
    // 按表头名称取列（不再写死列号）：原周报格式有两套——导出 48 列、内置导入模板 54 列（模板在「作业班组」后多一列「班组长」），
    // 从第 33 列起整体错开一位，只有按名称取才不会错位。子表头（当日计划工作量 / 备注）的列名在图片行 2，覆盖行 1。
    // 老格式（A=作业计划名称 B=计划类型 …）不认这两行表头，走后面的老分支。
    const HEAD = {};
    [rows[0] || [], rows[1] || []].forEach(line => line.forEach((v, i) => {
      const t = String(v == null ? '' : v).trim();
      if (t) HEAD[t] = i;
    }));
    const NEW_LAYOUT = HEAD['作业计划名称'] !== undefined && HEAD['计划开始时间'] !== undefined;
    // Step 5B 号码列：模板与导出统一为第 49 列「工作票号」；历史文件可能写「工作票编号」，
    // 保留别名兼容读取。两列同时填写且不一致时按行报错（整批拒绝），不静默择一。
    // 无该列时取值为空 —— 解析照旧，但配电周计划缺号会在整批校验里被拒（不再整份豁免）。
    const cellText = (r, i) => String(r[i] == null ? '' : r[i]).trim();
    const cellList = (r, i) => (cellText(r, i) ? cellText(r, i).split(/[；;]/).map(s => s.trim()).filter(Boolean) : []);
    const col = (r, name) => (HEAD[name] === undefined ? '' : cellText(r, HEAD[name]));
    const colList = (r, name) => (HEAD[name] === undefined ? [] : cellList(r, HEAD[name]));
    /* Step 5B 票号提取（新旧两种布局共用同一份逻辑，结果统一交给后面的整批校验）：
     * - 取值：「工作票号」为主、兼容别名「工作票编号」；两列皆空 → 空串（老格式无表头时即空串）。
     * - 冲突：两列同时有值且不一致 → 记入 errors 并返回 null（调用方直接 return），绝不静默择一。
     * - 不改任何其它字段的映射；不在此处做格式/号段/撞号判定（那是整批校验的事）。 */
    function takeTicketNo(r, rowNo) {
      const noMain = col(r, '工作票号');
      const noAlias = col(r, '工作票编号');
      if (noMain && noAlias && noMain !== noAlias) {
        errors.push('第' + rowNo + '行：「工作票号」与「工作票编号」两列同时填写且不一致（' + noMain + ' / ' + noAlias + '），请只保留一列');
        return null;
      }
      return noMain || noAlias;
    }
    // 时间列：接受 YYYY-MM-DD、YYYY-MM-DD HH（小时）、也兼容带分秒的 YYYY-MM-DD HH:mm[:ss]；
    // Excel 里把单元格设成日期/时间格式时读到的是序列号，这里一并换算。入库统一补全为 YYYY-MM-DD HH:mm:ss
    const DT_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/;
    const pad2 = n => String(n).padStart(2, '0');
    function normDT(v) {
      let s = v;
      if (typeof s === 'number' && isFinite(s)) {
        // Excel 序列号（1900 日期系统，25569 = 1970-01-01）
        const d = new Date(Math.round((s - 25569) * 86400000));
        s = d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
            pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
      }
      const m = String(s == null ? '' : s).trim().match(DT_RE);
      if (!m) return null;
      return m[1] + '-' + m[2] + '-' + m[3] + ' ' + pad2(m[4] || 0) + ':' + pad2(m[5] || 0) + ':' + pad2(m[6] || 0);
    }
    // 新格式没有「计划类型」列：按导入入口页签决定（周计划管理 / 月计划管理），默认周计划
    const wantType = String((req.query && req.query.planType) || '');
    rows.forEach((r, i) => {
      if (i === 0) return; // 表头
      const rowNo = i + 1;
      if (NEW_LAYOUT) {
        const pName = col(r, '作业计划名称');
        const startRaw = HEAD['计划开始时间'] === undefined ? '' : r[HEAD['计划开始时间']];
        const endRaw = HEAD['计划结束时间'] === undefined ? '' : r[HEAD['计划结束时间']];
        const start = normDT(startRaw);
        const end = normDT(endRaw);
        const blank = !pName && (startRaw == null || String(startRaw).trim() === '') && (endRaw == null || String(endRaw).trim() === '');
        if (blank) return; // 空行 / 第 2 行分组子表头
        if (!pName) { errors.push('第' + rowNo + '行：作业计划名称不能为空'); return; }
        if (!start) { errors.push('第' + rowNo + '行：计划开始时间「' + (String(startRaw || '').trim() || '空') + '」格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH'); return; }
        if (!end) { errors.push('第' + rowNo + '行：计划结束时间「' + (String(endRaw || '').trim() || '空') + '」格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH'); return; }
        if (end < start) { errors.push('第' + rowNo + '行：计划结束时间早于开始时间'); return; }
        // 两种布局共用同一份票号提取 + 别名冲突判定（冲突已记入 errors 并整批拒绝）
        const noCell = takeTicketNo(r, rowNo);
        if (noCell === null) return;
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
          // 「作业人员（共多少人）」以施工人员名单实际人数为准（与表单「从作业人员名单选择」后自动带数的口径一致）；
          // 名单为空时沿用文件里的值，避免把纯手填的人数清空
          staffCount: (() => {
            const txt = col(r, '作业实施（施工）人员（不包含工作负责人）');
            const n = txt ? txt.split(/[；;]/).map(s => s.trim()).filter(Boolean).length : 0;
            return n ? String(n) : col(r, '作业人员（共多少人）');
          })(),
          highStaff: col(r, '其中高处作业人员'),
          guardian: col(r, '专责监护人'), arrivalPersons: col(r, '到岗到位人员'), safetyPatrol: col(r, '安全巡查人员'),
          leader: col(r, '班组长'), teamLeader: col(r, '班组长'),   // 模板有此列，导出没有
          gasTester: col(r, '气体检测人员'), machine: col(r, '是否涉及机械施工'),
          wlPole: col(r, '杆塔（基）'), wlLine1035: col(r, '10kV/35kV线路（km/单线）'), wlCable: col(r, '电缆（千米）'),
          wlRing: col(r, '环网柜（个）'), wlVacuum: col(r, '真空开关（个）'), wlTransformer: col(r, '变压器（个）'),
          wlLine04: col(r, '0.4/0.22kV线路（km/单线）'),
          outageRange: col(r, '停电范围'), outageHours: col(r, '时户数'),
          ...(noCell ? { workTicketNo: noCell } : {})
        }));
        rowNos.push(rowNo);
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
      // 老格式（无表头）：字段映射逐字不动；票号同样走上面的共用提取——
      // 无该列时取值为空，配电票种缺号仍会在整批校验里被拒绝（旧布局同样参与校验，不再豁免）。
      const noCellOld = takeTicketNo(r, rowNo);
      if (noCellOld === null) return;
      parsed.push(planItem({
        name: pName, planType: pType, project: r[2], team: r[3], leader: r[4],
        startDate: start, endDate: end, ticketType: r[7], voltage: r[8], station: r[9], chargePerson: r[10],
        ...(noCellOld ? { workTicketNo: noCellOld } : {})
      }));
      rowNos.push(rowNo);
    });
    if (errors.length) {
      return res.status(400).json({ error: '导入失败，共 ' + errors.length + ' 处问题：' + errors.slice(0, 5).join('；') + (errors.length > 5 ? '（仅显示前 5 处）' : '') });
    }
    if (!parsed.length) return res.status(400).json({ error: '模板中没有可导入的数据行' });
    /* ---------- Step 5B：配电工作票号整批校验（须在业务判重之前，顺序不可颠倒） ----------
     * 适用面：仅配电票种（非配电/线路不扩围）；无号月计划先行豁免（不补号、不套校验）；
     *         月计划主动写配电号时仍须校验。
     * 规则：格式 / 号段 / 票种码 / 存活撞号 / 批内重复，全部走 core/plan-ticket-no 的
     * assertDistWorkTicketNoAvailable（Step 2 已审阅模块），本文件不另写一套。
     * 任一不合法 → 整批拒绝、不调用 saveDB、不静默改号，按既有导入报错形态返回；
     * 绝不允许「先按业务键跳过非法行再校验」。
     * 无票号列（历史 48 列模板 / 老格式无表头）时取值为空：解析照旧，但配电周计划缺号在此被整批拒绝。
     * 输入面统一：新旧两种布局都经 takeTicketNo() 产出同一份「号码 + 别名冲突」结果，再进本段校验。
     */
    const noErrors = [];
    const batchNos = [];
    parsed.forEach((p, i) => {
      const rowNo = rowNos[i] || (i + 2);
      const type = normTicketString(p.ticketType);
      if (!isDistPowerTicketType(type)) return;              // 非配电（含线路）：不扩围、不校验
      const no = normTicketString(p.workTicketNo);
      if (!no && p.planType === '月计划') return;            // 无号月计划先豁免：不补号、不套校验
      if (!no) {
        noErrors.push('第' + rowNo + '行：配电计划缺少工作票号（须为 YYYYMM + 类型码 6/7/9 + 801–999）');
        return;
      }
      const checked = assertDistWorkTicketNoAvailable({
        workTicketNo: no, ticketType: type, records: DB.workPlans, batchNos
      });
      if (!checked.ok) { noErrors.push('第' + rowNo + '行：' + checked.message); return; }
      batchNos.push(no);                                     // 批内已用号占位，后续同号即 DUPLICATE
    });
    if (noErrors.length) {
      return res.status(400).json({
        error: '导入失败，共 ' + noErrors.length + ' 处问题：' + noErrors.slice(0, 5).join('；') + (noErrors.length > 5 ? '（仅显示前 5 处）' : '')
      });
    }
    // 判重：planType + project + name + startDate；范围 = 库中同键未删除计划 + 本文件内先出现的行。
    // 现行导入对话框无逐行勾选能力，命中重复的行一律跳过（不覆盖、不改动已有记录）。
    const planKey = p => [p.planType, p.project, p.name, p.startDate]
      .map(x => String(x == null ? '' : x).trim()).join('\u0001');
    const seenPlans = new Set(DB.workPlans.filter(p => p && !p.deleted).map(planKey));
    const skippedRows = [];
    const fresh = [];
    parsed.forEach(p => {
      const k = planKey(p);
      if (seenPlans.has(k)) { skippedRows.push({ project: p.project || '', name: p.name || '' }); return; }
      seenPlans.add(k);
      fresh.push(p);
    });
    fresh.forEach(p => DB.workPlans.unshift(p));
    try {
      saveDB();                          // 全批一次保存
    } catch (e) {
      DB.workPlans.splice(0, fresh.length);   // unshift 进来的整段移除，还原到导入前（不重试、不声称磁盘原子）
      return res.status(500).json({ ok: false, error: 'SAVE_FAILED', message: '保存失败，已回滚内存记录：' + String((e && e.message) || e) });
    }
    res.json({ ok: true, added: fresh.length, skipped: skippedRows.length, skippedRows });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});
// ---------- 导出：对齐原周报「周计划」文件（49 列 / 两行表头 / 三处分组表头；第 49 列「工作票号」） ----------
const PLAN_XLSX_ROW1 = [
  '序号', '作业计划名称', '作业类型', '作业专业', '省专业管理部门', '计划开始时间', '计划结束时间', '电压等级',
  '变电站/线路', '作业地址', '作业内容', '工作票类型', '作业风险等级', '电网风险等级', '风险因素',
  '作业建管单位（市）', '作业建管单位（县）', '作业实施（施工）单位（市）', '作业实施（施工）单位（县）',
  '作业班组', '分包单位', '监理单位', '抄送单位', '工作负责人', '工作负责人联系方式',
  '作业实施（施工）人员（不包含工作负责人）', '重特大人身事故风险', '风险管控措施', '作业人员（共多少人）',
  '其中高处作业人员', '专责监护人', '到岗到位人员', '安全巡查人员', '作业资料审核负责人',
  '高处作业、培训交底负责人', '队伍、人员准入检查负责人', '施工机具和安全工器具检查负责人',
  '气体检测人员', '是否涉及机械施工', '当日计划工作量', '', '', '', '', '', '', '备注', '', '工作票号'
];
const PLAN_XLSX_ROW2 = [
  '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  '', '', '', '', '', '', '', '', '', '', '', '', '', '',
  '杆塔（基）', '10kV/35kV线路（km/单线）', '电缆（千米）', '环网柜（个）', '真空开关（个）', '变压器（个）',
  '0.4/0.22kV线路（km/单线）', '停电范围', '时户数', ''
];
const PLAN_XLSX_COLS = [
  8.83, 22.83, 12.83, 10.83, 16.83, 21.83, 21.83, 10.83, 18.83, 40.83, 27.83, 24.83, 14.83, 14.83, 40.83,
  20.83, 20.83, 28.83, 28.83, 12.83, 19.83, 10.83, 10.83, 12.83, 20.83, 40.83, 20.83, 40.83, 22.83, 24.83,
  12.83, 14.83, 14.83, 20.83, 26.83, 26.83, 32.83, 14.83, 18.83, 16.83, 26.83, 14.83, 14.83, 16.83, 14.83,
  27.83, 21.83, 8.83, 18.83
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
    planXlsxText(p.outageRange), planXlsxNum(p.outageHours),
    planXlsxText(p.workTicketNo)   // 第 49 列：原值直出，不 trim / 不补零 / 不转数字
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
      for (let c = 1; c <= 49; c++) {
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
app.post('/api/workPlans/:id/drawings', upload.single('file'), (req, res) => {
  const p = findPlan(req.params.id);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const dir = path.join(ROOT, 'data', 'uploads', 'plans', p.id);
  fs.mkdirSync(dir, { recursive: true });
  const diskName = Date.now() + '_' + safeFileName(req.file.originalname);
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
// ?inline=1 时对 PDF/图片给可预览的 Content-Type，供前端「打开」用；MIME 表在 core/util
app.get('/api/workPlans/:id/drawings/:fileId/download', (req, res) => {
  const p = findPlan(req.params.id);
  // 下载是只读接口：不初始化 drawings（避免 GET 顺手改记录）
  const f = p && (Array.isArray(p.drawings) ? p.drawings : []).find(x => x.id === req.params.fileId);
  const fp = f && path.join(ROOT, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  const ext = String(f.name || '').split('.').pop().toLowerCase();
  const inline = req.query.inline === '1' && INLINE_MIME[ext];
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
  const diskName = Date.now() + '_' + safeFileName(name);
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
  const rel = prev ? prev.path : ('uploads/plans/' + p.id + '/' + Date.now() + '_' + safeFileName(GEN_FILE_NAME));
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

// 月计划 xlsx 导出 → routes/monthPlans.js；借工管理专用端点 → routes/borrow.js
// 二者均在 server.js 中先于本文件加载，保证静态路径不被通用 /:id 路由抢先匹配。

/* ---------- Step 3：专用创建 POST（须注册在下面 crud() 之前，接管本集合创建） ----------
 * 只接管「配电工作票号 + ticketNoMode」语义；其余分支复刻 core/crud.js 通用 POST 的
 * 默认值 / 记录构造顺序 / 身份与时间字段 / HTTP 状态 / 响应形态。全分支落库前剥离
 * ticketNoMode，不写为记录字段；非目标分支不新增任何规范化规则。
 * 临界区：Node 单进程、本 handler 全程同步无 await，「读占用 → 分配/校验 → push → saveDB」
 * 处于同一同步临界区；不声称磁盘原子或跨进程全局锁（saveDB 为非原子 writeFileSync，本步不改 db.js）。
 * 号源规则一律走 core/plan-ticket-no（Step 2 已审阅模块），本文件不另写一套。
 * 本步不改导入、不挂专用 PUT、不改勘察生成；此 POST 亦为 Step 4 月生周的唯一创建通道（本步只预留）。
 */
// 「无工作票号」：仅认非空字符串；非字符串一并视为无票号（不抛异常、不新增类型门禁）
function hasNonEmptyTicketNo(v) { return typeof v === 'string' && v.trim() !== ''; }
// 与 core/plan-ticket-no 的 str() 同口径的规范化，供 manual「校验什么就保存什么」
function normTicketString(v) { return typeof v === 'string' ? v.trim() : ''; }
// 通用 POST 等价落库：构造顺序/默认值/响应形态与 core/crud.js 一致；saveDB 抛错则内存回滚
function commitPlanCreate(res, body) {
  // 与 core/crud.js:23 逐字一致：crud('workPlans','workPlans') 的 prefix.slice(0,2) === 'wo'
  const item = { id: genId('workPlans'.slice(0, 2)), createdAt: nowISO(), ...body };
  item.deleted = false;
  const before = DB.workPlans.length;
  DB.workPlans.push(item);
  try {
    saveDB();
  } catch (e) {
    DB.workPlans.length = before;  // 内存回滚到调用前状态（不声称磁盘原子/半写安全）
    return res.status(500).json({ ok: false, error: 'SAVE_FAILED', message: '保存失败，已回滚内存记录：' + String((e && e.message) || e) });
  }
  return res.json(item);
}

app.post('/api/workPlans', (req, res) => {
  const raw = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  const body = { ...raw };
  delete body.ticketNoMode;                     // 全分支剥离（含非目标）

  // 分流 1（先豁免）：月计划且无工作票号 → 原通用创建语义，不进入 mode 逻辑，
  // 也不因「月计划带配电票种」被强制取号或报 MODE_REQUIRED。
  if (raw.planType === '月计划' && !hasNonEmptyTicketNo(raw.workTicketNo)) {
    return commitPlanCreate(res, body);
  }
  // 分流 3（非目标）：线路 / 其它非配电计划 → 原通用创建语义，不套 mode 与 801 规则。
  if (!isDistPowerTicketType(raw.ticketType)) {
    return commitPlanCreate(res, body);
  }
  // 分流 2（目标配电三类）：按 ticketNoMode 接管编号。
  const mode = raw.ticketNoMode;
  if (mode === 'auto') {
    // 操作当天月份：服务端业务日期（Asia/Shanghai），与 routes/materials.js 的 todayBizDate() 同源 bjStr
    const yearMonth = bjStr().slice(0, 10).replace(/-/g, '').slice(0, 6);
    const allocated = allocateWorkTicketNo({ ticketType: body.ticketType, yearMonth, records: DB.workPlans });
    if (!allocated.ok) return res.status(400).json(allocated);   // EXHAUSTED 等：400 + 模块错误码，不落库
    body.workTicketNo = allocated.workTicketNo;                  // 忽略客户端预填号，保存服务端生成号
    return commitPlanCreate(res, body);
  }
  if (mode === 'manual') {
    // 校验与保存使用同一规范化后的 ticketType / workTicketNo（校验什么就保存什么）
    const ticketType = normTicketString(raw.ticketType);
    const workTicketNo = normTicketString(raw.workTicketNo);
    const checked = assertDistWorkTicketNoAvailable({ workTicketNo, ticketType, records: DB.workPlans });
    if (!checked.ok) return res.status(400).json(checked);       // 格式/号段/票种码/存活撞号：400，不落库
    body.ticketType = ticketType;
    body.workTicketNo = workTicketNo;
    return commitPlanCreate(res, body);
  }
  // 缺 mode 或 mode 为其它值：不默判 auto、不把预填号当已校验 manual、不重算、不落库
  return res.status(400).json({ ok: false, error: 'MODE_REQUIRED', message: '配电计划创建须显式上报 ticketNoMode（auto / manual）' });
});

/* ---------- Step 5A：专用编辑 PUT（须注册在 crud() 之前，接管本集合整记录更新） ----------
 * 判别一律走 core/plan-ticket-no 的 classifyPlanTicketEdit（Step 2 已审阅模块）：
 * 以「已存记录 + 原样请求体」调用，**不预删任何键**（含客户端 ticketNoMode / 标签 / 按钮名），
 * 只认分类器决策——预删键会把「带号编辑」伪装成轻操作，属停止条件。
 * 保存等价于 core/crud.js:35-44 的通用 PUT：{...cur, ...body, id, updatedAt}、deleted 取已存值、
 * 404 形态一致、res.json(merged) 响应形态一致；仅 validate 分支额外采用分类器返回的
 * 规范化 ticketType / workTicketNo（校验什么就保存什么），light / skip 分支不新增任何规范化。
 * 临界区：本 handler 全程同步无 await，「判别 → 撞号校验 → 写内存 → saveDB」同一临界区；
 * saveDB 抛错即还原内存记录且不重试；不声称磁盘原子 / 半写安全（本步不改 db.js）。
 */
function commitPlanUpdate(res, idx, merged) {
  const prev = DB.workPlans[idx];
  DB.workPlans[idx] = merged;
  try {
    saveDB();
  } catch (e) {
    DB.workPlans[idx] = prev;   // 内存回滚到本次更新前（不声称磁盘原子/半写安全）
    return res.status(500).json({ ok: false, error: 'SAVE_FAILED', message: '保存失败，已回滚内存记录：' + String((e && e.message) || e) });
  }
  return res.json(merged);
}

app.put('/api/workPlans/:id', (req, res) => {
  const idx = DB.workPlans.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const cur = DB.workPlans[idx];
  if (cur.deleted) return res.status(404).json({ error: '未找到' });

  const decision = classifyPlanTicketEdit({ stored: cur, body: req.body });
  if (!decision.ok) return res.status(400).json(decision);   // 400 + 模块错误码，不 saveDB、不改内存
  // 通用 PUT 合并语义（与 core/crud.js 一致：id 取路径参数、刷新 updatedAt、deleted 以已存为准）
  const merged = { ...cur, ...req.body, id: req.params.id, updatedAt: nowISO() };
  merged.deleted = cur.deleted;
  // 契约三字段：请求缺省或显式 undefined（等同未提供）一律沿用已存值——
  // 不得因 body 里带了 `workTicketNo: undefined` 就把已存号抹掉（light / skip 分支同样适用）
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
  ['planType', 'ticketType', 'workTicketNo'].forEach(k => {
    if (!Object.prototype.hasOwnProperty.call(body, k) || body[k] === undefined) merged[k] = cur[k];
  });

  if (decision.action === 'validate') {
    // 撞号断言排除已存自身；通过后才保存分类器返回的规范化值（禁止保存请求原值）
    const checked = assertDistWorkTicketNoAvailable({
      workTicketNo: decision.workTicketNo,
      ticketType: decision.ticketType,
      records: DB.workPlans,
      excludeIds: decision.excludeIds
    });
    if (!checked.ok) return res.status(400).json(checked);   // 撞号/格式：400，不 saveDB、不改内存
    merged.ticketType = decision.ticketType;
    merged.workTicketNo = decision.workTicketNo;
  }
  return commitPlanUpdate(res, idx, merged);
});

// 计划相关集合走通用 CRUD（逻辑删除；须晚于本文件所有专用端点注册，含上面的专用创建 POST 与专用编辑 PUT）
// borrowWorks 的 CRUD 已移至 routes/borrow.js，月计划 xlsx 导出已移至 routes/monthPlans.js
['plans', 'workPlans'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
