/* ========== views/monthPlans ========== */
/* 月计划管理面板（检修口径）：字段/列表/筛选/导入预览判重/导出/状态流转。
   数据仍在 workPlans 集合（planType='月计划'），不新增后端接口：
   导入用浏览器端 xlsx 解析 + 逐条 POST /api/workPlans，导出用浏览器端 xlsx 生成。 */
const MP_DEVICE_TYPES = ['变电', '线路', '配电台区', '电缆'];
const MP_VOLTAGES = ['35kV', '10kV', '0.4kV', '20kV', '110kV', '220kV'];
const MP_WORK_TYPES = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
const MP_STATUS = ['未执行', '已执行', '已结算', '已归档', '已取消'];
/* 导入/导出共用的列（按列表列序，作业类型与班组长插在设备类型之后） */
const MP_COLS = [
  { key: 'maintUnit', label: '检修单位' },
  { key: 'project', label: '涉及工程项目' },
  { key: 'maintDevice', label: '检修设备' },
  { key: 'voltage', label: '电压等级' },
  { key: 'deviceType', label: '设备类型' },
  { key: 'workType', label: '作业类型' },
  { key: 'leader', label: '班组长' },
  { key: 'outageStart', label: '计划停电开始' },
  { key: 'outageEnd', label: '计划停电结束' },
  { key: 'workStart', label: '计划工作开始' },
  { key: 'workEnd', label: '计划工作结束' }
];

/* 判重口径（纯函数，页面与冒烟共用）：同一导入年份内，检修设备 + 计划停电开始 相同 → 疑似重复；
   比对范围 = 已入库同年月计划 + 本次文件内自重复（第二条起算重复）。 */
