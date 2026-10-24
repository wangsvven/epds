/* ========== views/materials ========== */
/* 材料台账视图 MaterialsView 及其页签组件 Requisitions / Imports / Outbounds 与材料表专用图标 FunnelIcon。 */
/* ---------------- 材料台账 ---------------- */
const MaterialsView = {
  setup() {
    const { ref, reactive, computed, onMounted, watch, onUnmounted } = Vue;
    const tab = ref('detail');
    const list = ref([]);
    const projects = ref([]);
    const loading = ref(false);
    const selection = ref([]);
    const filters = reactive({ stage: '在建工程', workType: '', project: '', subProject: '', status: '', keyword: '' });
    const dialogVisible = ref(false);
    const editingId = ref(null);
    const origQty = ref(0);
    const SOURCE_TYPES = ['ERP采购申请', '甲供材料', '库存调拨', '乙供/自购', '运检项目'];
    const sourceColors = { 'ERP采购申请': '#3370ff', '甲供材料': '#7c4dbe', '库存调拨': '#0e9e9e', '乙供/自购': '#d48806', '运检项目': '#389e0d' };
    const statusColors = { '全部到库': '#389e0d', '部分到库': '#e6932c', '未到库': '#f56c6c', '已生成领料单': '#3370ff' };
    const emptyForm = () => ({ project: '', source: '甲供材料', inWeeklyPlan: true, sourceNote: '', description: '', qtyRequired: 0, qtyArrived: 0, unit: '', code: '', orderNo: '-', modifyReason: '' });
    const form = reactive(emptyForm());

    async function load() {
      loading.value = true;
      try {
        const [ms, ps, os] = await Promise.all([api.get('/api/materials'), api.get('/api/projects'), api.get('/api/materialOutbound/orders').catch(() => [])]);
        list.value = ms; projects.value = ps;
        outOrders.value = Array.isArray(os) ? os : [];
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    // 出库记录映射：materialId → 有效出库单数（已作废不计），用于材料明细「有出库记录」标识
    const outOrders = ref([]);
    const outMap = computed(() => {
      const mp = {};
      outOrders.value.forEach(o => {
        if (o.status === '已作废') return;
        (o.items || []).forEach(it => { mp[it.materialId] = (mp[it.materialId] || 0) + 1; });
      });
      return mp;
    });
    // 跳转到出库管理-出库单页签，并按该材料过滤
    function goOutbound(row) {
      // Outbounds 为懒挂载（v-else-if），事件可能先于监听器注册：先全局暂存，挂载时消费；事件作已挂载场景的兜底
      const detail = { id: row.id, description: row.description, code: row.code, project: row.project };
      window.__obFocusMaterial = detail;
      tab.value = 'outbound';
      nextTick(() => window.dispatchEvent(new CustomEvent('outbounds-focus-material', { detail })));
    }
    onMounted(load);
    // 切回材料明细即从后端重拉最新数据（确认入库/作废会改材料，旧快照导致更新不及时）
    watch(tab, (nv) => { if (nv === 'detail') load(); });
    // 领料单入库/作废后实时刷新材料明细（跨组件联动）
    function onMaterialsChanged() { if (tab.value === 'detail') load(); }
    window.addEventListener('materials-changed', onMaterialsChanged);
    onUnmounted(() => window.removeEventListener('materials-changed', onMaterialsChanged));
    // 项目详情「进入材料台账」：带入该项目筛选并切到材料明细
    function onFilterProject(e) {
      const name = e.detail && e.detail.project;
      if (!name) return;
      tab.value = 'detail';
      colFilters.project = [name];
      load();
    }
    window.addEventListener('materials-filter-project', onFilterProject);
    onUnmounted(() => window.removeEventListener('materials-filter-project', onFilterProject));

    // 单体工程名称 = 项目列表工程名称 ∪ 子项目名称（与项目列表联动、必须一致）
    const projectOptions = computed(() => {
      const names = [];
      projects.value.forEach(p => { if (p.name) names.push(p.name); (p.subProjects || []).forEach(s => s.name && names.push(s.name)); });
      return names;
    });
    const workTypeOptions = computed(() => [...new Set(projects.value.map(p => p.workType).filter(Boolean))]);
    const workTypeMap = computed(() => {
      const mp = {};
      projects.value.forEach(p => { mp[p.name] = p.workType || ''; (p.subProjects || []).forEach(s => { if (s.name) mp[s.name] = p.workType || ''; }); });
      return mp;
    });
    const subProjectNames = computed(() => {
      const p = projects.value.find(x => x.name === filters.project);
      return p ? (p.subProjects || []).map(s => s.name).filter(Boolean) : [];
    });
    // 阶段筛选下的可用工程（含其子项目）
    const allowedNames = computed(() => {
      const names = [];
      projects.value.forEach(p => {
        const ok = filters.stage === '全部工程' || (filters.stage === '已竣工工程' ? !!p.completed : !p.completed);
        if (!ok) return;
        if (p.name) names.push(p.name);
        (p.subProjects || []).forEach(s => s.name && names.push(s.name));
      });
      return names;
    });
    const filtered = computed(() => {
      const kw = filters.keyword.trim();
      return list.value.filter(m => {
        if (filters.stage && !allowedNames.value.includes(m.project)) return false;
        if (filters.workType && (workTypeMap.value[m.project] || '') !== filters.workType) return false;
        if (filters.project && m.project !== filters.project && !subProjectNames.value.includes(m.project)) return false;
        if (filters.subProject && m.project !== filters.subProject) return false;
        if (filters.status && m.status !== filters.status) return false;
        if (kw && !(m.project + m.description + m.orderNo + m.code).includes(kw)) return false;
        // 列筛选
        if (colFilters.project.length && !colFilters.project.includes(m.project)) return false;
        if (colFilters.description && !String(m.description || '').includes(colFilters.description)) return false;
        if (colFilters.unit.length && !colFilters.unit.includes(m.unit)) return false;
        if (colFilters.code && !String(m.code || '').includes(colFilters.code)) return false;
        if (colFilters.orderNo && !String(m.orderNo || '').includes(colFilters.orderNo)) return false;
        if (colFilters.source.length && !colFilters.source.includes(m.source)) return false;
        if (colFilters.status.length && !colFilters.status.includes(m.status)) return false;
        return true;
      });
    });

    function fmtQty(n) { const v = Math.round((Number(n) || 0) * 10000) / 10000; return String(v); }
    function fmt2(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }
    const statCount = computed(() => filtered.value.length);
    const sumRequired = computed(() => filtered.value.reduce((s, m) => s + (Number(m.qtyRequired) || 0), 0));
    const sumArrived = computed(() => filtered.value.reduce((s, m) => s + (Number(m.qtyArrived) || 0), 0));
    const sumNot = computed(() => filtered.value.reduce((s, m) => s + (Number(m.qtyNotArrived) || 0), 0));
    const fullCount = computed(() => filtered.value.filter(m => m.status === '全部到库').length);
    const partCount = computed(() => filtered.value.filter(m => m.status === '部分到库').length);
    const notCount = computed(() => filtered.value.filter(m => m.status === '未到库').length);

    function chipStyle(color) { return 'display:inline-block;padding:2px 10px;border-radius:3px;font-size:12px;line-height:20px;background:' + color + '1f;color:' + color + ';'; }
    // 入库核对：累计入库（= 已到）与应到比对；剩余可入库 = 应到 - 累计入库（不为负）
    function inOver(row) { return (Number(row.qtyArrived) || 0) > (Number(row.qtyRequired) || 0); }
    function inRemain(row) { return Math.max(0, Math.round(((Number(row.qtyRequired) || 0) - (Number(row.qtyArrived) || 0)) * 10000) / 10000); }

    // 列筛选（对齐原系统表头漏斗筛选）
    const colFilters = reactive({ project: [], description: '', unit: [], code: '', orderNo: '', source: [], status: [] });
    const tmpFilters = reactive({ description: '', code: '', orderNo: '' });
    const projectFilterOptions = computed(() => [...new Set(list.value.map(m => m.project).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh')));
    const unitOptions = computed(() => [...new Set(list.value.map(m => m.unit).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh')));
    const sourceFilterOptions = computed(() => [...new Set(list.value.map(m => m.source).filter(Boolean))]);
    const statusFilterOptions = [
      { label: '未到库', color: '' },
      { label: '已生成领料单', color: '#3370ff' },
      { label: '部分到库', color: '#e6932c' },
      { label: '全部到库', color: '#389e0d' },
      { label: '异常', color: '#f56c6c' },
      { label: '无效数据', color: '' }
    ];
    function fActive(k) { const v = colFilters[k]; return Array.isArray(v) ? v.length > 0 : String(v || '') !== ''; }
    function applyTmp(k) { colFilters[k] = String(tmpFilters[k] || '').trim(); }
    function resetTmp(k) { tmpFilters[k] = ''; colFilters[k] = ''; }
    function resetArr(k) { colFilters[k] = []; }

    function onSel(rows) { selection.value = rows; }
    // 锁定规则：全部到库 / 可继续领料为 0（未到量已全量生成领料单）/ 已加入暂存
    // 部分生成（已生成领料单 X 但可继续领料 > 0）仍可勾选，继续为剩余量生成领料单
    function canSelect(row) {
      return row.status !== '全部到库' && (Number(row.qtyCanGen) || 0) > 0 && !staging.value.includes(row.id);
    }
    function openAdd() {
      editingId.value = null;
      Object.assign(form, emptyForm());
      if (filters.project) form.project = filters.project;
      dialogVisible.value = true;
    }
    function openEdit(row) {
      editingId.value = row.id;
      origQty.value = Number(row.qtyRequired) || 0;
      Object.assign(form, emptyForm(), JSON.parse(JSON.stringify(row)), { modifyReason: '' });
      dialogVisible.value = true;
    }
    async function submit() {
      if (!form.project) return ElementPlus.ElMessage.error('请选择项目名称');
      if (!String(form.description || '').trim()) return ElementPlus.ElMessage.error('请输入物料描述');
      if (!SOURCE_TYPES.includes(form.source)) return ElementPlus.ElMessage.error('请选择来源类型');
      try {
        if (editingId.value) {
          await api.put('/api/materials/' + editingId.value, form);
          ElementPlus.ElMessage.success('已保存');
        } else {
          await api.post('/api/materials', form);
          ElementPlus.ElMessage.success('新增成功');
        }
        dialogVisible.value = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除物料「' + (row.description || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' });
      } catch { return; }
      try {
        await api.del('/api/materials/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
        window.dispatchEvent(new CustomEvent('materials-changed'));
      } catch (e) {
        // 依赖引用校验未通过：列出该物料被哪些业务数据引用
        const refs = e && e.data && e.data.refs;
        if (Array.isArray(refs) && refs.length) {
          const html = '<div style="line-height:1.8">该物料已被以下业务数据引用，请先到对应模块清理后再删除：</div>'
            + '<div style="margin-top:10px;line-height:2">'
            + refs.map(r => '· ' + r.label + '：<b>' + r.count + '</b> 条').join('<br>')
            + '</div>';
          ElementPlus.ElMessageBox.alert(html, '该物料已被其他数据引用，无法删除', {
            dangerouslyUseHTMLString: true, confirmButtonText: '知道了', type: 'warning'
          });
        } else {
          ElementPlus.ElMessage.error(e.message || '删除失败');
        }
      }
    }
    const staging = ref([]); // 暂存清单（存物料 id）
    const stagingQty = reactive({}); // 暂存清单每行领料数量（可任意填，默认=可继续领料，上限=可继续领料）
    const mainTable = ref(null);
    const stagingVisible = ref(false);
    const stagingPage = ref(1);
    const stagingPageSize = ref(20);
    const stagingRows = computed(() => {
      const rows = list.value.filter(m => staging.value.includes(m.id));
      // 保持加入顺序
      return staging.value.map(id => rows.find(r => r.id === id)).filter(Boolean);
    });
    const stagedProjects = computed(() => [...new Set(stagingRows.value.map(r => r.project))].length);
    function addStaging() {
      let added = 0;
      selection.value.forEach(row => {
        if (!staging.value.includes(row.id)) { staging.value.push(row.id); added++; }
      });
      if (added) ElementPlus.ElMessage.success('已加入暂存 ' + added + ' 条');
      else ElementPlus.ElMessage.info('所选物料均已在暂存清单中');
      selection.value = []; // 加入后清空勾选，按钮置灰归零
      if (mainTable.value) mainTable.value.clearSelection();
    }
    function showStaging() {
      if (!staging.value.length) { ElementPlus.ElMessage.info('暂存清单为空'); return; }
      // 每行领料数量默认 = 可继续领料，可在弹窗中任意修改（不能大于可继续领料）
      stagingRows.value.forEach(r => {
        if (!(Number(stagingQty[r.id]) > 0)) stagingQty[r.id] = Number(r.qtyCanGen) || 0;
      });
      stagingPage.value = 1; stagingVisible.value = true;
    }
    function removeStaging(id) {
      staging.value = staging.value.filter(x => x !== id);
      delete stagingQty[id];
      if (!staging.value.length) stagingVisible.value = false;
    }
    async function clearStaging() {
      try {
        await ElementPlus.ElMessageBox.confirm('确认清空暂存清单？', '提示', { type: 'warning' });
        staging.value = []; stagingVisible.value = false;
        Object.keys(stagingQty).forEach(k => delete stagingQty[k]);
      } catch (e) {}
    }
    async function genRequisition() {
      // 客户端校验：数量必须 > 0 且 ≤ 可继续领料
      for (const r of stagingRows.value) {
        const q = Number(stagingQty[r.id]);
        const canGen = Number(r.qtyCanGen) || 0;
        if (!(q > 0)) { ElementPlus.ElMessage.error('物料「' + (r.description || r.code) + '」领料数量无效，必须大于 0'); return; }
        if (q > canGen + 1e-9) { ElementPlus.ElMessage.error('物料「' + (r.description || r.code) + '」领料数量 ' + q + ' 不能大于可继续领料 ' + canGen); return; }
      }
      try {
        const items = stagingRows.value.map(r => ({ id: r.id, qty: Number(stagingQty[r.id]) }));
        const res = await api.post('/api/requisitions/create', { items });
        staging.value = []; stagingVisible.value = false;
        Object.keys(stagingQty).forEach(k => delete stagingQty[k]);
        ElementPlus.ElMessage.success('领料单 ' + res.data.reqNo + ' 已生成');
        load(); // 材料明细同步：已生成领料单 X / 可继续领料 Y、状态与勾选锁定即时刷新
        tab.value = 'requisition';
        window.dispatchEvent(new CustomEvent('requisitions-refresh'));
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    } 
    // ---------- 关联领料单弹窗（点击状态标签跳转） ----------
    const relDlg = reactive({ visible: false, material: null, recs: [], page: 1, pageSize: 30 });
    async function openRelated(row) {
      relDlg.material = row; relDlg.page = 1;
      relDlg.visible = true;
      await relLoad();
    }
    async function relLoad() {
      try {
        const res = await api.get('/api/materialRequisitions');
        const arr = Array.isArray(res) ? res : (res.data || []);
        const mid = relDlg.material && relDlg.material.id;
        relDlg.recs = arr.filter(r => (r.items || []).some(it => it.materialId === mid));
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    const relPaged = computed(() => relDlg.recs.slice((relDlg.page - 1) * relDlg.pageSize, relDlg.page * relDlg.pageSize));
    function relItem(rec) { return (rec.items || []).find(it => it.materialId === (relDlg.material && relDlg.material.id)) || {}; }
    // 该材料在本单据中的按次入库记录
    function relHist(rec) {
      const mid = relDlg.material && relDlg.material.id;
      const arr = [];
      (rec.history || []).forEach(h => {
        const r = (h.rows || []).find(x => x.materialId === mid);
        if (r) arr.push({ at: h.at, thisQty: r.thisQty, abnormal: r.abnormal, reason: r.reason });
      });
      return arr;
    }
    // 该材料累计已收数量（进度汇总用）
    function relArrived(rec) {
      return relHist(rec).reduce((s, h) => s + (Number(h.thisQty) || 0), 0);
    }
    // 该材料异常原因（取末次异常记录的 reason；作废时显示冲销原因）
    function relStockReason(rec) {
      if (rec.status === '已作废') return '作废冲销 · ' + (rec.voidReason || '未填写原因');
      const hs = relHist(rec).filter(h => h.abnormal && h.reason);
      return hs.length ? hs[hs.length - 1].reason : '';
    }
    function relStatusType(s) { return s === '待入库' || s === '部分到库' ? 'warning' : s === '已入库' ? 'success' : 'info'; }
    async function relDownload(rec) {
      try {
        const token = localStorage.getItem('erp_token');
        const res = await fetch('/api/materialRequisitions/' + rec.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('下载失败');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = rec.reqNo + '.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function relVoid(rec) {
      try {
        const { value } = await ElementPlus.ElMessageBox.prompt('作废后关联材料数量将冲销回退，确认作废领料单 ' + rec.reqNo + '？', '作废领料单', {
          confirmButtonText: '确认作废', cancelButtonText: '取 消', inputPlaceholder: '请输入作废原因（必填）',
          inputValidator: v => (v && v.trim()) ? true : '作废原因不能为空'
        });
        await api.put('/api/materialRequisitions/' + rec.id + '/void', { reason: value.trim() });
        ElementPlus.ElMessage.success('领料单 ' + rec.reqNo + ' 已作废');
        relLoad(); load(); // 弹窗与材料明细（状态/已生成/可继续领料）同步刷新
      } catch (e) { if (e !== 'cancel' && e !== 'close' && e && e.message) ElementPlus.ElMessage.error(e.message); }
    }
    function downloadTemplate() {
      const a = document.createElement('a');
      a.href = '/assets/materials_import_template.xlsx';
      a.download = '材料导入模板.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
    }
    function importMaterials() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.xlsx,.xls,.csv';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const fd = new FormData(); fd.append('file', file);
        try {
          const res = await fetch('/api/materials/import', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
            body: fd
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || '导入失败');
          ElementPlus.ElMessage.success('成功导入 ' + data.added + ' 条物料（批次 ' + data.batch + '）');
          load();
        } catch (e) { ElementPlus.ElMessage.error(e.message); }
      };
      input.click();
    }

    return { tab, list, loading, selection, filters, dialogVisible, editingId, form, SOURCE_TYPES, sourceColors, statusColors,
      projectOptions, workTypeOptions, subProjectNames, filtered, statCount, sumRequired, sumArrived, sumNot, fullCount, partCount, notCount,
      load, onSel, canSelect, openAdd, colFilters, tmpFilters, projectFilterOptions, unitOptions, sourceFilterOptions, statusFilterOptions, fActive, applyTmp, resetTmp, resetArr, openEdit, submit, remove, addStaging, showStaging, staging, stagingQty, mainTable, stagingVisible, stagingPage, stagingPageSize, stagingRows, stagedProjects, removeStaging, clearStaging, genRequisition, relDlg, relPaged, openRelated, relLoad, relItem, relHist, relArrived, relStockReason, relStatusType, relDownload, relVoid, downloadTemplate, importMaterials, chipStyle, inOver, inRemain, fmtQty, fmt2, outMap, goOutbound };
  },
  template: `
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="材料明细" name="detail" />
      <el-tab-pane label="领料单" name="requisition" />
      <el-tab-pane label="导入批次" name="import" />
      <el-tab-pane label="出库管理" name="outbound" />
    </el-tabs>

    <div v-if="tab==='detail'">
      <div class="toolbar">
        <span style="font-weight:600;font-size:15px">工程材料清单</span>
        <span class="spacer"></span>
        <el-button type="primary" @click="load">刷新台账</el-button>
        <el-button @click="downloadTemplate">下载导入模板</el-button>
        <el-button v-if="canWrite('materials')" @click="importMaterials">导入材料表</el-button>
        <el-button v-if="canWrite('materials')" @click="openAdd">新增材料</el-button>
        <el-button v-if="canWrite('materials')" :disabled="!selection.length" @click="addStaging">加入暂存（{{ selection.length }}）</el-button>
        <el-button v-if="canWrite('materials')" @click="showStaging">暂存清单（{{ staging.length }}）</el-button>
      </div>

      <div class="toolbar">
        <el-select v-model="filters.stage" style="width:130px">
          <el-option label="在建工程" value="在建工程" /><el-option label="全部工程" value="全部工程" /><el-option label="已竣工工程" value="已竣工工程" />
        </el-select>
        <el-select v-model="filters.workType" placeholder="全部工程类型" clearable style="width:150px">
          <el-option v-for="t in workTypeOptions" :key="t" :label="t" :value="t" />
        </el-select>
        <el-select v-model="filters.project" placeholder="全部项目" clearable filterable style="width:200px">
          <el-option v-for="n in projectOptions" :key="n" :label="n" :value="n" />
        </el-select>
        <el-select v-model="filters.subProject" placeholder="全部子项目" clearable filterable style="width:180px">
          <el-option v-for="n in subProjectNames" :key="n" :label="n" :value="n" />
        </el-select>
        <el-select v-model="filters.status" placeholder="全部状态" clearable style="width:120px">
          <el-option label="全部到库" value="全部到库" /><el-option label="部分到库" value="部分到库" /><el-option label="未到库" value="未到库" />
        </el-select>
        <el-input v-model="filters.keyword" placeholder="搜索项目、物料、订单号" style="width:220px" clearable @keyup.enter="load" />
        <el-button type="primary" @click="load">搜索</el-button>
      </div>

      <div class="mat-stats">
        <div class="mat-stat">
          <div class="mat-stat-lb">材料（全部筛选结果）</div>
          <div class="mat-stat-v">{{ statCount }}</div>
        </div>
        <div class="mat-stat">
          <div class="mat-stat-lb">全部需求总数量 / 已到 / 未到</div>
          <div class="mat-stat-v sm">{{ fmt2(sumRequired) }} / {{ fmt2(sumArrived) }} / {{ fmt2(sumNot) }}</div>
        </div>
        <div class="mat-stat">
          <div class="mat-stat-lb">全部 / 部分到库</div>
          <div class="mat-stat-v sm"><span class="st-ok">{{ fullCount }}</span><span class="st-warn">{{ partCount }}</span></div>
        </div>
        <div class="mat-stat">
          <div class="mat-stat-lb">未到 / 异常 / 无效</div>
          <div class="mat-stat-v sm"><span class="st-danger">{{ notCount }}</span><span class="st-muted">0</span><span class="st-muted">0</span></div>
        </div>
      </div>

      <el-table ref="mainTable" :data="filtered" v-loading="loading" class="mat-table" style="width:100%" @selection-change="onSel">
        <el-table-column type="selection" width="46" :selectable="canSelect" />
        <el-table-column prop="project" min-width="176">
          <template #header><div class="th-inner"><span>项目名称</span>
            <el-popover placement="bottom-end" trigger="click" :width="200">
              <template #reference><funnel-icon :on="fActive('project')" /></template>
              <el-select v-model="colFilters.project" multiple filterable collapse-tags placeholder="筛选项目" size="small" style="width:100%">
                <el-option v-for="n in projectFilterOptions" :key="n" :label="n" :value="n" />
              </el-select>
              <div style="text-align:right;margin-top:8px"><el-button size="small" @click="resetArr('project')">重置</el-button></div>
            </el-popover>
          </template>
          <template #default="{row}"><span class="mat-project" :title="row.project">{{ row.project }}</span></template>
        </el-table-column>
        <el-table-column prop="description" min-width="270">
          <template #header><div class="th-inner"><span>物料描述</span>
            <el-popover placement="bottom-end" trigger="click" :width="220">
              <template #reference><funnel-icon :on="fActive('description')" /></template>
              <el-input v-model="tmpFilters.description" size="small" placeholder="筛选物料描述" @keyup.enter="applyTmp('description')" clearable />
              <div style="text-align:right;margin-top:8px">
                <el-button size="small" type="primary" @click="applyTmp('description')">筛选</el-button>
                <el-button size="small" @click="resetTmp('description')">重置</el-button>
              </div>
            </el-popover>
          </template>
          <template #default="{row}">
            <div class="mat-desc" :title="row.description">{{ row.description }}</div>
            <div v-if="outMap[row.id]" class="mat-desc-extra">
              <span :style="chipStyle('#3370ff')">有出库记录</span>
              <el-link type="primary" :underline="false" style="font-size:12px" @click="goOutbound(row)">查看出库单</el-link>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="数量" width="224" align="left">
          <template #header><span>数量</span></template>
          <template #default="{row}">
            <div class="mat-qty-main mat-num">
              <span class="mat-qty-cell"><span class="mat-qty-lb">应到</span><b>{{ fmtQty(row.qtyRequired) }}</b></span>
              <span class="mat-qty-sep">/</span>
              <span class="mat-qty-cell"><span class="mat-qty-lb">已到</span><b :class="{ 'is-in': (Number(row.qtyArrived) || 0) > 0 }">{{ fmtQty(row.qtyArrived) }}</b></span>
              <span class="mat-qty-sep">/</span>
              <span class="mat-qty-cell"><span class="mat-qty-lb">未到</span><b>{{ fmtQty(row.qtyNotArrived) }}</b></span>
            </div>
            <div class="mat-qty-sub mat-num">已生成领料单 {{ fmtQty(row.qtyGenerated || 0) }} / 可继续领料 {{ fmtQty(row.qtyCanGen || 0) }}</div>
            <div v-if="(Number(row.qtyArrived) || 0) > 0" class="mat-qty-foot mat-num">累计入库 {{ fmtQty(row.qtyArrived) }} {{ row.unit || '' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="入库核对" width="132">
          <template #header><span>入库核对</span></template>
          <template #default="{row}">
            <span class="in-chip" :class="{ 'is-over': inOver(row) }">{{ inOver(row) ? '累计已超额' : '累计未超额' }}</span>
            <div class="mat-in-remain mat-num" :title="'应到 ' + fmtQty(row.qtyRequired) + ' / 累计入库 ' + fmtQty(row.qtyArrived) + (inOver(row) ? '（超出 ' + fmtQty((Number(row.qtyArrived) || 0) - (Number(row.qtyRequired) || 0)) + (row.unit ? ' ' + row.unit : '') + '）' : '')">
              剩余可入库 {{ fmtQty(inRemain(row)) }} {{ row.unit || '' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="unit" width="66" align="center">
          <template #header><div class="th-inner th-center"><span>单位</span>
            <el-popover placement="bottom-end" trigger="click" :width="140">
              <template #reference><funnel-icon :on="fActive('unit')" /></template>
              <el-checkbox-group v-model="colFilters.unit">
                <div v-for="u in unitOptions" :key="u" style="margin:2px 0"><el-checkbox :label="u">{{ u }}</el-checkbox></div>
              </el-checkbox-group>
              <div style="text-align:right;margin-top:6px"><el-button size="small" @click="resetArr('unit')">重置</el-button></div>
            </el-popover>
          </div></template>
          <template #default="{row}"><span class="mat-sub">{{ row.unit || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="code" width="116">
          <template #header><div class="th-inner"><span>物料编码</span>
            <el-popover placement="bottom-end" trigger="click" :width="210">
              <template #reference><funnel-icon :on="fActive('code')" /></template>
              <el-input v-model="tmpFilters.code" size="small" placeholder="筛选物料编码" @keyup.enter="applyTmp('code')" clearable />
              <div style="text-align:right;margin-top:8px">
                <el-button size="small" type="primary" @click="applyTmp('code')">筛选</el-button>
                <el-button size="small" @click="resetTmp('code')">重置</el-button>
              </div>
            </el-popover>
          </div></template>
          <template #default="{row}"><span class="mat-code">{{ row.code || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="orderNo" width="106" align="center">
          <template #header><div class="th-inner th-center"><span>采购订单号</span>
            <el-popover placement="bottom-end" trigger="click" :width="210">
              <template #reference><funnel-icon :on="fActive('orderNo')" /></template>
              <el-input v-model="tmpFilters.orderNo" size="small" placeholder="筛选采购订单号" @keyup.enter="applyTmp('orderNo')" clearable />
              <div style="text-align:right;margin-top:8px">
                <el-button size="small" type="primary" @click="applyTmp('orderNo')">筛选</el-button>
                <el-button size="small" @click="resetTmp('orderNo')">重置</el-button>
              </div>
            </el-popover>
          </div></template>
          <template #default="{row}"><span class="mat-code" :class="{ 'is-empty': !row.orderNo || row.orderNo === '-' }">{{ row.orderNo && row.orderNo !== '-' ? row.orderNo : '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="source" width="92" align="center">
          <template #header><div class="th-inner th-center"><span>来源</span>
            <el-popover placement="bottom-end" trigger="click" :width="160">
              <template #reference><funnel-icon :on="fActive('source')" /></template>
              <el-checkbox-group v-model="colFilters.source">
                <div v-for="s in sourceFilterOptions" :key="s" style="margin:2px 0"><el-checkbox :label="s">{{ s }}</el-checkbox></div>
              </el-checkbox-group>
              <div style="text-align:right;margin-top:6px"><el-button size="small" @click="resetArr('source')">重置</el-button></div>
            </el-popover>
          </div></template>
          <template #default="{row}"><span :style="chipStyle(sourceColors[row.source] || 'var(--text-3)')">{{ row.source }}</span></template>
        </el-table-column>
        <el-table-column prop="status" width="88" align="center">
          <template #header><div class="th-inner th-center"><span>状态</span>
            <el-popover placement="bottom-end" trigger="click" :width="170">
              <template #reference><funnel-icon :on="fActive('status')" /></template>
              <el-checkbox-group v-model="colFilters.status">
                <div v-for="s in statusFilterOptions" :key="s.label" style="margin:2px 0">
                  <el-checkbox :label="s.label"><span v-if="s.color" :style="chipStyle(s.color)">{{ s.label }}</span><template v-else>{{ s.label }}</template></el-checkbox>
                </div>
              </el-checkbox-group>
              <div style="text-align:right;margin-top:6px"><el-button size="small" @click="resetArr('status')">重置</el-button></div>
            </el-popover>
          </div></template>
          <template #default="{row}"><span :style="chipStyle(statusColors[row.status] || 'var(--text-3)') + 'cursor:pointer'" title="点击查看关联领料单" @click="openRelated(row)">{{ row.status }}</span></template>
        </el-table-column>
        <el-table-column v-if="canWrite('materials')" label="操作" width="98" align="center" fixed="right">
          <template #default="{row}">
            <div class="mat-acts">
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <el-dialog :title="'材料暂存清单（' + staging.length + '）'" v-model="stagingVisible" width="920px" top="10vh">
        <div style="margin-bottom:12px">
          <span :style="chipStyle('#3370ff')">材料 {{ stagingRows.length }} 条</span>
          <span :style="chipStyle('#8a5cf6') + 'margin-left:8px'">项目 {{ stagedProjects }} 个</span>
        </div>
        <el-table :data="stagingRows.slice((stagingPage-1)*stagingPageSize, stagingPage*stagingPageSize)" border style="width:100%">
          <el-table-column prop="project" label="项目名称" min-width="240" show-overflow-tooltip />
          <el-table-column prop="code" label="物料编码" width="130" />
          <el-table-column prop="description" label="物料描述" min-width="160" />
          <el-table-column prop="unit" label="单位" width="70" />
          <el-table-column label="领料数量" width="190">
            <template #default="{row}">
              <el-input-number v-model="stagingQty[row.id]" :min="0" :max="Number(row.qtyCanGen) || 0"
                controls-position="right" size="small" style="width:120px" placeholder="领料数量" />
              <div style="color:var(--text-3);font-size:12px;line-height:18px;margin-top:2px">可继续领料 {{ fmtQty(row.qtyCanGen) }} {{ row.unit }}（应到 {{ fmtQty(row.qtyRequired) }} / 已生成 {{ fmtQty(row.qtyGenerated) }}）</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{row}">
              <el-button link type="danger" size="small" @click="removeStaging(row.id)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="display:flex;justify-content:flex-end;margin-top:12px">
          <el-pagination v-model:current-page="stagingPage" v-model:page-size="stagingPageSize" :total="stagingRows.length"
            :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" background />
        </div>
        <template #footer>
          <el-button @click="stagingVisible=false">关 闭</el-button>
          <el-button type="danger" plain @click="clearStaging">清 空</el-button>
          <el-button type="primary" @click="genRequisition">生成领料单</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="relDlg.visible" width="1080px" top="8vh">
        <template #header>
          <div>
            <div style="font-size:16px;font-weight:600">关联领料单：{{ relDlg.material && relDlg.material.description }}</div>
            <div style="color:var(--text-3);font-size:12px;margin-top:4px">显示本材料关联的全部领料单，包含已入库和已作废记录；展开查看材料明细及入库记录。</div>
          </div>
        </template>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-weight:600">领料单</span>
          <el-button size="small" @click="relLoad">刷新领料单</el-button>
        </div>
        <el-table :data="relPaged" border style="width:100%">
          <el-table-column type="expand">
            <template #default="{row}">
              <div style="padding:10px 24px 16px;background:var(--surface-2)">
                <div class="rq-mat-head">
                  <span class="rq-mat-desc">{{ relItem(row).description }}</span>
                  <span class="rq-tag" :class="'is-' + relStatusType(row.status)">{{ row.status }}</span>
                  <span v-if="relStockReason(row)" class="rq-mat-reason">异常：{{ relStockReason(row) }}</span>
                </div>
                <div class="rq-mat-grid">
                  <div><label>项目</label><span class="rq-wrap">{{ relItem(row).project || '—' }}</span></div>
                  <div><label>应领数量</label><span class="rq-num">{{ fmtQty(relItem(row).qty) }} {{ relItem(row).unit || '' }}</span></div>
                  <div><label>物料编码</label><span class="rq-code">{{ relItem(row).code || '—' }}</span></div>
                  <div><label>采购订单号</label><span class="rq-code">{{ relItem(row).orderNo || '—' }}</span></div>
                </div>
                <div class="rq-mat-sum">
                  <span>进度：已收 <b>{{ fmtQty(relArrived(row)) }}</b> / 应领 <b>{{ fmtQty(relItem(row).qty) }}</b> / 剩余 <b :class="{ 'is-red': (relItem(row).qty - relArrived(row)) > 0 }">{{ fmtQty(relItem(row).qty - relArrived(row)) }}</b> {{ relItem(row).unit || '' }}</span>
                </div>
                <div class="rq-hist-head">入库记录<span class="rq-hist-n">共 {{ relHist(row).length }} 次</span></div>
                <el-table v-if="relHist(row).length" :data="relHist(row)" size="small" border>
                  <el-table-column prop="at" label="入库时间" width="170" />
                  <el-table-column label="本次入库数量" width="120" align="right"><template #default="{row:h}">{{ fmtQty(h.thisQty) }}</template></el-table-column>
                  <el-table-column label="入库情况" width="100" align="center"><template #default="{row:h}"><el-tag size="small" :type="h.abnormal ? 'danger' : 'success'">{{ h.abnormal ? '异常' : '正常' }}</el-tag></template></el-table-column>
                  <el-table-column prop="reason" label="异常原因" min-width="200"><template #default="{row:h}">{{ h.reason || '-' }}</template></el-table-column>
                </el-table>
                <div v-else style="color:var(--text-3);font-size:12px">暂无入库记录（确认入库/补入库后按次记录）</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="reqNo" label="领料单号" width="190" />
          <el-table-column label="涉及项目" min-width="200" show-overflow-tooltip>
            <template #default="{row}">{{ (row.projects || []).join('、') || '—' }}</template>
          </el-table-column>
          <el-table-column label="明细" width="110">
            <template #default="{row}">{{ (row.items || []).length }} 项 / {{ fmtQty(relItem(row).qty) }}</template>
          </el-table-column>
          <el-table-column prop="createdAt" label="创建时间" width="170" />
          <el-table-column label="状态" width="110">
            <template #default="{row}"><el-tag size="small" :type="relStatusType(row.status)">{{ row.status }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{row}">
              <el-button link type="primary" size="small" @click="relDownload(row)">下载</el-button>
              <el-button v-if="row.status !== '已作废'" link type="danger" size="small" @click="relVoid(row)">作 废</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="display:flex;justify-content:flex-end;margin-top:12px">
          <el-pagination v-model:current-page="relDlg.page" v-model:page-size="relDlg.pageSize" :total="relDlg.recs.length"
            :page-sizes="[30, 50, 100]" layout="total, sizes, prev, pager, next" background />
        </div>
      </el-dialog>
    </div>

    <div v-else-if="tab==='requisition'">
      <Requisitions />
    </div>
    <div v-else-if="tab==='import'">
      <Imports />
    </div>
    <div v-else-if="tab==='outbound'">
      <Outbounds />
    </div>

    <el-dialog :title="editingId ? '编辑材料' : '新增材料'" v-model="dialogVisible" width="960px" top="4vh">
      <el-form label-position="top">
        <el-form-item label="项目名称" required style="margin-bottom:14px">
          <el-select v-model="form.project" filterable placeholder="请输入关键字筛选项目（与项目列表联动）" style="width:100%">
            <el-option v-for="n in projectOptions" :key="n" :label="n" :value="n" />
          </el-select>
        </el-form-item>
        <el-row :gutter="24">
          <el-col :span="12" :xs="24">
            <el-form-item label="来源类型" required style="margin-bottom:14px">
              <el-select v-model="form.source" style="width:100%">
                <el-option v-for="s in SOURCE_TYPES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="周计划进度口径" style="margin-bottom:14px">
              <el-checkbox v-model="form.inWeeklyPlan">计入周计划进度（ERP应到）</el-checkbox>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="来源说明" style="margin-bottom:14px">
          <el-input v-model="form.sourceNote" placeholder="如：库存调拨单号、甲供材料依据、补录原因" />
        </el-form-item>
        <el-form-item label="物料描述" required style="margin-bottom:14px">
          <el-input v-model="form.description" />
        </el-form-item>
        <el-row :gutter="24">
          <el-col :span="12" :xs="24">
            <el-form-item label="应到数量" required style="margin-bottom:14px">
              <el-input-number v-model="form.qtyRequired" :min="0" :precision="4" :controls="false" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="单位" style="margin-bottom:14px">
              <el-input v-model="form.unit" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row v-if="editingId" :gutter="24">
          <el-col :span="12" :xs="24">
            <el-form-item label="已到数量" style="margin-bottom:14px">
              <el-input-number v-model="form.qtyArrived" :min="0" :precision="4" :controls="false" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="24">
          <el-col :span="12" :xs="24">
            <el-form-item label="物料编码" style="margin-bottom:14px">
              <el-input v-model="form.code" />
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="采购订单号" style="margin-bottom:14px">
              <el-input v-model="form.orderNo" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="修改应到数量原因" style="margin-bottom:6px">
          <el-input v-model="form.modifyReason" placeholder="如：ERP导出数量修正、录入纠偏" />
          <div style="color:var(--text-3);font-size:12px;margin-top:2px">{{ editingId ? '修改了应到数量时必填。' : '新增材料不需要填写。' }}</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>`
};

// 材料表格筛选列图标（仅材料相关表在用）
const FunnelIcon = { props: { on: Boolean },
  template: `<svg class="col-funnel" :class="{on}" viewBox="0 0 1024 1024" width="12" height="12"><path fill="currentColor" d="M384 523.392V928a32 32 0 0 0 46.336 28.608l192-96A32 32 0 0 0 640 832V523.392l280.768-343.104a32 32 0 0 0-24.768-52.288H128a32 32 0 0 0-24.768 52.288L384 523.392z"/></svg>` };

const Requisitions = {
  setup() {
    const list = ref([]);
    const loading = ref(false);
    const filters = reactive({ project: '', status: '', keyword: '' });
    const projectOptions = ref([]);
    // 确认入库 / 补入库弹窗（type: confirm=首次入库, supplement=部分到库后的补入库）
    const dlg = reactive({ visible: false, rec: null, mode: '无异常', rows: [], type: 'confirm' });
    // 作废弹窗
    const vdlg = reactive({ visible: false, rec: null, reason: '' });

    async function load() {
      loading.value = true;
      try {
        list.value = await api.get('/api/materialRequisitions');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    onMounted(async () => {
      load();
      try {
        const ps = await api.get('/api/projects');
        const names = [];
        ps.forEach(p => { if (p.name) names.push(p.name); (p.subProjects || []).forEach(s => s.name && names.push(s.name)); });
        projectOptions.value = names;
      } catch (e) {}
      window.addEventListener('requisitions-refresh', load);
    });
    const filtered = computed(() => list.value.filter(r => {
      if (filters.project && !r.projects.includes(filters.project)) return false;
      if (filters.status && r.status !== filters.status) return false;
      if (filters.keyword && !r.reqNo.toLowerCase().includes(filters.keyword.toLowerCase())) return false;
      return true;
    }).slice().sort((a, b) => cmpReqNo(a.reqNo, b.reqNo)));
    // 单号排序：先日期升序；同日新格式（4 位流水）在前按流水升序，旧格式（6 位时间）在后按时间升序
    function reqNoKey(no) {
      const m = String(no || '').match(/^LL-(\d{8})-(\d{4}|\d{6})$/);
      if (!m) return null;
      return { date: m[1], grp: m[2].length === 4 ? 0 : 1, seq: m[2] };
    }
    function cmpReqNo(a, b) {
      const ka = reqNoKey(a), kb = reqNoKey(b);
      if (!ka && !kb) return 0;
      if (!ka) return 1; // 无法识别的单号排最后
      if (!kb) return -1;
      if (ka.date !== kb.date) return ka.date < kb.date ? -1 : 1;
      if (ka.grp !== kb.grp) return ka.grp - kb.grp;
      if (ka.seq !== kb.seq) return ka.seq < kb.seq ? -1 : 1;
      return 0;
    }
    function resetFilters() { filters.project = ''; filters.status = ''; filters.keyword = ''; }
    function sumQty(r) { return r.items.reduce((s, i) => s + (Number(i.qty) || 0), 0); }
    function fmtQty(n) { const v = Math.round((Number(n) || 0) * 10000) / 10000; return String(v); }
    function statusType(s) { return s === '待入库' ? 'warning' : s === '部分到库' ? 'warning' : s === '已入库' ? 'success' : 'info'; }

    async function download(r) {
      try {
        const token = localStorage.getItem('erp_token');
        const res = await fetch('/api/materialRequisitions/' + r.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('下载失败');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = r.reqNo + '.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function openConfirm(r) {
      dlg.rec = r; dlg.mode = '无异常'; dlg.type = 'confirm';
      dlg.rows = r.items.map(it => ({ materialId: it.materialId, qty: Number(it.qty) || 0, thisQty: '', abnormal: false, reason: '' }));
      dlg.visible = true;
    }
    // 补入库：与入库弹窗功能一致，「领料数量」按剩余未入库数量展示，无异常时本次入库=剩余量
    function openSupplement(r) {
      dlg.rec = r; dlg.mode = '无异常'; dlg.type = 'supplement';
      dlg.rows = r.items.map(it => {
        const cr = (r.confirmRows || []).find(x => x.materialId === it.materialId);
        const done = cr ? (Number(cr.thisQty) || 0) : 0;
        return { materialId: it.materialId, qty: Math.round(((Number(it.qty) || 0) - done) * 10000) / 10000, thisQty: '', abnormal: false, reason: '' };
      });
      dlg.visible = true;
    }
    function rowFlag(materialId) { return dlg.rows.find(x => x.materialId === materialId) || {}; }
    // 补入库弹窗「已到数量」= 该物料累计已入库数量（confirmRows 累计值）
    function supDone(materialId) {
      const cr = ((dlg.rec && dlg.rec.confirmRows) || []).find(x => x.materialId === materialId);
      return cr ? (Math.round((Number(cr.thisQty) || 0) * 10000) / 10000) : 0;
    }
    function rowClass({ row }) {
      // 弹窗内异常行粉底
      return dlg.mode === '有异常' && rowFlag(row.materialId).abnormal ? 'rq-ab-row' : '';
    }
    function onModeChange(v) {
      // 切「有异常」：本次入库全部可编辑且预填领料数量，异常态由数量是否被修改实时驱动
      dlg.rows.forEach(r => {
        r.thisQty = v === '有异常' ? r.qty : '';
        r.abnormal = false;
        r.reason = '';
      });
    }
    function qtyInput(rec) {
      if (dlg.mode !== '有异常') return;
      const r = dlg.rows.find(x => x.materialId === rec.materialId);
      if (!r) return;
      const v = String(r.thisQty).trim();
      r.abnormal = v !== '' && Number(v) !== r.qty;
      if (!r.abnormal) r.reason = '';
    }
    async function doConfirm() {
      try {
        const rows = dlg.rows.map((r, i) => ({
          materialId: r.materialId,
          thisQty: r.abnormal ? r.thisQty : undefined,
          abnormal: r.abnormal,
          reason: r.reason
        }));
        await api.put('/api/materialRequisitions/' + dlg.rec.id + '/confirm', { rows });
        ElementPlus.ElMessage.success('领料单 ' + dlg.rec.reqNo + (dlg.type === 'supplement' ? ' 补入库成功' : ' 已确认入库'));
        dlg.visible = false; load();
        window.dispatchEvent(new CustomEvent('materials-changed')); // 材料明细实时刷新
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function voidReq(r) {
      vdlg.rec = r; vdlg.reason = ''; vdlg.visible = true;
    }
    function voidDeduct(r) {
      const s = (r.confirmRows || []).reduce((acc, x) => acc + (Number(x.thisQty) || 0), 0);
      return Math.round(s * 100) / 100;
    }
    async function confirmVoid() {
      if (!vdlg.reason.trim()) return ElementPlus.ElMessage.error('请填写作废原因');
      try {
        await api.put('/api/materialRequisitions/' + vdlg.rec.id + '/void', { reason: vdlg.reason.trim() });
        ElementPlus.ElMessage.success('领料单 ' + vdlg.rec.reqNo + ' 已作废');
        vdlg.visible = false; load();
        window.dispatchEvent(new CustomEvent('materials-changed')); // 材料明细实时刷新
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function deleteReq(r) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除领料单 ' + r.reqNo + '？删除后不可恢复。', '删除确认', { type: 'warning' });
        await api.del('/api/materialRequisitions/' + r.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }

    function stockInfo(rec, it) {
      if (rec.status === '待入库') return { text: '待入库', type: 'primary' };
      if (rec.status === '已作废') return { text: '已作废', type: 'info' };
      const cr = (rec.confirmRows || []).find(x => x.materialId === it.materialId);
      if (cr && cr.abnormal) return { text: '异常', type: 'danger' };
      if (cr) return { text: '已到 ' + (Math.round((Number(cr.thisQty) || 0) * 10000) / 10000), type: 'success' };
      return { text: '已入库', type: 'success' };
    }
    function stockReason(rec, it) {
      if (rec.status === '已作废') return '作废冲销 · ' + (rec.voidReason || '未填写原因');
      const cr = (rec.confirmRows || []).find(x => x.materialId === it.materialId);
      return (cr && cr.reason) || '-';
    }
    // 某物料在领料单内的全部入库/补入库操作记录（按时间顺序，N 次操作 N 条）
    function itemHistory(rec, materialId) {
      const out = [];
      ((rec && rec.history) || []).forEach(h => (h.rows || []).forEach(r => {
        if (r.materialId === materialId) out.push({ at: h.at, thisQty: r.thisQty, abnormal: r.abnormal, reason: r.reason });
      }));
      return out;
    }
    // 某物料累计已收数量（= 历次入库 thisQty 之和）；用于进度汇总
    function arrivedSum(rec, materialId) {
      return itemHistory(rec, materialId).reduce((s, h) => s + (Number(h.thisQty) || 0), 0);
    }
    return { list, loading, filters, projectOptions, dlg, vdlg, filtered, load, resetFilters, sumQty, fmtQty, statusType, download, openConfirm, openSupplement, rowFlag, supDone, rowClass, onModeChange, qtyInput, doConfirm, voidReq, voidDeduct, confirmVoid, deleteReq, stockInfo, stockReason, itemHistory, arrivedSum };
  },
  template: `
  <div>
    <div class="toolbar">
      <span style="font-weight:600;font-size:15px">领料单</span>
      <span class="spacer"></span>
      <el-button @click="load">刷新领料单</el-button>
    </div>
    <div class="toolbar">
      <el-select v-model="filters.project" placeholder="全部项目" clearable filterable style="width:220px">
        <el-option v-for="n in projectOptions" :key="n" :label="n" :value="n" />
      </el-select>
      <el-select v-model="filters.status" placeholder="全部状态" clearable style="width:130px">
        <el-option label="待入库" value="待入库" /><el-option label="部分到库" value="部分到库" /><el-option label="已入库" value="已入库" /><el-option label="已作废" value="已作废" />
      </el-select>
      <el-input v-model="filters.keyword" placeholder="搜索领料单号、文件名" style="width:220px" clearable @keyup.enter="load" />
      <el-button @click="resetFilters">重 置</el-button>
    </div>
    <el-table :data="filtered" v-loading="loading" border style="width:100%" class="rq-main" :row-class-name="rowClass">
      <el-table-column type="expand">
        <template #default="{row}">
          <div class="rq-exp">
            <div class="rq-exp-head">
              <span class="rq-exp-dot" :class="{ 'is-void': row.status==='已作废' }"></span>
              <span class="rq-exp-title">领料明细</span>
              <span class="rq-exp-count">{{ row.items.length }} 项 · 合计 {{ sumQty(row) }}</span>
              <span v-if="row.status==='已作废'" class="rq-exp-chip">已作废 · 数量已冲销</span>
            </div>
            <div v-for="(it, idx) in row.items" :key="it.materialId" class="rq-mat">
              <div class="rq-mat-head">
                <span class="rq-mat-idx">{{ idx + 1 }}</span>
                <span class="rq-mat-desc">{{ it.description }}</span>
                <span class="rq-tag" :class="'is-' + stockInfo(row, it).type">{{ stockInfo(row, it).text }}</span>
                <span v-if="stockReason(row, it) && stockReason(row, it) !== '-'" class="rq-mat-reason">异常：{{ stockReason(row, it) }}</span>
              </div>
              <div class="rq-mat-grid">
                <div><label>项目</label><span class="rq-wrap">{{ it.project || '—' }}</span></div>
                <div><label>应领数量</label><span class="rq-num">{{ fmtQty(it.qty) }} {{ it.unit || '' }}</span></div>
                <div><label>物料编码</label><span class="rq-code">{{ it.code || '—' }}</span></div>
                <div><label>采购订单号</label><span class="rq-code">{{ it.orderNo || '—' }}</span></div>
              </div>
              <div class="rq-mat-sum">
                <span>进度：已收 <b>{{ fmtQty(arrivedSum(row, it.materialId)) }}</b> / 应领 <b>{{ fmtQty(it.qty) }}</b> / 剩余 <b :class="{ 'is-red': (it.qty - arrivedSum(row, it.materialId)) > 0 }">{{ fmtQty(it.qty - arrivedSum(row, it.materialId)) }}</b> {{ it.unit || '' }}</span>
              </div>
              <div class="rq-hist-head">入库记录<span class="rq-hist-n">共 {{ itemHistory(row, it.materialId).length }} 次</span></div>
              <el-table v-if="itemHistory(row, it.materialId).length" :data="itemHistory(row, it.materialId)" size="small" border class="rq-hist-table">
                <el-table-column prop="at" label="入库时间" width="160" />
                <el-table-column label="本次入库数量" width="120" align="right"><template #default="{row:h}">{{ fmtQty(h.thisQty) }}</template></el-table-column>
                <el-table-column label="入库情况" width="100" align="center"><template #default="{row:h}"><el-tag size="small" :type="h.abnormal ? 'danger' : 'success'">{{ h.abnormal ? '异常' : '正常' }}</el-tag></template></el-table-column>
                <el-table-column prop="reason" label="异常原因" min-width="200"><template #default="{row:h}">{{ h.reason || '-' }}</template></el-table-column>
              </el-table>
              <div v-else class="rq-hist-empty">暂无入库记录（确认入库 / 补入库后按次记录）</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="reqNo" label="领料单号" width="190" />
      <el-table-column label="涉及项目" min-width="240" show-overflow-tooltip>
        <template #default="{row}">{{ row.projects.join('、') }}</template>
      </el-table-column>
      <el-table-column label="明细" width="130">
        <template #default="{row}">{{ row.items.length }} 项 / {{ sumQty(row) }}</template>
      </el-table-column>
      <el-table-column prop="createdAt" label="创建时间" width="160" />
      <el-table-column label="状态" width="100">
        <template #default="{row}"><el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{row}">
          <el-button link type="primary" size="small" @click="download(row)">下载</el-button>
          <el-button v-if="row.status==='待入库' && canWrite('materials')" link type="primary" size="small" @click="openConfirm(row)">确认入库</el-button>
          <el-button v-if="row.status==='部分到库' && canWrite('materials')" link type="primary" size="small" @click="openSupplement(row)">补入库</el-button>
          <el-button v-if="row.status!=='已作废' && canWrite('materials')" link type="danger" size="small" @click="voidReq(row)">作 废</el-button>
          <el-button v-if="row.status==='已作废' && canWrite('materials')" link type="danger" size="small" @click="deleteReq(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dlg.visible" width="1080px" top="8vh" :show-close="true">
      <template #header>
        <div>
          <div style="font-size:16px;font-weight:600">{{ dlg.type==='supplement' ? '补入库' : '确认入库' }}</div>
          <div style="margin-top:6px"><span style="font-weight:600">{{ dlg.rec && dlg.rec.reqNo }}</span>
            <span style="color:var(--text-3);margin-left:10px">请核对领料单明细后{{ dlg.type==='supplement' ? '补入库' : '确认入库' }}</span></div>
        </div>
      </template>
      <el-radio-group v-model="dlg.mode" style="margin-bottom:14px" @change="onModeChange">
        <el-radio label="无异常">无异常</el-radio>
        <el-radio label="有异常">有异常</el-radio>
      </el-radio-group>
      <el-table v-if="dlg.rec" :data="dlg.rec.items" border class="rq-confirm" :row-class-name="rowClass">
        <el-table-column prop="description" label="物料描述" min-width="180" />
        <el-table-column :label="dlg.type==='supplement' ? '未入库数量' : '领料数量'" width="110" align="right">
          <template #default="{row}">{{ (rowFlag(row.materialId).qty !== undefined) ? rowFlag(row.materialId).qty : row.qty }}</template>
        </el-table-column>
        <el-table-column label="已到数量" width="100" align="right">
          <template #default="{row}">
            <template v-if="dlg.type==='supplement'">{{ supDone(row.materialId) }}</template>
            <template v-else>{{ row.arrivedBefore }}</template>
          </template>
        </el-table-column>
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column label="本次入库" width="150" class-name="rq-this-qty">
          <template #default="{row}">
            <el-input v-if="dlg.mode==='有异常'" v-model="rowFlag(row.materialId).thisQty" size="small" placeholder="本次入库" @input="qtyInput(row)" />
            <span v-else style="color:#e0532b;font-weight:600">{{ (rowFlag(row.materialId).qty !== undefined) ? rowFlag(row.materialId).qty : row.qty }}</span>
          </template>
        </el-table-column>
        <el-table-column label="异常原因" min-width="190">
          <template #default="{row}">
            <template v-if="dlg.mode==='有异常' && rowFlag(row.materialId).abnormal">
              <div><el-tag size="small" type="danger">异常</el-tag></div>
              <el-input v-model="rowFlag(row.materialId).reason" size="small" placeholder="该物料异常原因" style="margin-top:6px" />
            </template>
            <el-tag v-else size="small" type="success">无异常</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="code" label="物料编码" width="130" />
        <el-table-column prop="orderNo" label="采购订单号" width="110" />
      </el-table>
      <template #footer>
        <el-button @click="dlg.visible=false">取 消</el-button>
        <el-button type="primary" @click="doConfirm">{{ dlg.type==='supplement' ? '确认补入库' : '确认入库' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="vdlg.visible" width="560px" top="14vh">
      <template #header><div style="font-size:16px;font-weight:600">作废领料单</div></template>
      <div v-if="vdlg.rec" style="font-size:14px;line-height:1.7">
        <span style="font-weight:600">{{ vdlg.rec.reqNo }}</span>
        作废后会扣减该领料单已入库数量，材料状态按扣减后的已到数量重新汇总。
      </div>
      <div style="background:var(--surface-3);border-radius:6px;padding:14px 18px;margin:14px 0">
        <div style="color:var(--text-3);font-size:13px">将冲销已入库数量</div>
        <div style="font-size:24px;font-weight:700;color:var(--text-1);margin-top:4px">{{ voidDeduct(vdlg.rec || {}) }}</div>
      </div>
      <el-input v-model="vdlg.reason" type="textarea" :rows="3" placeholder="请输入作废原因" />
      <template #footer>
        <el-button @click="vdlg.visible=false">取 消</el-button>
        <el-button type="danger" @click="confirmVoid">确认作废</el-button>
      </template>
    </el-dialog>
  </div>`
};

const Imports = {
  setup() {
    const list = ref([]);
    const loading = ref(false);
    const filters = reactive({ project: '', keyword: '' });
    const page = ref(1);
    const pageSize = ref(30);
    const projects = computed(() => [...new Set(list.value.map(b => b.project).filter(p => p && !p.includes('、')))]);
    const filtered = computed(() => list.value.filter(b =>
      (!filters.project || b.project === filters.project) &&
      (!filters.keyword.trim() || (b.fileName || '').includes(filters.keyword.trim()) || (b.remark || '').includes(filters.keyword.trim()))));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/api/materialImports');
        const arr = Array.isArray(r) ? r : (r.data || []);
        arr.sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
        list.value = arr;
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { loading.value = false; }
    }
    function doSearch() { page.value = 1; }
    // 删除导入批次（仅超级用户）：批次 + 该批次导入的材料一并删除
    async function removeBatch(row) {
      const n = Array.isArray(row.materialIds) && row.materialIds.length ? row.materialIds.length : (row.rows || 0);
      try {
        await ElementPlus.ElMessageBox.confirm(
          '删除批次「' + (row.fileName || '') + '」后，该批次导入的 ' + n + ' 条材料将一并从「材料明细」中删除，且不可恢复。是否继续？',
          '删除导入批次',
          { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
        );
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.info('已取消'); return; }
      try {
        const r = await api.del('/api/materialImports/' + row.id);
        const n = r && typeof r.deletedMaterials === 'number' ? r.deletedMaterials : null;
        if (n === null) {
          // 旧版服务端（未重启）：只删了批次、没有联动删材料 —— 明确告知，避免误以为已经清干净
          ElementPlus.ElMessage.warning('批次已删除，但服务端未联动删除材料：请重启服务后再试（重启会自动补全历史批次与材料的关联）');
        } else {
          ElementPlus.ElMessage.success('已删除批次「' + (row.fileName || '') + '」及 ' + n + ' 条材料');
        }
        await load();
        window.dispatchEvent(new CustomEvent('materials-changed'));
      } catch (e) {
        // 嵌套校验：批次内材料被领料单/出库单引用时，整批拒绝并列出引用
        const refs = e && e.data && e.data.refs;
        if (Array.isArray(refs) && refs.length) {
          const html = '<div style="line-height:1.8">该批次中有 <b>' + ((e.data && e.data.blockedMaterials) || '') + '</b> 条材料已被以下业务数据引用，无法整批删除：</div>'
            + '<div style="margin-top:10px;line-height:2">'
            + refs.map(r => '· ' + r.label + '：<b>' + r.count + '</b> 条').join('<br>')
            + '</div>'
            + '<div style="margin-top:10px;color:#909399;font-size:12px;line-height:1.7">请先在「领料单 / 出库管理」中清理相关单据，或在「材料明细」中逐条删除未被引用的物料。</div>';
          ElementPlus.ElMessageBox.alert(html, '该批次存在被引用的材料，无法删除', {
            dangerouslyUseHTMLString: true, confirmButtonText: '知道了', type: 'warning'
          });
        } else {
          ElementPlus.ElMessage.error(e.message || '删除失败');
        }
      }
    }
    onMounted(load);
    return { list, loading, filters, page, pageSize, projects, filtered, paged, load, doSearch, removeBatch };
  },
  template: `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:17px;font-weight:600">导入批次</div>
      <el-button @click="load">刷新批次</el-button>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px">
      <el-select v-model="filters.project" placeholder="全部项目" clearable style="width:220px" @change="doSearch">
        <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
      </el-select>
      <el-input v-model="filters.keyword" placeholder="搜索导入文件、备注" style="width:260px" clearable @keyup.enter="doSearch" />
      <el-button type="primary" @click="doSearch">搜索</el-button>
    </div>
    <el-table :data="paged" v-loading="loading" border style="width:100%">
      <el-table-column type="expand">
        <template #default="{row}">
          <div style="padding:12px 24px 16px;background:var(--surface-2)">
            <template v-if="(row.adjusted || 0) > 0 && (row.adjustments || []).length">
              <div style="font-weight:600;margin-bottom:8px">调整明细</div>
              <el-table :data="row.adjustments" size="small" border>
                <el-table-column prop="rowNo" label="行号" width="80" />
                <el-table-column prop="code" label="物料编码" width="140" />
                <el-table-column prop="description" label="物料描述" min-width="180" />
                <el-table-column prop="note" label="调整说明" min-width="220" />
              </el-table>
            </template>
            <template v-else>
              <span style="color:var(--text-2)">该次导入已读取完成，确认没有调整明细。</span>
            </template>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="importedAt" label="导入时间" width="170" />
      <el-table-column prop="fileName" label="文件名" min-width="170" show-overflow-tooltip />
      <el-table-column prop="project" label="项目归属" min-width="230" show-overflow-tooltip />
      <el-table-column label="行数（总/匹配/跳过）" width="170" align="center">
        <template #default="{row}">{{ row.rowsTotal ?? row.rows ?? 0 }} / {{ row.rowsMatched ?? row.rows ?? 0 }} / {{ row.rowsSkipped ?? 0 }}</template>
      </el-table-column>
      <el-table-column label="调整数" width="90" align="center">
        <template #default="{row}">{{ row.adjusted || 0 }}</template>
      </el-table-column>
      <el-table-column prop="importedBy" label="导入人" width="170" show-overflow-tooltip />
      <el-table-column label="备注" min-width="100">
        <template #default="{row}">{{ row.remark || '—' }}</template>
      </el-table-column>
      <el-table-column v-if="canAdmin()" label="操作" width="90" fixed="right">
        <template #default="{row}">
          <el-button link type="danger" size="small" @click="removeBatch(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:12px">
      <span style="color:var(--text-2);font-size:13px">共 {{ filtered.length }} 个批次</span>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="filtered.length"
        :page-sizes="[30, 50, 100]" layout="prev, pager, next, sizes" background />
    </div>
  </div>`
};

const Outbounds = {
  setup() {
    const tab = ref('stock');
    const f1 = ref('在建工程');
    const f2 = ref('自有工程');
    const f3 = ref('');
    const project = ref('');
    const keyword = ref('');
    const projects = ref([]);
    const workers = ref([]);
    const list = ref([]);
    const orders = ref([]);
    const loading = ref(false);
    const selection = ref([]);
    const outQty = reactive({});
    const mainTable = ref(null);
    const page = ref(1); const pageSize = ref(100);
    const opage = ref(1); const opageSize = ref(30);
    // 登记出库 / 出库单详情 / 归还 / 打印预览
    const dlg = reactive({ visible: false, receiver: '', rows: [] });
    const od = reactive({ visible: false, rec: null });
    const rdlg = reactive({ visible: false, rec: null, rows: [] });
    const vdlg = reactive({ visible: false, rec: null, reason: '' });
    const pdlg = reactive({ visible: false, rec: null });
    // 出库单页签筛选：材料筛选（点击「查看出库单」带入）+ 关键字（出库编号/工程/领取人）
    const matFilter = ref(null);
    const oKeyword = ref('');

    function chip(color) { return 'display:inline-block;padding:2px 10px;border-radius:3px;font-size:12px;line-height:20px;background:' + color + '1f;color:' + color + ';'; }
    function fmt(n) { const v = Number(n) || 0; return String(Math.round(v * 10000) / 10000); }
    function fmt4(n) { const v = Number(n) || 0; return v.toFixed(4); }

    async function loadMeta() {
      try {
        const r = await api.get('/api/projects');
        const arr = (Array.isArray(r) ? r : (r.data || [])).map(p => p.name || p.projectName).filter(Boolean);
        projects.value = [...new Set(arr)];
      } catch (e) {}
      try {
        const r = await api.get('/api/workers');
        workers.value = (Array.isArray(r) ? r : (r.data || [])).map(w => w.name).filter(Boolean);
      } catch (e) {}
    }
    async function load() {
      if (!project.value) { list.value = []; orders.value = []; return; }
      loading.value = true;
      try {
        const r = await api.get('/api/materialOutbound/stock?project=' + encodeURIComponent(project.value));
        list.value = Array.isArray(r) ? r : (r.data || []);
        const r2 = await api.get('/api/materialOutbound/orders?project=' + encodeURIComponent(project.value));
        orders.value = Array.isArray(r2) ? r2 : (r2.data || []);
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { loading.value = false; }
    }
    function onProjectChange() { selection.value = []; Object.keys(outQty).forEach(k => delete outQty[k]); page.value = 1; opage.value = 1; load(); }
    const filtered = computed(() => list.value.filter(r => !keyword.value.trim()
      || String(r.description || '').includes(keyword.value.trim()) || String(r.code || '').includes(keyword.value.trim())));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    function onSel(rows) {
      selection.value = rows;
      rows.forEach(r => { if (!(Number(outQty[r.id]) > 0)) outQty[r.id] = Number(r.available) || 0; });
    }
    function isSelected(row) { return selection.value.some(s => s.id === row.id); }
    function sumQty(o) { return (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0); }
    function remaining(it) { return Math.max(0, (Number(it.qty) || 0) - (Number(it.returned) || 0)); }

    function openDlg() {
      if (!selection.value.length) { ElementPlus.ElMessage.info('请先勾选需要出库的材料'); return; }
      dlg.rows = selection.value.map(r => ({ id: r.id, description: r.description, unit: r.unit, available: r.available, qty: Number(outQty[r.id]) || 0 }));
      dlg.receiver = ''; dlg.visible = true;
    }
    async function submitOut() {
      if (!dlg.receiver) { ElementPlus.ElMessage.warning('请选择领取人'); return; }
      for (const r of dlg.rows) {
        if (!(Number(r.qty) > 0)) { ElementPlus.ElMessage.error('「' + r.description + '」出库数量必须大于 0'); return; }
        if (Number(r.qty) > Number(r.available) + 1e-9) { ElementPlus.ElMessage.error('「' + r.description + '」本次出库 ' + r.qty + ' 超过可用库存 ' + r.available); return; }
      }
      try {
        const res = await api.post('/api/materialOutbound/create', {
          project: project.value, receiver: dlg.receiver,
          items: dlg.rows.map(r => ({ materialId: r.id, qty: Number(r.qty) }))
        });
        ElementPlus.ElMessage.success('出库单 ' + res.data.outNo + ' 已登记');
        dlg.visible = false;
        selection.value = [];
        if (mainTable.value && mainTable.value.clearSelection) mainTable.value.clearSelection();
        Object.keys(outQty).forEach(k => delete outQty[k]);
        await load();
        od.rec = res.data; od.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function openOrder(o) { od.rec = o; od.visible = true; }
    // 点击「查看出库单」：切换到出库单页签并按该材料筛选
    function showMatOrders(row) {
      matFilter.value = { id: row.id, description: row.description, code: row.code };
      oKeyword.value = '';
      tab.value = 'orders';
      opage.value = 1;
    }
    function clearMatFilter() { matFilter.value = null; opage.value = 1; }
    // 材料明细「查看出库单」跨组件跳转：选中对应工程 → 加载 → 按材料筛选出库单
    function focusMaterial(e) {
      const d = e.detail || {};
      if (!d.id) return;
      if (d.project) project.value = d.project;
      matFilter.value = { id: d.id, description: d.description, code: d.code };
      oKeyword.value = '';
      tab.value = 'orders';
      opage.value = 1;
      if (project.value) load();
    }
    window.addEventListener('outbounds-focus-material', focusMaterial);
    onUnmounted(() => window.removeEventListener('outbounds-focus-material', focusMaterial));
    const ofiltered = computed(() => {
      let arr = orders.value;
      if (matFilter.value) arr = arr.filter(o => (o.items || []).some(it => it.materialId === matFilter.value.id));
      const k = oKeyword.value.trim();
      if (k) arr = arr.filter(o => String(o.outNo || '').includes(k) || String(o.project || '').includes(k) || String(o.receiver || '').includes(k));
      return arr;
    });
    const opaged = computed(() => ofiltered.value.slice((opage.value - 1) * opageSize.value, opage.value * opageSize.value));
    // 出库单行汇总：累计领取/累计归还/补回数量/净出库（作废单已补回，净出库为 0）
    function oTake(o) { return (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0); }
    function oReturned(o) { return (o.items || []).reduce((s, i) => s + (Number(i.returned) || 0), 0); }
    function oCompensated(o) { return o.status === '已作废' ? Math.max(0, oTake(o) - oReturned(o)) : 0; }
    function oNet(o) { return o.status === '已作废' ? 0 : Math.max(0, oTake(o) - oReturned(o)); }
    function oRows(o) { return matFilter.value ? (o.items || []).filter(i => i.materialId === matFilter.value.id).length : (o.items || []).length; }
    function oQtyOf(o, key) {
      const its = matFilter.value ? (o.items || []).filter(i => i.materialId === matFilter.value.id) : (o.items || []);
      return its.reduce((s, i) => s + (Number(i[key]) || 0), 0);
    }
    function oTakeM(o) { return oQtyOf(o, 'qty'); }
    function oReturnedM(o) { return oQtyOf(o, 'returned'); }
    function oCompensatedM(o) { return o.status === '已作废' ? Math.max(0, oTakeM(o) - oReturnedM(o)) : 0; }
    function oNetM(o) { return o.status === '已作废' ? 0 : Math.max(0, oTakeM(o) - oReturnedM(o)); }
    function openReturn(o) {
      const rec = (o && o.items) ? o : od.rec; // 行内传入出库单；详情页按钮传 MouseEvent 时回退 od.rec
      if (!rec) return;
      rdlg.rec = rec;
      rdlg.rows = (rec.items || []).map(it => ({ materialId: it.materialId, description: it.description, remaining: remaining(it), qty: 0 }));
      rdlg.visible = true;
    }
    async function submitReturn() {
      if (!rdlg.rec) return;
      const rows = rdlg.rows.filter(r => Number(r.qty) > 0).map(r => ({ materialId: r.materialId, qty: Number(r.qty) }));
      if (!rows.length) { ElementPlus.ElMessage.warning('请填写归还数量'); return; }
      for (const r of rdlg.rows) {
        if (Number(r.qty) > r.remaining + 1e-9) { ElementPlus.ElMessage.error('「' + r.description + '」本次归还不能超过剩余未归还 ' + r.remaining); return; }
      }
      try {
        await api.put('/api/materialOutbound/' + rdlg.rec.id + '/return', { rows });
        rdlg.visible = false;
        ElementPlus.ElMessage.success('归还已登记，领取人固定为 ' + rdlg.rec.receiver);
        await load();
        if (od.visible && od.rec && od.rec.id === rdlg.rec.id) od.rec = orders.value.find(o => o.id === rdlg.rec.id) || od.rec;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    // 作废（二级弹窗，同领料单）：作废后未归还数量补回可用库存；已作废单可删除
    function openVoid(o) {
      const rec = (o && o.items) ? o : od.rec;
      if (!rec) return;
      if (rec.status !== '有效') { ElementPlus.ElMessage.info('该出库单已作废'); return; }
      vdlg.rec = rec; vdlg.reason = ''; vdlg.visible = true;
    }
    async function confirmVoid() {
      if (!vdlg.rec) return;
      if (!vdlg.reason.trim()) { ElementPlus.ElMessage.warning('作废原因不能为空'); return; }
      try {
        const res = await api.put('/api/materialOutbound/' + vdlg.rec.id + '/void', { reason: vdlg.reason.trim() });
        vdlg.visible = false;
        ElementPlus.ElMessage.success('出库单 ' + res.data.outNo + ' 已作废，未归还数量已补回可用库存');
        await load();
        if (od.visible && od.rec && od.rec.id === vdlg.rec.id) od.rec = orders.value.find(o => o.id === vdlg.rec.id) || od.rec;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    // 删除：仅已作废的出库单可删除（同领料单口径）
    async function deleteOrder(o) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除出库单 ' + o.outNo + '？删除后不可恢复。', '删除确认', { type: 'warning' });
        await api.del('/api/materialOutbound/' + o.id);
        if (od.visible && od.rec && od.rec.id === o.id) od.visible = false;
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel' && e !== 'close' && e && e.message) ElementPlus.ElMessage.error(e.message); }
    }
    // 顶部「删除出库记录」：一键清理当前工程全部已作废出库单
    async function deleteVoided() {
      const voided = orders.value.filter(o => o.status === '已作废');
      if (!voided.length) { ElementPlus.ElMessage.info('没有可删除的出库记录（仅已作废的出库单可删除，请先作废）'); return; }
      try {
        await ElementPlus.ElMessageBox.confirm('当前工程共有 ' + voided.length + ' 张已作废出库单，确认全部删除？删除后不可恢复。', '删除出库记录', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取 消' });
        for (const o of voided) await api.del('/api/materialOutbound/' + o.id);
        ElementPlus.ElMessage.success('已删除 ' + voided.length + ' 张已作废出库单');
        load();
      } catch (e) { if (e !== 'cancel' && e !== 'close' && e && e.message) ElementPlus.ElMessage.error(e.message); }
    }
    function printOrder() { pdlg.rec = od.rec; pdlg.visible = true; }
    function printRow(o) { pdlg.rec = o; pdlg.visible = true; }
    // 本页打印：把预览区 DOM 写入隐藏 iframe 后调起系统打印（不新开页面）
    // 注意：预览区用的是站内 CSS 变量（--line-strong / --surface-3 …），iframe 里没有这套变量，
    // 会导致 `border:1px solid var(--line-strong)` 整条声明失效 → 打印出来没有表格线。
    // 因此这里显式给出打印色值（黑线 / 浅灰表头），并用 !important 兜底覆盖内联样式。
    function doPrint() {
      const el = document.getElementById('ob-print-area');
      if (!el) return;
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow.document;
      const css = ''
        + ':root{--line-strong:#000;--surface-3:#eef1f5;--surface-2:#fff;--text-1:#000;--text-2:#000;--text-3:#222}'
        + '*{box-sizing:border-box}'
        + 'html,body{margin:0;padding:0;background:#fff;color:#000;'
        + '-webkit-print-color-adjust:exact;print-color-adjust:exact;'
        + 'font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px}'
        + '.obp-title{text-align:center;font-size:20px;font-weight:700;margin:0 0 14px;letter-spacing:2px}'
        + 'table{width:100%;border-collapse:collapse;margin:0 0 12px}'
        + 'td,th{border:1px solid #000 !important;padding:7px 9px;font-size:13px;text-align:left;'
        + 'color:#000;word-break:break-word;line-height:1.5}'
        + 'th{background:#eef1f5 !important;font-weight:600;text-align:center}'
        + 'td[style*="surface-3"]{background:#eef1f5 !important;font-weight:600}'
        + '.obp-sign{display:flex;justify-content:space-between;gap:48px;margin-top:34px;font-size:14px}'
        + '.obp-sign>div{flex:1;display:flex;align-items:flex-end;gap:6px;white-space:nowrap}'
        + '.obp-sign .obp-line{flex:1;border-bottom:1px solid #000;height:24px}'
        + 'tr,td,th,.obp-sign{page-break-inside:avoid;break-inside:avoid}'
        + 'thead{display:table-header-group}'
        + '@page{size:A4 portrait;margin:14mm}';
      const signBlock = ''
        + '<div class="obp-sign">'
        + '<div>出库人签字：<span class="obp-line"></span></div>'
        + '<div>领料人签字：<span class="obp-line"></span></div>'
        + '</div>';
      doc.open();
      doc.write('<!DOCTYPE html><html><head><meta charset="utf8"><title>材料出库单</title><style>' + css +
        '</style></head><body>' + el.innerHTML + signBlock + '</body></html>');
      doc.close();
      const fire = () => {
        try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { /* 用户取消/浏览器拦截 */ }
      };
      // 等一帧布局完成再调起打印，避免首帧拿到未完成的表格
      setTimeout(fire, 120);
      iframe.contentWindow.addEventListener('afterprint', () => iframe.remove());
      setTimeout(() => iframe.remove(), 60000);
    }
    onMounted(() => { loadMeta(); if (window.__obFocusMaterial) { const d = window.__obFocusMaterial; delete window.__obFocusMaterial; focusMaterial({ detail: d }); } });
    return { tab, f1, f2, f3, project, keyword, projects, workers, list, orders, loading, selection, outQty, mainTable, page, pageSize, opage, opageSize, paged, opaged, filtered, ofiltered, matFilter, oKeyword, load, onProjectChange, onSel, isSelected, openDlg, dlg, submitOut, od, openOrder, rdlg, openReturn, submitReturn, vdlg, openVoid, confirmVoid, deleteOrder, deleteVoided, printOrder, printRow, doPrint, pdlg, showMatOrders, clearMatFilter, chip, fmt, fmt4, sumQty, remaining, oTake, oReturned, oCompensated, oNet, oRows, oTakeM, oReturnedM, oCompensatedM, oNetM };
  },
  template: `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:17px;font-weight:600">请选择项目</div>
      <div>
        <el-button v-if="canWrite('materials')" type="primary" :disabled="!selection.length" @click="openDlg">登记出库（{{ selection.length }}）</el-button>
        <el-button @click="load">{{ tab === 'orders' ? '刷新出库记录' : '刷新库存' }}</el-button>
      </div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:14px">
      <el-select v-model="f1" style="width:130px"><el-option label="在建工程" value="在建工程" /><el-option label="全部工程" value="" /></el-select>
      <el-select v-model="f2" style="width:130px"><el-option label="自有工程" value="自有工程" /><el-option label="全部工程" value="" /></el-select>
      <el-select v-model="f3" placeholder="全部导入状态" clearable style="width:150px">
        <el-option label="全部导入状态" value="" /><el-option label="已导入" value="已导入" /><el-option label="未导入" value="未导入" />
      </el-select>
      <el-select v-model="project" placeholder="选择工程" filterable clearable style="width:260px" @change="onProjectChange">
        <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
      </el-select>
      <el-button v-if="tab==='orders' && canWrite('materials')" type="danger" plain style="margin-left:auto" @click="deleteVoided">删除出库记录</el-button>
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="可出库材料" name="stock">
        <div style="display:flex;gap:10px;margin:2px 0 12px;width:320px">
          <el-input v-model="keyword" placeholder="搜索材料名称、编码" clearable @keyup.enter="load" />
          <el-button type="primary" @click="load">搜索</el-button>
        </div>
        <el-empty v-if="!project" description="请先选择工程，再查看可出库材料。" />
        <template v-else>
          <el-table ref="mainTable" :data="paged" v-loading="loading" border style="width:100%" @selection-change="onSel">
            <el-table-column type="selection" width="42" />
            <el-table-column label="材料名称" min-width="240">
              <template #default="{row}">
                <div style="font-weight:600">{{ row.description }}</div>
                <div v-if="row.hasRecords" style="margin-top:4px;display:flex;align-items:center;gap:10px">
                  <span :style="chip('var(--text-3)')">有出库记录</span>
                  <el-link type="primary" :underline="false" style="font-size:12px" @click="showMatOrders(row)">查看出库单</el-link>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="code" label="材料编码" width="130" />
            <el-table-column prop="unit" label="单位" width="70" />
            <el-table-column label="累计入库" width="100" align="right"><template #default="{row}">{{ fmt(row.inQty) }}</template></el-table-column>
            <el-table-column label="累计领取" width="100" align="right"><template #default="{row}">{{ fmt(row.taken) }}</template></el-table-column>
            <el-table-column label="累计归还" width="100" align="right"><template #default="{row}">{{ fmt(row.returned) }}</template></el-table-column>
            <el-table-column label="净出库" width="100" align="right"><template #default="{row}">{{ fmt(row.net) }}</template></el-table-column>
            <el-table-column label="可用库存" width="110" align="right">
              <template #default="{row}"><span style="font-weight:700">{{ fmt(row.available) }}</span></template>
            </el-table-column>
            <el-table-column label="本次出库数量" width="160">
              <template #default="{row}">
                <el-input-number v-model="outQty[row.id]" :disabled="!isSelected(row)" :min="0" :max="Number(row.available)"
                  :precision="4" :controls="false" size="small" style="width:130px" placeholder="出库数量" />
              </template>
            </el-table-column>
          </el-table>
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:12px">
            <span style="color:var(--text-2);font-size:13px">共 {{ filtered.length }} 行</span>
            <el-pagination v-model:current-page="page" v-model:page-size="pageSize" :total="filtered.length"
              :page-sizes="[100, 200]" layout="prev, pager, next, sizes" background />
          </div>
        </template>
      </el-tab-pane>

      <el-tab-pane label="出库单" name="orders">
        <div style="display:flex;gap:10px;align-items:center;margin:2px 0 12px">
          <el-tag v-if="matFilter" closable type="info" @close="clearMatFilter">{{ matFilter.description }}</el-tag>
          <el-input v-model="oKeyword" placeholder="搜索出库编号、工程、领取人" style="width:280px" clearable @keyup.enter="load" />
          <el-button type="primary" @click="load">搜索</el-button>
        </div>
        <el-empty v-if="!project" description="请先选择工程。" />
        <template v-else>
          <el-table :data="opaged" v-loading="loading" border style="width:100%">
            <el-table-column prop="outNo" label="出库单号" width="200" />
            <el-table-column prop="project" label="工程" min-width="240" show-overflow-tooltip />
            <el-table-column prop="receiver" label="领取人" width="100" />
            <el-table-column label="材料行" width="80" align="center"><template #default="{row}">{{ oRows(row) }}</template></el-table-column>
            <el-table-column label="累计领取" width="100" align="right"><template #default="{row}">{{ fmt(oTakeM(row)) }}</template></el-table-column>
            <el-table-column label="累计归还" width="100" align="right"><template #default="{row}">{{ fmt(oReturnedM(row)) }}</template></el-table-column>
            <el-table-column label="补回数量" width="100" align="right"><template #default="{row}">{{ fmt(oCompensatedM(row)) }}</template></el-table-column>
            <el-table-column label="净出库" width="100" align="right"><template #default="{row}">{{ fmt(oNetM(row)) }}</template></el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{row}"><el-tag size="small" :type="row.status === '有效' ? 'success' : 'info'">{{ row.status }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="createdAt" label="登记时间" width="160" />
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="{row}">
                <el-button link type="primary" size="small" @click="openOrder(row)">查看</el-button>
                <el-button v-if="row.status === '有效' && canWrite('materials')" link type="primary" size="small" @click="openReturn(row)">登记归还</el-button>
                <el-button v-if="row.status === '有效' && canWrite('materials')" link type="danger" size="small" @click="openVoid(row)">作废</el-button>
                <el-button v-if="row.status === '已作废' && canWrite('materials')" link type="danger" size="small" @click="deleteOrder(row)">删除</el-button>
                <el-button link type="primary" size="small" @click="printRow(row)">打印</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:12px">
            <span style="color:var(--text-2);font-size:13px">共 {{ ofiltered.length }} 个出库单</span>
            <el-pagination v-model:current-page="opage" v-model:page-size="opageSize" :total="ofiltered.length"
              :page-sizes="[30, 50, 100]" layout="prev, pager, next, sizes" background />
          </div>
        </template>
      </el-tab-pane>
    </el-tabs>

    <el-dialog title="登记出库" v-model="dlg.visible" width="680px" top="8vh">
      <el-form label-position="top">
        <el-form-item label="工程">
          <el-select v-model="project" disabled style="width:100%" placeholder="请选择工程" />
        </el-form-item>
        <el-form-item label="领取人" required style="margin-top:-8px">
          <el-select v-model="dlg.receiver" placeholder="选择领取人" filterable style="width:100%">
            <el-option v-for="w in workers" :key="w" :label="w" :value="w" />
          </el-select>
        </el-form-item>
      </el-form>
      <div style="color:var(--text-2);font-size:13px;margin:-6px 0 10px">已选择 {{ dlg.rows.length }} 种材料，提交时会再次核对当前可用库存。</div>
      <el-table :data="dlg.rows" size="small" border style="width:100%">
        <el-table-column prop="description" label="材料" min-width="180" />
        <el-table-column label="可用库存" width="110" align="right"><template #default="{row}">{{ fmt4(row.available) }}</template></el-table-column>
        <el-table-column label="本次出库" width="150">
          <template #default="{row}">
            <el-input-number v-model="row.qty" :min="0" :max="Number(row.available)" :precision="4" :controls="false" size="small" style="width:130px" />
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="dlg.visible=false">取 消</el-button>
        <el-button type="primary" :disabled="!dlg.receiver" @click="submitOut">确认出库</el-button>
      </template>
    </el-dialog>

    <el-dialog v-if="od.rec" :title="od.rec.outNo" v-model="od.visible" width="900px" top="6vh">
      <div style="display:grid;grid-template-columns:1fr 1fr;row-gap:8px;column-gap:16px;font-size:13px;margin-bottom:14px">
        <div>出库单号：{{ od.rec.outNo }}</div>
        <div>工程：{{ od.rec.project }}</div>
        <div>领取人：{{ od.rec.receiver }}</div>
        <div>单据状态：<el-tag size="small" :type="od.rec.status === '有效' ? 'success' : 'info'">{{ od.rec.status }}</el-tag></div>
        <div>补回未归还数量：{{ od.rec.compensated || 0 }}</div>
        <div>登记时间：{{ od.rec.createdAt }}</div>
      </div>
      <el-table :data="od.rec.items" size="small" border style="width:100%">
        <el-table-column prop="description" label="材料" min-width="180" />
        <el-table-column prop="code" label="编码" width="130" />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column label="已出库" width="100" align="right"><template #default="{row}">{{ fmt4(row.qty) }}</template></el-table-column>
        <el-table-column label="已归还" width="100" align="right"><template #default="{row}">{{ fmt4(row.returned) }}</template></el-table-column>
        <el-table-column label="剩余未归还" width="120" align="right"><template #default="{row}">{{ fmt4(remaining(row)) }}</template></el-table-column>
        <el-table-column label="净出库" width="100" align="right"><template #default="{row}">{{ fmt4(row.qty - row.returned) }}</template></el-table-column>
      </el-table>
      <template #footer>
        <el-button v-if="od.rec.status === '有效' && canWrite('materials')" @click="openReturn()">登记归还</el-button>
        <el-button v-if="od.rec.status === '有效' && canWrite('materials')" type="danger" plain @click="openVoid()">作废并补回</el-button>
        <el-button @click="printOrder">打 印</el-button>
        <el-button type="primary" @click="od.visible=false">关 闭</el-button>
      </template>
    </el-dialog>

    <el-dialog title="登记归还" v-model="rdlg.visible" width="640px">
      <div v-if="rdlg.rec" style="display:grid;grid-template-columns:1fr 1fr;row-gap:8px;column-gap:16px;font-size:13px;margin-bottom:14px">
        <div>出库编号：{{ rdlg.rec.outNo }}</div>
        <div>工程：{{ rdlg.rec.project }}</div>
        <div>原领取人：{{ rdlg.rec.receiver }}</div>
        <div>登记时间：{{ rdlg.rec.createdAt }}</div>
      </div>
      <el-table :data="rdlg.rows" size="small" border style="width:100%">
        <el-table-column prop="description" label="材料" min-width="180" />
        <el-table-column label="剩余未归还" width="120" align="right"><template #default="{row}">{{ fmt4(row.remaining) }}</template></el-table-column>
        <el-table-column label="本次归还" width="160">
          <template #default="{row}">
            <el-input-number v-model="row.qty" :min="0" :max="Number(row.remaining)" :precision="4" :controls="false" size="small" style="width:130px" />
          </template>
        </el-table-column>
      </el-table>
      <div v-if="rdlg.rec" style="color:var(--text-3);font-size:13px;margin-top:12px">领取人固定为原记录中的 {{ rdlg.rec.receiver }}。</div>
      <template #footer>
        <el-button @click="rdlg.visible=false">取 消</el-button>
        <el-button type="primary" @click="submitReturn">确认归还</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="vdlg.visible" width="560px" top="14vh">
      <template #header><div style="font-size:16px;font-weight:600">作废出库单</div></template>
      <div v-if="vdlg.rec" style="font-size:14px;line-height:1.7">
        <span style="font-weight:600">{{ vdlg.rec.outNo }}</span>
        作废后该单未归还数量将补回可用库存，作废后的出库单可删除。
      </div>
      <div style="background:var(--surface-3);border-radius:6px;padding:14px 18px;margin:14px 0">
        <div style="color:var(--text-3);font-size:13px">将补回可用库存</div>
        <div style="font-size:24px;font-weight:700;color:var(--text-1);margin-top:4px">{{ oNet(vdlg.rec || {}) }}</div>
      </div>
      <el-input v-model="vdlg.reason" type="textarea" :rows="3" placeholder="请输入作废原因" />
      <template #footer>
        <el-button @click="vdlg.visible=false">取 消</el-button>
        <el-button type="danger" @click="confirmVoid">确认作废</el-button>
      </template>
    </el-dialog>

    <el-dialog v-if="pdlg.rec" title="材料出库单" v-model="pdlg.visible" width="780px" top="6vh" :close-on-click-modal="false">
      <div id="ob-print-area">
        <div style="text-align:center;font-size:20px;font-weight:700;margin-bottom:16px">材料出库单</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
          <tr>
            <td style="width:90px;background:var(--surface-3);font-weight:600;border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">出库批次</td>
            <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ pdlg.rec.outNo }}</td>
            <td style="width:90px;background:var(--surface-3);font-weight:600;border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">登记时间</td>
            <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ pdlg.rec.createdAt }}</td>
          </tr>
          <tr>
            <td style="background:var(--surface-3);font-weight:600;border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">工程</td>
            <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ pdlg.rec.project }}</td>
            <td style="background:var(--surface-3);font-weight:600;border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">领取人</td>
            <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ pdlg.rec.receiver }}</td>
          </tr>
        </table>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="width:60px;background:var(--surface-3);border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">序号</th>
              <th style="background:var(--surface-3);border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">材料名称</th>
              <th style="background:var(--surface-3);border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">材料编码</th>
              <th style="width:70px;background:var(--surface-3);border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">单位</th>
              <th style="width:100px;background:var(--surface-3);border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in pdlg.rec.items" :key="i">
              <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">{{ i + 1 }}</td>
              <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ it.description }}</td>
              <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ it.code }}</td>
              <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:center">{{ it.unit }}</td>
              <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px;text-align:right">{{ fmt(it.qty) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <el-button @click="pdlg.visible=false">关 闭</el-button>
        <el-button type="primary" @click="doPrint">打 印</el-button>
      </template>
    </el-dialog>
  </div>`
};
