/* ========== core/borrow-doc ========== */
/* 借工单（用工申请审批表）docx 生成：按模板位置填空，零依赖（复用 core/util 的 zip 实现）。
 *
 * 模板：assets/借工单模板.docx —— 《用工申请审批表》：标题 + 抬头「年 月 日」+ 10 行表格。
 * 表格结构（左=标签格，右=值格，值格原为空白）：
 *   项目类型 | ___        项目名称 | ___        班组名称 | ___ | 用工时间 | ___
 *   工作内容及用工需求 | ___            外协单位 | ___
 *   班组负责人 | ___ | 业务管理部门专责 | ___
 *   业务管理部门分管负责人 | ___   业务管理部门负责人 | ___   业务分管领导 | ___   备 注 | ___
 *
 * 填法（按位置，不做占位符替换）：逐行扫描，命中标签的格取其**右侧相邻格**写入值；
 * 抬头「年 月 日」按申请日期填。未映射的格（班组名称 / 外协单位 / 各级审批签字）保持空白供手写。
 * 排版：短值居中；长文本（工作内容、备注）左对齐 + 左右内缩，多行用 <w:br/> 断行；
 * 沿用模板原字体（Songti SC Regular 13pt=sz26）与单元格垂直居中。 */
const { listZipEntries, buildStoreZip, decodeXmlEntities } = require('./util');

const DOC_ENTRY = 'word/document.xml';
/* 填入值的统一字体：宋体 13pt（sz=26 半磅）、黑色 —— 模板里各空值格残留格式不一
 * （「项目名称」格残留 28pt、部分格缺垂直居中），填值一律按此归一，避免同一张表字号跳变。 */
const FALLBACK_RPR = '<w:rPr><w:rFonts w:ascii="Songti SC Regular" w:eastAsia="Songti SC Regular" '
  + 'w:hAnsi="Songti SC Regular" w:cs="Songti SC Regular" w:hint="eastAsia"/>'
  + '<w:color w:val="000000"/><w:kern w:val="0"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>';

function str(v) { return String(v == null ? '' : v).trim(); }
function num(v) { const n = Number(v); return String(Number.isFinite(n) && n > 0 ? Math.round(n) : 0); }
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// 取 docx 片段里的全部文本（用于识别标签格）
function textOf(frag) {
  const inner = String(frag || '').replace(/<w:tcPr>[\s\S]*?<\/w:tcPr>/, '');
  const raw = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(m => (typeof decodeXmlEntities === 'function' ? decodeXmlEntities(m[1]) : m[1]))
    .join('');
  return raw.replace(/\s+/g, '');
}

/* 日期格式：抬头「2026年 11 月 03 日」、用工时间「2026.11.03」（与参考版式一致） */
function fmtDateCn(v) {
  const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return str(v);
  return m[1] + '年 ' + String(m[2]).padStart(2, '0') + ' 月 ' + String(m[3]).padStart(2, '0') + ' 日';
}
function fmtDateDot(v) {
  const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return str(v);
  return m[1] + '.' + String(m[2]).padStart(2, '0') + '.' + String(m[3]).padStart(2, '0');
}

/* 记录 → 各标签应填的值。未列出的标签（外协单位/各级审批签字）保持空白。 */
function buildPlan(rec) {
  const r = rec || {};
  const plan = {};

  plan['项目类型'] = { align: 'center', text: str(r.projectType) };
  plan['项目名称'] = { align: 'center', text: str(r.projectName) };
  // 班组名称 ← 往来单位（软件里的“往来单位”即本表的班组/借出方）
  plan['班组名称'] = { align: 'center', text: str(r.unit) };
  plan['用工时间'] = { align: 'center', text: fmtDateDot(r.workDate) };

  // 工作内容 + 用工需求（数量并入同一格，末行追加需求行）
  const lines = [];
  const content = str(r.workContent);
  if (content) lines.push(content);
  const need = Number(r.techCount) || 0, work = Number(r.workerCount) || 0, veh = Number(r.vehicleCount) || 0;
  if (need || work || veh) {
    lines.push('技工' + num(need) + '人次、民工' + num(work) + '人次、车辆' + num(veh) + '辆次');
  }
  plan['工作内容及用工需求'] = { align: 'left', text: lines.join('\n') };

  // 备注：借工方向并入（模板无方向行）
  const remark = [str(r.direction), str(r.remark)].filter(Boolean).join('；');
  plan['备注'] = { align: 'left', text: remark };

  return plan;
}

