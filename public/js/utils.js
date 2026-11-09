/* ========== js/utils ========== */
/* 纯工具与共享常量：tagType、材料分桶 MAT_* / matBucketOf、包名与单位换算 MAT_PKG_LABEL / MAT_UNIT_TO_KM / matUnitToKm / fmtKm。 */
function tagType(val) {
  if (['进行中', '已发放', '成功', '已出库', '全部到库', '已完成', '已归还'].includes(val)) return 'success';
  if (['未开工', '未到库', '待审批', '待审核', '未开始', '编制中'].includes(val)) return 'warning';
  if (['部分到库'].includes(val)) return 'primary';
  return 'info';
}

/* ---------------- 材料分桶（电杆 / 导线 / 设备 / 金具及铁附件）：项目页与工程实际施工共用 ---------------- */
const MAT_POLE_RE = /电杆|预应力|方杆|水泥杆|钢管杆|等径杆|锥形杆|混凝土杆/;
const MAT_CABLE_RE = new RegExp('\\b(?:' + [
  'GJX?', 'LGJX?', 'LGJF', 'LJ', 'TJ', 'JL\\s*\\/\\s*G[1-3][AB]?',
  'JKLYJ\\/B', 'JKLYJ', 'JKLGYJ', 'JKLY', 'JKLV', 'JKYJ',
  'YJLV22', 'YJV22', 'YJLV32', 'YJV32', 'YJLV', 'YJV', 'YJLY', 'YJY',
  'VLV', 'VV',
  'BVV', 'BVVB', 'BLVV', 'BVR', 'BV', 'BLV', 'BXR', 'BLX', 'BX',
  'RVVP', 'RVV', 'RVS', 'RV',
  'KVVP', 'KVV', 'KYJV', 'OPGW', 'ADSS'
].join('|') + ')', 'i');
const MAT_DEVICE_RE = /变压器|JP\s*柜|配电箱|开关|熔断器|断路器|避雷器|互感器|集中器|环网柜|分支箱/;
const MAT_FITTING_RE = /金具|铁附件|抱箍|托箍|横担|托担|挂环|挂板|碗头|球头|联板|线夹|并沟|楔形|耐张|悬垂|压接管|接续管|拉线棒|拉线盘|撑铁|垫铁|斜撑|撑脚|螺杆|螺丝|螺栓|穿钉|桩头|保护套|护套|绝缘罩|防盗锁|标识牌|标识管|相序牌|警示牌|标志|接线端子|接地环|接地线|接地体|接地铁|门型架|槽钢|夹铁|防震锤|绝缘子|瓷瓶|电缆头|脚钉|爬梯|卡盘|底盘|支架/;
function matBucketOf(desc) {
  const s = String(desc || '');
  if (MAT_POLE_RE.test(s)) return 'pole';
  if (MAT_CABLE_RE.test(s)) return 'cable';
  if (MAT_FITTING_RE.test(s)) return 'fitting'; // 先于设备：避免被「熔断器 / 变压器 / JP柜 / 避雷器」字样误吞
  if (MAT_DEVICE_RE.test(s)) return 'device';
  return 'fitting'; // 其余统一归「金具及铁附件」
}

/* ---------------- 材料包名与单位换算 ----------------
 * 电杆=根、导线=千米、设备=台、金具及铁附件=件（包口径）。
 * 材料明细里导线类多以「m（米）」计量，而包口径是「千米」，展示/汇总时按 1 千米 = 1000 米 折算；
 * 钢绞线等以 kg 计量的条目无法折算成千米，单独提示，不混进千米合计。 */
const MAT_PKG_LABEL = { pole: '电杆', cable: '导线', device: '设备', fitting: '金具及铁附件' };
const MAT_UNIT_TO_KM = { m: 0.001, '米': 0.001, km: 1, '千米': 1, '公里': 1 };
function matUnitToKm(qty, unit) {
  const f = MAT_UNIT_TO_KM[String(unit == null ? '' : unit).trim().toLowerCase()];
  return f === undefined ? null : (Number(qty) || 0) * f;
}
function fmtKm(n) {
  const v = Math.round((Number(n) || 0) * 1000) / 1000;
  return String(v);
}

