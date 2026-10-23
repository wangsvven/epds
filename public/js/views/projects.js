/* ========== views/projects ========== */
/* 项目列表视图 ProjectsView。 */
/* ---------------- 项目列表 ---------------- */
const ProjectsView = {
  setup() {
    const { ref, reactive, computed, onMounted } = Vue;
    const activeTab = ref('自有工程');
    const projects = ref([]);
    const annualPlans = ref([]);
    const substations = ref([]);
    const users = ref([]);
    const materials = ref([]);
    const workPlans = ref([]);
    const units = ref([]);   // 单位维护（分包/监理/抄送），分包单位下拉数据源
    const unitsLoading = ref(true);
    const filters = reactive({ keyword: '', annualPlan: '', batch: '', substation: '', leader: '' });
    const page = ref(1);
    const pageSize = ref(50);

    const dialogVisible = ref(false);
    const editingId = ref(null);
    const emptyForm = () => ({ annualPlan: '', batch: '', name: '', subcontractor: '', contractNo: '', workType: '', specialty: '', provincialDept: '', substation: '', leader: '', startDate: '', endDate: '', subProjects: [], category: '', completed: false });
    const form = reactive(emptyForm());

    const workTypes = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
    const specialties = ['运检', '营销'];
    const provincialDepts = ['设备部', '产业部'];

    async function load() {
      try {
        const [p, a, ss, u, ms, wp, un] = await Promise.all([
          api.get('/api/projects'), api.get('/api/annualPlans'), api.get('/api/substations'), api.get('/api/users'),
          api.get('/api/materials'), api.get('/api/workPlans'), api.get('/api/units')
        ]);
        projects.value = p; annualPlans.value = a; substations.value = ss; users.value = u;
        materials.value = Array.isArray(ms) ? ms : (ms.data || []);
        workPlans.value = Array.isArray(wp) ? wp : (wp.data || []);
        units.value = Array.isArray(un) ? un : (un.data || []);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { unitsLoading.value = false; }
    }
    // 分包（己方）单位：来自全局设置「单位维护」中 type=分包单位 的字典
    const subcontractorUnits = computed(() => units.value.filter(u => u.type === '分包单位').slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)));
    // 项目关联的材料/计划：项目名 ∪ 子项目名（与材料台账、计划管理的关联项目口径一致）
    const projNames = computed(() => {
      const d = detail.value;
      if (!d) return [];
      return [d.name, ...((d.subProjects || []).map(s => s.name).filter(Boolean))];
    });
    const projMaterials = computed(() => {
      const names = projNames.value;
      return materials.value.filter(m => names.includes(m.project));
    });
    const projPlans = computed(() => {
      const names = projNames.value;
      return workPlans.value.filter(p => names.includes(p.project));
    });
    // 项目信息：字段键值对（响应式网格渲染）
    const projInfoFields = computed(() => {
      const d = detail.value;
      if (!d) return [];
      return [
        ['项目名称（包）', d.name || '-'],
        ['项目名称(自定义)', d.customName || '-'],
        ['年度计划', d.annualPlan || '-'],
        ['批次', d.batch || '-'],
        ['分包单位', d.subcontractor || '-'],
        ['合同编号', d.contractNo || '-'],
        ['作业类型', d.workType || '-'],
        ['作业专业', d.specialty || '-'],
        ['省专业管理部门', d.provincialDept || '-'],
        ['子项目列表', (d.subProjects && d.subProjects.length) ? d.subProjects.map(s => s.name).join('、') : '无'],
        ['属地供电所', d.substation || '-'],
        ['班组长', d.leader || '-'],
        ['开工日期', d.startDate || '-'],
        ['预期竣工日期', d.endDate || '-'],
        ['创建时间', fmtDT(d.createdAt)]
      ];
    });
    // 周计划进度芯片（复用列表口径）
    const projProgressChips = computed(() => detail.value ? progressChips(detail.value) : []);
    const projProgressHasData = computed(() => {
      const p = detail.value && detail.value.progress;
      if (!p) return false;
      return !!(p.pole && p.pole.total) || !!(p.cable && p.cable.total) || !!(p.device && p.device.total);
    });
    // 材料归类（按包汇总）：电杆 / 导线 / 设备 / 金具及铁附件
    // 电杆：混凝土电杆 / 预应力 / 方杆 / 电杆 / 水泥杆 / 钢管杆 / 等径杆 / 锥形杆
    // 导线：按国标型号命名匹配（忽略大小写）——
    //   裸导线 GJ(钢绞线)、GJX、LGJ(钢芯铝绞线)、LGJX、LGJF、LJ(铝绞线)、TJ(铜绞线)、JL/G1A~G3B
    //   架空绝缘 JKLYJ、JKLGYJ、JKLY、JKLV、JKYJ
    //   电力电缆 YJV、YJLV、YJY、YJLY、YJV22、YJLV22、VV、VLV
    //   电线 BV、BLV、BVR、BVV、BVVB、BLVV、BX、BLX、BXR、RV、RVS、RVV、RVVP
    //   控制电缆/光缆 KVV、KVVP、KYJV、OPGW、ADSS
    // 设备：变压器、JP柜（配电箱）、开关（含真空开关、隔离开关、负荷开关）、熔断器、断路器（含一二次融合）、
    //       避雷器、互感器、集中器、环网柜、分支箱
    // 金具及铁附件：抱箍 / 横担 / 线夹 / 挂环 / 接线端子 / 接地材料 / 绝缘子 / 护套 / 标识牌等；未匹配项也归此类，不再回落设备
    // 注意：金具关键词必须先于设备判断——「熔断器横担」「变压器抱箍」「JP柜固定螺杆」「避雷器绝缘护套」实际是铁附件而非设备
    const matType = matBucketOf; // 与全局材料分桶同口径（电杆/导线/设备/金具及铁附件）
    // 按包汇总：电杆 / 导线 / 设备 / 金具及铁附件
    // 单位换算：导线包口径为「千米」，而材料明细里的导线多以「米(m)」计量（钢绞线为 kg），
    // 汇总时把可折算项（m/米/km/千米/公里）统一折算为千米，不可折算项（如 kg）不进千米合计、单独提示。
    const ledger = computed(() => {
      const ms = projMaterials.value;
      const sum = (k) => ms.reduce((s, m) => s + (Number(m[k]) || 0), 0);
      const rows = LEDGER_CONF.map(([k, label, unit]) => {
        const typed = ms.filter(m => matType(m.description) === k);
        let erp, planned, extra = '';
        if (k === 'cable') {
          let erpKm = 0, planKm = 0, otherQty = 0, otherUnit = '';
          typed.forEach(m => {
            const rq = matUnitToKm(m.qtyRequired, m.unit);
            const pg = matUnitToKm(m.qtyGenerated, m.unit);
            if (rq === null) { otherQty += Number(m.qtyRequired) || 0; otherUnit = otherUnit || String(m.unit || ''); }
            else { erpKm += rq; planKm += pg === null ? 0 : pg; }
          });
          erp = Math.round(erpKm * 1000) / 1000;
          planned = Math.round(planKm * 1000) / 1000;
          if (otherQty > 0) extra = `另有 ${otherQty} ${otherUnit}（不折算）`;
        } else {
          erp = typed.reduce((s, m) => s + (Number(m.qtyRequired) || 0), 0);
          planned = typed.reduce((s, m) => s + (Number(m.qtyGenerated) || 0), 0);
        }
        const pct = erp > 0 ? Math.min(100, Math.floor(planned / erp * 100)) : 0;
        return { key: k, label, unit, erp, planned, pct, need: Math.max(0, Math.round((erp - planned) * 1000) / 1000), items: typed, extra };
      });
      return {
        count: ms.length,
        required: sum('qtyRequired'), arrived: sum('qtyArrived'), notArrived: sum('qtyNotArrived'),
        allCount: ms.filter(m => m.status === '全部到库').length,
        partCount: ms.filter(m => m.status === '部分到库').length,
        abnormal: ms.filter(m => m.status === '异常').length,
        invalid: ms.filter(m => m.status === '无效数据').length,
        rows
      };
    });
    // 跳转全局材料台账（带本项目筛选）/ 计划管理（带项目关键词）
    function enterMaterials() {
      window.dispatchEvent(new CustomEvent('materials-filter-project', { detail: { project: detail.value.name } }));
      window.dispatchEvent(new CustomEvent('nav-materials'));
    }
    // 查看月计划/周计划：精准跳转到「计划管理」对应页签，并只保留本项目（含子项目）的计划
    // 计划管理为懒挂载组件，事件会先于其监听器注册触发，故先把跳转意图全局暂存、由目标页 setup 时消费
    function enterPlans(kind) {
      const d = detail.value || {};
      window.__pendingPlansNav = {
        tab: kind === 'month' ? 'month' : 'week',
        label: d.name || '',
        names: projNames.value.slice()
      };
      window.dispatchEvent(new CustomEvent('nav-plans'));
    }
    function fmtQty(n) { const v = Number(n) || 0; return String(Math.round(v * 10000) / 10000); }

    const batchOptions = computed(() => [...new Set(projects.value.map(x => x.batch).filter(Boolean))]);

    const filteredList = computed(() => {
      const tab = activeTab.value;
      return projects.value.filter(p => {
        if (tab === '已竣工') { if (!p.completed) return false; }
        else if ((p.category || '自有工程') !== tab || p.completed) return false;
        if (filters.keyword) {
          const kw = filters.keyword.trim();
          const subNames = (p.subProjects || []).map(s => s.name).join('、');
          if (!(p.name || '').includes(kw) && !subNames.includes(kw)) return false;
        }
        if (filters.annualPlan && p.annualPlan !== filters.annualPlan) return false;
        if (filters.batch && p.batch !== filters.batch) return false;
        if (filters.substation && p.substation !== filters.substation) return false;
        if (filters.leader && p.leader !== filters.leader) return false;
        return true;
      });
    });
    const pagedList = computed(() => filteredList.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

    function switchTab(t) { activeTab.value = t; page.value = 1; }
    function resetFilters() { Object.assign(filters, { keyword: '', annualPlan: '', batch: '', substation: '', leader: '' }); page.value = 1; }

    // 局计划进度：深蓝=电杆、浅蓝=线材、灰=设备；完成 100% 隐藏，<1% 显示 <1%，超额显示超出比例
    function progressChips(row) {
      const conf = [['pole', '电杆', '#3370ff'], ['cable', '线材', '#7aa7ff'], ['device', '设备', 'var(--line-strong)']];
      const out = [];
      conf.forEach(([k, label, color]) => {
        const p = (row.progress && row.progress[k]) || {};
        const total = p.total || 0, done = p.done || 0;
        if (!total || done <= 0) { out.push({ text: '0%', color }); return; }
        const r = done / total;
        if (r === 1) return; // 完成 100% 时隐藏
        out.push({ text: r < 0.01 ? '<1%' : Math.floor(r * 100) + '%', color });
      });
      return out;
    }

    function openAdd() {
      editingId.value = null;
      Object.assign(form, emptyForm());
      form.category = activeTab.value === '客户工程' ? '客户工程' : '自有工程';
      dialogVisible.value = true;
    }
    function openEdit(p) {
      editingId.value = p.id;
      Object.assign(form, emptyForm(), JSON.parse(JSON.stringify(p)), { subProjects: (p.subProjects || []).map(s => ({ ...s })) });
      dialogVisible.value = true;
    }
    function addSub() { form.subProjects.push({ name: '', substation: '', leader: '' }); }
    function removeSub(i) { form.subProjects.splice(i, 1); }

    async function submit() {
      if (!form.annualPlan) return ElementPlus.ElMessage.error('请选择年度计划名称');
      if (!form.name) return ElementPlus.ElMessage.error('请输入项目名称（包）');
      if (!form.substation) return ElementPlus.ElMessage.error('请选择属地供电所');
      for (let i = 0; i < form.subProjects.length; i++) {
        const s = form.subProjects[i];
        if (!s.name || !s.substation) return ElementPlus.ElMessage.error('子项目 ' + (i + 1) + '：名称、属地供电所均为必填');
      }
      try {
        const body = JSON.parse(JSON.stringify(form));
        if (editingId.value) { await api.put('/api/projects/' + editingId.value, body); ElementPlus.ElMessage.success('已保存'); }
        else { await api.post('/api/projects', body); ElementPlus.ElMessage.success('新增成功'); }
        dialogVisible.value = false;
        await load();
        // 详情页打开时同步最新数据
        if (detail.value) detail.value = projects.value.find(x => x.id === detail.value.id) || null;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    // ---- 项目详情页 ----
    const detail = ref(null);
    function showDetail(p) { detail.value = p; }
    function backToList() { detail.value = null; load(); }
    async function completeProject() {
      try { await ElementPlus.ElMessageBox.confirm('确认将该项目标记为竣工？竣工后将移入「已竣工」列表。', '竣工', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); } catch { return; }
      try {
        await api.put('/api/projects/' + detail.value.id + '/complete');
        ElementPlus.ElMessage.success('已竣工');
        backToList();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function removeProject() {
      try { await ElementPlus.ElMessageBox.confirm('删除后不可恢复，确认删除该项目？', '删除项目', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); } catch { return; }
      try {
        await api.del('/api/projects/' + detail.value.id);
        ElementPlus.ElMessage.success('已删除');
        backToList();
      } catch (e) {
        // 依赖引用校验未通过：列出被哪些业务数据引用，避免用户反复试
        const refs = e && e.data && e.data.refs;
        if (Array.isArray(refs) && refs.length) {
          const html = '<div style="line-height:1.8">该项目已被以下业务数据引用，请先到对应模块清理后再删除：</div>'
            + '<div style="margin-top:10px;line-height:2">'
            + refs.map(r => '· ' + r.label + '：<b>' + r.count + '</b> 条').join('<br>')
            + '</div>';
          ElementPlus.ElMessageBox.alert(html, '该项目已被其他数据引用，无法删除', {
            dangerouslyUseHTMLString: true, confirmButtonText: '知道了', type: 'warning'
          });
        } else {
          ElementPlus.ElMessage.error(e.message || '删除失败');
        }
      }
    }

    // ---- 详情页资料管理：设计图纸/奥维地图/现场照片/规范图纸 ----
    const FILE_TYPE_CONF = {
      design: { label: '设计图纸', maxMB: 2, multiple: true },
      map:    { label: '奥维地图', maxMB: 2, multiple: false },
      photo:  { label: '现场照片', maxMB: 10, multiple: true },
      spec:   { label: '规范图纸', maxMB: 3, multiple: true }
    };
    const projFileInput = ref(null);
    const projUploadType = ref('');
    function projFiles(type) { return ((detail.value && detail.value.files) || []).filter(f => f.type === type); }
    function triggerProjUpload(type) {
      projUploadType.value = type;
      if (projFileInput.value) { projFileInput.value.value = ''; projFileInput.value.click(); }
    }
    async function onProjUpload(ev) {
      const files = [...(ev.target.files || [])];
      if (!files.length || !detail.value) return;
      for (const file of files) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('type', projUploadType.value);
        try {
          const res = await fetch('/api/projects/' + detail.value.id + '/files', {
            method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '上传失败');
          detail.value.files = detail.value.files || [];
          detail.value.files.push(data);
          ElementPlus.ElMessage.success(file.name + ' 上传成功');
        } catch (e) { ElementPlus.ElMessage.error(e.message); }
      }
    }
    async function delProjFile(f) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除「' + f.name + '」？', '删除', { type: 'warning' }); } catch { return; }
      try {
        await api.del('/api/projects/' + detail.value.id + '/files/' + f.id);
        detail.value.files = detail.value.files.filter(x => x.id !== f.id);
        ElementPlus.ElMessage.success('已删除');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function packProjDownload(type) {
      fetch('/api/projects/' + detail.value.id + '/files/pack?type=' + type, {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }
      })
        .then(r => { if (!r.ok) return r.json().then(d => { throw new Error(d.error || '下载失败'); }); return r.blob(); })
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (detail.value.name || '项目') + '-' + FILE_TYPE_CONF[type].label + '.zip';
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        })
        .catch(e => ElementPlus.ElMessage.error(e.message));
    }
    function fmtDT(s) {
      if (!s) return '-';
      const d = new Date(s);
      if (isNaN(d)) return s;
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    // ---- 详情页材料台账汇总（材料台账/周计划模块完成前，按项目进度推导的占位数据） ----
    const LEDGER_CONF = [['pole', '电杆', '根'], ['cable', '导线', '千米'], ['device', '设备', '台'], ['fitting', '金具及铁附件', '件']];
    // 包配色（与项目列表局计划进度色一致：深蓝=电杆、浅蓝=导线、灰=设备；琥珀=金具及铁附件）
    function pkgColor(key) { return { pole: '#3370ff', cable: '#7aa7ff', device: 'var(--text-3)', fitting: '#e6a23c' }[key] || 'var(--text-3)'; }
    // 材料状态 → 标签类型（扁平 plain 样式）
    function statusTagType(s) {
      if (s === '全部到库') return 'success';
      if (s === '部分到库') return 'warning';
      if (s === '已生成领料单') return 'primary';
      if (s === '未到库') return 'danger';
      return 'info';
    }

    onMounted(load);

    return {
      activeTab, projects, annualPlans, substations, users, filters, page, pageSize,
      batchOptions, filteredList, pagedList, switchTab, resetFilters, progressChips,
      dialogVisible, editingId, form, workTypes, specialties, provincialDepts,
      units, unitsLoading, subcontractorUnits,
      openAdd, openEdit, addSub, removeSub, submit,
      detail, showDetail, backToList, completeProject, removeProject,
      projFileInput, projFiles, triggerProjUpload, onProjUpload, delProjFile, packProjDownload, fmtDT,
      projMaterials, projPlans, ledger, enterMaterials, enterPlans, fmtQty, pkgColor, statusTagType,
      projInfoFields, projProgressChips, projProgressHasData
    };
  },
  template: `
  <div>
   <template v-if="!detail">
    <!-- 顶部页签 -->
    <div class="proj-bar">
      <div class="seg">
        <div v-for="t in ['自有工程','客户工程','已竣工']" :key="t" @click="switchTab(t)"
          class="seg-item" :class="{ on: activeTab===t }">{{ t }}</div>
      </div>
      <div class="bar-spacer"></div>
      <el-button v-if="activeTab!=='已竣工' && canWrite('projects')" type="primary" @click="openAdd">新增项目</el-button>
    </div>

    <!-- 筛选 -->
    <div class="panel" style="padding:14px 16px;margin:14px 0 12px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:14px;color:var(--text-1)">筛选：</span>
        <el-input v-model="filters.keyword" placeholder="项目名称（包）/子项目..." clearable style="width:200px" @input="page=1" />
        <el-select v-model="filters.annualPlan" placeholder="年度计划" clearable style="width:170px" @change="page=1">
          <el-option v-for="a in annualPlans" :key="a.id" :label="a.name" :value="a.name" />
        </el-select>
        <el-select v-model="filters.batch" placeholder="批次" clearable style="width:120px" @change="page=1">
          <el-option v-for="b in batchOptions" :key="b" :label="b" :value="b" />
        </el-select>
        <el-select v-model="filters.substation" placeholder="属地供电所" clearable style="width:150px" @change="page=1">
          <el-option v-for="s in substations" :key="s.id" :label="s.name" :value="s.name" />
        </el-select>
        <el-select v-model="filters.leader" placeholder="班组长" clearable style="width:130px" @change="page=1">
          <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.name" />
        </el-select>
        <el-button @click="resetFilters">重置</el-button>
      </div>
      <div style="color:var(--text-3);font-size:12px;margin-top:10px">过滤分组排序：电杆、线材、设备；深蓝=电杆，浅蓝=线材，灰=设备（括内显示数量，完成 100% 时隐藏，超额时显示超出比例）</div>
    </div>

    <!-- 列表 -->
    <el-table :data="pagedList" style="width:100%">
      <el-table-column type="index" label="序号" width="70" align="center" />
      <el-table-column prop="name" label="工程名称" min-width="260" show-overflow-tooltip>
        <template #default="{row}">
          <el-link type="primary" :underline="false" @click="showDetail(row)">{{ row.name }}</el-link>
        </template>
      </el-table-column>
      <el-table-column prop="substation" label="属地供电所" min-width="150" />
      <el-table-column label="班组长" width="110">
        <template #default="{row}">{{ row.leader || '-' }}</template>
      </el-table-column>
      <el-table-column label="子项目" min-width="130" show-overflow-tooltip>
        <template #default="{row}">{{ (row.subProjects || []).map(s => s.name).join('、') }}</template>
      </el-table-column>
      <el-table-column prop="endDate" label="预期竣工日期" width="130" />
      <el-table-column label="局计划进度" width="220">
        <template #default="{row}">
          <span v-for="(c,ci) in progressChips(row)" :key="ci"
            :style="{background:c.color,color:'#fff',fontSize:'11px',padding:'2px 8px',borderRadius:'3px',marginRight:'4px',display:'inline-block',lineHeight:'16px'}">{{ c.text }}</span>
        </template>
      </el-table-column>
    </el-table>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:14px">
      <span style="color:var(--text-2);font-size:13px">共 {{ filteredList.length }} 条</span>
      <el-pagination background layout="prev, pager, next" :total="filteredList.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
      <el-select :model-value="pageSize" size="small" style="width:104px" @change="n=>{pageSize=n;page=1}">
        <el-option v-for="n in [20,50,100]" :key="n" :label="n + ' 条/页'" :value="n" />
      </el-select>
    </div>

   </template>

   <!-- ============ 项目详情页 ============ -->
   <template v-else>
    <el-link type="primary" :underline="false" @click="backToList" style="font-size:14px;margin-bottom:14px">← 返回项目列表</el-link>

    <!-- 项目信息 -->
    <el-card shadow="never" style="margin-bottom:14px">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="min-width:0;display:flex;align-items:baseline;gap:8px">
            <span style="font-weight:600;flex-shrink:0">项目信息</span>
            <span style="color:var(--text-3);font-size:13px;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ detail.name }}</span>
          </div>
          <div v-if="canWrite('projects')" style="display:flex;align-items:center;gap:4px;flex-shrink:0">
            <el-button type="primary" size="small" @click="completeProject">竣工</el-button>
            <el-button size="small" @click="openEdit(detail)">编辑</el-button>
            <el-button link type="danger" size="small" @click="removeProject" style="margin-left:8px">删除项目</el-button>
          </div>
        </div>
      </template>
      <div class="proj-info-grid">
        <div class="pi-cell" v-for="f in projInfoFields" :key="f[0]">
          <div class="pi-label">{{ f[0] }}</div>
          <div class="pi-value">{{ f[1] }}</div>
        </div>
        <div class="pi-cell">
          <div class="pi-label">周计划进度</div>
          <div class="pi-value">
            <template v-if="projProgressChips.length">
              <span v-for="(c,ci) in projProgressChips" :key="ci" class="pi-chip" :style="{ color: c.color }">{{ c.text }}</span>
            </template>
            <span v-else class="pi-muted">{{ projProgressHasData ? '已全部完成' : '暂无进度数据' }}</span>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 资料管理 -->
    <el-card shadow="never" style="margin-bottom:14px">
      <template #header><span style="font-weight:600">资料管理</span></template>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 48px">
        <div>
          <div style="font-weight:600;font-size:14px;margin-bottom:14px">图纸</div>
          <div style="margin-bottom:20px">
            <div style="font-size:14px;color:var(--text-1);margin-bottom:8px">设计图纸</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button v-if="canWrite('projects')" type="primary" size="small" @click="triggerProjUpload('design')">上传设计图纸</el-button>
              <el-button size="small" :disabled="!projFiles('design').length" @click="packProjDownload('design')">打包下载（{{ projFiles('design').length }}）</el-button>
              <span style="color:var(--text-3);font-size:12px">可多选，单文件不超过 2MB</span>
            </div>
            <div v-for="f in projFiles('design')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed var(--line)">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-1)">{{ f.name }}</span>
              <el-button v-if="canWrite('projects')" link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:var(--text-3);font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('design').length" style="color:var(--text-3);font-size:12px;padding:8px 0">暂无设计图纸，可点击上传</div>
          </div>
          <div>
            <div style="font-size:14px;color:var(--text-1);margin-bottom:8px">奥维地图</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button v-if="canWrite('projects')" type="primary" size="small" @click="triggerProjUpload('map')">上传奥维地图</el-button>
              <el-button size="small" :disabled="!projFiles('map').length" @click="packProjDownload('map')">打包下载（{{ projFiles('map').length }}）</el-button>
              <span style="color:var(--text-3);font-size:12px">单文件不超过 2MB</span>
            </div>
            <div v-for="f in projFiles('map')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed var(--line)">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-1)">{{ f.name }}</span>
              <el-button v-if="canWrite('projects')" link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:var(--text-3);font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('map').length" style="color:var(--text-3);font-size:12px;padding:8px 0">暂无奥维地图，可点击上传</div>
          </div>
        </div>
        <div>
          <div style="font-weight:600;font-size:14px;margin-bottom:14px">现场资料</div>
          <div style="margin-bottom:20px">
            <div style="font-size:14px;color:var(--text-1);margin-bottom:8px">现场照片</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button v-if="canWrite('projects')" type="primary" size="small" @click="triggerProjUpload('photo')">上传现场照片</el-button>
              <el-button size="small" :disabled="!projFiles('photo').length" @click="packProjDownload('photo')">打包下载（{{ projFiles('photo').length }}）</el-button>
              <span style="color:var(--text-3);font-size:12px">可多选，单张不超过 10MB</span>
            </div>
            <div v-for="f in projFiles('photo')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed var(--line)">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-1)">{{ f.name }}</span>
              <el-button v-if="canWrite('projects')" link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:var(--text-3);font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('photo').length" style="color:var(--text-3);font-size:12px;padding:8px 0">暂无现场照片，可点击上传</div>
          </div>
          <div>
            <div style="font-size:14px;color:var(--text-1);margin-bottom:8px">规范图纸</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button v-if="canWrite('projects')" type="primary" size="small" @click="triggerProjUpload('spec')">上传规范图纸</el-button>
              <el-button size="small" :disabled="!projFiles('spec').length" @click="packProjDownload('spec')">打包下载（{{ projFiles('spec').length }}）</el-button>
              <span style="color:var(--text-3);font-size:12px">可多选，单文件不超过 3MB</span>
            </div>
            <div v-for="f in projFiles('spec')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed var(--line)">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-1)">{{ f.name }}</span>
              <el-button v-if="canWrite('projects')" link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:var(--text-3);font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('spec').length" style="color:var(--text-3);font-size:12px;padding:8px 0">暂无规范图纸，可点击上传</div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 计划管理 -->
    <el-card shadow="never" style="margin-bottom:14px">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">计划管理</span>
          <div style="display:flex;gap:16px">
            <el-link type="primary" :underline="false" @click="enterPlans('month')">查看月计划</el-link>
            <el-link type="primary" :underline="false" @click="enterPlans('week')">查看周计划</el-link>
          </div>
        </div>
      </template>
      <div style="margin-bottom:18px">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px">月计划（{{ projPlans.filter(p => p.planType === '月计划').length }}）</div>
        <el-table v-if="projPlans.filter(p => p.planType === '月计划').length" :data="projPlans.filter(p => p.planType === '月计划')" border size="small">
          <el-table-column prop="name" label="计划名称" min-width="220" show-overflow-tooltip />
          <el-table-column prop="team" label="作业班组" width="120" />
          <el-table-column prop="leader" label="班组长" width="100" />
          <el-table-column prop="startDate" label="开始" width="120" />
          <el-table-column prop="endDate" label="结束" width="120" />
          <el-table-column prop="status" label="状态" width="90" />
        </el-table>
        <div v-else style="color:var(--text-3);font-size:13px">暂无与本项目关联的月计划，可在「计划管理」-「月计划管理」中新增计划并关联本项目。</div>
      </div>
      <div>
        <div style="font-weight:600;font-size:14px;margin-bottom:8px">周计划（{{ projPlans.filter(p => p.planType === '周计划').length }}）</div>
        <el-table v-if="projPlans.filter(p => p.planType === '周计划').length" :data="projPlans.filter(p => p.planType === '周计划')" border size="small">
          <el-table-column prop="name" label="计划名称" min-width="220" show-overflow-tooltip />
          <el-table-column prop="team" label="作业班组" width="120" />
          <el-table-column prop="leader" label="班组长" width="100" />
          <el-table-column prop="startDate" label="开始" width="120" />
          <el-table-column prop="endDate" label="结束" width="120" />
          <el-table-column prop="status" label="状态" width="90" />
        </el-table>
        <div v-else style="color:var(--text-3);font-size:13px">暂无与本项目关联的周计划，可在「计划管理」-「周计划管理」中新增计划并关联本项目。</div>
      </div>
    </el-card>

    <!-- 材料台账 -->
    <el-card shadow="never">
      <template #header>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">材料台账</span>
          <el-button type="primary" size="small" @click="enterMaterials">进入材料台账</el-button>
        </div>
      </template>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px">
        <div style="border:1px solid var(--line);border-radius:4px;padding:12px 16px;background:var(--surface)">
          <div style="font-size:20px;font-weight:700;color:#3370ff;line-height:26px">{{ ledger.count }}</div>
          <div style="color:var(--text-3);font-size:12px;margin-top:2px">材料行</div>
        </div>
        <div style="border:1px solid var(--line);border-radius:4px;padding:12px 16px;background:var(--surface)">
          <div style="display:flex;gap:18px">
            <div style="white-space:nowrap"><div style="font-size:17px;font-weight:700;color:#3370ff;line-height:24px">{{ fmtQty(ledger.required) }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">应到</div></div>
            <div style="white-space:nowrap"><div style="font-size:17px;font-weight:700;color:#389e0d;line-height:24px">{{ fmtQty(ledger.arrived) }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">已到</div></div>
            <div style="white-space:nowrap"><div style="font-size:17px;font-weight:700;color:#f56c6c;line-height:24px">{{ fmtQty(ledger.notArrived) }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">未到</div></div>
          </div>
        </div>
        <div style="border:1px solid var(--line);border-radius:4px;padding:12px 16px;background:var(--surface)">
          <div style="display:flex;gap:18px">
            <div><div style="font-size:20px;font-weight:700;color:#389e0d;line-height:26px">{{ ledger.allCount }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">全部到库</div></div>
            <div><div style="font-size:20px;font-weight:700;color:#e6932c;line-height:26px">{{ ledger.partCount }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">部分到库</div></div>
          </div>
        </div>
        <div style="border:1px solid var(--line);border-radius:4px;padding:12px 16px;background:var(--surface)">
          <div style="display:flex;gap:18px">
            <div><div style="font-size:20px;font-weight:700;color:#f56c6c;line-height:26px">{{ ledger.notArrived }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">未到</div></div>
            <div><div style="font-size:20px;font-weight:700;color:#e6a23c;line-height:26px">{{ ledger.abnormal }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">异常</div></div>
            <div><div style="font-size:20px;font-weight:700;color:var(--text-3);line-height:26px">{{ ledger.invalid }}</div><div style="color:var(--text-3);font-size:12px;margin-top:2px">无效</div></div>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-weight:600;font-size:14px">按包汇总</span>
        <span style="color:var(--text-3);font-size:12px">台账应到 / 已报计划量 / 需补计划量</span>
      </div>
      <el-table :data="ledger.rows" border size="small">
        <el-table-column type="expand">
          <template #default="{row}">
            <div style="padding:8px 16px 12px;background:var(--surface-2)">
              <el-table :data="row.items" size="small" border>
                <el-table-column prop="description" label="物料描述" min-width="300">
                  <template #default="{row}">
                    <div style="white-space:normal;word-break:break-all;line-height:1.5">{{ row.description }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="应到" width="120" align="right"><template #default="{row}">{{ fmtQty(row.qtyRequired) }}</template></el-table-column>
                <el-table-column label="已到" width="120" align="right"><template #default="{row}">{{ fmtQty(row.qtyArrived) }}</template></el-table-column>
                <el-table-column label="未到" width="120" align="right"><template #default="{row}">{{ fmtQty(row.qtyNotArrived) }}</template></el-table-column>
                <el-table-column prop="unit" label="单位" width="80" align="center" />
                <el-table-column label="状态" width="110" align="center">
                  <template #default="{row}"><el-tag size="small" effect="plain" :type="statusTagType(row.status)">{{ row.status }}</el-tag></template>
                </el-table-column>
                <template #empty><span style="color:var(--text-3);font-size:12px">该包暂无材料</span></template>
              </el-table>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="包" width="120" align="center">
          <template #default="{row}">
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600">
              <span :style="{width:'8px',height:'8px',borderRadius:'2px',background:pkgColor(row.key),display:'inline-block'}"></span>{{ row.label }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="单位" width="110" align="center">
          <template #default="{row}">
            <div>{{ row.unit }}</div>
            <div v-if="row.extra" class="ledger-unit-extra">{{ row.extra }}</div>
          </template>
        </el-table-column>
        <el-table-column label="ERP应到" width="140" align="right"><template #default="{row}"><span style="font-weight:600">{{ fmtQty(row.erp) }}</span></template></el-table-column>
        <el-table-column label="已报计划量（周计划）" min-width="240">
          <template #default="{row}">
            <div style="display:flex;align-items:center;gap:10px;padding:3px 0">
              <span style="font-size:13px;min-width:56px;text-align:right;white-space:nowrap">{{ fmtQty(row.planned) }}</span>
              <div style="flex:1;height:6px;background:var(--surface-3);border-radius:3px;overflow:hidden">
                <div :style="{ width: row.pct + '%', background: row.pct >= 100 ? '#389e0d' : '#3370ff', height: '100%', transition: 'width .3s' }"></div>
              </div>
              <span :style="{fontSize:'12px',flexShrink:0,color: row.pct >= 100 ? '#389e0d' : 'var(--text-2)',whiteSpace:'nowrap'}">已报 {{ row.pct }}%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="需补计划量" width="140" align="right">
          <template #default="{row}"><span :style="{fontWeight:600,color: row.need > 0 ? '#f56c6c' : 'var(--line-strong)'}">{{ fmtQty(row.need) }}</span></template>
        </el-table-column>
      </el-table>
    </el-card>

    <input ref="projFileInput" type="file" style="display:none" :multiple="['design','photo','spec'].includes(projUploadType)" @change="onProjUpload" />
   </template>

    <!-- 新增/编辑项目 -->
    <el-dialog :title="editingId ? '编辑项目' : '新增项目'" v-model="dialogVisible" width="720px" top="4vh">
      <div style="max-height:68vh;overflow:auto;padding-right:8px">
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>年度计划名称</div>
          <el-select v-model="form.annualPlan" placeholder="请选择" style="width:100%">
            <el-option v-for="a in annualPlans" :key="a.id" :label="a.name" :value="a.name" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">批次</div>
          <el-input v-model="form.batch" placeholder="请输入（选填）" />
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>项目名称（包）</div>
          <el-input v-model="form.name" placeholder="请输入项目名称（包）" />
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">分包单位</div>
          <el-select v-model="form.subcontractor" placeholder="请从分包（己方）单位中选择" clearable filterable allow-create default-first-option style="width:100%"
                     :loading="unitsLoading">
            <el-option v-for="u in subcontractorUnits" :key="u.id" :label="u.name" :value="u.name" />
          </el-select>
          <div v-if="!unitsLoading && !subcontractorUnits.length" style="font-size:12px;color:var(--text-3);margin-top:4px">
            暂无可选分包单位，请先到「全局设置 → 单位维护 → 分包单位」中添加
          </div>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">合同编号</div>
          <el-input v-model="form.contractNo" placeholder="请输入合同编号（选填）" clearable />
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">作业类型</div>
          <el-select v-model="form.workType" placeholder="请选择" style="width:100%">
            <el-option v-for="t in workTypes" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">作业专业</div>
          <el-select v-model="form.specialty" placeholder="请选择" style="width:100%">
            <el-option v-for="t in specialties" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">省专业管理部门</div>
          <el-select v-model="form.provincialDept" placeholder="请选择" style="width:100%">
            <el-option v-for="t in provincialDepts" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>属地供电所</div>
          <el-select v-model="form.substation" placeholder="请选择" style="width:100%">
            <el-option v-for="s in substations" :key="s.id" :label="s.name" :value="s.name" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">班组长（选填）</div>
          <el-select v-model="form.leader" placeholder="请选择（班组长用户组，可留空）" clearable style="width:100%">
            <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.name" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">子项目（选填）</div>
          <div v-for="(sp,si) in form.subProjects" :key="si" style="border:1px solid var(--line);border-radius:4px;padding:14px 16px;margin-bottom:12px">
            <div style="font-size:14px;color:var(--text-1);margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>子项目名称</div>
            <el-input v-model="sp.name" placeholder="请输入子项目名称" style="margin-bottom:12px" />
            <div style="font-size:14px;color:var(--text-1);margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>属地供电所</div>
            <el-select v-model="sp.substation" placeholder="请选择" style="width:100%;margin-bottom:12px">
              <el-option v-for="s in substations" :key="s.id" :label="s.name" :value="s.name" />
            </el-select>
            <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">班组长（选填）</div>
            <el-select v-model="sp.leader" placeholder="请选择（班组长用户组，可留空）" clearable style="width:100%;margin-bottom:8px">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.name" />
            </el-select>
            <el-button link type="danger" @click="removeSub(si)">删除</el-button>
          </div>
          <div style="border:1px dashed var(--line-strong);border-radius:4px;text-align:center;padding:12px;cursor:pointer;color:var(--text-2);font-size:14px" @click="addSub">+ 添加子项目</div>
        </div>
        <div style="margin-bottom:8px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">开工日期</div>
          <el-date-picker v-model="form.startDate" type="date" placeholder="请选择日期" value-format="YYYY-MM-DD" style="width:100%" />
        </div>
        <div style="margin-bottom:8px">
          <div style="font-size:14px;color:var(--text-1);margin-bottom:6px">预期竣工日期</div>
          <el-date-picker v-model="form.endDate" type="date" placeholder="请选择日期" value-format="YYYY-MM-DD" style="width:100%" />
        </div>
      </div>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">确定</el-button>
      </template>
    </el-dialog>
  </div>`
};
