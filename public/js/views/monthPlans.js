/* ========== views/monthPlans ========== */
/* 月计划管理面板（检修口径，定稿版）：22 字段表单 + 关联项目带出 + 停电时户数计算 +
   导入预览判重 + 导出 + 状态流转。
   数据仍在 workPlans 集合（planType='月计划'），不新增后端接口：
   导入用浏览器端 xlsx 解析 + 逐条 POST /api/workPlans，导出用浏览器端 xlsx 生成。 */

const MP_VOLTAGES = ['10kV', '35kV', '0.4kV', '20kV', '110kV', '220kV'];
const MP_DEVICE_TYPES = ['配网主线', '配网支线', '变电设备', '不涉及'];
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
/* 导入时必须存在的表头列（其余列缺失按默认值补） */
const MP_IMPORT_REQUIRED = ['检修设备', '计划停电开始', '计划停电结束'];

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
    if (s && e && e <= s) out.outageEnd = '计划停电结束时间须晚于开始时间';
    return out;
  },
  keyOf(o) { return String((o && o.maintDevice) || '').trim() + '||' + String((o && o.outageStart) || '').trim(); }
};
if (typeof window !== 'undefined') window.MonthPlanCalc = MonthPlanCalc;

const MonthPlansPanel = {
  props: {
    tab: { type: String, default: 'month' },              // month | archived
    projectScope: { type: Array, default: () => [] }      // 项目详情「查看月计划」带入的项目范围
  },
  setup(props) {
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
    const importYear = ref(String(new Date().getFullYear()));

    const yearOpts = computed(() => {
      const y = new Date().getFullYear();
      return [y - 1, y, y + 1].map(String);
    });
    const uniq = arr => Array.from(new Set(arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean)));
    const hist = key => uniq(list.value.map(p => p[key]));
    const areaOpts = computed(() => uniq([...substations.value, ...hist('areaStation')]));
    const maintUnitOpts = computed(() => uniq([...units.value, ...substations.value, ...hist('maintUnit')]));
    const leaderOpts = computed(() => uniq([...leaderAccounts.value, ...hist('leader')]));
    const workTypeOpts = computed(() => uniq([...MP_WORK_TYPES, ...hist('workType')]));
    const deviceTypeOpts = computed(() => uniq([...MP_DEVICE_TYPES, ...hist('deviceType')]));
    const voltageOpts = computed(() => uniq([...MP_VOLTAGES, ...hist('voltage')]));
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
    }
    function onWorkTimeInput() {
      workTimeTouched.value = String(dlg.form.workTime || '').trim() !== '';
    }
    function onCountChange() {
      dlg.form.outageHouseholds = MonthPlanCalc.households(dlg.form.transformerCount, dlg.form.outageStart, dlg.form.outageEnd);
    }
    const durationText = computed(() => {
      const h = MonthPlanCalc.hours(dlg.form && dlg.form.outageStart, dlg.form && dlg.form.outageEnd);
      return h ? h.toFixed(1) + ' 小时' : '—';
    });
    const householdsText = computed(() => {
      const v = dlg.form && dlg.form.outageHouseholds;
      return (v === '' || v === undefined || v === null) ? '—' : String(v);
    });

    function validate() {
      const r = MonthPlanCalc.validate(dlg.form);
      clearErrors();
      let ok = true;
      Object.keys(r).forEach(k => { if (r[k]) { errors[k] = r[k]; ok = false; } });
      return ok;
    }

    async function submit() {
      if (!validate()) return;
      const f = dlg.form;
      const payload = {};
      MP_COLS.forEach(c => { payload[c.key] = f[c.key] === undefined || f[c.key] === null ? '' : f[c.key]; });
      Object.assign(payload, {
        planType: '月计划',
        name: String(f.maintDevice || '').trim(),           // workPlans.name 是核心字段，月计划取检修设备
        outageStart: normDT(f.outageStart), outageEnd: normDT(f.outageEnd),
        // 共用页签（已执行/已结算/日历）读 startDate/endDate，同步为停电时间
        startDate: normDT(f.outageStart), endDate: normDT(f.outageEnd),
        status: dlg.editingId ? (f.status || '未执行') : '未执行'
      });
      // 属地供电所不在 22 字段表单里：由关联项目的属地供电所派生，保证列表筛选有来源
      const proj = projects.value.find(x => x.name === payload.project);
      if (proj && proj.substation) payload.areaStation = proj.substation;
      dlg.busy = true;
      try {
        if (dlg.editingId) await api.put('/api/workPlans/' + dlg.editingId, payload);
        else await api.post('/api/workPlans', payload);
        ElementPlus.ElMessage.success(dlg.editingId ? '月计划已更新' : '月计划已新增');
        dlg.visible = false; await load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { dlg.busy = false; }
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

    /* ---------------- 导出（当前页签 + 当前筛选，22 列，可回灌） ---------------- */
    const blank = v => (v == null ? '' : String(v));
    const WIDE_COLS = ['检修设备', '检修内容', '影响用户和区域', '涉及重要电力用户名称', '备注'];
    function exportXlsx() {
      const rows = filtered.value;
      const aoa = [MP_COLS.map(c => c.label)];
      rows.forEach(p => aoa.push(MP_COLS.map(c => blank(p[c.key]))));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = MP_COLS.map(c => ({ wch: WIDE_COLS.includes(c.label) ? 26 : (['涉及工程项目', '计划工作时间'].includes(c.label) ? 24 : 16) }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '月计划');
      XLSX.writeFile(wb, '月计划导出.xlsx');
      ElementPlus.ElMessage.success('已导出 ' + rows.length + ' 条');
    }

    /* ---------------- 导入预览（浏览器解析 + 判重） ---------------- */
    const imp = reactive({ visible: false, busy: false, fileName: '', rows: [], err: '' });
    const impInput = ref(null);
    const impAddedCount = computed(() => imp.rows.filter(r => r.verdict === '新增').length);
    const impDupCount = computed(() => imp.rows.length - impAddedCount.value);
    function pickImpFile() { if (impInput.value) impInput.value.click(); }
    const cellText = v => String(v == null ? '' : v).trim();
    const MP_DEFAULTS = { workType: '配农网工程', gridRisk: '无', riskLevel: 'IV', importantUsers: '无' };

    async function onImpFile(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { ElementPlus.ElMessage.error('文件大小超过 10MB'); return; }
      let aoa;
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      } catch (e) {
        ElementPlus.ElMessage.error('文件解析失败：' + (e.message || '无法识别的表格'));
        return;
      }
      const head = (aoa[0] || []).map(cellText);
      const idx = {};
      head.forEach((h, i) => { if (h && idx[h] === undefined) idx[h] = i; });
      const miss = MP_IMPORT_REQUIRED.filter(n => idx[n] === undefined);
      if (miss.length) {
        ElementPlus.ElMessage.error('表头缺少列：' + miss.join('、') + '。至少需要：' + MP_IMPORT_REQUIRED.join('、'));
        return;
      }
      const parsed = [];
      const bad = [];
      for (let i = 1; i < aoa.length; i++) {
        const r = aoa[i];
        if (!r) continue;
        const o = { __row: i + 1 };
        MP_COLS.forEach(c => {
          o[c.key] = idx[c.label] === undefined ? (MP_DEFAULTS[c.key] || '') : cellText(r[idx[c.label]]);
        });
        o.areaStation = '';
        if (!o.maintDevice && !o.outageStart) continue;                 // 空行
        const lack = [];
        if (!o.maintDevice) lack.push('检修设备');
        if (!o.outageStart) lack.push('计划停电开始');
        if (!o.outageEnd) lack.push('计划停电结束');
        if (lack.length) { bad.push('第' + (i + 1) + '行缺少：' + lack.join('、')); parsed.push(o); continue; }
        o.outageStart = normDT(o.outageStart); o.outageEnd = normDT(o.outageEnd);
        if (!o.workTime) o.workTime = MonthPlanCalc.genWorkTime(o.outageStart, o.outageEnd);      // 文件未给则按联动补算
        if (!String(o.outageHouseholds).trim()) o.outageHouseholds = MonthPlanCalc.households(o.transformerCount, o.outageStart, o.outageEnd);
        const proj = projects.value.find(x => x.name === o.project);
        if (proj && proj.substation) o.areaStation = proj.substation;
        parsed.push(o);
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
      dlg, errors, derived, workTimeTouched, durationText, householdsText,
      openAdd, openEdit, openView, submit, onProjectChange, onManual, onOutageChange, onWorkTimeInput, onCountChange,
      markExecuted, markSettled, backToTodo, cancelPlan,
      exportXlsx, imp, impInput, pickImpFile, onImpFile, confirmImport, impAddedCount, impDupCount,
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
      <el-button v-if="canWrite('plans')" type="primary" size="small" @click="openAdd">新增计划</el-button>
      <div class="pf-item mp-year">
        <span class="pf-label">导入年份：</span>
        <el-select v-model="importYear" size="small" class="mp-year-sel">
          <el-option v-for="y in yearOpts" :key="y" :label="y" :value="y" />
        </el-select>
      </div>
      <el-button v-if="canWrite('plans')" size="small" @click="pickImpFile">导入预览 xls</el-button>
      <el-button size="small" @click="exportXlsx">导出 xlsx</el-button>
      <input ref="impInput" type="file" accept=".xlsx,.xls" style="display:none" @change="onImpFile" />
    </div>

    <el-table :data="paged" v-loading="loading" class="plan-table mp-table" style="width:100%">
      <el-table-column type="index" label="序号" width="50" align="center" :index="idxBase" />
      <el-table-column prop="maintUnit" label="检修单位" width="92" show-overflow-tooltip />
      <el-table-column prop="projectName" label="涉及工程项目" min-width="104" show-overflow-tooltip />
      <el-table-column prop="maintDevice" label="检修设备" min-width="104" show-overflow-tooltip />
      <el-table-column prop="voltage" label="电压等级" width="76" align="center" />
      <el-table-column prop="deviceType" label="设备类型" width="82" />
      <el-table-column label="计划停电时间" width="178" class-name="pf-nowrap">
        <template #default="{row}"><span class="mp-time">{{ fmtRange(row.outageStart, row.outageEnd) }}</span></template>
      </el-table-column>
      <el-table-column label="计划工作时间" min-width="194" show-overflow-tooltip>
        <template #default="{row}"><span class="mp-time">{{ row.workTime || '—' }}</span></template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{row}">
          <div class="mp-acts">
            <span class="mp-badge" :class="badgeClass(row.status)">{{ row.status }}</span>
            <template v-if="canWrite('plans')">
              <template v-if="row.status === '未执行'">
                <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                <el-button link type="warning" size="small" @click="markExecuted(row)">标记已执行</el-button>
                <el-button link type="danger" size="small" @click="cancelPlan(row)">取消计划</el-button>
              </template>
              <template v-else-if="row.status === '已执行'">
                <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                <el-button link type="warning" size="small" @click="markSettled(row)">标记已结算</el-button>
                <el-button link type="warning" size="small" @click="backToTodo(row)">退回未执行</el-button>
              </template>
              <template v-else>
                <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
                <el-button link type="info" size="small" @click="openView(row)">查看</el-button>
              </template>
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

    <el-dialog :title="dlg.readonly ? '查看月计划' : (dlg.editingId ? '编辑月计划' : '新增月计划')"
      v-model="dlg.visible" width="min(980px, 96%)" top="5vh" class="mp-dlg">
      <div v-if="dlg.form" class="mp-form">
        <!-- 顶部带出区 -->
        <div class="mp-derive">
          <div class="mp-derive-row">
            <span class="mp-derive-lb">关联项目</span>
            <el-select v-model="dlg.form.project" filterable clearable placeholder="请选择项目"
              :disabled="dlg.readonly" class="mp-derive-sel" @change="onProjectChange">
              <el-option v-for="o in projectOpts" :key="o" :label="o" :value="o" />
            </el-select>
          </div>
          <div class="mp-derive-hint">选定项目后，下方带「自动带出」标记的字段将被填充，仍可手动修改。</div>
        </div>

        <!-- 基本信息 -->
        <div class="mp-sec">
          <div class="mp-sec-title">基本信息</div>
          <el-row :gutter="16">
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">运维单位</label>
                <el-input v-model="dlg.form.opsUnit" maxlength="60" :disabled="dlg.readonly" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">检修单位<span v-if="derived.maintUnit" class="mp-auto">自动带出</span></label>
                <el-select v-model="dlg.form.maintUnit" filterable allow-create default-first-option clearable
                  placeholder="请选择或输入" :disabled="dlg.readonly" @change="onManual('maintUnit')">
                  <el-option v-for="o in maintUnitOpts" :key="o" :label="o" :value="o" />
                </el-select>
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item">
                <label class="mp-lb">涉及工程项目<span v-if="derived.projectName" class="mp-auto">自动带出</span></label>
                <el-input v-model="dlg.form.projectName" maxlength="120" :disabled="dlg.readonly" @input="onManual('projectName')" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item" :class="{ 'mp-haserr': !!errors.maintDevice }">
                <label class="mp-lb">检修设备<span class="mp-req">*</span></label>
                <el-input v-model="dlg.form.maintDevice" type="textarea" :rows="2" maxlength="200" :disabled="dlg.readonly"
                  @input="errors.maintDevice = ''" />
                <div v-if="errors.maintDevice" class="mp-err">{{ errors.maintDevice }}</div>
              </div>
            </el-col>
            <el-col :xs="24" :sm="8">
              <div class="mp-item">
                <label class="mp-lb">电压等级</label>
                <el-select v-model="dlg.form.voltage" :disabled="dlg.readonly" placeholder="请选择">
                  <el-option v-for="v in voltageOpts" :key="v" :label="v" :value="v" />
                </el-select>
              </div>
            </el-col>
            <el-col :xs="24" :sm="8">
              <div class="mp-item">
                <label class="mp-lb">设备类型</label>
                <el-select v-model="dlg.form.deviceType" clearable :disabled="dlg.readonly" placeholder="请选择">
                  <el-option v-for="d in deviceTypeOpts" :key="d" :label="d" :value="d" />
                </el-select>
              </div>
            </el-col>
            <el-col :xs="24" :sm="8">
              <div class="mp-item" :class="{ 'mp-haserr': !!errors.workType }">
                <label class="mp-lb">检修类型<span class="mp-req">*</span></label>
                <el-select v-model="dlg.form.workType" clearable :disabled="dlg.readonly" placeholder="请选择" @change="errors.workType = ''">
                  <el-option v-for="w in workTypeOpts" :key="w" :label="w" :value="w" />
                </el-select>
                <div v-if="errors.workType" class="mp-err">{{ errors.workType }}</div>
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item">
                <label class="mp-lb">检修内容</label>
                <el-input v-model="dlg.form.maintContent" type="textarea" :rows="3" maxlength="2000" :disabled="dlg.readonly" />
              </div>
            </el-col>
          </el-row>
        </div>

        <!-- 停电安排 -->
        <div class="mp-sec">
          <div class="mp-sec-title">停电安排</div>
          <el-row :gutter="16">
            <el-col :xs="24" :sm="12">
              <div class="mp-item" :class="{ 'mp-haserr': !!errors.outageStart }">
                <label class="mp-lb">计划停电开始时间<span class="mp-req">*</span></label>
                <plan-date-time v-model="dlg.form.outageStart" placeholder="开始时间" :disabled="dlg.readonly" @update:model-value="onOutageChange" />
                <div v-if="errors.outageStart" class="mp-err">{{ errors.outageStart }}</div>
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item" :class="{ 'mp-haserr': !!errors.outageEnd }">
                <label class="mp-lb">计划停电结束时间<span class="mp-req">*</span></label>
                <plan-date-time v-model="dlg.form.outageEnd" placeholder="结束时间" :disabled="dlg.readonly" @update:model-value="onOutageChange" />
                <div v-if="errors.outageEnd" class="mp-err">{{ errors.outageEnd }}</div>
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-dur">停电时长 <b>{{ durationText }}</b></div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item">
                <label class="mp-lb">计划工作时间<span class="mp-state">{{ workTimeTouched ? '已手动修改' : '自动生成' }}</span></label>
                <el-input v-model="dlg.form.workTime" maxlength="120" :disabled="dlg.readonly" @input="onWorkTimeInput" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item">
                <label class="mp-lb">影响用户和区域</label>
                <el-input v-model="dlg.form.affectArea" type="textarea" :rows="2" maxlength="500" :disabled="dlg.readonly" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">停电涉及中压配变数</label>
                <el-input v-model="dlg.form.transformerCount" maxlength="8" :disabled="dlg.readonly" @input="onCountChange" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">停电时户数</label>
                <div class="mp-ro">{{ householdsText }}</div>
                <div class="mp-ro-hint">自动计算：中压配变数 × 停电时长（小时）</div>
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item">
                <label class="mp-lb">涉及重要电力用户名称</label>
                <el-input v-model="dlg.form.importantUsers" type="textarea" :rows="2" maxlength="500" :disabled="dlg.readonly" />
              </div>
            </el-col>
          </el-row>
        </div>

        <!-- 风险与执行 -->
        <div class="mp-sec">
          <div class="mp-sec-title">风险与执行</div>
          <el-row :gutter="16">
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">电网风险等级</label>
                <el-select v-model="dlg.form.gridRisk" :disabled="dlg.readonly" placeholder="请选择">
                  <el-option v-for="g in MP_GRID_RISKS" :key="g" :label="g" :value="g" />
                </el-select>
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">作业风险等级</label>
                <el-select v-model="dlg.form.riskLevel" :disabled="dlg.readonly" placeholder="请选择">
                  <el-option v-for="r in MP_RISK_LEVELS" :key="r" :label="r" :value="r" />
                </el-select>
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">近2月停电次数</label>
                <el-input v-model="dlg.form.outageCount2m" maxlength="8" :disabled="dlg.readonly" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">本年度停电次数</label>
                <el-input v-model="dlg.form.outageCountYear" maxlength="8" :disabled="dlg.readonly" />
              </div>
            </el-col>
            <el-col :xs="24" :sm="12">
              <div class="mp-item">
                <label class="mp-lb">班组长<span v-if="derived.leader" class="mp-auto">自动带出</span></label>
                <el-select v-model="dlg.form.leader" filterable allow-create default-first-option clearable
                  placeholder="请选择或输入" :disabled="dlg.readonly" @change="onManual('leader')">
                  <el-option v-for="o in leaderOpts" :key="o" :label="o" :value="o" />
                </el-select>
              </div>
            </el-col>
            <el-col :xs="24" :sm="24">
              <div class="mp-item">
                <label class="mp-lb">备注</label>
                <el-input v-model="dlg.form.planNote" type="textarea" :rows="2" maxlength="500" :disabled="dlg.readonly" />
              </div>
            </el-col>
          </el-row>
        </div>
      </div>
      <template #footer>
        <div class="mp-foot">
          <span class="mp-foot-tip">带 <b>*</b> 为必填项</span>
          <div class="mp-foot-btns">
            <el-button @click="dlg.visible=false">{{ dlg.readonly ? '关闭' : '取消' }}</el-button>
            <el-button v-if="!dlg.readonly" type="primary" :loading="dlg.busy" @click="submit">确定</el-button>
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
        <el-table-column label="计划停电时间" width="190" class-name="pf-nowrap">
          <template #default="{row}"><span class="mp-time">{{ fmtRange(row.outageStart, row.outageEnd) }}</span></template>
        </el-table-column>
        <el-table-column prop="workTime" label="计划工作时间" min-width="170" show-overflow-tooltip />
        <el-table-column label="导入判定" min-width="184">
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
