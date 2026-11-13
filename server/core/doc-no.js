/* ========== core/doc-no ========== */
/* 单据编号公共规则（领料单 LL- / 出库单 OUT-），供 routes/materials 与冒烟脚本共用。
 *
 * 定版格式：前缀 + YYYYMMDD + '-' + 4 位当日流水（不足补零），业务日期即单号日期段。
 * 历史写法（只在解析/排序时兼容，不再产生）：无前缀 `20261028-001`、6 位时间后缀 `LL-20261024-123004`。
 *
 * 取号 nextDocNo：同类型 + 同日前缀下，只统计「未删除」单据，取最小未占用流水。
 * 排序 cmpDocNo：日期升序 → 流水组（4 位在前、6 位时间组在后）→ 流水数值升序，与前端 utils.js 的 cmpReqNo 同口径。
 */

// 单号解析：前缀可选、日期 8 位、流水为纯数字（位数不限）
const DOC_NO_RE = /^(?:(LL|OUT)-)?(\d{8})-(\d+)$/;

/** 拆解单号 → { prefix, date, width, grp, seq }；无法识别返回 null。
 *  grp：6 位后缀按「时间」语义分组（排在同日 4 位流水之后），与 public/js/utils.js 的 reqNoKey 逐字对齐。 */
function docNoKey(no) {
  const m = String(no == null ? '' : no).match(DOC_NO_RE);
  if (!m) return null;
  const suf = m[3];
  return { prefix: m[1] || '', date: m[2], width: suf.length, grp: suf.length === 6 ? 1 : 0, seq: parseInt(suf, 10) };
}

/** 单号升序比较：日期 → 流水组（4 位在前、6 位时间组在后）→ 流水数值；无法识别的排最后。 */
function cmpDocNo(a, b) {
  const ka = docNoKey(a), kb = docNoKey(b);
  if (!ka && !kb) return 0;
  if (!ka) return 1;
  if (!kb) return -1;
  if (ka.date !== kb.date) return ka.date < kb.date ? -1 : 1;
  if (ka.grp !== kb.grp) return ka.grp - kb.grp;
  if (ka.seq !== kb.seq) return ka.seq - kb.seq;
  return 0;
}

/** 取号：该单据类型 + 该业务日期前缀下，只统计「未删除」单据，取最小未占用的正整数流水。
 *  例：0001 在、0002 已删除、0003 已作废、0004 在 → 下一张 0002；补上后再下一张 0005。无空缺时等价于最大号 +1。
 *  超过 9999 位数自然增长。 */
function nextDocNo(list, field, prefix) {
  const used = new Set();
  for (const r of (list || [])) {
    if (!r || r.deleted) continue; // 已删除记录不占号（其原单号字段保持原值不动）
    const no = r[field];
    if (typeof no !== 'string' || no.indexOf(prefix) !== 0) continue;
    const suf = no.slice(prefix.length);
    if (/^\d+$/.test(suf)) used.add(parseInt(suf, 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return prefix + String(n).padStart(4, '0');
}

module.exports = { DOC_NO_RE, docNoKey, cmpDocNo, nextDocNo };
