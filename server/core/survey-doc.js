/* ========== core/survey-doc ========== */
/* 现场勘察记录 docx 生成：把 survey 数据按 17 个槽位顺序填进模板的 XXXX（零依赖，复用 core/util 的 zip 实现）。 */
const { listZipEntries, buildStoreZip } = require('./util');

const SLOT_COUNT = 17;                 // 模板 word/document.xml 里 XXXX 的固定处数
const DOC_ENTRY = 'word/document.xml';
const SCOPE_ALL = '全组';

function str(v) { return String(v == null ? '' : v).trim(); }
// 多行文本 → 去首尾空白、丢空行后的行数组
function lines(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(Boolean);
}
// XML 文本转义（& 必须最先替换）
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// 兜底：段落结构异常时，多行值退回「段内 <w:br/> 断开」的老做法
function slotXml(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').split('\n')
    .map(xmlEscape).join('</w:t><w:br/><w:t xml:space="preserve">');
}

// 小组数：只有「分2/3个小组」才算分组
function groupCount(sv) {
  const g = str(sv && sv.grouping);
  if (g === '分3个小组') return 3;
  if (g === '分2个小组') return 2;
  return 0;
}
// 工作地点 / 工作内容：分组时逐组「{i}小组：{值}」（跳过全空的组，全空回落总字段），不分组直接用总字段
function groupOrFallback(sv, key) {
  const n = groupCount(sv);
  if (!n) return lines(sv && sv[key]).join('\n');
  const gs = (sv && Array.isArray(sv.groups)) ? sv.groups : [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = lines((gs[i] || {})[key]).join('\n');
    if (!v) continue;
    out.push((i + 1) + '小组：' + v);
  }
  return out.length ? out.join('\n') : lines(sv && sv[key]).join('\n');
}
// 编号：survey.surveyNo 已是完整编号（部门+编号），直接用；
// 仅当它不以部门(班组)开头时才按旧规则拼一次（防御旧数据：4a 阶段存的是裸号）
function surveyNoText(plan, sv) {
  const team = str(sv.team) || str(plan && plan.team);
  let no = str(sv.surveyNo) || str(plan && plan.surveyNo);
  if (team && no && no.indexOf(team) !== 0) no = team + no;
  return no;
}
// 4.3：环境描述 + 每条危险点「（n）标题」，situation 非空接「：情况」
function hazardText43(sv) {
  const out = [];
  const env = lines(sv && sv.envDesc).join('\n');
  if (env) out.push(env);
  const hs = (sv && Array.isArray(sv.hazardPoints)) ? sv.hazardPoints : [];
  hs.forEach((h, i) => {
    const t = str(h && h.title);
    if (!t) return;
    const sit = str(h && h.situation);
    out.push('（' + (i + 1) + '）' + t + (sit ? '：' + sit : ''));
  });
  return out.join('\n');
}
// 4.4 班组措施槽（槽位 11）：只放班组措施本身；接地线已并入通用风险槽（见 groundMeasuresLines）
function teamMeasuresText(sv) {
  return lines(sv && sv.teamMeasures).join('\n');
}
// 接地线条目正文（不含标题行）：两块电压等级各自「分别在 / 逐行 / 验明确无电压后装设…各一组。」
//   分组且该行归属非「全组」时行尾加「（N小组）」；两个电压等级都没填 → 返回空数组（整条不输出）
function groundMeasuresLines(sv) {
  const grouped = groupCount(sv) > 0;
  const out = [];
  const block = (raw, scopes, kv) => {
    const arr = lines(raw);
    if (!arr.length) return;
    const sc = Array.isArray(scopes) ? scopes : [];
    out.push('分别在');
    arr.forEach((ln, i) => {
      const s = str(sc[i]);
      out.push(ln + ((grouped && s && s !== SCOPE_ALL) ? '（' + s + '）' : ''));
    });
    out.push('验明确无电压后装设' + kv + '接地线各一组。');
  };
  block(sv && sv.ground10, sv && sv.ground10Scopes, '10kV');
  block(sv && sv.ground04, sv && sv.ground04Scopes, '0.4kV');
  return out;
}
// 4.4 通用风险控制措施槽（槽位 12）：危险点措施（1..N）+ 末尾「（N+1）装设接地线的安全措施」及正文
function commonMeasuresText(sv) {
  const out = [];
  const hs = (sv && Array.isArray(sv.hazardPoints)) ? sv.hazardPoints : [];
  hs.forEach(h => {
    const t = str(h && h.title);
    if (!t) return;
    out.push('（' + (out.length + 1) + '）' + t + '的安全措施：' + str(h && h.measure));
  });
  const g = groundMeasuresLines(sv);
  if (g.length) {
    out.push('（' + (out.length + 1) + '）装设接地线的安全措施');
    g.forEach(x => out.push(x));
  }
  return out.join('\n');
}
// 勘察日期 → [年, 月, 日]（数字不补零）；空/非法回落当天
function dateParts(surveyDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(surveyDate));
  if (m && !isNaN(new Date(m[1] + '-' + m[2] + '-' + m[3]).getTime())) {
    return [String(+m[1]), String(+m[2]), String(+m[3])];
  }
  const d = new Date();
  return [String(d.getFullYear()), String(d.getMonth() + 1), String(d.getDate())];
}

