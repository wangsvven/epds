/* ========== core/borrow-doc ========== */
/* 借工单 docx 生成：把借工记录按 13 个槽位顺序填进模板的 XXXX（零依赖，复用 core/util 的 zip 实现）。
 * 占位约定与 core/survey-doc 一致：模板 word/document.xml 内 13 处 XXXX，按顺序替换；多行值用段内
 * <w:br/> 断开（适配表格单元格）。与勘察模板不同：空值填空白（这是打印用的成品单据，不留 XXXX）。 */
const { listZipEntries, buildStoreZip } = require('./util');

const SLOT_COUNT = 13;
const DOC_ENTRY = 'word/document.xml';

function str(v) { return String(v == null ? '' : v).trim(); }
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// 多行文本 → 单元格内 <w:br/> 断行
function slotXml(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n')
    .map(xmlEscape).join('</w:t><w:br/><w:t xml:space="preserve">');
}

// 13 个槽位值（顺序 = 模板 XXXX 出现顺序）
function borrowSlots(rec) {
  const r = rec || {};
  const n = v => String(Number(v) || 0);
  return [
    str(r.unit),            // 1  往来单位
    str(r.direction),       // 2  方向
    str(r.externalUnit),    // 3  外协单位
    str(r.projectType),     // 4  项目类型
    str(r.projectName),     // 5  项目名称
    str(r.workContent),     // 6  工作内容
    str(r.applyDate),       // 7  申请日期
    str(r.workDate),        // 8  用工日期
    n(r.techCount),         // 9  技工
    n(r.workerCount),       // 10 民工
    n(r.vehicleCount),      // 11 车辆
    str(r.signStatus),      // 12 签单状态
    str(r.remark)           // 13 备注
  ];
}

/* 模板 buffer → 新 docx buffer（其余条目原样打包，不改模板文件本身） */
function buildBorrowDocx(templateBuf, rec) {
  const entries = listZipEntries(templateBuf);
  if (!entries.length) throw new Error('模板文件无法解析（不是有效的 docx）');
  const idx = entries.findIndex(e => e.name === DOC_ENTRY);
  if (idx < 0) throw new Error('模板缺少 ' + DOC_ENTRY);
  let xml = entries[idx].data.toString('utf8');
  const found = (xml.match(/XXXX/g) || []).length;
  if (found < SLOT_COUNT) {
    const err = new Error('借工单模板槽位不足（XXXX 共 ' + found + ' 处，应为 ' + SLOT_COUNT + ' 处）');
    err.code = 'TPL_SLOTS';
    throw err;
  }
  const slots = borrowSlots(rec);
  let from = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const at = xml.indexOf('XXXX', from);
    if (at < 0) break;
    const t = slots[i] ? slotXml(slots[i]) : '';   // 空值填空白
    xml = xml.slice(0, at) + t + xml.slice(at + 4);
    from = at + t.length;
  }
  const out = entries.slice();
  out[idx] = { name: DOC_ENTRY, data: Buffer.from(xml, 'utf8') };
  return { buffer: buildStoreZip(out), slots: found };
}

module.exports = { SLOT_COUNT, borrowSlots, buildBorrowDocx };