function runXml(text, rPr) {
  const body = String(text).replace(/\r\n?/g, '\n').split('\n')
    .map(xmlEscape).join('</w:t><w:br/><w:t xml:space="preserve">');
  return '<w:r>' + (rPr || FALLBACK_RPR) + '<w:t xml:space="preserve">' + body + '</w:t></w:r>';
}

// 段落属性微调：统一字体、对齐方式、长文本左右内缩（去掉模板首行缩进，避免续行错位）
function tunePPr(pPr, align, multi) {
  let p = pPr || '<w:pPr></w:pPr>';
  p = /<w:rPr>[\s\S]*?<\/w:rPr>/.test(p)
    ? p.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, FALLBACK_RPR)
    : p.replace(/<\/w:pPr>$/, FALLBACK_RPR + '</w:pPr>');
  const jc = align === 'left' ? '<w:jc w:val="left"/>' : '<w:jc w:val="center"/>';
  p = /<w:jc\b[^>]*\/>/.test(p) ? p.replace(/<w:jc\b[^>]*\/>/, jc) : p.replace(/<\/w:pPr>$/, jc + '</w:pPr>');
  if (align === 'left') {
    const ind = '<w:ind w:left="113" w:right="113"/>';
    p = /<w:ind\b[^>]*\/>/.test(p) ? p.replace(/<w:ind\b[^>]*\/>/, ind) : p.replace(/<\/w:pPr>$/, ind + '</w:pPr>');
  }
  // 多行内容：模板的固定行距（624/906 twips，为手写留白）会让折行间距过大，改 1.5 倍自动行距
  if (multi) {
    const sp = '<w:spacing w:line="360" w:lineRule="auto"/>';
    p = /<w:spacing\b[^>]*\/>/.test(p) ? p.replace(/<w:spacing\b[^>]*\/>/, sp) : p.replace(/<\/w:pPr>$/, sp + '</w:pPr>');
  }
  return p;
}

/* 单元格属性补垂直居中（模板部分空值格缺 vAlign，填值后会顶端对齐） */
function tuneTcPr(tcPr) {
  if (!tcPr) return '';
  return /<w:vAlign\b[^>]*\/>/.test(tcPr)
    ? tcPr.replace(/<w:vAlign\b[^>]*\/>/, '<w:vAlign w:val="center"/>')
    : tcPr.replace(/<\/w:tcPr>$/, '<w:vAlign w:val="center"/></w:tcPr>');
}

/* 用新内容重建一个单元格：保留 tcPr（列宽/边框/合并）与段落行距，字体/对齐/垂直居中归一 */
function buildCell(cellXml, text, align) {
  const tcPr = tuneTcPr((cellXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0]);
  const pMatch = cellXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/);
  const pPr = pMatch ? (pMatch[0].match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0] : '';
  const body = str(text) ? runXml(str(text), FALLBACK_RPR) : '';
  const multi = String(text).indexOf('\n') >= 0;
  return '<w:tc>' + tcPr + '<w:p>' + tunePPr(pPr, align, multi) + body + '</w:p></w:tc>';
}

/* 逐行填表：命中标签格 → 写右侧相邻格 */
function fillRow(rowXml, plan) {
  const cells = [];
  rowXml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, c => { cells.push(c); return c; });
  if (cells.length < 2) return rowXml;
  const out = cells.slice();
  for (let i = 0; i < cells.length - 1; i++) {
    const spec = plan[textOf(cells[i])];
    if (spec && str(spec.text)) out[i + 1] = buildCell(cells[i + 1], spec.text, spec.align);
  }
  const first = rowXml.indexOf('<w:tc>');
  const lastEnd = rowXml.lastIndexOf('</w:tc>') + '</w:tc>'.length;
  return rowXml.slice(0, first) + out.join('') + rowXml.slice(lastEnd);
}

/* 表格在页面上的水平位置（模板里表格是绝对定位的 tblpX / tblW，页边距多为 0）。
 * 抬头段落（标题、日期）按同一条带状区域对齐：左边界=表格左边，右边界=表格右边。 */
