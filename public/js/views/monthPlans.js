/* ========== views/monthPlans ========== */
/* 月计划管理面板（检修口径，定稿版）：22 字段表单 + 关联项目带出 + 停电时户数计算 +
   导入预览判重 + 导出 + 状态流转。
   数据仍在 workPlans 集合（planType='月计划'），不新增后端接口：
   导入用浏览器端 xlsx 解析 + 逐条 POST /api/workPlans，导出用浏览器端 xlsx 生成。 */

const MP_VOLTAGES = ['0.4kV', '10kV', '35kV'];
const MP_DEVICE_TYPES = ['配网支线', '配网主线', '不涉及'];
const MP_WORK_TYPES = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
const MP_GRID_RISKS = ['无', '一级', '二级', '三级', '四级', '五级', '六级', '七级', '八级'];
const MP_RISK_LEVELS = ['无', 'I', 'II', 'III', 'IV', 'V'];
const MP_STATUS = ['未执行', '已执行', '已结算', '已归档', '已取消'];
/* 22 个表单字段（键名沿用草稿/既有字段；新增键名见汇报清单） */
const MP_COLS = [
  { key: 'opsUnit', label: '运维单位' },
  { key: 'maintUnit', label: '检修单位' },
  { key: 'project', label: '关联项目' },
  { key: 'projectName', label: '涉及工程项目' },
  { key: 'maintDevice', label: '检修设备' },
  { key: 'voltage', label: '电压等级' },
  { key: 'deviceType', label: '设备类型' },
  { key: 'outageStart', label: '计划停电开始' },
  { key: 'outageEnd', label: '计划停电结束' },
  { key: 'workTime', label: '计划工作时间' },
  { key: 'workType', label: '检修类型' },
  { key: 'maintContent', label: '检修内容' },
  { key: 'affectArea', label: '影响用户和区域' },
  { key: 'transformerCount', label: '停电涉及中压配变数' },
  { key: 'outageHouseholds', label: '停电时户数' },
  { key: 'importantUsers', label: '涉及重要电力用户名称' },
  { key: 'gridRisk', label: '电网风险等级' },
  { key: 'riskLevel', label: '作业风险等级' },
  { key: 'outageCount2m', label: '近2月停电次数' },
  { key: 'outageCountYear', label: '本年度停电次数' },
  { key: 'planNote', label: '备注' },
  { key: 'leader', label: '班组长' }
];
/* 导入表头识别：模板 20 列（含「计划停电时间」）与旧版导出（含「计划停电开始/结束」）都支持，
   见 setup() 里的 MP_HEADER_MAP；缺列按默认值补。 */

/* 纯函数（页面与冒烟共用，避免两处漂移） */
const MonthPlanCalc = {
  pad2(n) { return String(n).padStart(2, '0'); },
  // 解析 'YYYY-MM-DD HH:mm[:ss]'（也容错 T 分隔与纯日期）为本地时间；失败返回 null
  parse(v) {
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 0, 0, 0);
    return null;
  },
  md(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; },
  hhmm(d) { return this.pad2(d.getHours()) + ':' + this.pad2(d.getMinutes()); },
  // 停电时长（小时，保留 2 位，可带小数）
  hours(start, end) {
    const s = this.parse(start), e = this.parse(end);
    if (!s || !e) return 0;
    const h = (e.getTime() - s.getTime()) / 3600000;
    return h > 0 ? Math.round(h * 100) / 100 : 0;
  },
  // 计划工作时间：「M月D日-M月D日HH:mm-HH:mm」，开始+30 分钟、结束−30 分钟，两段日期各取自身年月日
  genWorkTime(start, end) {
    const s = this.parse(start), e = this.parse(end);
    if (!s || !e) return '';
    const s2 = new Date(s.getTime() + 30 * 60000);
    const e2 = new Date(e.getTime() - 30 * 60000);
    return this.md(s2) + '-' + this.md(e2) + this.hhmm(s2) + '-' + this.hhmm(e2);
  },
  // 停电时户数 = 中压配变数 × 停电时长（小时），四舍五入取整；配变数为空 → ''
  households(count, start, end) {
    const raw = String(count == null ? '' : count).trim();
    if (!raw) return '';
    const n = Number(raw);
    if (!isFinite(n)) return '';
    const h = this.hours(start, end);
    if (!h) return '';
    return Math.round(n * h);
  },
  // 判重：同一导入年份内，检修设备 + 计划停电开始 相同 → 疑似重复；范围 = 已入库同年 + 本文件自重复
  judge(parsed, existing, year) {
    const yr = String(year || '');
    const pool = (existing || [])
      .filter(p => String(p.outageStart || '').startsWith(yr))
      .sort((a, b) => String(a.outageStart || '').localeCompare(String(b.outageStart || '')));
    const existKey = new Map();
    pool.forEach((p, i) => { const k = this.keyOf(p); if (!existKey.has(k)) existKey.set(k, i + 1); });
    const seen = new Map();
    (parsed || []).forEach((o, i) => {
      const k = this.keyOf(o);
      if (existKey.has(k)) o.verdict = '疑似重复（与已入库第 ' + existKey.get(k) + ' 条撞键）';
      else if (seen.has(k)) o.verdict = '疑似重复（与本文件第 ' + seen.get(k) + ' 行重复）';
      else o.verdict = '新增';
      if (!seen.has(k)) seen.set(k, o.__row || i + 2);
    });
    return parsed;
  },
  // 表单必填校验（前端与冒烟共用）：返回 { 字段: 提示 }，全通过时各值为 ''
  validate(f) {
    const g = f || {};
    const out = { maintDevice: '', workType: '', outageStart: '', outageEnd: '' };
    const s = String(g.outageStart == null ? '' : g.outageStart).trim();
    const e = String(g.outageEnd == null ? '' : g.outageEnd).trim();
    if (!String(g.maintDevice || '').trim()) out.maintDevice = '请填写检修设备';
    if (!String(g.workType || '').trim()) out.workType = '请选择检修类型';
    if (!s) out.outageStart = '请选择计划停电开始时间';
    if (!e) out.outageEnd = '请选择计划停电结束时间';
    if (s && e && e < s) out.outageEnd = '计划停电结束时间不能早于开始时间';
    return out;
  },
  keyOf(o) { return String((o && o.maintDevice) || '').trim() + '||' + String((o && o.outageStart) || '').trim(); },
  /* 模板「计划停电时间」文本 → 起止时间（YYYY-MM-DD HH:mm:00）；year 由「导入年份」给。
     支持：M月D日HH:mm-M月D日HH:mm（连续停电）、M月D日HH:mm-HH:mm（同日）、
     M月D日-M月D日HH:mm-HH:mm（白停夜送/夜投，日期段+时间段）。无法识别返回 null。 */
  parseOutageText(text, year) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const y = Number(year) || (new Date()).getFullYear();
    // 去掉「（白停夜送）」这类括注，统一分隔符与空白
    const s = raw.replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '').replace(/[~～至—–]/g, '-');
    const p2 = n => String(n).padStart(2, '0');
    const mk = (m, d, hh, mm) => y + '-' + p2(m) + '-' + p2(d) + ' ' + p2(hh) + ':' + p2(mm) + ':00';
    let m = /^(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})-(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})$/.exec(s);
    if (m) return { start: mk(m[1], m[2], m[3], m[4]), end: mk(m[5], m[6], m[7], m[8]) };
    m = /^(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(s);
    if (m) return { start: mk(m[1], m[2], m[3], m[4]), end: mk(m[1], m[2], m[5], m[6]) };
    m = /^(\d{1,2})月(\d{1,2})日-(\d{1,2})月(\d{1,2})日(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(s);
    if (m) return { start: mk(m[1], m[2], m[5], m[6]), end: mk(m[3], m[4], m[7], m[8]) };
    return null;
  }
};
if (typeof window !== 'undefined') window.MonthPlanCalc = MonthPlanCalc;