// 17 个槽位值（顺序 = 模板 XXXX 出现顺序）
function surveySlots(plan, survey, recorder) {
  const sv = survey || {};
  const [y, m, d] = dateParts(sv.surveyDate);
  return [
    str(sv.surveyUnit),                              // 1 勘察单位
    str(sv.team) || str(plan && plan.team),          // 2 部门（班组）
    surveyNoText(plan, sv),                          // 3 编号（survey 里已是完整编号，直接用；未带部门前缀时才拼）
    str(sv.dualName),                                // 4 双重名称
    // 5 工作地点：取计划的作业地址原值（编辑器不再单独存「工作地点」）；
    //   计划无地址的老数据回落 survey.workLocation / 分组拼接，避免空白
    str(plan && plan.address) || groupOrFallback(sv, 'workLocation'),
    groupOrFallback(sv, 'workTask'),                 // 6 工作内容（= 编辑器「3.工作任务」合并框）
    str(sv.outageScope),                             // 7 4.1 停电范围
    str(sv.retainedLive),                            // 8 4.2 保留带电部位
    hazardText43(sv),                                // 9 4.3
    str(sv.opsMeasures),                             // 10 4.4 运维措施
    teamMeasuresText(sv),                            // 11 4.4 班组措施（只放措施本身）
    commonMeasuresText(sv),                          // 12 4.4 通用风险控制措施（危险点 + 接地线条目）
    '',                                              // 13 4.5 附图与说明
    str(recorder),                                   // 14 记录人
    y, m, d                                          // 15-17 勘察日期
  ];
}