function tableBand(xml) {
  const sect = (xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/) || [''])[0];
  const pageW = parseInt((sect.match(/<w:pgSz w:w="(\d+)"/) || [])[1] || '11900', 10);
  const marR = parseInt((sect.match(/<w:pgMar[^>]*w:right="(\d+)"/) || [])[1] || '0', 10);
  const marL = parseInt((sect.match(/<w:pgMar[^>]*w:left="(\d+)"/) || [])[1] || '0', 10);
  const tblPr = (xml.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/) || [''])[0];
  const tblX = parseInt((tblPr.match(/w:tblpX="(-?\d+)"/) || [])[1] || '0', 10);
  const tblW = parseInt((tblPr.match(/<w:tblW w:w="(\d+)"/) || [])[1] || '0', 10);
  const left = Math.max(0, tblX - marL);                       // 段落左缩进
  const right = Math.max(0, (pageW - marR) - (tblX + tblW));   // 段落右缩进
  return { left, right };
}

/* 抬头段落属性：统一字体 + 按表格左右边界缩进 + 对齐方式 */
function tuneHeadPPr(pPr, align, band) {
  let p = pPr || '<w:pPr></w:pPr>';
  p = /<w:rPr>[\s\S]*?<\/w:rPr>/.test(p)
    ? p.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, FALLBACK_RPR)
    : p.replace(/<\/w:pPr>$/, FALLBACK_RPR + '</w:pPr>');
  const ind = '<w:ind w:left="' + band.left + '" w:right="' + band.right + '"/>';
  p = /<w:ind\b[^>]*\/>/.test(p) ? p.replace(/<w:ind\b[^>]*\/>/, ind) : p.replace(/<\/w:pPr>$/, ind + '</w:pPr>');
  const jc = '<w:jc w:val="' + align + '"/>';
  p = /<w:jc\b[^>]*\/>/.test(p) ? p.replace(/<w:jc\b[^>]*\/>/, jc) : p.replace(/<\/w:pPr>$/, jc + '</w:pPr>');
  return p;
}

/* 抬头处理：标题居中于表格上方、日期右对齐于表格右边界（模板页边距为 0，日期原本会贴到纸边） */
function fillHeadLines(xml, rec) {
  const band = tableBand(xml);
  const d = str(rec && rec.applyDate) || str(rec && rec.workDate);
  const dateText = /^\d{4}-\d{1,2}-\d{1,2}/.test(d) ? fmtDateCn(d) : '';
  return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, p => {
    const t = textOf(p);
    if (t === '用工申请审批表') {
      const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
      return '<w:p>' + tuneHeadPPr(pPr, 'center', band) + runXml('用工申请审批表', FALLBACK_RPR) + '</w:p>';
    }
    if (t === '年月日') {
      const pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
      const body = dateText ? runXml(dateText, FALLBACK_RPR) : '';
      return '<w:p>' + tuneHeadPPr(pPr, 'right', band) + body + '</w:p>';
    }
    return p;
  });
}

/* 模板 buffer → 新 docx buffer（其余条目原样打包，不改模板文件本身） */
function buildBorrowDocx(templateBuf, rec) {
  const entries = listZipEntries(templateBuf);
  if (!entries.length) throw new Error('模板文件无法解析（不是有效的 docx）');
  const idx = entries.findIndex(e => e.name === DOC_ENTRY);
  if (idx < 0) throw new Error('模板缺少 ' + DOC_ENTRY);

  const plan = buildPlan(rec);
  let xml = entries[idx].data.toString('utf8');
  if (!/<w:tbl>/.test(xml)) throw new Error('模板缺少表格（应为《用工申请审批表》）');

  xml = xml.replace(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g, row => fillRow(row, plan));
  xml = fillHeadLines(xml, rec || {});

  const filled = Object.keys(plan).filter(k => str(plan[k].text)).length;
  const out = entries.slice();
  out[idx] = { name: DOC_ENTRY, data: Buffer.from(xml, 'utf8') };
  return { buffer: buildStoreZip(out), filled, plan };
}

module.exports = { buildPlan, buildBorrowDocx };
