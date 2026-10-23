/* ========== views/actualWorks ========== */
/* 工程实际施工量视图 ActualConstructionView 及工作类型与材料包映射常量。 */
/* ---------------- 工程实际施工量 ---------------- */
const ACTUAL_WORK_TYPES = ['转运', '立杆', '放线和设备安装'];
// 工作类型 → 材料包：转运/立杆 对应 电杆；放线和设备安装 对应 导线 + 设备
const ACTUAL_WORK_BUCKETS = {
  '转运': ['pole'],
  '立杆': ['pole'],
  '放线和设备安装': ['cable', 'device']
};
const ActualConstructionView = {
  setup() {
    const pad2 = n => String(n).padStart(2, '0');
    const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
    const tab = ref('fill');
    const form = reactive({ date: todayStr(), project: '', workTypes: [], workers: [] });
    // 工作类型 / 施工人员：默认单选，打开「多选」开关才支持多选
    const multi = reactive({ workTypes: false, workers: false });
    const projectsFull = ref([]);
    const materialsAll = ref([]);
    const usersAll = ref([]);
    const qtyMap = reactive({});
    const materialSearch = ref('');
    const records = ref([]);
    const loading = ref(false);
    const busy = ref(false);
    // 报表筛选
    const dateRange = ref(null);
    const fProject = ref('');
    const fWorkType = ref('');
    const fWorker = ref('');
    const fSubmitter = ref('');
    const page = ref(1);
    const pageSize = ref(20);
    const editingId = ref('');

    const projects = computed(() => projectsFull.value.map(p => p.name || p.projectName).filter(Boolean));
    const currentProject = computed(() => projectsFull.value.find(p => (p.name || p.projectName) === form.project) || null);
    const projectNames = computed(() => {
      const p = currentProject.value;
      if (!p) return [];
      return [p.name, ...((p.subProjects || []).map(s => s.name).filter(Boolean))];
    });
    // 施工人员：优先取该项目的班组长（含子项目），无则回退到「班组长」账号
    const leaders = computed(() => {
      const p = currentProject.value;
      const arr = [];
      if (p) { if (p.leader) arr.push(p.leader); (p.subProjects || []).forEach(s => { if (s.leader) arr.push(s.leader); }); }
      let uniq = [...new Set(arr.filter(Boolean))];
      if (!uniq.length) uniq = usersAll.value.filter(u => (u.userGroup || u.role) === '班组长').map(u => u.name).filter(Boolean);
      return [...new Set(uniq)];
    });
    // 所选工作类型对应的材料桶
    const selectedBuckets = computed(() => {
      const set = new Set();
      (form.workTypes || []).forEach(t => (ACTUAL_WORK_BUCKETS[t] || []).forEach(b => set.add(b)));
      return set;
    });
    // 材料：本项目（含子项目）中，按所选工作类型对应的包过滤；并标注所属包 / 包口径单位
    const projectMaterials = computed(() => {
      const names = projectNames.value;
      if (!names.length) return [];
      const buckets = selectedBuckets.value;
      if (!buckets.size) return [];
      return materialsAll.value
        .filter(m => !m.deleted && names.includes(m.project) && buckets.has(matBucketOf(m.description)))
        .map(m => {
          const pkg = matBucketOf(m.description);
          return { ...m, pkg, pkgLabel: MAT_PKG_LABEL[pkg] || pkg, unitKm: pkg === 'cable' && matUnitToKm(0, m.unit) !== null };
        });
    });
    const filteredMaterials = computed(() => {
      const k = materialSearch.value.trim();
      if (!k) return projectMaterials.value;
      return projectMaterials.value.filter(m => String(m.description || '').includes(k) || String(m.code || '').includes(k));
    });
    const reportRows = computed(() => {
      let list = records.value.slice();
      if (fProject.value) list = list.filter(r => r.project === fProject.value);
      if (fWorkType.value) list = list.filter(r => rowTypes(r).includes(fWorkType.value));
      if (fWorker.value) list = list.filter(r => rowWorkers(r).includes(fWorker.value));
      if (fSubmitter.value) list = list.filter(r => String(r.submitter || '') === fSubmitter.value);
      const dr = dateRange.value;
      if (Array.isArray(dr) && dr.length === 2 && dr[0] && dr[1]) list = list.filter(r => r.date >= dr[0] && r.date <= dr[1]);
      return list;
    });
    // 班组长 / 实施人员 筛选项（来自已有记录）
    const workerOptions = computed(() => [...new Set(records.value.flatMap(r => rowWorkers(r)).filter(Boolean))].sort());
    const submitterOptions = computed(() => [...new Set(records.value.map(r => String(r.submitter || '')).filter(Boolean))].sort());
    const paged = computed(() => reportRows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    watch(() => [reportRows.value.length, pageSize.value], () => {
      const maxP = Math.max(1, Math.ceil(reportRows.value.length / pageSize.value));
      if (page.value > maxP) page.value = maxP;
    });
    watch(() => form.project, () => {
      form.workers = (form.workers || []).filter(w => leaders.value.includes(w));
      materialSearch.value = '';
    });
    // 多选 → 单选时只保留第一个已选项，避免残留多个值
    watch(() => multi.workTypes, on => { if (!on && form.workTypes.length > 1) form.workTypes = form.workTypes.slice(0, 1); });
    watch(() => multi.workers, on => { if (!on && form.workers.length > 1) form.workers = form.workers.slice(0, 1); });
    // 项目或工作类型变化时，剔除已不在当前材料清单中的已填数量（保留仍可见的）
    watch(() => [form.project, form.workTypes.join('|')], () => {
      const ids = new Set(projectMaterials.value.map(m => m.id));
      Object.keys(qtyMap).forEach(k => { if (!ids.has(k)) delete qtyMap[k]; });
    });

    function rowTypes(r) { return Array.isArray(r.workTypes) ? r.workTypes : (r.workType ? [r.workType] : []); }
    function rowWorkers(r) { return Array.isArray(r.workers) ? r.workers : (r.worker ? [r.worker] : []); }

    async function loadMeta() {
      try { const r = await api.get('/api/projects'); projectsFull.value = Array.isArray(r) ? r : (r.data || []); } catch (e) {}
      try { const r = await api.get('/api/materials'); materialsAll.value = Array.isArray(r) ? r : (r.data || []); } catch (e) {}
      try { const r = await api.get('/api/users'); usersAll.value = Array.isArray(r) ? r : (r.data || []); } catch (e) {}
    }
    async function loadRecords() {
      loading.value = true;
      try { const r = await api.get('/api/actualWorks'); records.value = Array.isArray(r) ? r : (r.data || []); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function matQty(id) { const n = Number(qtyMap[id]); return Number.isFinite(n) && n > 0 ? n : 0; }
    // 导线类材料按「千米」折算显示（材料明细单位为米时）——返回 null 表示无需/无法折算
    function kmOf(row) {
      if (!row || row.pkg !== 'cable') return null;
      const q = matQty(row.id);
      if (!q) return null;
      const km = matUnitToKm(q, row.unit);
      return km === null ? null : fmtKm(km);
    }
    const filledCount = computed(() => projectMaterials.value.filter(m => matQty(m.id) > 0).length);
    function fmtQty(n) { const v = Math.round((Number(n) || 0) * 10000) / 10000; return String(v); }
    async function submit() {
      if (!form.date) return ElementPlus.ElMessage.warning('请选择日期');
      if (!form.project) return ElementPlus.ElMessage.warning('请选择项目名称（包）');
      if (!form.workTypes.length) return ElementPlus.ElMessage.warning('请选择工作类型');
      if (!form.workers.length) return ElementPlus.ElMessage.warning('请选择施工人员');
      const items = projectMaterials.value.filter(m => matQty(m.id) > 0)
        .map(m => ({ materialId: m.id, code: m.code || '', description: m.description || '', unit: m.unit || '', qty: matQty(m.id) }));
      if (projectMaterials.value.length && !items.length) return ElementPlus.ElMessage.warning('请至少填写一项材料实际施工量');
      busy.value = true;
      try {
        const payload = { date: form.date, project: form.project, workTypes: form.workTypes.slice(), workers: form.workers.slice(), items };
        if (editingId.value) {
          await api.put('/api/actualWorks/' + editingId.value, payload);
          ElementPlus.ElMessage.success('已保存');
        } else {
          await api.post('/api/actualWorks', payload);
          ElementPlus.ElMessage.success('已提交');
        }
        editingId.value = '';
        form.workTypes = [];
        form.workers = [];
        Object.keys(qtyMap).forEach(k => { delete qtyMap[k]; });
        await loadRecords();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { busy.value = false; }
    }
    // 编辑报表行：带回填写页
    function editRecord(row) {
      editingId.value = row.id;
      form.date = row.date || todayStr();
      form.project = row.project || '';
      const wt = rowTypes(row).slice(); form.workTypes = wt;
      const wk = rowWorkers(row).slice(); form.workers = wk;
      multi.workTypes = wt.length > 1;
      multi.workers = wk.length > 1;
      Object.keys(qtyMap).forEach(k => { delete qtyMap[k]; });
      (row.items || []).forEach(it => { if (it.materialId) qtyMap[it.materialId] = it.qty; });
      materialSearch.value = '';
      tab.value = 'fill';
      ElementPlus.ElMessage.info('已载入该条记录，修改后点「保存」');
    }
    function cancelEdit() {
      editingId.value = '';
      form.workTypes = []; form.workers = [];
      Object.keys(qtyMap).forEach(k => { delete qtyMap[k]; });
      ElementPlus.ElMessage.info('已取消编辑');
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认删除「${row.date} · ${row.project} · ${rowTypes(row).join('、')}」？`, '删除记录',
          { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
      } catch (e) { return; }
      try { await api.del('/api/actualWorks/' + row.id); ElementPlus.ElMessage.success('已删除'); await loadRecords(); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function itemsText(row) {
      const arr = row.items || [];
      if (!arr.length) return '—';
      return arr.map(it => {
        const base = `${it.description}×${it.qty}${it.unit || ''}`;
        const km = matUnitToKm(it.qty, it.unit);
        return km === null ? base : `${base}（${fmtKm(km)}千米）`;
      }).join('；');
    }
    function resetFilters() { dateRange.value = null; fProject.value = ''; fWorkType.value = ''; fWorker.value = ''; fSubmitter.value = ''; page.value = 1; }
    function pkgLabelOf(it) { const b = matBucketOf(it && it.description); return MAT_PKG_LABEL[b] || ''; }
    // 导出为真正的 Excel(.xlsx)：一条记录 → 材料按条数占多行，其余列按记录纵向合并
    function exportExcel() {
      const rows = reportRows.value;
      if (!rows.length) return ElementPlus.ElMessage.warning('没有可导出的数据');
      if (typeof XLSX === 'undefined') return ElementPlus.ElMessage.error('Excel 组件未加载，请刷新页面重试');
      const head = ['日期', '工作类型', '项目名称（包）', '班组长/实施人员', '材料', '提交人', '提交时间'];
      const aoa = [head];
      const merges = [];
      rows.forEach(r => {
        const types = rowTypes(r).join('、');
        const workers = rowWorkers(r).join('、');
        const items = (r.items || []);
        const lines = items.length
          ? items.map(it => `${pkgLabelOf(it) ? pkgLabelOf(it) + '-' : ''}${it.description || ''}；${it.qty} ${it.unit || ''}`.trim())
          : ['—'];
        const start = aoa.length;
        lines.forEach(ln => aoa.push([r.date, types, r.project, workers, ln, r.submitter || '', r.submittedAt || '']));
        const end = aoa.length - 1;
        if (end > start) {
          [0, 1, 2, 3, 5, 6].forEach(c => merges.push({ s: { r: start, c }, e: { r: end, c } }));
        }
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!merges'] = merges;
      ws['!cols'] = [{ wch: 12 }, { wch: 14 }, { wch: 38 }, { wch: 16 }, { wch: 62 }, { wch: 10 }, { wch: 19 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '工程实际施工量');
      XLSX.writeFile(wb, '工程实际施工量报表_' + todayStr() + '.xlsx');
    }
    onMounted(() => { loadMeta(); loadRecords(); });
    return {
      tab, form, multi, projects, leaders, projectMaterials, filteredMaterials, materialSearch, qtyMap, matQty, kmOf, filledCount, fmtQty,
      records, loading, busy, dateRange, fProject, fWorkType, fWorker, fSubmitter, workerOptions, submitterOptions,
      page, pageSize, paged, reportRows, editingId, editRecord, cancelEdit,
      workTypes: ACTUAL_WORK_TYPES, submit, remove, itemsText, pkgLabelOf, resetFilters, exportExcel, todayStr, rowTypes, rowWorkers
    };
  },
  template: `
  <div class="ac-page">
    <div class="ac-tabs">
      <div class="ac-tab" :class="{ on: tab === 'fill' }" @click="tab = 'fill'">填写</div>
      <div class="ac-tab" :class="{ on: tab === 'report' }" @click="tab = 'report'">工程实际施工量报表</div>
    </div>

    <div v-show="tab === 'fill'" class="ac-pane">
      <h2 class="ac-h2">工程实际施工量</h2>
      <div v-if="editingId" class="ac-edit-banner">
        <span>正在编辑 <b>{{ form.date }}</b>{{ form.project ? ' · ' + form.project : '' }} 的记录</span>
        <el-button link type="primary" size="small" @click="cancelEdit">取消编辑</el-button>
      </div>
      <el-form :model="form" label-position="top" class="ac-form">
        <el-form-item label="日期" required style="max-width:460px">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%"
            popper-class="ac-date-pop" :clearable="false" />
        </el-form-item>
        <el-form-item label="项目名称（包）" required style="max-width:460px">
          <el-select v-model="form.project" filterable clearable placeholder="请选择项目" style="width:100%">
            <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item required class="ac-multi-item">
          <template #label>
            <span class="ac-lb">工作类型</span>
            <span class="ac-multi-sw">
              <el-switch v-model="multi.workTypes" size="small" />
              <span class="ac-multi-txt">{{ multi.workTypes ? '可多选' : '多选' }}</span>
            </span>
          </template>
          <el-radio-group v-if="!multi.workTypes" v-model="form.workTypes[0]">
            <el-radio v-for="t in workTypes" :key="t" :label="t" :value="t">{{ t }}</el-radio>
          </el-radio-group>
          <el-checkbox-group v-else v-model="form.workTypes">
            <el-checkbox v-for="t in workTypes" :key="t" :label="t" :value="t">{{ t }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item required class="ac-multi-item">
          <template #label>
            <span class="ac-lb">施工人员</span>
            <span class="ac-multi-sw">
              <el-switch v-model="multi.workers" size="small" />
              <span class="ac-multi-txt">{{ multi.workers ? '可多选' : '多选' }}</span>
            </span>
          </template>
          <div class="ac-worker-row">
            <span class="ac-worker-key">班组长：</span>
            <template v-if="leaders.length">
              <el-radio-group v-if="!multi.workers" v-model="form.workers[0]">
                <el-radio v-for="w in leaders" :key="w" :label="w" :value="w">{{ w }}</el-radio>
              </el-radio-group>
              <el-checkbox-group v-else v-model="form.workers">
                <el-checkbox v-for="w in leaders" :key="w" :label="w" :value="w">{{ w }}</el-checkbox>
              </el-checkbox-group>
            </template>
            <span v-else class="ac-worker-empty">该项目包未设置班组长，请先在「项目列表」中维护班组长。</span>
          </div>
        </el-form-item>

        <div class="ac-sec">
          <div class="ac-sec-head">
            <span class="ac-sec-title">材料及数量</span>
            <span v-if="projectMaterials.length" class="ac-sec-meta">已填 {{ filledCount }} / {{ projectMaterials.length }} 项</span>
            <el-input v-if="projectMaterials.length > 8" v-model="materialSearch" class="ac-sec-search"
              placeholder="搜索物料描述或编码" clearable />
          </div>
          <div v-if="!form.project" class="ac-hint">请先选择项目名称（包），选择后可填报该项目的材料及数量。</div>
          <div v-else-if="!form.workTypes.length" class="ac-hint">请选择工作类型：转运 / 立杆 匹配电杆；放线和设备安装 匹配导线、设备。</div>
          <div v-else-if="!projectMaterials.length" class="ac-hint">该项目包在当前工作类型下没有可填报的材料。</div>
          <div v-else class="ac-mlist">
            <div v-for="m in filteredMaterials" :key="m.id" class="ac-mrow">
              <div class="ac-mname">
                <span class="ac-mpkg">{{ m.pkgLabel }}</span>
                <span class="ac-msep">·</span>
                <span class="ac-mdesc">{{ m.description }}</span>
              </div>
              <el-input v-model="qtyMap[m.id]" class="ac-mqty" placeholder="数量" />
              <span class="ac-munit">{{ m.unit || '' }}</span>
              <span class="ac-merp">ERP应到 {{ fmtQty(m.qtyRequired) }}</span>
              <span v-if="kmOf(m) !== null" class="ac-mkm">≈ {{ kmOf(m) }} 千米</span>
            </div>
            <div v-if="!filteredMaterials.length" class="ac-mempty">没有匹配的材料</div>
          </div>
        </div>
        <el-form-item style="margin-top:22px">
          <el-button v-if="canWrite('actualWorks')" type="primary" :loading="busy" @click="submit">{{ editingId ? '保存' : '提交' }}</el-button>
          <el-button v-if="editingId" @click="cancelEdit">取消</el-button>
        </el-form-item>
      </el-form>
    </div>

    <div v-show="tab === 'report'" class="ac-pane">
      <h2 class="ac-h2">工程实际施工量报表</h2>
      <div class="ac-filters">
        <el-button class="ac-export" @click="exportExcel">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true" style="margin-right:6px">
            <path d="M8 2v8m0 0 2.6-2.6M8 10 5.4 7.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M2.5 11.5v1.2c0 .7.5 1.3 1.2 1.3h8.6c.7 0 1.2-.6 1.2-1.3v-1.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>导出 Excel
        </el-button>
        <el-date-picker v-model="dateRange" type="daterange" value-format="YYYY-MM-DD" range-separator="至"
          start-placeholder="开始日期" end-placeholder="结束日期" style="width:236px" popper-class="ac-date-pop" />
        <el-select v-model="fProject" placeholder="项目名称（包）" clearable filterable style="width:212px">
          <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
        </el-select>
        <el-select v-model="fWorkType" placeholder="工作类型" clearable style="width:150px">
          <el-option v-for="t in workTypes" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="fWorker" placeholder="班组长" clearable style="width:126px">
          <el-option v-for="w in workerOptions" :key="w" :label="w" :value="w" />
        </el-select>
        <el-select v-model="fSubmitter" placeholder="实施人员" clearable style="width:126px">
          <el-option v-for="s in submitterOptions" :key="s" :label="s" :value="s" />
        </el-select>
      </div>
      <el-table class="ac-rep" :data="paged" v-loading="loading" style="width:100%" empty-text="暂无数据">
        <el-table-column prop="date" label="日期" width="100" class-name="ac-mid" />
        <el-table-column label="工作类型" width="96" class-name="ac-mid">
          <template #default="{row}">{{ rowTypes(row).join('、') || '—' }}</template>
        </el-table-column>
        <el-table-column label="项目名称（包）" min-width="220" class-name="ac-mid">
          <template #default="{row}"><span class="ac-rep-proj">{{ row.project }}</span></template>
        </el-table-column>
        <el-table-column label="班组长/实施人员" width="116" class-name="ac-mid">
          <template #default="{row}"><span class="rule-names">{{ rowWorkers(row).join('、') || '—' }}</span></template>
        </el-table-column>
        <el-table-column label="材料" min-width="280">
          <template #default="{row}">
            <div v-if="row.items && row.items.length" class="ac-rep-lines">
              <div v-for="(it,i) in row.items" :key="i" class="ac-rep-line" :title="pkgLabelOf(it) + '-' + (it.description || '')">
                <span class="ac-rep-pkg">{{ pkgLabelOf(it) }}</span>
                <span class="ac-rep-desc">{{ it.description }}</span>
              </div>
            </div>
            <span v-else class="ac-rep-none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="92" align="right">
          <template #default="{row}">
            <div v-if="row.items && row.items.length" class="ac-rep-lines">
              <div v-for="(it,i) in row.items" :key="i" class="ac-rep-line ac-rep-q">
                <b>{{ it.qty }}</b><span class="ac-rep-unit">{{ it.unit || '' }}</span>
              </div>
            </div>
            <span v-else class="ac-rep-none">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="108" align="center" class-name="ac-mid">
          <template #default="{row}">
            <el-button v-if="canWrite('actualWorks')" link type="primary" size="small" @click="editRecord(row)">编辑</el-button>
            <el-button v-if="canWrite('actualWorks')" link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="ac-pager">
        <span class="ac-total">共 {{ reportRows.length }} 条</span>
        <el-pagination background layout="prev, pager, next" :total="reportRows.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
        <el-select :model-value="pageSize" size="small" style="width:104px" @change="n=>{pageSize=n;page=1}">
          <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
        </el-select>
      </div>
    </div>
  </div>`
};
