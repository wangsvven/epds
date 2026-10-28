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
 * 定版格式：LL-YYYYMMDD-NNN（3 位当日流水，位数可自然增长到 1000+）。
 * 解析同时接受无 LL- 前缀的历史测试期写法（YYYYMMDD-NNN），仅用于排序兼容，不再用于生成。
 * 同日排序口径：流水组（3 位及以上数字后缀，含残留旧 4 位流水）按数值升序 → 6 位时间后缀组按值升序 → 无法识别的排最后。
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