// XXXX 所在段落的边界（段落内不会嵌套 <w:p>）
function paraRangeAt(xml, at) {
  const pStart = Math.max(xml.lastIndexOf('<w:p ', at), xml.lastIndexOf('<w:p>', at));
  if (pStart < 0) return null;
  const pEnd = xml.indexOf('</w:p>', at);
  if (pEnd < 0) return null;
  return { pStart, pEnd: pEnd + '</w:p>'.length };
}
// 多行值 → 把 XXXX 所在段落按行展开成 N 段：每段沿用原段落 pPr、XXXX 所在 run 的 rPr，
// 以及 run 里的固定前缀文字（如「工作内容：」），只把 XXXX 换成该行；第 2..N 段去掉重复的 w14:paraId。
function expandParagraph(xml, at, ls) {
  const r = paraRangeAt(xml, at);
  if (!r) return null;
  const openEnd = xml.indexOf('>', r.pStart);
  if (openEnd < 0 || openEnd > at) return null;
  const pOpen = xml.slice(r.pStart, openEnd + 1);
  let pPr = '';
  if (xml.startsWith('<w:pPr>', openEnd + 1)) {
    const e = xml.indexOf('</w:pPr>', openEnd + 1);
    if (e < 0 || e > at) return null;
    pPr = xml.slice(openEnd + 1, e + '</w:pPr>'.length);
  }
  const runStart = Math.max(xml.lastIndexOf('<w:r>', at), xml.lastIndexOf('<w:r ', at));
  const runEnd = xml.indexOf('</w:r>', at + 4);
  if (runStart < 0 || runStart < r.pStart || runEnd < 0) return null;
  const runOpen = xml.slice(runStart, at);              // <w:r><w:rPr>…</w:rPr><w:t …>
  const runClose = xml.slice(at + 4, runEnd + '</w:r>'.length);   // </w:t></w:r>
  const paraXml = xml.slice(r.pStart, r.pEnd);
  const pOpenNoId = pOpen.replace(/\s+w14:paraId="[^"]*"/g, '').replace(/\s+w14:textId="[^"]*"/g, '');
  let text = paraXml.slice(0, at - r.pStart) + xmlEscape(ls[0]) + paraXml.slice(at - r.pStart + 4);
  for (let i = 1; i < ls.length; i++) {
    text += pOpenNoId + pPr + runOpen + xmlEscape(ls[i]) + runClose + '</w:p>';
  }
  return { from: r.pStart, to: r.pEnd, text };
}
// 逐个按序替换 XXXX（只替换到 17 处，替换进来的文本不会被再次扫描）
//   空值：保留模板 XXXX（打印后手填）；只有槽位 10「运维人员措施」空值才替换为空字符串
//   多行：逐行成段（见 expandParagraph）
const EMPTY_KEEPS_XXXX_EXCEPT = 10;
function fillTemplate(xml, slots) {
  let out = xml;
  let from = 0;
  for (let i = 0; i < SLOT_COUNT; i++) {
    const at = out.indexOf('XXXX', from);
    if (at < 0) break;
    const raw = String(slots[i] == null ? '' : slots[i]);
    if (!raw && (i + 1) !== EMPTY_KEEPS_XXXX_EXCEPT) { from = at + 4; continue; }
    const ls = raw.replace(/\r\n?/g, '\n').split('\n');
    if (ls.length <= 1) {
      const t = xmlEscape(ls[0]);
      out = out.slice(0, at) + t + out.slice(at + 4);
      from = at + t.length;
      continue;
    }
    const exp = expandParagraph(out, at, ls);
    if (!exp) {                       // 兜底：段落结构异常时退回段内换行
      const t = slotXml(raw);
      out = out.slice(0, at) + t + out.slice(at + 4);
      from = at + t.length;
      continue;
    }
    out = out.slice(0, exp.from) + exp.text + out.slice(exp.to);
    from = exp.from + exp.text.length;
  }
  return out;
}

/* 模板 buffer → 新 docx buffer（其余条目原样打包，不改模板文件本身） */
function buildSurveyDocx(templateBuf, plan, survey, recorder) {
  const entries = listZipEntries(templateBuf);
  if (!entries.length) throw new Error('模板文件无法解析（不是有效的 docx）');
  const idx = entries.findIndex(e => e.name === DOC_ENTRY);
  if (idx < 0) throw new Error('模板缺少 ' + DOC_ENTRY);
  const xml = entries[idx].data.toString('utf8');
  const found = (xml.match(/XXXX/g) || []).length;
  if (found < SLOT_COUNT) {
    const err = new Error('模板槽位不足（XXXX 共 ' + found + ' 处，应为 ' + SLOT_COUNT + ' 处）');
    err.code = 'TPL_SLOTS';
    throw err;
  }
  const filled = fillTemplate(xml, surveySlots(plan, survey, recorder));
  const out = entries.slice();
  out[idx] = { name: DOC_ENTRY, data: Buffer.from(filled, 'utf8') };
  return { buffer: buildStoreZip(out), slots: found };
}

module.exports = { SLOT_COUNT, surveySlots, fillTemplate, buildSurveyDocx };