/* ---------------- 领料单号解析与排序（材料台账领料单列表用） ----------------
 * 定版格式：LL-YYYYMMDD-NNNN（4 位当日流水，从 0001 起，位数可自然增长到 10000+）。
 * 解析同时接受无 LL- 前缀的历史测试期写法（YYYYMMDD-NNN），仅用于排序兼容，不再用于生成。
 * 同日排序口径：流水组（非 6 位数字后缀，含历史 3 位流水）按数值升序 → 6 位时间后缀组按值升序 → 无法识别的排最后。
 * 纯函数、无依赖；window.MaterialNo 供冒烟脚本（vm 加载）与前端共用。 */
function reqNoKey(no) {
  const s = String(no == null ? '' : no);
  const m = s.match(/^(?:LL-)?(\d{8})-(\d+)$/);
  if (!m) return null;
  const suf = m[2];
  // 6 位数字后缀按「时间」语义处理，其余（3/4/5/7+ 位）按「流水」语义
  return { date: m[1], grp: suf.length === 6 ? 1 : 0, seq: parseInt(suf, 10) };
}
function cmpReqNo(a, b) {
  const ka = reqNoKey(a), kb = reqNoKey(b);
  if (!ka && !kb) return 0;
  if (!ka) return 1; // 无法识别的单号排最后
  if (!kb) return -1;
  if (ka.date !== kb.date) return ka.date < kb.date ? -1 : 1;
  if (ka.grp !== kb.grp) return ka.grp - kb.grp;
  if (ka.seq !== kb.seq) return ka.seq - kb.seq;   // 数值比较：流水位数会变长
  return 0;
}
if (typeof window !== 'undefined') window.MaterialNo = { key: reqNoKey, cmp: cmpReqNo };

/* ---------------- 物料简称（领料单列表「物料描述」列用） ----------------
 * 目标：只保留物料名称主体，去掉后面的型号 / 规格 / 参数。
 * 例：直角挂板Z-7 → 直角挂板；预应力混凝土电杆(Z)Φ190×12M×GY（法兰）→ 预应力混凝土电杆；
 *    低压JP柜50kVA（双回、无补偿）→ 低压JP柜；10kV氧化锌避雷器HY5WS-17/50 → 10kV氧化锌避雷器。
 * 做法：从左向右扫描，中文 / 中文标点 / 名称型拉丁前缀（PVC、JP、10kV、2.1m，后面紧跟中文）属于名称；
 *      遇到规格符号（Φ □ ∠ × 等）、英文数字型号串、非中文括注即截断；纯中文括注（如「耐张双杆」）保留。
 * 纯函数、无依赖；window.MatName 供冒烟脚本（vm 加载）与前端共用。 */
