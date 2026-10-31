/* ========== core/month-plan-xlsx ========== */
/* 月计划导出模板（与用户提供的「月计划导出模板.xlsx」逐列一致）：
   - 两张子表：主网 / 配网
   - 第 1 行：标题（A1:T1 合并，加粗 16 号居中）
   - 第 2 行：20 列表头（加粗 12 号居中、自动换行、细边框）
   - 第 3 行：红色填写说明（12 号居中、自动换行、细边框）
   - 第 4 行起：数据行
   列宽按模板像素换算成 Excel 字符宽；导出文件可直接回灌导入（见 public/js/views/monthPlans.js 的解析）。 */
const ExcelJS = require('exceljs');

// 20 列表头（顺序即模板顺序）
const HEADERS = [
  '序号', '运维单位', '检修单位', '涉及工程项目', '检修设备', '电压等级', '设备类型',
  '计划停电时间', '计划工作时间', '检修类型', '检修内容', '影响主要用户和区域',
  '停电涉及中压配变数', '停电时户数', '涉及重要电力用户名称', '电网风险等级',
  '作业风险等级', '近2月停电次数', '本年度停电次数', '备注'
];
// 列宽（模板读取的像素值）
const WIDTH_PX = [54, 82, 82, 97, 274, 62, 129, 142, 121, 135, 271, 176, 66, 44, 121, 63, 63, 138, 75, 223];
// 第 3 行填写说明（与模板原文一致）
const NOTES = [
  '总体上按时间排序，但关联性的工作几行连在一起写',
  '下拉单选',
  '根据实际填写',
  '涉及项目的需写项目名称，一个工程的不同检修计划几行连在一起写',
  '检修设备名称\nXXkVXX站：XXkVXXX线XX开关及线路\nXXX线',
  '下拉单选，多设备停电取最高电压等级',
  '下拉单选，变电站设备、主网线路、配网主线、配网支线、配变、低压总保、重合闸、保护装置、发电设备、其他',
  '连续停电格式：X月X日XX:XX-X月X日XX:XX\n白停夜送、白停夜投格式：X月X日-X月X日XX:XX-XX:XX（白停夜送）或者重合闸写：（白停夜投）',
  '连续停电格式：X月X日XX:XX-X月X日XX:XX\n白停夜送、白停夜投格式：X月X日-X月X日XX:XX-XX:XX（白停夜送）或者重合闸写：（白停夜投）',
  '基建、迁改、预试预检、大修、技改、消缺、业扩工程、农配网工程、客户工程，其他',
  'XX',
  '四川省自贡市XX区：XX街道XXX、XX镇XXX乡(1、农村地区村组前面必须加上XX乡或XX镇。2、城市地区如不涉及乡镇的，则需加上街道或社区名称。3、停电范围中不能出现台区名称，即范围中不能有“台变”“专变”“配变”“配变”字。)',
  'XX', 'XX', 'XX', '下拉单选', '下拉单选',
  '对于涉及对外停电的配网工作，各供电单位应根据检修开始时间向前追溯两个月，自行核查停电次数',
  '',
  '发电车需求等需要说明的事项'
];
// 设备类型里属于「主网」的口径；其余都进「配网」子表
const MAIN_GRID_TYPES = ['变电站设备', '主网线路', '发电设备'];

/* 停电时间文本：连续停电格式 X月X日XX:XX-X月X日XX:XX；同日写 X月X日XX:XX-XX:XX */
function outageText(start, end) {
  const s = String(start || '').trim(), e = String(end || '').trim();
  const md = v => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    return m ? (Number(m[2]) + '月' + Number(m[3]) + '日') : '';
  };
  const hm = v => (v.length >= 16 ? v.slice(11, 16) : '');
  if (!s && !e) return '';
  if (s && e) {
    if (s.slice(0, 10) === e.slice(0, 10)) return md(s) + hm(s) + '-' + hm(e);
    return md(s) + hm(s) + '-' + md(e) + hm(e);
  }
  return s || e;
}