const MonthPlansPanel = {
  props: {
    tab: { type: String, default: 'month' },              // month | archived
    projectScope: { type: Array, default: () => [] }      // 项目详情「查看月计划」带入的项目范围
  },
  // 「新增周计划」交给父组件（PlansPanel）打开周计划表单并带入本行内容
  emits: ['make-week'],
  setup(props, { emit }) {
    const { ref, reactive, computed, onMounted, watch } = Vue;
    const list = ref([]);
    const loading = ref(false);
    const filters = reactive({ areaStation: '', workType: '', leader: '', startDate: '', endDate: '', keyword: '' });
    const page = ref(1);
    const pageSize = ref(20);
    const projects = ref([]);
    const substations = ref([]);
    const units = ref([]);
    const leaderAccounts = ref([]);
    const importYear = ref(String(ServerTime.year()));

    const yearOpts = computed(() => {
      const y = ServerTime.year();
      return [y - 1, y, y + 1].map(String);
    });
    const uniq = arr => Array.from(new Set(arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean)));
    const hist = key => uniq(list.value.map(p => p[key]));
    const areaOpts = computed(() => uniq([...substations.value, ...hist('areaStation')]));
    const maintUnitOpts = computed(() => uniq([...units.value, ...substations.value, ...hist('maintUnit')]));
    const leaderOpts = computed(() => uniq([...leaderAccounts.value, ...hist('leader')]));
    const workTypeOpts = computed(() => uniq([...MP_WORK_TYPES, ...hist('workType')]));
    const deviceTypeOpts = computed(() => uniq([...MP_DEVICE_TYPES, ...hist('deviceType')]));
    const voltageOpts = computed(() => MP_VOLTAGES.slice());
    const projectOpts = computed(() => uniq(projects.value.map(p => p.name)));

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/api/workPlans');
        const arr = Array.isArray(r) ? r : (r.data || []);
        list.value = arr.filter(p => p && p.planType === '月计划' && !p.deleted)
          .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    async function loadOptions() {
      try {
        const [ps, ss, un, us] = await Promise.all([
          api.get('/api/projects'), api.get('/api/substations'), api.get('/api/units'), api.get('/api/users')
        ]);
        projects.value = (ps || []).filter(x => x && !x.deleted);
        substations.value = (ss || []).filter(x => x && !x.deleted).map(x => x.name);
        units.value = (un || []).filter(x => x && !x.deleted).map(x => x.name);
        leaderAccounts.value = (us || []).filter(u => u && u.userGroup === '班组长' && u.status !== '停用').map(u => u.name);
      } catch (e) { /* 选项加载失败不阻断主流程 */ }
    }

    /* ---------------- 列表 / 筛选 / 分页 ---------------- */
    const tabList = computed(() => props.tab === 'archived'
      ? list.value.filter(p => p.status === '已归档')
      : list.value.filter(p => p.status === '未执行'));

    const filtered = computed(() => tabList.value.filter(p => {
      if (props.projectScope && props.projectScope.length) {
        const hitScope = props.projectScope.includes(p.project) || props.projectScope.includes(p.projectName);
        if (!hitScope) return false;
      }
      if (filters.areaStation && (p.areaStation || '') !== filters.areaStation) return false;
      if (filters.workType && (p.workType || '') !== filters.workType) return false;
      if (filters.leader && (p.leader || '') !== filters.leader) return false;
      const d = String(p.outageStart || '').slice(0, 10);
      if (filters.startDate && (!d || d < filters.startDate)) return false;
      if (filters.endDate && (!d || d > filters.endDate)) return false;
      const kw = filters.keyword.trim();
      if (kw) {
        const hay = [p.projectName, p.maintDevice, p.maintUnit].map(x => String(x || '')).join(' ');
        if (!hay.includes(kw)) return false;
      }
      return true;
    }));
    const maxPage = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    watch(() => filtered.value.length, () => { if (page.value > maxPage.value) page.value = maxPage.value; });

    const idxBase = i => (page.value - 1) * pageSize.value + i + 1;
    function fmtRange(a, b) {
      const s = String(a || '').trim(), e = String(b || '').trim();
      if (!s && !e) return '—';
      const sd = s.slice(0, 10), ed = e.slice(0, 10);
      if (s && e && sd === ed) return sd + ' ' + s.slice(11, 16) + ' ~ ' + e.slice(11, 16);
      if (s && e) return s.slice(0, 16) + ' ~ ' + e.slice(0, 16);
      return (s || e).slice(0, 16);
    }
    const normDT = v => {
      const s = String(v == null ? '' : v).trim();
      return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s) ? s + ':00' : s;
    };

    /* ---- 列表时间列：日期、时分分两行显示，日期段同月只写一次「月」，保证不截断 ---- */
    const dayParts = v => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v == null ? '' : v).trim());
      return m ? { y: m[1], m: Number(m[2]), d: Number(m[3]) } : null;
    };
    const mdText = p => p.m + '月' + p.d + '日';
    // 日期段：同日→「11月1日」；同月→「11月1日-30日」；跨月→「11月1日-12月3日」
    function compactDay(a, b) {
      const s = dayParts(a), e = dayParts(b);
      if (!s && !e) return '—';
      if (!s || !e) return mdText(s || e);
      if (s.m === e.m && s.d === e.d) return mdText(s);
      if (s.m === e.m) return s.m + '月' + s.d + '日-' + e.d + '日';
      return mdText(s) + '-' + mdText(e);
    }
    const clockText = v => String(v == null ? '' : v).trim().slice(11, 16);
    function outageDay(a, b) { return compactDay(a, b); }
    function outageClock(a, b) {
      const s = clockText(a), e = clockText(b);
      if (!s || !e) return s || e || '';
      return s + '-' + e;
    }
    // 已入库的「11月1日-11月30日19:57-20:57」同样压缩日期段
    const compactDayStr = d => {
      const m = /^(\d{1,2})月(\d{1,2})日-(\d{1,2})月(\d{1,2})日$/.exec(String(d || '').trim());
      if (!m) return d;
      const [m1, d1, m2, d2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
      if (m1 === m2 && d1 === d2) return m1 + '月' + d1 + '日';
      if (m1 === m2) return m1 + '月' + d1 + '日-' + d2 + '日';
      return d;
    };
    /* 计划工作时间是入库时的整串（如「11月1日-11月30日19:57-20:57」），按最后一个「日」切成日期段 + 时间段；
       也兼容「2026-11-01 08:00」这种旧数据 */
    function splitWork(v) {
      const s = String(v == null ? '' : v).trim();
      if (!s) return { d: '—', h: '' };
      const i = s.lastIndexOf('日');
      if (i >= 0) return { d: compactDayStr(s.slice(0, i + 1)), h: s.slice(i + 1).trim() };
      const m = /^(\d{4}-\d{2}-\d{2})[ T]?(\d{2}:\d{2})?/.exec(s);
      if (m) return { d: compactDay(m[1], ''), h: m[2] || '' };
      return { d: s, h: '' };
    }
    const workDay = v => splitWork(v).d;
    const workClock = v => splitWork(v).h;

    const badgeClass = st => ({ '未执行': 'mp-b-new', '已执行': 'mp-b-run', '已结算': 'mp-b-done', '已归档': 'mp-b-arc', '已取消': 'mp-b-can' }[st] || 'mp-b-new');

    /* ---------------- 新增 / 编辑 / 查看 ---------------- */
    const dlg = reactive({ visible: false, editingId: '', busy: false, readonly: false, form: null });
    const errors = reactive({ maintDevice: '', outageStart: '', outageEnd: '', workType: '' });
    const derived = reactive({ maintUnit: false, projectName: false, leader: false });   // 「自动带出」pill，仅会话态
    const workTimeTouched = ref(false);

    function blankForm() {
      return {
        opsUnit: '', maintUnit: '', project: '', projectName: '', maintDevice: '',
        voltage: '10kV', deviceType: '', outageStart: '', outageEnd: '', workTime: '',
        workType: '配农网工程', maintContent: '', affectArea: '', transformerCount: '',
        outageHouseholds: '', importantUsers: '无', gridRisk: '无', riskLevel: 'IV',
        outageCount2m: '', outageCountYear: '', planNote: '', leader: '', status: '未执行'
      };
    }
    function clearErrors() { Object.keys(errors).forEach(k => { errors[k] = ''; }); }
    function resetDerived() { derived.maintUnit = false; derived.projectName = false; derived.leader = false; }

    function openAdd() {
      dlg.editingId = ''; dlg.readonly = false; dlg.form = blankForm();
      resetDerived(); workTimeTouched.value = false; clearErrors(); dlg.visible = true;
    }
    function openEdit(row) {
      dlg.editingId = row.id; dlg.readonly = false;
      const f = blankForm();
      f.id = row.id;                                          // 查看弹窗里的状态流转要用 id
      Object.keys(f).forEach(k => { if (row[k] !== undefined && row[k] !== null) f[k] = row[k]; });
      if (!f.projectName && row.project) f.projectName = row.project;   // 老记录没有 projectName 时兜底
      dlg.form = f;
      resetDerived();                                        // 编辑既有记录不显示「自动带出」
      workTimeTouched.value = !!String(f.workTime || '').trim();
      clearErrors(); dlg.visible = true;
    }
    function openView(row) { openEdit(row); dlg.readonly = true; }
    function warn(msg) { ElementPlus.ElMessage.warning(msg); }

    /* 关联项目带出：涉及工程项目=项目名、检修单位=项目分包（施工）单位、班组长=项目班组长 */
    function onProjectChange(name) {
      const p = projects.value.find(x => x.name === name);
      if (!p) return;
      const f = dlg.form;
      if (p.name) { f.projectName = p.name; derived.projectName = true; }
      if (p.subcontractor) { f.maintUnit = p.subcontractor; derived.maintUnit = true; }
      if (p.leader) { f.leader = p.leader; derived.leader = true; }
    }
    function onManual(key) { if (derived[key] !== undefined) derived[key] = false; }

    function onOutageChange() {
      const f = dlg.form;
      if (!workTimeTouched.value) f.workTime = MonthPlanCalc.genWorkTime(f.outageStart, f.outageEnd);
      f.outageHouseholds = MonthPlanCalc.households(f.transformerCount, f.outageStart, f.outageEnd);
      errors.outageStart = ''; errors.outageEnd = '';
      if (timeInvalid.value) {
        errors.outageEnd = '计划停电结束时间不能早于开始时间';
        warn('计划停电结束时间不能早于开始时间');
      }
    }
    // 结束时间是否早于开始时间（早于 → 锁提交、面板内也锁确定）
    const timeInvalid = computed(() => {
      const f = dlg.form;
      if (!f) return false;
      const s = String(f.outageStart || '').trim();
      const e = String(f.outageEnd || '').trim();
      return !!(s && e && e < s);
    });
    // 结束时间面板的默认带出值：开始时间 + 2 小时，跨天则压回同日 23:59
    const outageEndHint = computed(() => {
      const f = dlg.form;
      const p = f && MonthPlanCalc.parse(f.outageStart);   // 返回 Date
      if (!p || isNaN(p.getTime())) return '';
      const p2 = MonthPlanCalc.pad2;
      const t = new Date(p.getTime() + 2 * 3600 * 1000);
      const sameDay = t.getFullYear() === p.getFullYear() && t.getMonth() === p.getMonth() && t.getDate() === p.getDate();
      if (!sameDay) return p.getFullYear() + '-' + p2(p.getMonth() + 1) + '-' + p2(p.getDate()) + ' 23:59';
      return t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate()) + ' ' + p2(t.getHours()) + ':' + p2(t.getMinutes());
    });
    function onWorkTimeInput() {
      workTimeTouched.value = String(dlg.form.workTime || '').trim() !== '';
    }
    function onCountChange() {
      dlg.form.outageHouseholds = MonthPlanCalc.households(dlg.form.transformerCount, dlg.form.outageStart, dlg.form.outageEnd);
    }
    const durationText = computed(() => {
      const f = dlg.form;
      if (!f || !f.outageStart || !f.outageEnd) return '—';
      const h = MonthPlanCalc.hours(f.outageStart, f.outageEnd);
      return h.toFixed(1) + ' 小时';
    });
    const householdsText = computed(() => {
      const v = dlg.form && dlg.form.outageHouseholds;
      return (v === '' || v === undefined || v === null) ? '' : String(v);
    });

    function validate() {
      const r = MonthPlanCalc.validate(dlg.form);
      clearErrors();
      let ok = true;
      Object.keys(r).forEach(k => { if (r[k]) { errors[k] = r[k]; ok = false; } });
      return ok;
    }

    function buildPayload(status) {
      const f = dlg.form;
      const payload = {};
      MP_COLS.forEach(c => { payload[c.key] = f[c.key] === undefined || f[c.key] === null ? '' : f[c.key]; });
      Object.assign(payload, {
        planType: '月计划',
        name: String(f.maintDevice || '').trim(),           // workPlans.name 是核心字段，月计划取检修设备
        outageStart: normDT(f.outageStart), outageEnd: normDT(f.outageEnd),
        // 共用页签（已执行/已结算/日历）读 startDate/endDate，同步为停电时间
        startDate: normDT(f.outageStart), endDate: normDT(f.outageEnd),
        status: status || (dlg.editingId ? (f.status || '未执行') : '未执行')
      });
      // 属地供电所不在 22 字段表单里：由关联项目的属地供电所派生，保证列表筛选有来源
      const proj = projects.value.find(x => x.name === payload.project);
      if (proj && proj.substation) payload.areaStation = proj.substation;
      return payload;
    }

    async function save(status, tip) {
      if (!validate()) return;
      dlg.busy = true;
      try {
        const payload = buildPayload(status);
        if (dlg.editingId) await api.put('/api/workPlans/' + dlg.editingId, payload);
        else await api.post('/api/workPlans', payload);
        ElementPlus.ElMessage.success(tip || (dlg.editingId ? '月计划已更新' : '月计划已新增'));
        dlg.visible = false; await load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { dlg.busy = false; }
    }
    function submit() { return save(); }
    // 状态列已去掉：在编辑弹窗里直接流转（先保存当前修改再置状态，避免改动丢失）
    async function saveWith(status, tip) {
      await confirmDo('将先保存当前修改，再' + tip + '。确认继续？', () => save(status, tip + '，已保存'));
    }

    /* ---------------- 状态流转（只改 status） ---------------- */
    async function setStatus(row, status, tip) {
      try {
        await api.put('/api/workPlans/' + row.id, { status });
        ElementPlus.ElMessage.success(tip);
        await load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function confirmDo(text, fn) {
      try { await ElementPlus.ElMessageBox.confirm(text, '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      await fn();
    }
    function markExecuted(row) { return confirmDo('确认将「' + (row.maintDevice || row.name) + '」标记为已执行？', () => setStatus(row, '已执行', '已标记为已执行')); }
    function markSettled(row) { return confirmDo('确认将「' + (row.maintDevice || row.name) + '」标记为已结算？', () => setStatus(row, '已结算', '已标记为已结算')); }
    function backToTodo(row) { return confirmDo('确认将该月计划退回未执行？', () => setStatus(row, '未执行', '已退回未执行')); }
    function cancelPlan(row) { return confirmDo('确认取消该月计划？', () => setStatus(row, '已取消', '已取消')); }

    /* ---------------- 列表操作列：新增周计划 / 编辑 / 复刻 / 归档 / 删除 ---------------- */
    const rowLabel = row => (row.maintDevice || row.name || '该月计划');
    // 新增周计划：把本行交给父组件，由周计划表单带入后保存
    function makeWeek(row) { emit('make-week', row); }
    // 已归档的记录不再进编辑，改为只读查看
    function editRow(row) { if (row.status === '已归档') openView(row); else openEdit(row); }
    // 复刻：整条复制为新的月计划（未执行，停电时间不变）
    async function copyMonth(row) {
      try {
        const body = JSON.parse(JSON.stringify(row));
        delete body.id; delete body.createdAt;
        body.status = '未执行';
        await api.post('/api/workPlans', body);
        ElementPlus.ElMessage.success('已复刻为新的月计划');
        await load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function archivePlan(row) {
      return confirmDo('确认将「' + rowLabel(row) + '」归档？归档后可在「已归档月计划」中查看。',
        () => setStatus(row, '已归档', '已归档'));
    }
    async function removePlan(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除月计划「' + rowLabel(row) + '」？删除后不可恢复。', '提示',
          { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' });
      } catch (e) { return; }
      try {
        await api.del('/api/workPlans/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    // 操作列「更多」下拉 → 路由到已有动作
    function onAct(row, cmd) {
      if (cmd === 'copy') return copyMonth(row);
      if (cmd === 'archive') return archivePlan(row);
      if (cmd === 'delete') return removePlan(row);
    }
    // 查看弹窗里的状态流转：二次确认后改状态并关窗
    const formStatus = computed(() => (dlg.form && dlg.form.status) || '未执行');
    async function flowFromView(status, tip) {
      if (!dlg.form) return;
      const label = dlg.form.maintDevice || dlg.form.name || '该月计划';
      const verb = { '已执行': '标记为已执行', '已结算': '标记为已结算', '未执行': '退回未执行', '已取消': '取消' }[status] || '更新状态';
      await confirmDo('确认将「' + label + '」' + verb + '？', async () => {
        await setStatus(dlg.form, status, tip);
        dlg.visible = false;
      });
    }

    /* ---------------- 导出（按「月计划导出模板」生成，服务端 ExcelJS 出样式） ---------------- */
    const exporting = ref(false);
    async function exportXlsx() {
      const rows = filtered.value;
      if (!rows.length) { ElementPlus.ElMessage.warning('当前筛选没有可导出的月计划'); return; }
      exporting.value = true;
      try {
        const ids = rows.map(r => r.id).filter(Boolean).join(',');
        const firstDate = (rows.find(r => r.outageStart) || {}).outageStart || '';
        const year = importYear.value || String(ServerTime.year());
        const month = firstDate.slice(5, 7) ? String(Number(firstDate.slice(5, 7))) : '';
        let url = '/api/workPlans/month-plan.xlsx?ids=' + encodeURIComponent(ids) + '&year=' + encodeURIComponent(year);
        if (month) url += '&month=' + encodeURIComponent(month);
        const { blob, name } = await api.download(url);
        const a = document.createElement('a');
        const href = URL.createObjectURL(blob);
        a.href = href;
        a.download = name || ('月计划-' + year + '.xlsx');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(href), 2000);
        ElementPlus.ElMessage.success('已按模板导出 ' + rows.length + ' 条');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { exporting.value = false; }
    }

    /* ---------------- 导入预览（浏览器解析 + 判重） ---------------- */
    const imp = reactive({ visible: false, busy: false, fileName: '', rows: [], err: '' });
    const impInput = ref(null);
    const impAddedCount = computed(() => imp.rows.filter(r => r.verdict === '新增').length);
    const impDupCount = computed(() => imp.rows.length - impAddedCount.value);
    function pickImpFile() { if (impInput.value) impInput.value.click(); }
    const cellText = v => String(v == null ? '' : v).trim();
    const MP_DEFAULTS = { workType: '配农网工程', gridRisk: '无', riskLevel: 'IV', importantUsers: '无' };

    /* 表头 → 字段：同时认「月计划导出模板」的 20 列与旧版 22 列导出 */
    const MP_HEADER_MAP = {
      '运维单位': 'opsUnit', '检修单位': 'maintUnit', '关联项目': 'project',
      '涉及工程项目': 'projectName', '检修设备': 'maintDevice', '电压等级': 'voltage',
      '设备类型': 'deviceType', '计划工作时间': 'workTime', '检修类型': 'workType',
      '检修内容': 'maintContent', '影响主要用户和区域': 'affectArea', '影响用户和区域': 'affectArea',
      '停电涉及中压配变数': 'transformerCount', '停电时户数': 'outageHouseholds',
      '涉及重要电力用户名称': 'importantUsers', '电网风险等级': 'gridRisk', '作业风险等级': 'riskLevel',
      '近2月停电次数': 'outageCount2m', '本年度停电次数': 'outageCountYear', '备注': 'planNote',
      '班组长': 'leader', '计划停电开始': 'outageStart', '计划停电结束': 'outageEnd'
    };
    // 模板第 3 行的红字填写说明，命中即跳过
    const isNoteRow = cells => cells.some(c => /下拉单选|连续停电格式|检修设备名称|发电车需求|总体上按时间排序/.test(c));

    async function onImpFile(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { ElementPlus.ElMessage.error('文件大小超过 10MB'); return; }

      let book;
      try {
        const buf = await file.arrayBuffer();
        book = XLSX.read(new Uint8Array(buf), { type: 'array' });
      } catch (e) {
        ElementPlus.ElMessage.error('文件解析失败：' + (e.message || '无法识别的表格'));
        return;
      }

      const parsed = [];
      const bad = [];
      let headerFound = false;

      // 模板有「主网 / 配网」两张子表，逐表解析后合并
      book.SheetNames.forEach(name => {
        const aoa = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '', raw: false });
        if (!aoa.length) return;
        // 表头行：前 10 行里命中表头名最多的一行（模板第 1 行是合并标题，第 2 行才是表头）
        let hi = -1, best = 0;
        for (let i = 0; i < Math.min(aoa.length, 10); i++) {
          const cells = (aoa[i] || []).map(cellText);
          const hit = cells.filter(c => MP_HEADER_MAP[c] || c === '计划停电时间').length;
          if (hit > best) { best = hit; hi = i; }
        }
        if (hi < 0 || best < 4) return;                       // 非数据表（空白子表等）
        headerFound = true;
        const idx = {};
        (aoa[hi] || []).map(cellText).forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });
        if (idx['检修设备'] === undefined) return;
        const timeCol = idx['计划停电时间'];

        for (let i = hi + 1; i < aoa.length; i++) {
          const r = aoa[i] || [];
          const cells = r.map(cellText);
          if (!cells.some(Boolean)) continue;
          if (isNoteRow(cells)) continue;                      // 红字说明行
          const o = { __row: i + 1, __sheet: name };
          MP_COLS.forEach(c => { o[c.key] = MP_DEFAULTS[c.key] || ''; });
          Object.keys(MP_HEADER_MAP).forEach(label => {
            const ci = idx[label];
            if (ci !== undefined) o[MP_HEADER_MAP[label]] = cellText(r[ci]);
          });
          o.areaStation = '';
          if (!o.projectName && o.project) o.projectName = o.project;
          if (!o.project && o.projectName) o.project = o.projectName;
          // 时间：模板是「计划停电时间」合并文本，旧导出是开始/结束两列
          if (timeCol !== undefined) {
            const rt = MonthPlanCalc.parseOutageText(cellText(r[timeCol]), importYear.value);
            if (rt) { o.outageStart = rt.start; o.outageEnd = rt.end; }
          }
          if (!o.maintDevice && !o.outageStart && !o.outageEnd) continue;   // 空行
          const lack = [];
          if (!o.maintDevice) lack.push('检修设备');
          if (!o.outageStart) lack.push('计划停电时间');
          if (!o.outageEnd) lack.push('计划停电结束');
          if (lack.length) { bad.push(name + ' 第' + (i + 1) + '行缺少：' + lack.join('、')); parsed.push(o); continue; }
          o.outageStart = normDT(o.outageStart); o.outageEnd = normDT(o.outageEnd);
          if (!o.workTime) o.workTime = MonthPlanCalc.genWorkTime(o.outageStart, o.outageEnd);   // 未给则按联动补算
          if (!String(o.outageHouseholds).trim()) o.outageHouseholds = MonthPlanCalc.households(o.transformerCount, o.outageStart, o.outageEnd);
          const proj = projects.value.find(x => x.name === (o.project || o.projectName));
          if (proj && proj.substation) o.areaStation = proj.substation;
          parsed.push(o);
        }
      });

      if (!headerFound) {
        ElementPlus.ElMessage.error('没识别到表头：请用「导出 xlsx」下载的模板填写（表头需含检修设备、计划停电时间等列）');
        return;
      }
      if (bad.length) {
        ElementPlus.ElMessage.error('文件有 ' + bad.length + ' 行数据不完整，未导入：' + bad.slice(0, 3).join('；') + (bad.length > 3 ? ' …' : ''));
        return;
      }
      if (!parsed.length) { ElementPlus.ElMessage.warning('文件中没有可导入的数据行'); return; }
      MonthPlanCalc.judge(parsed, list.value, importYear.value);
      imp.rows = parsed; imp.fileName = file.name; imp.err = ''; imp.visible = true;
    }

    async function confirmImport() {
      const addRows = imp.rows.filter(r => r.verdict === '新增');
      const skip = imp.rows.length - addRows.length;
      imp.busy = true;
      let done = 0;
      try {
        for (const r of addRows) {
          const body = { planType: '月计划', status: '未执行', name: r.maintDevice };
          MP_COLS.forEach(c => { body[c.key] = r[c.key] === undefined ? '' : r[c.key]; });
          body.areaStation = r.areaStation || '';
          body.startDate = r.outageStart; body.endDate = r.outageEnd;
          await api.post('/api/workPlans', body);
          done += 1;
        }
        ElementPlus.ElMessage.success('导入成功：新增 ' + done + ' 条，跳过重复 ' + skip + ' 条');
        imp.visible = false; imp.rows = [];
        await load();
      } catch (e) {
        ElementPlus.ElMessage.error('导入中断（已写入 ' + done + ' 条）：' + e.message);
        await load();
      } finally { imp.busy = false; }
    }

    onMounted(() => { load(); loadOptions(); });

    return {
      list, loading, filters, page, pageSize, importYear, yearOpts,
      areaOpts, maintUnitOpts, leaderOpts, workTypeOpts, deviceTypeOpts, voltageOpts, projectOpts,
      tabList, filtered, paged, maxPage, idxBase, fmtRange, badgeClass,
      outageDay, outageClock, workDay, workClock,
      dlg, errors, derived, workTimeTouched, durationText, householdsText, timeInvalid, outageEndHint,
      openAdd, openEdit, openView, submit, onProjectChange, onManual, onOutageChange, onWorkTimeInput, onCountChange,
      markExecuted, markSettled, backToTodo, cancelPlan,
      makeWeek, editRow, copyMonth, archivePlan, removePlan, onAct, formStatus, flowFromView, saveWith,
      exportXlsx, exporting, imp, impInput, pickImpFile, onImpFile, confirmImport, impAddedCount, impDupCount,
      MP_DEVICE_TYPES, MP_VOLTAGES, MP_WORK_TYPES, MP_GRID_RISKS, MP_RISK_LEVELS, MP_STATUS, MP_COLS
    };
  },
  template: `
  <div class="mp-wrap">
    <div class="plan-filters">
      <el-select v-model="filters.areaStation" placeholder="属地供电所" clearable class="pf-select" @change="page=1">
        <el-option v-for="o in areaOpts" :key="o" :label="o" :value="o" />
      </el-select>
      <el-select v-model="filters.workType" placeholder="作业类型" clearable class="pf-select" @change="page=1">
        <el-option v-for="o in workTypeOpts" :key="o" :label="o" :value="o" />
      </el-select>
      <el-select v-model="filters.leader" placeholder="班组长" clearable class="pf-select" style="width:104px" @change="page=1">
        <el-option v-for="o in leaderOpts" :key="o" :label="o" :value="o" />
      </el-select>
      <el-date-picker v-model="filters.startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" class="pf-date" @change="page=1" />
      <el-date-picker v-model="filters.endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" class="pf-date" @change="page=1" />
      <el-input v-model="filters.keyword" placeholder="关键词（项目/工作内容/检修设备）" clearable class="pf-input mp-kw" @input="page=1" />
      <span class="pf-actions-sep" />
      <div class="pf-actions">
        <el-button v-if="canWrite('plans')" type="primary" size="small" @click="openAdd">新增计划</el-button>
        <div class="pf-item mp-year">
          <span class="pf-label">导入年份：</span>
          <el-select v-model="importYear" size="small" class="mp-year-sel">
            <el-option v-for="y in yearOpts" :key="y" :label="y" :value="y" />
          </el-select>
        </div>
        <el-button v-if="canWrite('plans')" size="small" @click="pickImpFile">导入预览 xls</el-button>
        <el-button size="small" :loading="exporting" title="按「月计划导出模板」生成（主网/配网两张子表），导出文件可直接再导入" @click="exportXlsx">导出 xlsx</el-button>
      </div>
      <input ref="impInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onImpFile" />
    </div>

    <el-table :data="paged" v-loading="loading" class="plan-table mp-table" style="width:100%">
      <el-table-column type="index" label="序号" width="52" align="center" :index="idxBase" />
      <el-table-column prop="maintUnit" label="检修单位" width="96" class-name="mp-wrapcell" />
      <el-table-column prop="projectName" label="涉及工程项目" min-width="104" show-overflow-tooltip />
      <el-table-column prop="maintDevice" label="检修设备" min-width="100" show-overflow-tooltip />
      <el-table-column prop="voltage" label="电压等级" width="74" align="center" />
      <el-table-column prop="deviceType" label="设备类型" width="78" />
      <el-table-column label="计划停电时间" width="114" class-name="mp-tcol">
        <template #default="{row}">
          <div class="mp-time2">
            <span class="mp-t-d">{{ outageDay(row.outageStart, row.outageEnd) }}</span>
            <span class="mp-t-h">{{ outageClock(row.outageStart, row.outageEnd) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="计划工作时间" width="114" class-name="mp-tcol">
        <template #default="{row}">
          <div class="mp-time2">
            <span class="mp-t-d">{{ workDay(row.workTime) }}</span>
            <span class="mp-t-h">{{ workClock(row.workTime) }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="workType" label="检修类型" width="90" show-overflow-tooltip />
      <el-table-column prop="maintContent" label="检修内容" min-width="100" show-overflow-tooltip />
      <el-table-column prop="leader" label="班组长" width="78" show-overflow-tooltip />
      <el-table-column label="操作" width="208" fixed="right">
        <template #default="{row}">
          <div class="mp-acts">
            <template v-if="canWrite('plans')">
              <el-button link type="primary" size="small" class="mp-act-lead" @click="makeWeek(row)">新增周计划</el-button>
              <el-button link type="primary" size="small" @click="editRow(row)">编辑</el-button>
              <el-dropdown trigger="click" class="mp-act-more" @command="c => onAct(row, c)">
                <el-button link type="primary" size="small">更多<svg class="mp-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="copy">复制</el-dropdown-item>
                    <el-dropdown-item v-if="row.status !== '已归档'" command="archive">归档</el-dropdown-item>
                    <el-dropdown-item command="delete" divided class="mp-dd-danger">删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
            <el-button v-else link type="primary" size="small" @click="openView(row)">查看</el-button>
          </div>
        </template>
      </el-table-column>
      <template #empty>
        <div class="plan-empty">
          <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M11 38v9a5 5 0 0 0 5 5h32a5 5 0 0 0 5-5v-9" />
            <path d="M11 38l7-21a5 5 0 0 1 4.7-3.4h18.6A5 5 0 0 1 46 17l7 21" />
            <path d="M11 38h11l2.5 5h15L42 38h11" />
          </svg>
          <span>暂无数据</span>
        </div>
      </template>
    </el-table>

    <div class="plan-pager">
      <span class="pp-total">共 {{ filtered.length }} 条，第 {{ page }} 页</span>
      <el-select v-model="pageSize" size="small" class="pp-size" @change="page=1">
        <el-option v-for="s in [20, 50, 100]" :key="s" :label="s + ' 条/页'" :value="s" />
      </el-select>
      <el-button size="small" :disabled="page <= 1" @click="page = page - 1">上一页</el-button>
      <el-button size="small" :disabled="page >= maxPage" @click="page = page + 1">下一页</el-button>
    </div>

    <el-dialog :title="dlg.readonly ? '查看计划' : (dlg.editingId ? '编辑计划' : '新增计划')"
      v-model="dlg.visible" width="min(780px, 96%)" top="6vh" class="mp-dlg">
      <el-form v-if="dlg.form" label-position="right" label-width="190px" class="mp-form" :class="{ 'mp-readonly': dlg.readonly }">
        <el-form-item label="运维单位">
          <el-input v-model="dlg.form.opsUnit" maxlength="60" :disabled="dlg.readonly" placeholder="默认：国网富顺县供电公司" />
        </el-form-item>
        <el-form-item label="检修单位" class="mp-auto-row">
          <template #label><span v-if="derived.maintUnit" class="mp-auto">自动带出</span><span>检修单位：</span></template>
          <el-select v-model="dlg.form.maintUnit" filterable allow-create default-first-option clearable
            placeholder="请选择（可来自关联项目）" :disabled="dlg.readonly" @change="onManual('maintUnit')">
            <el-option v-for="o in maintUnitOpts" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联项目">
          <el-select v-model="dlg.form.project" filterable clearable :disabled="dlg.readonly"
            placeholder="选择后自动带出检修单位、涉及工程项目、班组长" @change="onProjectChange">
            <el-option v-for="o in projectOpts" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="涉及工程项目" class="mp-auto-row">
          <template #label><span v-if="derived.projectName" class="mp-auto">自动带出</span><span>涉及工程项目：</span></template>
          <el-input v-model="dlg.form.projectName" maxlength="120" :disabled="dlg.readonly"
            placeholder="未关联项目时填写；关联项目后自动带出" @input="onManual('projectName')" />
        </el-form-item>
        <el-form-item label="检修设备" required :error="errors.maintDevice">
          <el-input v-model="dlg.form.maintDevice" type="textarea" :rows="2" maxlength="200" :disabled="dlg.readonly"
            placeholder="替换原停电位置" @input="errors.maintDevice = ''" />
        </el-form-item>
        <el-form-item label="电压等级">
          <el-select v-model="dlg.form.voltage" :disabled="dlg.readonly" placeholder="请选择">
            <el-option v-for="v in voltageOpts" :key="v" :label="v" :value="v" />
          </el-select>
        </el-form-item>
        <el-form-item label="设备类型">
          <el-select v-model="dlg.form.deviceType" clearable :disabled="dlg.readonly" placeholder="配网主线、配网支线、不涉及">
            <el-option v-for="d in deviceTypeOpts" :key="d" :label="d" :value="d" />
          </el-select>
        </el-form-item>
        <el-form-item label="计划停电开始时间" required :error="errors.outageStart">
          <plan-date-time v-model="dlg.form.outageStart" placeholder="开始时间" :disabled="dlg.readonly" @update:model-value="onOutageChange" />
        </el-form-item>
        <el-form-item label="计划停电结束时间" required :error="errors.outageEnd">
          <plan-date-time v-model="dlg.form.outageEnd" placeholder="结束时间" :disabled="dlg.readonly"
            :min="dlg.form.outageStart" :default-from="outageEndHint"
            min-tip="计划停电结束时间不能早于开始时间" @update:model-value="onOutageChange" />
        </el-form-item>
        <div class="mp-dur-row"><div class="mp-dur">停电时长 <b>{{ durationText }}</b></div></div>
        <el-form-item class="mp-auto-row">
          <template #label><span class="mp-state">{{ workTimeTouched ? '已手动修改' : '自动生成' }}</span><span>计划工作时间：</span></template>
          <el-input v-model="dlg.form.workTime" maxlength="120" :disabled="dlg.readonly" @input="onWorkTimeInput" />
        </el-form-item>
        <el-form-item label="检修类型" required :error="errors.workType">
          <el-select v-model="dlg.form.workType" clearable :disabled="dlg.readonly" placeholder="请选择" @change="errors.workType = ''">
            <el-option v-for="w in workTypeOpts" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
        <el-form-item label="检修内容">
          <el-input v-model="dlg.form.maintContent" type="textarea" :rows="3" maxlength="2000" :disabled="dlg.readonly"
            placeholder="留空" />
        </el-form-item>
        <el-form-item label="影响用户和区域">
          <el-input v-model="dlg.form.affectArea" type="textarea" :rows="2" maxlength="500" :disabled="dlg.readonly"
            placeholder="影响主要用户和区域" />
        </el-form-item>
        <el-form-item label="停电涉及中压配变数">
          <el-input v-model="dlg.form.transformerCount" maxlength="8" :disabled="dlg.readonly"
            placeholder="停电涉及中压配变数" @input="onCountChange" />
        </el-form-item>
        <el-form-item label="停电时户数">
          <div class="mp-ro-wrap">
            <div class="mp-ro">{{ householdsText }}</div>
            <div class="mp-ro-hint">自动计算：中压配变数 × 停电时长（小时）</div>
          </div>
        </el-form-item>
        <el-form-item label="涉及重要电力用户名称">
          <el-input v-model="dlg.form.importantUsers" type="textarea" :rows="2" maxlength="500" :disabled="dlg.readonly" />
        </el-form-item>
        <el-form-item label="电网风险等级">
          <el-select v-model="dlg.form.gridRisk" :disabled="dlg.readonly" placeholder="请选择">
            <el-option v-for="g in MP_GRID_RISKS" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
        <el-form-item label="作业风险等级">
          <el-select v-model="dlg.form.riskLevel" :disabled="dlg.readonly" placeholder="请选择">
            <el-option v-for="r in MP_RISK_LEVELS" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="近2月停电次数">
          <el-input v-model="dlg.form.outageCount2m" maxlength="8" :disabled="dlg.readonly" />
        </el-form-item>
        <el-form-item label="本年度停电次数">
          <el-input v-model="dlg.form.outageCountYear" maxlength="8" :disabled="dlg.readonly" />
        </el-form-item>
        <el-form-item label="班组长" class="mp-auto-row">
          <template #label><span v-if="derived.leader" class="mp-auto">自动带出</span><span>班组长：</span></template>
          <el-select v-model="dlg.form.leader" filterable allow-create default-first-option clearable
            placeholder="请选择或输入" :disabled="dlg.readonly" @change="onManual('leader')">
            <el-option v-for="o in leaderOpts" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="dlg.form.planNote" type="textarea" :rows="2" maxlength="500" :disabled="dlg.readonly" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="mp-foot">
          <span v-if="dlg.readonly && canWrite('plans') && dlg.form" class="mp-foot-tip">
            <span class="mp-badge" :class="badgeClass(formStatus)">{{ formStatus }}</span>
          </span>
          <span v-else class="mp-foot-tip">带 <b>*</b> 为必填项</span>
          <div class="mp-foot-btns">
            <template v-if="dlg.readonly && canWrite('plans') && dlg.form">
              <el-button v-if="formStatus === '未执行'" size="small" type="warning" plain @click="flowFromView('已执行','已标记为已执行')">标记已执行</el-button>
              <el-button v-if="formStatus === '未执行'" size="small" type="danger" plain @click="flowFromView('已取消','已取消')">取消计划</el-button>
              <el-button v-if="formStatus === '已执行'" size="small" type="warning" plain @click="flowFromView('已结算','已标记为已结算')">标记已结算</el-button>
              <el-button v-if="formStatus === '已执行'" size="small" @click="flowFromView('未执行','已退回未执行')">退回未执行</el-button>
            </template>
            <el-button v-if="!dlg.readonly && dlg.editingId && canWrite('plans') && formStatus === '未执行'"
              size="small" type="warning" plain @click="saveWith('已执行','标记为已执行')">保存并标记已执行</el-button>
            <el-button @click="dlg.visible=false">{{ dlg.readonly ? '关闭' : '取消' }}</el-button>
            <el-button v-if="!dlg.readonly" type="primary" :loading="dlg.busy" :disabled="timeInvalid" @click="submit">确定</el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-dialog :title="'导入预览（' + importYear + ' 年）'" v-model="imp.visible" width="min(1080px, 96%)" top="5vh">
      <div class="mp-imp-sum">
        共解析 <b>{{ imp.rows.length }}</b> 条 · 新增 <b class="ok">{{ impAddedCount }}</b> 条 · 疑似重复 <b class="dup">{{ impDupCount }}</b> 条
        <span v-if="imp.fileName" class="mp-imp-file">{{ imp.fileName }}</span>
      </div>
      <el-table :data="imp.rows" class="plan-table mp-imp-table" max-height="56vh" style="width:100%">
        <el-table-column type="index" label="序号" width="52" align="center" />
        <el-table-column prop="maintUnit" label="检修单位" min-width="110" show-overflow-tooltip />
        <el-table-column prop="projectName" label="涉及工程项目" min-width="170" show-overflow-tooltip />
        <el-table-column prop="maintDevice" label="检修设备" min-width="150" show-overflow-tooltip />
        <el-table-column prop="voltage" label="电压等级" width="86" align="center" />
        <el-table-column prop="deviceType" label="设备类型" width="92" />
        <el-table-column label="计划停电时间" width="118" class-name="mp-tcol">
          <template #default="{row}">
            <div class="mp-time2">
              <span class="mp-t-d">{{ outageDay(row.outageStart, row.outageEnd) }}</span>
              <span class="mp-t-h">{{ outageClock(row.outageStart, row.outageEnd) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="计划工作时间" width="130" class-name="mp-tcol">
          <template #default="{row}">
            <div class="mp-time2">
              <span class="mp-t-d">{{ workDay(row.workTime) }}</span>
              <span class="mp-t-h">{{ workClock(row.workTime) }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="导入判定" min-width="180">
          <template #default="{row}">
            <span :class="row.verdict === '新增' ? 'mp-v-new' : 'mp-v-dup'">{{ row.verdict }}</span>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button :disabled="imp.busy" @click="imp.visible=false">取消</el-button>
        <el-button type="primary" :loading="imp.busy" @click="confirmImport">确认导入（跳过重复）</el-button>
      </template>
    </el-dialog>
  </div>`
};