const MAT_NAME_CJK = /[\u3400-\u9fff\u3007\u2160-\u217f]/;            // 汉字 / 〇 / Ⅰ-Ⅻ
const MAT_NAME_PUNCT = /[，、·：；]/;                                   // 名称内部允许的中文标点
const MAT_SPEC_CHAR = /[Φφ□∠［\[×∽=*＊²]/;                            // 规格起始符号
const MAT_OPEN = /[（(]/, MAT_CLOSE = /[）)]/;
const MAT_PREFIX_UNIT = /^\d+(?:\.\d+)?(?:kV|KV|kVA|KVA|m|mm|M)$/;    // 「10kV」「2.1m」这类量词前缀
const MAT_PREFIX_LATIN = /^[A-Za-z]{1,5}$/;                            // 「PVC」「JP」「U」「ZBG」
function matShortName(desc) {
  const s = String(desc == null ? '' : desc).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (MAT_NAME_CJK.test(c) || MAT_NAME_PUNCT.test(c)) { i++; continue; }
    // 名称中间的空格：后面还跟中文才保留（如「M垫铁 隔离刀闸」）
    if (c === ' ') { if (i + 1 < n && MAT_NAME_CJK.test(s[i + 1])) { i++; continue; } break; }
    if (MAT_OPEN.test(c)) {
      let j = i + 1;
      while (j < n && !MAT_CLOSE.test(s[j])) j++;
      const inner = s.slice(i + 1, j);
      const chineseOnly = inner.length > 0 && inner.length <= 14
        && /^[\u4e00-\u9fff，、·：；\s]+$/.test(inner);
      if (chineseOnly) { i = j < n ? j + 1 : n; continue; }
      break;                                                            // 非中文括注 = 型号 / 规格
    }
    if (MAT_SPEC_CHAR.test(c)) break;
    if (/[A-Za-z0-9]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9.\/+\-]/.test(s[j])) j++;
      const tok = s.slice(i, j);
      const followedByCJK = j < n && MAT_NAME_CJK.test(s[j]);
      const isPrefix = followedByCJK && tok.length <= 8
        && (MAT_PREFIX_LATIN.test(tok) || MAT_PREFIX_UNIT.test(tok));
      if (isPrefix) { i = j; continue; }
      break;                                                            // 型号串起点
    }
    break;
  }
  const name = s.slice(0, i).replace(/[\s，、·：；]+$/, '').trim();
  return name || s;                                                      // 纯型号描述时原样兜底
}
// 领料单明细 → 去重后的物料简称列表
function matNamesOf(items) {
  const out = [];
  (items || []).forEach(it => {
    const name = matShortName(it && it.description);
    if (name && out.indexOf(name) < 0) out.push(name);
  });
  return out;
}
if (typeof window !== 'undefined') window.MatName = { short: matShortName, list: matNamesOf };

/* 作业人员派生状态（准入到期预警的唯一口径，前后端需要处与冒烟共用同一份代码）。
   只计算、不写库：todayStr 由调用方按北京时间传 YYYY-MM-DD（ServerTime.ymd() / bjStr()）。
   - 存储状态 待定 → 派生 待定（不参与预警）
   - 存储状态 已退场 → 派生 已退场（不参与预警、不可被选人；由名单「退场」按钮写入）
   - 存储状态 已准入 且有效期结束日 < 今天 → 派生 待定（超期自动转）
   - 有效期为空 → 不触发自动转换，按存储状态
   - 到期距离 days = 结束日 - 今天（自然日）；结束日当天 0，次日起为负 */
function workerStatusOf(w, todayStr) {
  const stored = String((w && w.status) || '已准入').trim();
  const today = String(todayStr || '').slice(0, 10);
  const end = String((w && w.validEnd) || '').trim().slice(0, 10);
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  let days = null;
  if (end && dayRe.test(end) && dayRe.test(today)) {
    days = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  }
  const overdue = stored === '已准入' && days !== null && days < 0;
  const warn = stored === '已准入' && days !== null && days >= 0 && days <= 30;
  const derived = stored === '已退场' ? '已退场'
    : ((stored === '待定' || overdue) ? '待定' : '已准入');
  return {
    stored, derived, days,
    overdueDays: overdue ? -days : 0,
    warn, overdue,
    highlight: warn || overdue,
    admitted: derived === '已准入'
  };
}

/* 首页公告栏：汇总存储状态为已准入且（0–30 天内到期或已超期）的人员。
   超期排最前，其余按到期日升序；只派生不落库。 */
function workerAlerts(list, todayStr) {
  const out = [];
  (list || []).forEach(w => {
    if (!w || w.deleted) return;
    const s = workerStatusOf(w, todayStr);
    if (s.stored !== '已准入' || !(s.warn || s.overdue)) return;
    out.push({
      id: w.id, name: String(w.name || ''), team: String(w.team || ''),
      validEnd: String(w.validEnd || ''), days: s.days,
      overdueDays: s.overdueDays, overdue: s.overdue
    });
  });
  out.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const d = a.validEnd.localeCompare(b.validEnd);
    return d || a.name.localeCompare(b.name);
  });
  return out;
}
if (typeof window !== 'undefined') window.WorkerStatus = { of: workerStatusOf, alerts: workerAlerts };
