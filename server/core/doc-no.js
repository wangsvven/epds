/* ========== core/doc-no ========== */
/* 单据编号公共规则（领料单 LL- / 出库单 OUT-），供 routes/materials 与冒烟脚本共用。
 *
 * 定版格式：前缀 + YYYYMMDD + '-' + 4 位当日流水（不足补零），业务日期即单号日期段。
 * 历史写法（只在解析/排序时兼容，不再产生）：无前缀 `20261028-001`、6 位时间后缀 `LL-20261024-123004`。
 *
 * 三条规则（2026-11-13 晚定版，覆盖此前「作废不回收」与「删除补缺」两版）：
 *  1) 取号 nextDocNo：同类型 + 同日前缀下，只统计「未删除」单据，取最小未占用流水（删除后对齐前仍有空缺时补缺；无空缺即末尾 +1）。
 *  2) 删除对齐 alignPlan：删除一张后，同类型 + 同单号日期 + 同位数格式的活单按现有流水顺序重编为 1..n，
 *     被改号的单据单号前移；已删除记录单号保持原值（审计留痕，允许与活单同号，靠 id 区分）。
 *  3) 引用同步 refPatchPlan：单号是「显示缓存」的字段（correctedFromNo / correctedByNo）同步改写为新号，保持指向同一单据。
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

/** 单号升序比较：日期 → 流水组（4 位在前、6 位时间组在后）→ 流水数值；无法识别的排最后。
 *  与 public/js/utils.js 的 cmpReqNo 同口径（同一份语义，前端列表与后端排序不会打架）。 */
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

/**
 * 列表排序（2026-11-13 22:18 定版）：当天组置顶 → 日期升序 → 同日内流水升序。
 * today 必须是「服务端业务日期」（routes 侧的 todayBizDate()，与前端 ServerTime.ymd() 同源）。
 * 与 public/js/utils.js 的 cmpReqNoTop 同口径——两处规则文字、行为必须一致。
 * 例：today=13 日 → 13-0001…13-0004 置顶，其下 11-0001、11-0002、12-0001；到 14 日 13 组落回升序位置。
 */
function cmpDocNoTopToday(a, b, today) {
  const ka = docNoKey(a), kb = docNoKey(b);
  if (!ka && !kb) return 0;
  if (!ka) return 1;   // 无法识别的单号排最后
  if (!kb) return -1;
  const t = String(today || '').replace(/-/g, '');   // 允许传 YYYY-MM-DD 或 YYYYMMDD
  const ta = !!t && ka.date === t, tb = !!t && kb.date === t;
  if (ta !== tb) return ta ? -1 : 1;          // 当天组整组置顶
  if (ka.date !== kb.date) return ka.date < kb.date ? -1 : 1;
  if (ka.grp !== kb.grp) return ka.grp - kb.grp;
  return ka.seq - kb.seq;
}

/** 删除后的对齐计划（不改数据，只算）：返回 { changes: [{ rec, field, from, to }], skipped }
 *  - 只处理「同类型 + 同单号日期 + 同位数」的活单，按当前流水升序重编为 1..n；
 *  - 位数保持该组原有格式（现行 4 位补零）；
 *  - 6 位时间后缀（历史 legacy 写法，其后缀是时间而非流水）整组跳过，不参与重编（skipped='legacy-6'）。 */
function alignPlan(list, field, deletedRec) {
  const dk = docNoKey(deletedRec && deletedRec[field]);
  if (!dk) return { changes: [], skipped: 'unparsable' };
  if (dk.width === 6) return { changes: [], skipped: 'legacy-6' };
  const rows = (list || []).filter(r => {
    if (!r || r.deleted || r === deletedRec) return false;
    const k = docNoKey(r[field]);
    return !!k && k.date === dk.date && k.width === dk.width;
  }).sort((a, b) => {
    const ka = docNoKey(a[field]), kb = docNoKey(b[field]);
    if (ka.seq !== kb.seq) return ka.seq - kb.seq;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const changes = [];
  rows.forEach((r, i) => {
    const cur = String(r[field]);
    const target = String(i + 1).padStart(dk.width, '0');
    if (cur.slice(cur.length - dk.width) === target) return;
    changes.push({ rec: r, field, from: cur, to: cur.slice(0, cur.length - dk.width) + target });
  });
  return { changes, skipped: '' };
}

/** 引用同步计划：把 correctedFromNo / correctedByNo 里等于「旧号」的值改成「新号」。
 *  这些字段是单号的显示缓存（*No 后缀），真实关联走 id（correctedFrom / correctedBy），改号后必须同步，否则详情会指错单。 */
const DOC_NO_REF_FIELDS = ['correctedFromNo', 'correctedByNo'];
function refPatchPlan(lists, changes) {
  const map = {};
  (changes || []).forEach(c => { map[c.from] = c.to; });
  const out = [];
  (lists || []).forEach(list => (list || []).forEach(rec => {
    if (!rec) return;
    DOC_NO_REF_FIELDS.forEach(f => {
      const v = rec[f];
      if (typeof v !== 'string' || !v) return;
      if (!map[v]) return;
      out.push({ rec, field: f, from: v, to: map[v] });
    });
  }));
  return out;
}

module.exports = { DOC_NO_RE, DOC_NO_REF_FIELDS, docNoKey, cmpDocNo, cmpDocNoTopToday, nextDocNo, alignPlan, refPatchPlan };