const MonthPlanCalc = {
  keyOf(o) { return String((o && o.maintDevice) || '').trim() + '||' + String((o && o.outageStart) || '').trim(); },
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
  }
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
    const substations = ref([]);
    const units = ref([]);
    const leaderAccounts = ref([]);
    const importYear = ref(String(new Date().getFullYear()));

    const yearOpts = computed(() => {
      const y = new Date().getFullYear();
      return [y - 1, y, y + 1].map(String);
    });
    // 历史值去重（下拉给 allow-create 手填，历史值同时作为候选，避免老数据选不到）
    const uniq = arr => Array.from(new Set(arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean)));
    const hist = key => uniq(list.value.map(p => p[key]));
    const areaOpts = computed(() => uniq([...substations.value, ...hist('areaStation')]));
    const maintUnitOpts = computed(() => uniq([...units.value, ...substations.value, ...hist('maintUnit')]));
    const leaderOpts = computed(() => uniq([...leaderAccounts.value, ...hist('leader')]));
    const workTypeOpts = computed(() => uniq([...MP_WORK_TYPES, ...hist('workType')]));
    const deviceTypeOpts = computed(() => uniq([...MP_DEVICE_TYPES, ...hist('deviceType')]));
    const voltageOpts = computed(() => uniq([...MP_VOLTAGES, ...hist('voltage')]));

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
        const [ss, un, us] = await Promise.all([
          api.get('/api/substations'), api.get('/api/units'), api.get('/api/users')
        ]);
        substations.value = (ss || []).filter(x => x && !x.deleted).map(x => x.name);
        units.value = (un || []).filter(x => x && !x.deleted).map(x => x.name);
        leaderAccounts.value = (us || []).filter(u => u && u.userGroup === '班组长' && u.status !== '停用').map(u => u.name);
      } catch (e) { /* 选项加载失败不阻断主流程 */ }
    }

    // 页签归属：月计划管理 = 月计划且未执行；已归档月计划 = 月计划且已归档
    const tabList = computed(() => props.tab === 'archived'
      ? list.value.filter(p => p.status === '已归档')
      : list.value.filter(p => p.status === '未执行'));

    const filtered = computed(() => tabList.value.filter(p => {
      if (props.projectScope && props.projectScope.length && !props.projectScope.includes(p.project)) return false;
      if (filters.areaStation && (p.areaStation || '') !== filters.areaStation) return false;
      if (filters.workType && (p.workType || '') !== filters.workType) return false;
      if (filters.leader && (p.leader || '') !== filters.leader) return false;
      const d = String(p.outageStart || '').slice(0, 10);
      if (filters.startDate && (!d || d < filters.startDate)) return false;
      if (filters.endDate && (!d || d > filters.endDate)) return false;
      const kw = filters.keyword.trim();
      if (kw) {
        const hay = [p.project, p.maintDevice, p.maintUnit].map(x => String(x || '')).join(' ');
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
    // 状态徽标配色
    const badgeClass = st => ({ '未执行': 'mp-b-new', '已执行': 'mp-b-run', '已结算': 'mp-b-done', '已归档': 'mp-b-arc', '已取消': 'mp-b-can' }[st] || 'mp-b-new');

    /* ---------------- 新增 / 编辑 / 查看 ---------------- */
    const dlg = reactive({ visible: false, editingId: '', busy: false, readonly: false, form: null });
    function blankForm() {
      return {
        maintUnit: '', areaStation: '', project: '', maintDevice: '', voltage: '10kV', deviceType: '',
        workType: '', leader: '', outageStart: '', outageEnd: '', workStart: '', workEnd: '', status: '未执行'
      };
    }
    function openAdd() {
      dlg.editingId = ''; dlg.readonly = false; dlg.form = blankForm(); dlg.visible = true;
    }
    function openEdit(row) {
      dlg.editingId = row.id; dlg.readonly = false;
      dlg.form = Object.assign(blankForm(), {
        maintUnit: row.maintUnit || '', areaStation: row.areaStation || '', project: row.project || '',
        maintDevice: row.maintDevice || row.name || '', voltage: row.voltage || '10kV', deviceType: row.deviceType || '',
        workType: row.workType || '', leader: row.leader || '',
        outageStart: row.outageStart || row.startDate || '', outageEnd: row.outageEnd || row.endDate || '',
        workStart: row.workStart || '', workEnd: row.workEnd || '', status: row.status || '未执行'
      });
      dlg.visible = true;
    }
    function openView(row) { openEdit(row); dlg.readonly = true; }
    function warn(msg) { ElementPlus.ElMessage.warning(msg); }

    async function submit() {
      const f = dlg.form;
      if (!String(f.maintUnit || '').trim()) return warn('请填写检修单位');
      if (!String(f.project || '').trim()) return warn('请填写涉及工程项目');
      if (!String(f.maintDevice || '').trim()) return warn('请填写检修设备');
      if (!f.voltage) return warn('请选择电压等级');
      if (!f.outageStart || !f.outageEnd) return warn('请选择计划停电时间');
      if (!f.workStart || !f.workEnd) return warn('请选择计划工作时间');
      if (normDT(f.outageEnd) < normDT(f.outageStart)) return warn('计划停电结束时间不能早于开始时间');
      if (normDT(f.workEnd) < normDT(f.workStart)) return warn('计划工作结束时间不能早于开始时间');
      const body = {
        planType: '月计划',
        name: String(f.maintDevice).trim(),          // workPlans.name 是核心字段，月计划取其检修设备
        maintUnit: String(f.maintUnit).trim(), areaStation: String(f.areaStation || '').trim(),
        project: String(f.project).trim(), maintDevice: String(f.maintDevice).trim(),
        voltage: f.voltage, deviceType: f.deviceType || '',
        workType: f.workType || '', leader: f.leader || '',
        outageStart: normDT(f.outageStart), outageEnd: normDT(f.outageEnd),
        workStart: normDT(f.workStart), workEnd: normDT(f.workEnd),
        // 共用页签（已执行/已结算/日历/已归档）读 startDate/endDate，统一同步为停电时间
        startDate: normDT(f.outageStart), endDate: normDT(f.outageEnd),
        status: dlg.editingId ? (f.status || '未执行') : '未执行'
      };
      dlg.busy = true;
      try {
        if (dlg.editingId) await api.put('/api/workPlans/' + dlg.editingId, body);
        else await api.post('/api/workPlans', body);
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

    /* ---------------- 导出（当前页签 + 当前筛选，可回灌） ---------------- */
    const blank = v => (v == null ? '' : String(v));
    function exportXlsx() {
      const rows = filtered.value;
      const aoa = [MP_COLS.map(c => c.label)];
      rows.forEach(p => aoa.push(MP_COLS.map(c => blank(p[c.key]))));
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = MP_COLS.map(c => ({ wch: ['涉及工程项目'].includes(c.label) ? 28 : (['检修设备', '检修单位'].includes(c.label) ? 22 : 18) }));
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
      const need = MP_COLS.map(c => c.label);
      const miss = need.filter(n => idx[n] === undefined);
      if (miss.length) {
        ElementPlus.ElMessage.error('表头缺少列：' + miss.join('、') + '。应为：' + need.join('、'));
        return;
      }
      const pick = (r, name) => cellText(r[idx[name]]);
      const parsed = [];
      const bad = [];
      for (let i = 1; i < aoa.length; i++) {
        const r = aoa[i];
        if (!r) continue;
        const o = {
          maintUnit: pick(r, '检修单位'), project: pick(r, '涉及工程项目'), maintDevice: pick(r, '检修设备'),
          voltage: pick(r, '电压等级'), deviceType: pick(r, '设备类型'), workType: pick(r, '作业类型'), leader: pick(r, '班组长'),
          outageStart: normDT(pick(r, '计划停电开始')), outageEnd: normDT(pick(r, '计划停电结束')),
          workStart: normDT(pick(r, '计划工作开始')), workEnd: normDT(pick(r, '计划工作结束')),
          __row: i + 1
        };
        if (!o.maintUnit && !o.project && !o.maintDevice && !o.outageStart) continue;   // 空行
        const lack = [];
        if (!o.maintUnit) lack.push('检修单位');
        if (!o.project) lack.push('涉及工程项目');
        if (!o.maintDevice) lack.push('检修设备');
        if (!o.voltage) lack.push('电压等级');
        if (!o.outageStart) lack.push('计划停电开始');
        if (!o.outageEnd) lack.push('计划停电结束');
        if (!o.workStart) lack.push('计划工作开始');
        if (!o.workEnd) lack.push('计划工作结束');
        if (lack.length) bad.push('第' + (i + 1) + '行缺少：' + lack.join('、'));
        parsed.push(o);
      }
      if (bad.length) {
        ElementPlus.ElMessage.error('文件有 ' + bad.length + ' 行数据不完整，未导入：' + bad.slice(0, 3).join('；') + (bad.length > 3 ? ' …' : ''));
        return;
      }
      if (!parsed.length) { ElementPlus.ElMessage.warning('文件中没有可导入的数据行'); return; }
      // 判重：同一导入年份内，检修设备 + 计划停电开始相同 → 疑似重复
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
          await api.post('/api/workPlans', {
            planType: '月计划', status: '未执行',
            name: r.maintDevice, maintUnit: r.maintUnit, project: r.project, maintDevice: r.maintDevice,
            voltage: r.voltage, deviceType: r.deviceType, workType: r.workType, leader: r.leader,
            outageStart: r.outageStart, outageEnd: r.outageEnd, workStart: r.workStart, workEnd: r.workEnd,
            startDate: r.outageStart, endDate: r.outageEnd
          });
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
      areaOpts, maintUnitOpts, leaderOpts, workTypeOpts, deviceTypeOpts, voltageOpts,
      tabList, filtered, paged, maxPage, idxBase, fmtRange, badgeClass,
      dlg, openAdd, openEdit, openView, submit,
      markExecuted, markSettled, backToTodo, cancelPlan,
      exportXlsx, imp, impInput, pickImpFile, onImpFile, confirmImport, impAddedCount, impDupCount,
      MP_DEVICE_TYPES, MP_VOLTAGES, MP_WORK_TYPES, MP_STATUS, MP_COLS
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
      <el-table-column prop="maintUnit" label="检修单位" width="96" show-overflow-tooltip />
      <el-table-column prop="project" label="涉及工程项目" min-width="112" show-overflow-tooltip />
      <el-table-column prop="maintDevice" label="检修设备" min-width="112" show-overflow-tooltip />
      <el-table-column prop="voltage" label="电压等级" width="76" align="center" />
      <el-table-column prop="deviceType" label="设备类型" width="76" />
      <el-table-column label="计划停电时间" width="178" class-name="pf-nowrap">
        <template #default="{row}"><span class="mp-time">{{ fmtRange(row.outageStart, row.outageEnd) }}</span></template>
      </el-table-column>
      <el-table-column label="计划工作时间" width="178" class-name="pf-nowrap">
        <template #default="{row}"><span class="mp-time">{{ fmtRange(row.workStart, row.workEnd) }}</span></template>
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
      v-model="dlg.visible" width="min(920px, 94%)" top="6vh">
      <el-form v-if="dlg.form" label-position="top" :disabled="dlg.readonly" style="max-height:70vh;overflow:auto;padding-right:6px">
        <el-row :gutter="18">
          <el-col :xs="24" :sm="12">
            <el-form-item label="检修单位" required>
              <el-select v-model="dlg.form.maintUnit" filterable allow-create default-first-option clearable placeholder="请选择或输入">
                <el-option v-for="o in maintUnitOpts" :key="o" :label="o" :value="o" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="属地供电所">
              <el-select v-model="dlg.form.areaStation" filterable allow-create default-first-option clearable placeholder="请选择或输入">
                <el-option v-for="o in areaOpts" :key="o" :label="o" :value="o" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="涉及工程项目" required>
              <el-input v-model="dlg.form.project" maxlength="120" placeholder="工程项目名称" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="检修设备" required>
              <el-input v-model="dlg.form.maintDevice" maxlength="120" placeholder="设备名称 / 线路杆段" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="电压等级" required>
              <el-select v-model="dlg.form.voltage" placeholder="请选择">
                <el-option v-for="v in voltageOpts" :key="v" :label="v" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="设备类型">
              <el-select v-model="dlg.form.deviceType" clearable placeholder="请选择">
                <el-option v-for="d in deviceTypeOpts" :key="d" :label="d" :value="d" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业类型">
              <el-select v-model="dlg.form.workType" clearable placeholder="请选择">
                <el-option v-for="w in workTypeOpts" :key="w" :label="w" :value="w" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="班组长">
              <el-select v-model="dlg.form.leader" filterable allow-create default-first-option clearable placeholder="请选择或输入">
                <el-option v-for="o in leaderOpts" :key="o" :label="o" :value="o" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划停电时间" required>
              <div class="mp-range">
                <plan-date-time v-model="dlg.form.outageStart" placeholder="开始时间" :disabled="dlg.readonly" />
                <span class="mp-range-sep">至</span>
                <plan-date-time v-model="dlg.form.outageEnd" placeholder="结束时间" :disabled="dlg.readonly" />
              </div>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划工作时间" required>
              <div class="mp-range">
                <plan-date-time v-model="dlg.form.workStart" placeholder="开始时间" :disabled="dlg.readonly" />
                <span class="mp-range-sep">至</span>
                <plan-date-time v-model="dlg.form.workEnd" placeholder="结束时间" :disabled="dlg.readonly" />
              </div>
            </el-form-item>
          </el-col>
          <el-col v-if="dlg.editingId" :xs="24" :sm="12">
            <el-form-item label="状态">
              <el-select v-model="dlg.form.status" placeholder="请选择">
                <el-option v-for="s in MP_STATUS" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">{{ dlg.readonly ? '关闭' : '取消' }}</el-button>
        <el-button v-if="!dlg.readonly" type="primary" :loading="dlg.busy" @click="submit">保存</el-button>
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
        <el-table-column prop="project" label="涉及工程项目" min-width="180" show-overflow-tooltip />
        <el-table-column prop="maintDevice" label="检修设备" min-width="160" show-overflow-tooltip />
        <el-table-column prop="voltage" label="电压等级" width="86" align="center" />
        <el-table-column prop="deviceType" label="设备类型" width="92" />
        <el-table-column label="计划停电时间" width="190" class-name="pf-nowrap">
          <template #default="{row}"><span class="mp-time">{{ fmtRange(row.outageStart, row.outageEnd) }}</span></template>
        </el-table-column>
        <el-table-column label="计划工作时间" width="190" class-name="pf-nowrap">
          <template #default="{row}"><span class="mp-time">{{ fmtRange(row.workStart, row.workEnd) }}</span></template>
        </el-table-column>
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
