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
 * 抬头「年 月 日」按申请日期填。未映射的格（外协单位 / 各级审批签字）保持空白供手写。
 *
 * 格式原则：**只填数据，不改格式**——字体/字号/加粗/对齐/行距/缩进/垂直居中/列宽全部沿用模板预设
 * （文字套用该格段落自带的 rPr，等同于在 Word 里往空格里打字）；仅日期段的缩进与右对齐按表格边界调整。 */
const { listZipEntries, buildStoreZip, decodeXmlEntities } = require('./util');

const DOC_ENTRY = 'word/document.xml';

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

  plan['项目类型'] = { text: str(r.projectType) };
  plan['项目名称'] = { text: str(r.projectName) };
  // 班组名称 ← 往来单位（软件里的“往来单位”即本表的班组/借出方）
  plan['班组名称'] = { text: str(r.unit) };
  plan['用工时间'] = { text: fmtDateDot(r.workDate) };

  // 工作内容 + 用工需求（数量并入同一格，末行追加需求行）
  const lines = [];
  const content = str(r.workContent);
  if (content) lines.push(content);
  const need = Number(r.techCount) || 0, work = Number(r.workerCount) || 0, veh = Number(r.vehicleCount) || 0;
  if (need || work || veh) {
    lines.push('技工' + num(need) + '人次、民工' + num(work) + '人次、车辆' + num(veh) + '辆次');
  }
  plan['工作内容及用工需求'] = { text: lines.join('\n') };

  // 备注：借工方向并入（模板无方向行）
  const remark = [str(r.direction), str(r.remark)].filter(Boolean).join('；');
  plan['备注'] = { text: remark };

  return plan;
}

function runXml(text, rPr) {
  const body = String(text).replace(/\r\n?/g, '\n').split('\n')
    .map(xmlEscape).join('</w:t><w:br/><w:t xml:space="preserve">');
  return '<w:r>' + (rPr || '') + '<w:t xml:space="preserve">' + body + '</w:t></w:r>';
}

/* 取模板为该段落/单元格预设的字体：优先已有 run 的 rPr，否则用段落标记上的 rPr
 * （Word 里在空格里输入文字，就是套用这个预设字体）——保证“只填数据、不改格式”。 */
function presetRPr(frag) {
  const runs = frag.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/);
  if (runs) {
    const r = (runs[0].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    if (r) return r;
  }
  const pPr = (frag.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
  return (pPr.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
}

/* 用新内容重建一个单元格：tcPr（列宽/边框/合并/垂直对齐）与 pPr（字体/字号/对齐/行距/缩进）
 * 全部**原样保留**，只写入文字；多行用 <w:br/> 断开。 */
function buildCell(cellXml, text) {
  const tcPr = (cellXml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0];
  const pMatch = cellXml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/);
  const pPr = pMatch ? (pMatch[0].match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0] : '';
  const body = str(text) ? runXml(str(text), presetRPr(cellXml)) : '';
  return '<w:tc>' + tcPr + '<w:p>' + pPr + body + '</w:p></w:tc>';
}

/* 逐行填表：命中标签格 → 写右侧相邻格 */
function fillRow(rowXml, plan) {
  const cells = [];
  rowXml.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, c => { cells.push(c); return c; });
  if (cells.length < 2) return rowXml;
  const out = cells.slice();
  for (let i = 0; i < cells.length - 1; i++) {
    const spec = plan[textOf(cells[i])];
    if (spec && str(spec.text)) out[i + 1] = buildCell(cells[i + 1], spec.text);
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

/* 抬头处理：**标题段原样不动**（表头字体/字号/加粗一律保留模板原样）；
 * 只把「年 月 日」那一段填成日期，并把该段按表格右边界右对齐（位置调整，不改字体与行距）。 */
function fillHeadLines(xml, rec) {
  const band = tableBand(xml);
  const d = str(rec && rec.applyDate) || str(rec && rec.workDate);
  const dateText = /^\d{4}-\d{1,2}-\d{1,2}/.test(d) ? fmtDateCn(d) : '';
  if (!dateText) return xml;
  return xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, p => {
    if (textOf(p) !== '年月日') return p;
    let pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    // 仅改缩进（对准表格左右边界）与对齐（右对齐），其余属性（字体/字号/行距）保持模板原样
    const ind = '<w:ind w:left="' + band.left + '" w:right="' + band.right + '"/>';
    pPr = /<w:ind\b[^>]*\/>/.test(pPr) ? pPr.replace(/<w:ind\b[^>]*\/>/, ind) : pPr.replace(/<\/w:pPr>$/, ind + '</w:pPr>');
    const jc = '<w:jc w:val="right"/>';
    pPr = /<w:jc\b[^>]*\/>/.test(pPr) ? pPr.replace(/<w:jc\b[^>]*\/>/, jc) : pPr.replace(/<\/w:pPr>$/, jc + '</w:pPr>');
    return '<w:p>' + pPr + runXml(dateText, presetRPr(p)) + '</w:p>';
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