/* 一行数据 → 20 列（序号由调用方给） */
function rowValues(p, seq) {
  const v = k => (p && p[k] != null ? String(p[k]) : '');
  return [
    seq,
    v('opsUnit'),
    v('maintUnit'),
    v('projectName') || v('project'),
    v('maintDevice'),
    v('voltage'),
    v('deviceType'),
    outageText(p && p.outageStart, p && p.outageEnd),
    v('workTime'),
    v('workType'),
    v('maintContent'),
    v('affectArea'),
    v('transformerCount'),
    v('outageHouseholds'),
    v('importantUsers'),
    v('gridRisk'),
    v('riskLevel'),
    v('outageCount2m'),
    v('outageCountYear'),
    v('planNote')
  ];
}

const px2w = px => Math.round(((px - 5) / 7) * 10) / 10;   // 像素 → Excel 字符宽
const px2h = px => Math.round(px * 0.75 * 100) / 100;      // 像素 → 磅（行高）

const THIN = { style: 'thin', color: { argb: 'FF000000' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const FONT_CN = '宋体';

function fillSheet(ws, title, rows) {
  ws.properties.defaultRowHeight = 20;
  for (let c = 1; c <= HEADERS.length; c++) ws.getColumn(c).width = px2w(WIDTH_PX[c - 1]);

  // 标题
  ws.mergeCells(1, 1, 1, HEADERS.length);
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: FONT_CN, size: 16, bold: true, color: { argb: 'FF000000' } };
  t.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(1).height = px2h(31);

  // 表头
  const hr = ws.getRow(2);
  HEADERS.forEach((h, i) => { hr.getCell(i + 1).value = h; });
  hr.height = px2h(68);
  for (let c = 1; c <= HEADERS.length; c++) {
    const cell = hr.getCell(c);
    cell.font = { name: FONT_CN, size: 12, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER;
  }

  // 填写说明（红字）
  const nr = ws.getRow(3);
  NOTES.forEach((n, i) => { nr.getCell(i + 1).value = n; });
  nr.height = px2h(204);
  for (let c = 1; c <= HEADERS.length; c++) {
    const cell = nr.getCell(c);
    cell.font = { name: FONT_CN, size: 12, color: { argb: 'FFFF0000' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = BORDER;
  }

  // 数据
  rows.forEach((p, i) => {
    const r = ws.getRow(4 + i);
    rowValues(p, i + 1).forEach((v, ci) => {
      const cell = r.getCell(ci + 1);
      cell.value = v;
      cell.font = { name: FONT_CN, size: 11 };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    r.height = px2h(30);
  });

  ws.views = [{ state: 'frozen', ySplit: 3 }];   // 冻结标题/表头/说明，长表滚动时表头常驻
}

/**
 * 生成月计划工作簿
 * @param {Array} rows 月计划记录
 * @param {{company?:string, year:number, month:number}} meta
 * @returns {Promise<Buffer>}
 */
async function buildMonthPlanXlsx(rows, meta) {
  const list = Array.isArray(rows) ? rows : [];
  const m = meta || {};
  const company = String(m.company || 'XX供电公司');
  const year = m.year || new Date().getFullYear();
  const month = m.month || (new Date().getMonth() + 1);

  const main = [], dist = [];
  list.forEach(p => {
    const t = String((p && p.deviceType) || '');
    (MAIN_GRID_TYPES.includes(t) ? main : dist).push(p);
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Electric Power Data System';
  wb.created = new Date();
  fillSheet(wb.addWorksheet('主网'), company + year + '年' + month + '月发输变配电设备检修计划（主网）', main);
  fillSheet(wb.addWorksheet('配网'), company + year + '年' + month + '月配电设备检修计划（配网）', dist);
  return wb.xlsx.writeBuffer();
}

module.exports = { HEADERS, NOTES, WIDTH_PX, outageText, rowValues, buildMonthPlanXlsx };
