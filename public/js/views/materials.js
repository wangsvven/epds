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
    // 「全部…」用非空哨兵值：空字符串会被 el-select 当成未选、退化成灰色 placeholder
    const ALL = '__all';
    const filters = reactive({ stage: '在建工程', category: ALL, importState: ALL, project: ALL, status: ALL, keyword: '' });
    const dialogVisible = ref(false);
    const editingId = ref(null);
    const origQty = ref(0);
    // 与 server/routes/materials.js 的同名枚举必须保持一致；scripts/smoke.js 有逐项相等断言防漂移。
    const SOURCE_TYPES = ['ERP采购申请', '甲供材料', '库存调拨', '乙供/自购', '运检项目'];
    const sourceColors = { 'ERP采购申请': '#3370ff', '甲供材料': '#7c4dbe', '库存调拨': '#0e9e9e', '乙供/自购': '#d48806', '运检项目': '#389e0d' };
    const statusColors = { '全部到库': '#389e0d', '部分到库': '#e6932c', '未到库': '#f56c6c', '已生成领料单': '#3370ff' };
    // P3-1：新增材料默认不计入周计划进度（用户仍可手工勾选；存量数据不动）
    const emptyForm = () => ({ project: '', source: '甲供材料', inWeeklyPlan: false, sourceNote: '', description: '', qtyRequired: null, qtyArrived: 0, unit: '', code: '', orderNo: '-', modifyReason: '' });
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
    // F5：出库记录映射按 entries 净额（netItems）判断，与可出库列表的 hasRecords 同口径；
    // 不再看未改写的 items。已作废/已删除、净额为 0（全部冲销或更正后转走）的单都不计。
    const outOrders = ref([]);
    const outMap = computed(() => {
      const mp = {};
      outOrders.value.forEach(o => {
        if (o.deleted || o.status !== '有效') return;
        const rows = (o.netItems && o.netItems.length) ? o.netItems : (o.items || []);
        rows.forEach(it => {
          if (it && it.materialId && Number(it.qty) > 0) mp[it.materialId] = (mp[it.materialId] || 0) + 1;
        });
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

    // 单体工程名称 = 项目列表工程名称 ∪ 子项目名称（新增/编辑材料下拉用，保持全量）
    const projectOptions = computed(() => {
      const names = [];
      projects.value.forEach(p => { if (p.name) names.push(p.name); (p.subProjects || []).forEach(s => s.name && names.push(s.name)); });
      return names;
    });
    // 项目导入情况：该项目名下是否存在「带 importId 的材料行」（手工录入的不算导入）
    const projectImport = computed(() => {
      const mp = {};
      list.value.forEach(m => {
        const n = m.project; if (!n) return;
        const o = mp[n] || (mp[n] = { total: 0, imported: 0 });
        o.total++;
        if (m.importId) o.imported++;
      });
      return mp;
    });
    function importStateOf(name) {
      const o = projectImport.value[name];
      return o && o.imported > 0 ? 'imported' : 'none';
    }
    // 框1~3 联动：工程状态（completed）/ 工程类型（category）/ 导入情况
    function projectPass(p) {
      if (filters.stage === '已竣工工程' ? !p.completed : p.completed) return false;
      if (filters.category && filters.category !== ALL && (p.category || '') !== filters.category) return false;
      if (filters.importState && filters.importState !== ALL && importStateOf(p.name) !== filters.importState) return false;
      return true;
    }
    // 框4 候选：随框1~框3 联动过滤后的真实项目名单
    const projectCandidates = computed(() => {
      const names = [];
      projects.value.forEach(p => {
        if (!projectPass(p)) return;
        if (p.name) names.push(p.name);
        (p.subProjects || []).forEach(s => { if (s.name) names.push(s.name); });
      });
      return names;
    });
    // 当前可用于显示的材料所属工程（框1~3 的并集）
    const allowedNames = computed(() => projectCandidates.value);
    // 选中项目下的子项目名（用于按父项目筛选时连带子项目材料）
    const selectedSubProjectNames = computed(() => {
      const p = projects.value.find(x => x.name === filters.project);
      return p ? (p.subProjects || []).map(s => s.name).filter(Boolean) : [];
    });
    // 框1~3 变化后，若已选项目不在候选中则清空选择
    watch(projectCandidates, (opts) => {
      if (filters.project && filters.project !== ALL && !opts.includes(filters.project)) filters.project = ALL;
    });
    const filtered = computed(() => {
      const kw = filters.keyword.trim();
      return list.value.filter(m => {
        if (!allowedNames.value.includes(m.project)) return false;
        if (filters.project && filters.project !== ALL && m.project !== filters.project && !selectedSubProjectNames.value.includes(m.project)) return false;
        if (filters.status && filters.status !== ALL && m.status !== filters.status) return false;
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
    // 材料明细分页：20/50/100/200，默认 50
    const detailPage = ref(1);
    const detailPageSize = ref(50);
    const detailPaged = computed(() => filtered.value.slice((detailPage.value - 1) * detailPageSize.value, detailPage.value * detailPageSize.value));
    watch(() => [filters.stage, filters.category, filters.importState, filters.project, filters.status, filters.keyword], () => { detailPage.value = 1; });
    watch(detailPageSize, () => { detailPage.value = 1; });
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
      if (filters.project && filters.project !== ALL) form.project = filters.project;
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
    // 暂存清单「领料总数」：汇总全部暂存行的领料数量（含分页未显示的行），输入框改动即时联动
    const stagingTotalQty = computed(() => stagingRows.value.reduce((s, r) => s + (Number(stagingQty[r.id]) || 0), 0));
    // Tab 在数量输入框之间直接切换：跳过「移除」按钮 / 分页 / 底部按钮；末行回到首行，Shift+Tab 反向
    function onStagingTab(e) {
      if (e.key !== 'Tab') return;
      const boxes = Array.from(e.currentTarget.querySelectorAll('.stg-qty-input'));
      if (!boxes.length) return;
      const i = boxes.findIndex(b => b === e.target || b.contains(e.target));
      if (i < 0) return; // 焦点不在数量输入区，保持浏览器默认行为
      e.preventDefault();
      const next = e.shiftKey ? (i - 1 + boxes.length) % boxes.length : (i + 1) % boxes.length;
      const input = boxes[next].querySelector('input');
      if (input) { input.focus(); input.select(); }
    }
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
    // P4-6：生成领料单前先确认开单日（默认今天，可补录），并预示即将生成的单号
    const gdlg = reactive({ visible: false, date: '', reason: '', items: [], no: '' });
    const gToday = () => ((window.ServerTime && ServerTime.ymd) ? ServerTime.ymd() : new Date().toISOString().slice(0, 10));
    const gLimit30 = () => { const t = new Date(gToday() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 30); return t.toISOString().slice(0, 10); };
    function genRequisition() {
      // 客户端校验：数量必须 > 0 且 ≤ 可继续领料
      for (const r of stagingRows.value) {
        const q = Number(stagingQty[r.id]);
        const canGen = Number(r.qtyCanGen) || 0;
        if (!(q > 0)) { ElementPlus.ElMessage.error('物料「' + (r.description || r.code) + '」领料数量无效，必须大于 0'); return; }
        if (q > canGen + 1e-9) { ElementPlus.ElMessage.error('物料「' + (r.description || r.code) + '」领料数量 ' + q + ' 不能大于可继续领料 ' + canGen); return; }
      }
      gdlg.items = stagingRows.value.map(r => ({ id: r.id, qty: Number(stagingQty[r.id]) }));
      gdlg.date = gToday(); gdlg.reason = ''; gdlg.no = '';
      gdlg.visible = true;
      refreshGenNo();
    }
    async function refreshGenNo() {
      try {
        const res = await api.get('/api/materialRequisitions');
        const rows = Array.isArray(res) ? res : (res.data || []);
        const pre = 'LL-' + String(gdlg.date || '').replace(/-/g, '') + '-';
        let max = 0;
        rows.forEach(r => {
          const no = String((r && r.reqNo) || '');
          if (no.indexOf(pre) !== 0) return;
          const sfx = no.slice(pre.length);
          if (/^\d+$/.test(sfx)) max = Math.max(max, parseInt(sfx, 10));
        });
        gdlg.no = pre + String(max + 1).padStart(4, '0');
      } catch (e) { gdlg.no = ''; }
    }
    async function doGenRequisition() {
      try {
        const items = gdlg.items;
        const res = await api.post('/api/requisitions/create', { items, reqDate: gdlg.date || '', reqDateReason: gdlg.reason || '' });
        staging.value = []; stagingVisible.value = false; gdlg.visible = false;
        Object.keys(stagingQty).forEach(k => delete stagingQty[k]);
        ElementPlus.ElMessage.success('领料单 ' + res.data.reqNo + ' 已生成（开单日 ' + (res.data.reqDate || '') + '）');
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
    // P2 导入：选文件后先弹窗，可「试校验」再「确认导入」；正式导入行为与文案不变
    const idlg = reactive({ visible: false, file: null, fileName: '', errors: [], checked: false, note: '', checking: false, importing: false });
    function importMaterials() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.xlsx,.xls,.csv';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        idlg.file = file; idlg.fileName = file.name;
        idlg.errors = []; idlg.checked = false; idlg.note = ''; idlg.visible = true;
      };
      input.click();
    }
    async function previewImport() {
      if (!idlg.file) return;
      idlg.checking = true;
      try {
        const fd = new FormData(); fd.append('file', idlg.file, idlg.fileName);
        const res = await fetch('/api/materials/import/preview', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
          body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '试校验失败');
        idlg.checked = true;
        idlg.errors = Array.isArray(data.errors) ? data.errors : [];
        idlg.note = data.note || '';
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { idlg.checking = false; }
    }
    async function doImport() {
      if (!idlg.file) return;
      idlg.importing = true;
      try {
        const fd = new FormData(); fd.append('file', idlg.file, idlg.fileName);
        const res = await fetch('/api/materials/import', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
          body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success(data.added ? ('成功导入 ' + data.added + ' 条物料（批次 ' + data.batch + '），跳过重复 ' + (data.skipped || 0) + ' 条') : ('全部 ' + (data.skipped || 0) + ' 条均为重复，未生成导入批次'));
        idlg.visible = false;
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { idlg.importing = false; }
    }

    return { tab, list, loading, selection, filters, dialogVisible, editingId, form, SOURCE_TYPES, sourceColors, statusColors,
      projectOptions, projectCandidates, filtered, statCount, detailPage, detailPageSize, detailPaged, sumRequired, sumArrived, sumNot, fullCount, partCount, notCount,
      load, onSel, canSelect, openAdd, colFilters, tmpFilters, projectFilterOptions, unitOptions, sourceFilterOptions, statusFilterOptions, fActive, applyTmp, resetTmp, resetArr, openEdit, submit, remove, addStaging, showStaging, staging, stagingQty, stagingTotalQty, onStagingTab, mainTable, stagingVisible, stagingPage, stagingPageSize, stagingRows, stagedProjects, removeStaging, clearStaging, genRequisition, gdlg, doGenRequisition, refreshGenNo, gLimit30, gToday, relDlg, relPaged, openRelated, relLoad, relItem, relHist, relArrived, relStockReason, relStatusType, relDownload, relVoid, downloadTemplate, importMaterials, idlg, previewImport, doImport, chipStyle, inOver, inRemain, fmtQty, fmt2, outMap, goOutbound };
  },
  template: `
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="材料明细" name="detail" />
      <el-tab-pane label="领料单" name="requisition" />
      <el-tab-pane label="导入批次" name="import" />
      <el-tab-pane label="出库管理" name="outbound" />
      <el-tab-pane label="到货统计" name="arrival" />
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
          <el-option label="在建工程" value="在建工程" /><el-option label="已竣工工程" value="已竣工工程" />
        </el-select>
        <el-select v-model="filters.category" style="width:150px">
          <el-option label="全部工程类型" value="__all" /><el-option label="自有工程" value="自有工程" /><el-option label="客户工程" value="客户工程" />
        </el-select>
        <el-select v-model="filters.importState" style="width:150px">
          <el-option label="全部项目" value="__all" /><el-option label="已导入材料" value="imported" /><el-option label="未导入材料" value="none" />
        </el-select>
        <el-select v-model="filters.project" filterable style="width:200px">
          <el-option label="全部项目" value="__all" /><el-option v-for="n in projectCandidates" :key="n" :label="n" :value="n" />
        </el-select>
        <el-select v-model="filters.status" style="width:150px">
          <el-option label="全部状态" value="__all" />
          <el-option label="未到库" value="未到库" />
          <el-option label="已生成领料单" value="已生成领料单" />
          <el-option label="部分到库" value="部分到库" />
          <el-option label="全部到库" value="全部到库" />
          <el-option label="异常" value="异常" />
          <el-option label="无效数据" value="无效数据" />
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

      <el-table ref="mainTable" :data="detailPaged" row-key="id" v-loading="loading" class="mat-table" style="width:100%" @selection-change="onSel">
        <el-table-column type="selection" width="46" reserve-selection :selectable="canSelect" />
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
        <el-table-column v-if="canWrite('materials')" label="操作" width="98" align="center">
          <template #default="{row}">
            <div class="mat-acts">
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

      <div class="mat-pager">
        <span class="mat-pager-total">共 {{ filtered.length }} 行</span>
        <el-pagination v-model:current-page="detailPage" v-model:page-size="detailPageSize" :total="filtered.length"
          :page-sizes="[20, 50, 100, 200]" layout="prev, pager, next, sizes" background />
      </div>

      <el-dialog :title="'材料暂存清单（' + staging.length + '）'" v-model="stagingVisible" width="920px" top="10vh">
        <div class="stg-chips">
          <span :style="chipStyle('#3370ff')">材料 {{ stagingRows.length }} 条</span>
          <span :style="chipStyle('#8a5cf6')">项目 {{ stagedProjects }} 个</span>
          <span :style="chipStyle('#0e9e9e')">领料总数 <b>{{ fmtQty(stagingTotalQty) }}</b></span>
        </div>
        <div @keydown="onStagingTab">
        <el-table :data="stagingRows.slice((stagingPage-1)*stagingPageSize, stagingPage*stagingPageSize)" border style="width:100%" class="stg-table">
          <el-table-column prop="project" label="项目名称" min-width="240" show-overflow-tooltip />
          <el-table-column prop="code" label="物料编码" width="130" />
          <el-table-column prop="description" label="物料描述" min-width="160" />
          <el-table-column prop="unit" label="单位" width="70" />
          <el-table-column label="领料数量" width="190">
            <template #default="{row}">
              <el-input-number v-model="stagingQty[row.id]" :min="0" :max="Number(row.qtyCanGen) || 0" :precision="4" :step="0.1"
                controls-position="right" size="small" class="stg-qty-input" style="width:120px" placeholder="领料数量" />
              <div style="color:var(--text-3);font-size:12px;line-height:18px;margin-top:2px">可继续领料 {{ fmtQty(row.qtyCanGen) }} {{ row.unit }}（应到 {{ fmtQty(row.qtyRequired) }} / 已生成 {{ fmtQty(row.qtyGenerated) }}）</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{row}">
              <el-button link type="danger" size="small" tabindex="-1" @click="removeStaging(row.id)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
        </div>
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
                  <el-table-column label="入库时间" width="170"><template #default="{row}">{{ fmtTime(row.at) }}</template></el-table-column>
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
          <el-table-column label="创建时间" width="170"><template #default="{row}">{{ fmtTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{row}"><el-tag size="small" :type="relStatusType(row.status)">{{ row.status }}</el-tag></template>
          </el-table-column>
          <el-table-column label="操作" width="120">
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
    <div v-else-if="tab==='arrival'">
      <ArrivalStats />
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
              <el-input-number v-model="form.qtyRequired" :min="0.0001" :precision="4" :controls="false" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="单位" style="margin-bottom:14px">
              <el-input v-model="form.unit" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="24">
          <el-col :span="12" :xs="24">
            <el-form-item label="已到数量" style="margin-bottom:14px">
              <el-input :model-value="fmtQty(form.qtyArrived || 0)" readonly />
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

    <el-dialog title="导入材料表" v-model="idlg.visible" width="640px" top="10vh">
      <div style="font-size:14px;margin-bottom:10px">已选择文件：<b>{{ idlg.fileName }}</b></div>
      <div style="color:var(--text-2);font-size:13px;line-height:1.7;margin-bottom:12px">
        可先「试校验」查看全部行的错误清单（不写库、不生成批次）；正式导入时任意一行不通过都会整批拒绝。
      </div>
      <div v-if="idlg.note" :style="{ fontSize:'13px', lineHeight:'1.7', marginBottom:'10px', color: idlg.errors.length ? 'var(--el-color-danger)' : 'var(--el-color-success)' }">{{ idlg.note }}</div>
      <div v-if="idlg.errors.length" style="max-height:260px;overflow:auto;border:1px solid var(--line-strong);border-radius:6px;padding:8px 12px">
        <div v-for="(e, i) in idlg.errors" :key="i" style="font-size:13px;line-height:1.9;color:var(--el-color-danger)">· {{ e.message }}</div>
      </div>
      <template #footer>
        <el-button @click="idlg.visible=false">取 消</el-button>
        <el-button :loading="idlg.checking" @click="previewImport">试校验</el-button>
        <el-button type="primary" :loading="idlg.importing" @click="doImport">确认导入</el-button>
      </template>
    </el-dialog>

    <el-dialog title="生成领料单" v-model="gdlg.visible" width="560px" top="12vh">
      <el-form label-position="top">
        <el-form-item label="领料日期（开单日，决定单号日期）" required>
          <el-date-picker v-model="gdlg.date" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" @change="refreshGenNo" />
        </el-form-item>
        <el-form-item label="即将生成的单号">
          <el-input :model-value="gdlg.no" readonly />
        </el-form-item>
        <el-form-item v-if="gdlg.date && gdlg.date < gLimit30()" label="领料日期早于 30 天，补录原因" required>
          <el-input v-model="gdlg.reason" placeholder="请说明补录原因" />
        </el-form-item>
      </el-form>
      <div style="color:var(--text-2);font-size:13px">共 {{ gdlg.items.length }} 种材料；提交后按该开单日取号，录入时间另行记录。</div>
      <template #footer>
        <el-button @click="gdlg.visible=false">取 消</el-button>
        <el-button type="primary" @click="doGenRequisition">确认生成</el-button>
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
    const dlg = reactive({ visible: false, rec: null, mode: '无异常', rows: [], type: 'confirm', arrivalDate: '', arrivalReason: '' });
    const todayStr = () => ((window.ServerTime && ServerTime.ymd) ? ServerTime.ymd() : new Date().toISOString().slice(0, 10));
    function oldLimit30() { const t = new Date(todayStr() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 30); return t.toISOString().slice(0, 10); }
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
    // 单号排序口径（js/utils.js 的 reqNoKey / cmpReqNo，冒烟脚本共用同一份纯函数）：
    // 日期升序 → 同日内 流水组（3 位及以上数字后缀，含残留旧 4 位）按数值升序 → 6 位时间后缀组按值升序 → 无法识别的排最后
    // 定版格式 LL-YYYYMMDD-NNN；解析同时接受无 LL- 前缀的历史测试期写法。
    function resetFilters() { filters.project = ''; filters.status = ''; filters.keyword = ''; }
    function sumQty(r) { return r.items.reduce((s, i) => s + (Number(i.qty) || 0), 0); }
    // 列表「物料描述」列：只取物料名称主体，去掉型号 / 规格，多物料按明细顺序去重
    function matNames(r) { return window.MatName.list(r.items); }
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
      dlg.rec = r; dlg.mode = '无异常'; dlg.type = 'confirm'; dlg.arrivalDate = todayStr(); dlg.arrivalReason = '';
      dlg.rows = r.items.map(it => ({ materialId: it.materialId, qty: Number(it.qty) || 0, thisQty: '', abnormal: false, reason: '' }));
      dlg.visible = true;
    }
    // 补入库：与入库弹窗功能一致，「领料数量」按剩余未入库数量展示，无异常时本次入库=剩余量
    function openSupplement(r) {
      dlg.rec = r; dlg.mode = '无异常'; dlg.type = 'supplement'; dlg.arrivalDate = todayStr(); dlg.arrivalReason = '';
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
        await api.put('/api/materialRequisitions/' + dlg.rec.id + '/confirm', { rows, arrivalDate: dlg.arrivalDate || '', arrivalReason: dlg.arrivalReason || '' });
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
      } catch (e) {
        // 冲销会把可用库存冲成负数：列出占用中的出库单（单号 + 净出库），逐条核对
        const refs = e && e.data && e.data.refs;
        if (Array.isArray(refs) && refs.length) {
          const html = '<div style="line-height:1.8">' + (e.message || '') + '</div>'
            + '<div style="margin-top:10px;line-height:2">'
            + refs.map(r => '· 出库单 <b>' + r.outNo + '</b>：净出库 <b>' + fmtQty(r.net) + '</b>'
              + (r.description ? '（' + r.description + '）' : '')).join('<br>')
            + '</div>';
          ElementPlus.ElMessageBox.alert(html, '无法作废领料单', {
            dangerouslyUseHTMLString: true, confirmButtonText: '知道了', type: 'warning'
          });
        } else {
          ElementPlus.ElMessage.error(e.message);
        }
      }
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
    // P4-7/P4-8 入库更正：可同时改数量、到货日、型号；单号与开单日不变
    const cdlg = reactive({ visible: false, rec: null, entry: null, arrivalDate: '', arrivalReason: '', reason: '', saving: false, rows: [], blockRefs: [], bundle: null });
    const matAll = ref([]);
    async function loadMatOptions() {
      if (matAll.value.length) return;
      try { matAll.value = await api.get('/api/materials'); } catch (e) {}
    }
    const matOptions = computed(() => {
      const ps = (cdlg.rec && cdlg.rec.projects) || [];
      const all = (matAll.value || []).filter(m => m && !m.deleted);
      const hit = all.filter(m => !ps.length || ps.includes(m.project));
      return hit.length ? hit : all;
    });
    const matLabel = m => {
      if (!m) return '';
      const ps = (cdlg.rec && cdlg.rec.projects) || [];
      const tags = [];
      if (ps.length && m.project && !ps.includes(m.project)) tags.push('其他工程');
      if (!(Number(m.qtyArrived) > 0)) tags.push('未到库');
      return (m.code ? m.code + ' ' : '') + (m.description || '') + (tags.length ? '（' + tags.join('；') + '）' : '');
    };
    async function openCorrect(rec, h) {
      await loadMatOptions();
      const raw = (rec.history || []).find(x => x && x.id === h.id);
      if (!raw) return;
      cdlg.rec = rec; cdlg.entry = raw;
      cdlg.arrivalDate = raw.arrivalDate || (raw.at || '').slice(0, 10);
      cdlg.arrivalReason = ''; cdlg.reason = ''; cdlg.blockRefs = []; cdlg.bundle = null;
      cdlg.rows = (raw.rows || []).filter(r => r && r.materialId).map(r => {
        const m = matAll.value.find(x => x.id === r.materialId) || {};
        return {
          materialId: r.materialId, description: m.description || r.description || r.materialId,
          oldQty: Number(r.thisQty) || 0, qty: Number(r.thisQty) || 0, newMaterialId: r.materialId
        };
      });
      cdlg.visible = true;
    }
    async function submitCorrect() {
      if (!cdlg.rec || !cdlg.entry) return;
      if (!String(cdlg.reason || '').trim()) { ElementPlus.ElMessage.error('请填写更正原因'); return; }
      if (cdlg.bundle && cdlg.bundle.enabled && !String(cdlg.bundle.reason || '').trim()) { ElementPlus.ElMessage.error('请填写附带出库更正的原因（不得沿用主更正原因）'); return; }
      if (cdlg.arrivalDate && cdlg.arrivalDate < oldLimit30() && !String(cdlg.arrivalReason || '').trim()) {
        ElementPlus.ElMessage.error('到货日期早于 30 天，请填写补录原因'); return;
      }
      cdlg.saving = true;
      try {
        const body = {
          rows: cdlg.rows.map(r => ({ materialId: r.materialId, qty: Number(r.qty), newMaterialId: r.newMaterialId })),
          arrivalDate: cdlg.arrivalDate,
          reason: String(cdlg.reason).trim(),
          arrivalReason: String(cdlg.arrivalReason || '').trim()
        };
        if (cdlg.bundle && cdlg.bundle.enabled) {
          body.outboundCorrections = [{
            outboundId: cdlg.bundle.outboundId,
            entryId: cdlg.bundle.entryId,
            qty: Number(cdlg.bundle.qty),
            outDate: cdlg.bundle.outDate,
            reason: String(cdlg.bundle.reason || '').trim(),
            materialId: cdlg.bundle.materialId || (cdlg.rows[0] && cdlg.rows[0].newMaterialId) || ''
          }];
        }
        await api.post('/api/materialRequisitions/' + cdlg.rec.id + '/receipts/' + cdlg.entry.id + '/correct', body);
        ElementPlus.ElMessage.success('已更正该次入库，单号与开单日不变');
        cdlg.visible = false;
        await load();
      } catch (e) {
        const d = e.data || {};
        if (d.canBundle && Array.isArray(d.refs)) {
          cdlg.blockRefs = d.refs.filter(x => x && x.outboundId && x.entryId);
          if (!cdlg.bundle && cdlg.blockRefs.length) {
            const r0 = cdlg.blockRefs[0];
            cdlg.bundle = {
              enabled: true, outboundId: r0.outboundId, entryId: r0.entryId,
              qty: Number(r0.net || r0.qty) || 0, outDate: r0.outDate || cdlg.arrivalDate,
              materialId: (cdlg.rows[0] && cdlg.rows[0].newMaterialId) || '', reason: ''
            };
          }
        } else {
          cdlg.blockRefs = [];
        }
        ElementPlus.ElMessage.error(e.message);
      } finally { cdlg.saving = false; }
    }
    function itemHistory(rec, materialId) {
      const out = [];
      ((rec && rec.history) || []).forEach(h => (h.rows || []).forEach(r => {
        if (r.materialId !== materialId) return;
        // P4-7：标签 原记录(已冲销)/冲销/更正/入库；冲销与已冲销的原记录都不能再作为更正目标
        const tag = h.reverses ? '冲销' : (h.correctsEntry ? '更正' : (h.reversed ? '原记录(已冲销)' : '入库'));
        out.push({
          id: h.id || '', at: h.at, arrivalDate: h.arrivalDate || '',
          thisQty: r.thisQty, abnormal: r.abnormal,
          reason: r.reason || h.reason || '',
          tag, canCorrect: !!h.id && !h.reverses && !h.reversed
        });
      }));
      return out;
    }
    // 某物料累计已收数量（= 历次入库 thisQty 之和）；用于进度汇总
    function arrivedSum(rec, materialId) {
      return itemHistory(rec, materialId).reduce((s, h) => s + (Number(h.thisQty) || 0), 0);
    }
    return { list, loading, filters, projectOptions, dlg, vdlg, filtered, load, resetFilters, sumQty, matNames, fmtQty, statusType, download, openConfirm, openSupplement, rowFlag, supDone, rowClass, onModeChange, qtyInput, doConfirm, voidReq, voidDeduct, confirmVoid, deleteReq, stockInfo, stockReason, itemHistory, arrivedSum, todayStr, oldLimit30, cdlg, openCorrect, submitCorrect, matOptions, matLabel };
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
              <span class="rq-exp-count">开单日 {{ row.reqDate || '—' }} · 录入 {{ fmtTime(row.createdAt) }}</span>
              <span v-if="row.correctedFromNo" class="rq-exp-chip">更正自 {{ row.correctedFromNo }}</span>
              <span v-if="row.correctedByNo" class="rq-exp-chip">已由 {{ row.correctedByNo }} 更正</span>
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
                <el-table-column label="到货日期" width="120"><template #default="{row:h}">{{ h.arrivalDate || (h.at || '').slice(0, 10) }}</template></el-table-column>
                <el-table-column label="标签" width="120"><template #default="{row:h}"><el-tag size="small" :type="h.tag === '冲销' ? 'danger' : (h.tag === '更正' ? 'warning' : (h.tag === '原记录(已冲销)' ? 'info' : 'success'))">{{ h.tag }}</el-tag></template></el-table-column>
                <el-table-column label="录入时间" width="170"><template #default="{row:h}">{{ fmtTime(h.at) }}</template></el-table-column>
                <el-table-column label="本次入库数量" width="120" align="right"><template #default="{row:h}">{{ fmtQty(h.thisQty) }}</template></el-table-column>
                <el-table-column label="入库情况" width="100" align="center"><template #default="{row:h}"><el-tag size="small" :type="h.abnormal ? 'danger' : 'success'">{{ h.abnormal ? '异常' : '正常' }}</el-tag></template></el-table-column>
                <el-table-column prop="reason" label="原因" min-width="180"><template #default="{row:h}">{{ h.reason || '-' }}</template></el-table-column>
                <el-table-column label="操作" width="90" align="center"><template #default="{row:h}"><el-button v-if="h.canCorrect && row.status !== '已作废' && canWrite('materials')" link type="primary" size="small" @click="openCorrect(row, h)">更正</el-button></template></el-table-column>
              </el-table>
              <div v-else class="rq-hist-empty">暂无入库记录（确认入库 / 补入库后按次记录）</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="reqNo" label="领料单号" width="180" />
      <el-table-column label="涉及项目" min-width="200" class-name="rq-wrapcell">
        <template #default="{row}">
          <span v-for="(p, i) in row.projects" :key="i" class="rq-cell-item">{{ p }}</span>
          <span v-if="!row.projects.length" class="rq-cell-item">—</span>
        </template>
      </el-table-column>
      <el-table-column label="物料描述" min-width="160" class-name="rq-wrapcell">
        <template #default="{row}">
          <span v-for="(n, i) in matNames(row)" :key="i" class="rq-cell-item">{{ n }}</span>
          <span v-if="!matNames(row).length" class="rq-cell-item">—</span>
        </template>
      </el-table-column>
      <el-table-column label="明细" width="110">
        <template #default="{row}">{{ row.items.length }} 项 / {{ sumQty(row) }}</template>
      </el-table-column>
      <el-table-column label="开单日" width="110"><template #default="{row}">{{ row.reqDate || '—' }}</template></el-table-column>
      <el-table-column label="创建时间" width="150"><template #default="{row}">{{ fmtTime(row.createdAt) }}</template></el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{row}"><el-tag size="small" :type="statusType(row.status)">{{ row.status }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="190">
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
      <el-row :gutter="12" style="margin-bottom:12px">
        <el-col :span="10" :xs="24">
          <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">到货日期（整单一个，分多天到货请分多次入库）</div>
          <el-date-picker v-model="dlg.arrivalDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" />
        </el-col>
        <el-col :span="14" :xs="24" v-if="dlg.arrivalDate && dlg.arrivalDate < oldLimit30()">
          <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">到货日期早于 30 天，补录原因</div>
          <el-input v-model="dlg.arrivalReason" placeholder="请说明补录原因" />
        </el-col>
      </el-row>
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

    <el-dialog title="入库更正" v-model="cdlg.visible" width="720px" top="10vh">
      <div v-if="cdlg.entry" style="background:var(--surface-3);border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:13px;line-height:1.9">
        <div>领料单：<b>{{ cdlg.rec && cdlg.rec.reqNo }}</b>　开单日 {{ cdlg.rec && cdlg.rec.reqDate }}</div>
        <div>原到货日：{{ cdlg.entry.arrivalDate || (cdlg.entry.at || '').slice(0, 10) }}　本次入库 {{ cdlg.rows.length }} 行</div>
        <div style="color:var(--text-3)">可同时改型号、数量、到货日；单号、开单日、创建时间都不变。改项目或整单作废请走「作废重开」。</div>
      </div>
      <el-form label-position="top">
        <el-row :gutter="12">
          <el-col :span="12" :xs="24">
            <el-form-item label="更正后到货日" required>
              <el-date-picker v-model="cdlg.arrivalDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="更正原因" required>
              <el-input v-model="cdlg.reason" placeholder="如：型号录入错误，应为 B" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="cdlg.arrivalDate && cdlg.arrivalDate < oldLimit30()" label="到货日早于 30 天，补录原因" required>
          <el-input v-model="cdlg.arrivalReason" placeholder="请说明补录原因" />
        </el-form-item>
        <el-table :data="cdlg.rows" size="small" border style="width:100%">
          <el-table-column label="原型号" min-width="170"><template #default="{row}">{{ row.description }}</template></el-table-column>
          <el-table-column label="原数量" width="90" align="right"><template #default="{row}">{{ row.oldQty }}</template></el-table-column>
          <el-table-column label="新型号（可改）" min-width="230">
            <template #default="{row}">
              <el-select v-model="row.newMaterialId" filterable style="width:100%">
                <el-option v-for="m in matOptions" :key="m.id" :label="matLabel(m)" :value="m.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="新数量" width="130">
            <template #default="{row}">
              <el-input-number v-model="row.qty" :min="0" :precision="4" :controls="false" style="width:100%" />
            </template>
          </el-table-column>
        </el-table>
        <div v-if="cdlg.blockRefs.length" style="margin-top:12px;background:#FDF6EC;border:1px solid #FAECD8;border-radius:6px;padding:10px 12px">
          <div style="color:#E6A23C;font-size:13px;margin-bottom:6px">该物料被以下出库占用，单独改型号会被回放拒绝，可一并更正：</div>
          <div v-for="r in cdlg.blockRefs" :key="r.outboundId + ':' + r.entryId" style="font-size:13px;line-height:1.8">{{ r.outNo }}　{{ r.description }}　{{ r.qty }}　{{ r.outDate }}</div>
          <div v-if="cdlg.bundle" style="margin-top:8px;border-top:1px dashed #E4E7ED;padding-top:8px">
            <el-checkbox v-model="cdlg.bundle.enabled">一并更正该出库</el-checkbox>
            <template v-if="cdlg.bundle.enabled">
              <el-row :gutter="8" style="margin-top:6px">
                <el-col :span="10" :xs="24">
                  <el-select v-model="cdlg.bundle.materialId" filterable style="width:100%">
                    <el-option v-for="m in matOptions" :key="m.id" :label="matLabel(m)" :value="m.id" />
                  </el-select>
                </el-col>
                <el-col :span="5" :xs="24">
                  <el-input-number v-model="cdlg.bundle.qty" :min="0" :precision="4" :controls="false" style="width:100%" />
                </el-col>
                <el-col :span="9" :xs="24">
                  <el-date-picker v-model="cdlg.bundle.outDate" type="date" value-format="YYYY-MM-DD" style="width:100%" />
                </el-col>
              </el-row>
              <div style="margin-top:6px;font-size:13px;color:var(--text-2)">附带出库更正原因（必填，不得沿用主更正原因）</div>
              <el-input v-model="cdlg.bundle.reason" placeholder="请单独填写该次出库更正原因" style="margin-top:4px" />
            </template>
          </div>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="cdlg.visible=false">取 消</el-button>
        <el-button type="primary" :loading="cdlg.saving" @click="submitCorrect">确认更正</el-button>
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
      <el-table-column label="导入时间" width="170"><template #default="{row}">{{ fmtTime(row.importedAt) }}</template></el-table-column>
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
      <el-table-column v-if="canAdmin()" label="操作" width="90">
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
    const f1 = ref('在建工程');   // 在建工程 | 已竣工工程
    const f2 = ref('全部工程类型');   // 全部工程类型 | 自有工程 | 客户工程
    const f3 = ref('');           // '' = 全部导入状态 | 已导入 | 未导入
    const project = ref('');
    const keyword = ref('');
    const allProjects = ref([]);  // 完整项目对象（含 completed / category）
    const importMap = ref(null);  // 项目名 → { total, imported }，用到导入状态时才加载
    const workers = ref([]);
    const list = ref([]);
    const orders = ref([]);
    const loading = ref(false);
    const selection = ref([]);
    const outQty = reactive({});
    const mainTable = ref(null);
    const page = ref(1); const pageSize = ref(50);
    const opage = ref(1); const opageSize = ref(30);
    // 登记出库 / 出库单详情 / 归还 / 打印预览
    // P1：出库可选关联 —— 计划（workPlanId）、作业日（workDate）、工序（processName），明细行来源领料单（requisitionId）
    const dlg = reactive({ visible: false, workerId: '', workPlanId: '', workDate: '', outDate: '', outDateReason: '', processName: '', rows: [] });
    const reqList = ref([]);   // 来源领料单候选（未作废即可，按材料行过滤）
    const planList = ref([]);  // 关联计划候选（按工程同口径过滤）
    const od = reactive({ visible: false, rec: null });
    const rdlg = reactive({ visible: false, rec: null, rows: [], returnDate: '', returnDateReason: '' });
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
        allProjects.value = (Array.isArray(r) ? r : (r.data || [])).filter(p => p && (p.name || p.projectName));
      } catch (e) {}
      try {
        const r = await api.get('/api/workers');
        // 领取人只列派生状态为已准入者（已准入且准入有效期未超期）；下拉保留 id + 姓名，提交按 workerId
        const arr = Array.isArray(r) ? r : (r.data || []);
        const today = ServerTime.ymd();
        workers.value = arr.filter(w => w && w.name && WorkerStatus.of(w, today).admitted)
          .map(w => ({ id: w.id, name: w.name, team: String(w.team || '') }));
      } catch (e) {}
    }
    // 导入情况：该项目名下是否存在「带 importId 的材料行」（手工录入的不算导入）
    // 材料量较大，仅在用户真的要用「导入状态」筛选时才拉一次
    async function loadImportMap() {
      if (importMap.value) return;
      try {
        const r = await api.get('/api/materials');
        const arr = Array.isArray(r) ? r : (r.data || []);
        const mp = {};
        arr.forEach(m => {
          const n = m.project; if (!n) return;
          const o = mp[n] || (mp[n] = { total: 0, imported: 0 });
          o.total++; if (m.importId) o.imported++;
        });
        importMap.value = mp;
      } catch (e) { importMap.value = {}; }
    }
    function importStateOf(name) {
      const o = (importMap.value || {})[name];
      return o && o.imported > 0 ? '已导入' : '未导入';
    }
    // 框1~3 联动：工程状态（completed）/ 工程类型（category）/ 导入情况
    function projectPass(p) {
      const done = !!p.completed;
      if (f1.value === '已竣工工程' ? !done : done) return false;
      if (f2.value && f2.value !== '全部工程类型' && (p.category || '') !== f2.value) return false;
      if (f3.value && importStateOf(p.name || p.projectName) !== f3.value) return false;
      return true;
    }
    // 框4 候选：随框1~框3 过滤后的工程名单
    const projects = computed(() => {
      const names = [];
      allProjects.value.forEach(p => { if (!projectPass(p)) return; const n = p.name || p.projectName; if (n) names.push(n); });
      return [...new Set(names)];
    });
    // 框1~3 变化后，已选工程若不在候选中则清空
    watch([f1, f2, f3], () => {
      if (project.value && projects.value.indexOf(project.value) < 0) { project.value = ''; onProjectChange(); }
    });
    async function load() {
      if (!project.value) { list.value = []; orders.value = []; return; }
      loading.value = true;
      try {
        const r = await api.get('/api/materialOutbound/stock?project=' + encodeURIComponent(project.value));
        list.value = Array.isArray(r) ? r : (r.data || []);
        const r2 = await api.get('/api/materialOutbound/orders?project=' + encodeURIComponent(project.value));
        orders.value = Array.isArray(r2) ? r2 : (r2.data || []);
        await loadLinks();
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { loading.value = false; }
    }
    // P1：关联候选（领料单 / 计划）—— 量小，随工程加载一并拉取；失败静默（关联是可选项）
    async function loadLinks() {
      try {
        const r = await api.get('/api/materialRequisitions');
        const arr = Array.isArray(r) ? r : (r.data || []);
        reqList.value = arr.filter(x => x && x.status !== '已作废');
      } catch (e) { reqList.value = []; }
      try {
        const r2 = await api.get('/api/workPlans');
        planList.value = Array.isArray(r2) ? r2 : (r2.data || []);
      } catch (e) { planList.value = []; }
    }
    // 项目名同口径（同名或同属一个父工程），与后端 sameProjectScope 一致
    function sameScope(a, b) {
      const na = String(a || '').trim(); const nb = String(b || '').trim();
      if (!na || !nb) return false;
      if (na === nb) return true;
      const fam = n => {
        const hit = allProjects.value.find(p => String(p.name || '').trim() === n
          || (p.subProjects || []).some(s => String((s || {}).name || '').trim() === n));
        return hit ? String(hit.name || '').trim() : '';
      };
      const fa = fam(na); const fb = fam(nb);
      return !!fa && fa === fb;
    }
    function reqOptionsOf(materialId) {
      return reqList.value.filter(r => (r.items || []).some(i => i && i.materialId === materialId));
    }
    const planOptions = computed(() => planList.value.filter(w => w && sameScope(w.project, project.value)));
    function onProjectChange() { selection.value = []; Object.keys(outQty).forEach(k => delete outQty[k]); page.value = 1; opage.value = 1; load(); }
    const filtered = computed(() => list.value.filter(r => !keyword.value.trim()
      || String(r.description || '').includes(keyword.value.trim()) || String(r.code || '').includes(keyword.value.trim())));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    function onSel(rows) {
      // P3-2：勾选只决定范围，出库数量默认留空由用户填写（不再自动填可用量）
      selection.value = rows;
    }
    function isSelected(row) { return selection.value.some(s => s.id === row.id); }
    function sumQty(o) { return (o.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0); }
    function remaining(it) { return Math.max(0, (Number(it.qty) || 0) - (Number(it.returned) || 0)); }

    function openDlg() {
      if (!selection.value.length) { ElementPlus.ElMessage.info('请先勾选需要出库的材料'); return; }
      // P3-2：未填数量时保持为空（不用 0 占位），提交由前端拦截提示
      const q0 = v => (v === undefined || v === null || v === '' ? null : Number(v));
      dlg.rows = selection.value.map(r => ({ id: r.id, description: r.description, unit: r.unit, available: r.available, qty: q0(outQty[r.id]), requisitionId: '' }));
      dlg.workerId = ''; dlg.workPlanId = ''; dlg.workDate = ''; dlg.processName = '';
      dlg.outDate = bizToday(); dlg.outDateReason = '';
      dlg.visible = true;
    }
    // P4-6：出库日默认等于已填作业日（作业日晚于今天则回落今天）
    function bizToday() { return (window.ServerTime && ServerTime.ymd) ? ServerTime.ymd() : new Date().toISOString().slice(0, 10); }
    function oldLimit30() { const t = new Date(bizToday() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 30); return t.toISOString().slice(0, 10); }
    function onWorkDateChange(v) {
      if (!v) return;
      dlg.outDate = v <= bizToday() ? v : bizToday();
    }
    const outDateFallbackNow = computed(() => !!(dlg.workDate && dlg.workDate > bizToday()));
    const needOutReason = computed(() => {
      if (!dlg.outDate) return false;
      const t = new Date(bizToday() + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() - 30);
      return dlg.outDate < t.toISOString().slice(0, 10);
    });
    const outNoPreview = computed(() => {
      if (!dlg.outDate) return '';
      const pre = 'OUT-' + String(dlg.outDate).replace(/-/g, '') + '-';
      let max = 0;
      (orders.value || []).forEach(o => {
        const no = String((o && o.outNo) || '');
        if (no.indexOf(pre) !== 0) return;
        const sfx = no.slice(pre.length);
        if (/^\d+$/.test(sfx)) max = Math.max(max, parseInt(sfx, 10));
      });
      return pre + String(max + 1).padStart(4, '0');
    });
    async function submitOut() {
      const w = workers.value.find(x => x.id === dlg.workerId);
      if (!w) { ElementPlus.ElMessage.warning('请选择领取人'); return; }
      for (const r of dlg.rows) {
        if (!(Number(r.qty) > 0)) { ElementPlus.ElMessage.error('请填写出库数量（' + r.description + '）'); return; }
        if (Number(r.qty) > Number(r.available) + 1e-9) { ElementPlus.ElMessage.error('「' + r.description + '」本次出库 ' + r.qty + ' 超过可用库存 ' + r.available); return; }
      }
      try {
        const res = await api.post('/api/materialOutbound/create', {
          project: project.value, workerId: w.id, receiver: w.name,
          workPlanId: dlg.workPlanId || '', workDate: dlg.workDate || '', processName: (dlg.processName || '').trim(),
          outDate: dlg.outDate || '', outDateReason: dlg.outDateReason || '',
          items: dlg.rows.map(r => ({ materialId: r.id, qty: Number(r.qty), requisitionId: r.requisitionId || '' }))
        });
        ElementPlus.ElMessage.success('出库单 ' + res.data.outNo + ' 已登记' + (res.outDateFallback ? '（作业日晚于今天，出库日已按今天）' : ''));
        dlg.visible = false;
        selection.value = [];
        if (mainTable.value && mainTable.value.clearSelection) mainTable.value.clearSelection();
        Object.keys(outQty).forEach(k => delete outQty[k]);
        await load();
        od.rec = res.data; od.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function openOrder(o) { od.rec = o; od.visible = true; }
    // P4-9 出库更正：原型号/数量/出库日只读；可改型号、数量、出库日；已有归还不显示入口
    const ocdlg = reactive({ visible: false, rec: null, entry: null, outDate: '', outDateReason: '', reason: '', saving: false, rows: [], receiptCandidates: [], bundle: null, showBundle: false });
    const outMatAll = ref([]);
    async function loadOutMatOptions() {
      if (outMatAll.value.length) return;
      try { outMatAll.value = await api.get('/api/materials'); } catch (e) {}
    }
    const outMatOptions = computed(() => {
      const pj = (ocdlg.rec && ocdlg.rec.project) || '';
      const all = (outMatAll.value || []).filter(m => m && !m.deleted);
      const hit = all.filter(m => !pj || m.project === pj);
      return hit.length ? hit : all;
    });
    const outMatLabel = m => {
      if (!m) return '';
      const pj = (ocdlg.rec && ocdlg.rec.project) || '';
      const tags = [];
      if (pj && m.project && m.project !== pj) tags.push('其他工程');
      if (!(Number(m.qtyArrived) > 0)) tags.push('未到库，需一并更正入库');
      return (m.code ? m.code + ' ' : '') + (m.description || '') + (tags.length ? '（' + tags.join('；') + '）' : '');
    };
    function entryTag(e) {
      if (!e) return '';
      if (e.reverses || e.direction === 'in') return '冲销';
      if (e.correctsEntry) return '更正';
      return e.reversed ? '原记录(已冲销)' : '原记录';
    }
    function entryTagType(e) {
      const t = entryTag(e);
      return t === '冲销' ? 'danger' : (t === '更正' ? 'warning' : (t === '原记录(已冲销)' ? 'info' : 'success'));
    }
    function entryMatText(e) {
      const sign = e && e.direction === 'in' ? '+' : '';
      return ((e && e.rows) || []).map(r => (r.description || r.code || r.materialId) + ' ' + sign + r.qty).join('；');
    }
    function canCorrectEntry(e) {
      const rec = od.rec;
      const writable = (typeof Auth !== 'undefined' && Auth.loaded
        && (Auth.writeModules.includes('*') || Auth.writeModules.includes('materials')));
      return !!(rec && rec.status === '有效' && !(rec.returns || []).some(x => x && (x.rows || []).length)
        && e && e.id && e.direction !== 'in' && !e.reverses && !e.reversed && writable);
    }
    async function openOutCorrect(rec, e) {
      await loadOutMatOptions();
      ocdlg.rec = rec; ocdlg.entry = e;
      ocdlg.outDate = e.outDate || rec.outDate || '';
      ocdlg.outDateReason = ''; ocdlg.reason = ''; ocdlg.saving = false;
      ocdlg.receiptCandidates = []; ocdlg.bundle = null; ocdlg.showBundle = false;
      ocdlg.rows = ((e && e.rows) || []).filter(r => r && r.materialId).map(r => {
        const m = outMatAll.value.find(x => x.id === r.materialId) || {};
        return {
          materialId: r.materialId, description: m.description || r.description || r.materialId,
          oldQty: Number(r.qty) || 0, qty: Number(r.qty) || 0, newMaterialId: r.materialId,
          requisitionId: r.requisitionId || ''
        };
      });
      // 入库不足时的连带候选：同一来源领料单里包含当前物料的未冲销入库条目
      const reqId = ocdlg.rows.map(r => r.requisitionId).filter(Boolean)[0] || '';
      if (reqId) {
        const req = reqList.value.find(x => x.id === reqId);
        if (req) {
          const ids = new Set(ocdlg.rows.map(r => r.materialId));
          ocdlg.receiptCandidates = (req.history || []).filter(h => h && h.id && !h.reverses && !h.reversed
            && (h.rows || []).some(r2 => r2 && ids.has(r2.materialId))).map(h => {
            const row = (h.rows || []).find(r2 => r2 && ids.has(r2.materialId)) || {};
            return {
              requisitionId: req.id, reqNo: req.reqNo || '', entryId: h.id,
              arrivalDate: h.arrivalDate || (h.at || '').slice(0, 10),
              qty: Number(row.thisQty) || 0, materialId: row.materialId || ''
            };
          });
        }
      }
      ocdlg.visible = true;
    }
    async function submitOutCorrect() {
      if (!ocdlg.rec || !ocdlg.entry) return;
      if (!String(ocdlg.reason || '').trim()) { ElementPlus.ElMessage.error('请填写更正原因'); return; }
      if (ocdlg.bundle && ocdlg.bundle.enabled && !String(ocdlg.bundle.reason || '').trim()) { ElementPlus.ElMessage.error('请填写附带入库更正的原因（不得沿用主更正原因）'); return; }
      if (ocdlg.outDate && ocdlg.outDate < oldLimit30() && !String(ocdlg.outDateReason || '').trim()) {
        ElementPlus.ElMessage.error('出库日期早于 30 天，请填写补录原因'); return;
      }
      ocdlg.saving = true;
      try {
        const body = {
          rows: ocdlg.rows.map(r => ({ materialId: r.materialId, qty: Number(r.qty), newMaterialId: r.newMaterialId })),
          outDate: ocdlg.outDate,
          reason: String(ocdlg.reason).trim(),
          outDateReason: String(ocdlg.outDateReason || '').trim()
        };
        if (ocdlg.bundle && ocdlg.bundle.enabled) {
          body.receiptCorrections = [{
            requisitionId: ocdlg.bundle.requisitionId,
            entryId: ocdlg.bundle.entryId,
            qty: Number(ocdlg.bundle.qty),
            arrivalDate: ocdlg.bundle.arrivalDate,
            reason: String(ocdlg.bundle.reason || '').trim(),
            materialId: ocdlg.bundle.materialId || (ocdlg.rows[0] && ocdlg.rows[0].newMaterialId) || ''
          }];
        }
        await api.post('/api/materialOutbound/' + ocdlg.rec.id + '/entries/' + ocdlg.entry.id + '/correct', body);
        ElementPlus.ElMessage.success('已更正该次出库，单号与登记时间不变');
        ocdlg.visible = false;
        await load();
        if (od.visible && od.rec && od.rec.id === ocdlg.rec.id) od.rec = orders.value.find(o => o.id === ocdlg.rec.id) || od.rec;
      } catch (e) {
        if (ocdlg.receiptCandidates.length && /可用库存|可用不足|未到库|为负|可一并更正/.test(String(e.message || ''))) {
          ocdlg.showBundle = true;
          if (!ocdlg.bundle) {
            const c = ocdlg.receiptCandidates[0];
            ocdlg.bundle = {
              enabled: true, requisitionId: c.requisitionId, reqNo: c.reqNo, entryId: c.entryId,
              qty: c.qty, arrivalDate: c.arrivalDate,
              materialId: (ocdlg.rows[0] && ocdlg.rows[0].newMaterialId) || '', reason: ''
            };
          }
        }
        ElementPlus.ElMessage.error(e.message);
      } finally { ocdlg.saving = false; }
    }
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
    // 第五批修正 F4：有效出库物料以 entries 净额为准，原 items 原文不动（列表/筛选/详情/打印共用）
    function netRowsOf(rec) {
      const raw = (rec && rec.netItems && rec.netItems.length)
        ? rec.netItems
        : ((rec && rec.items) || []).map(it => Object.assign({}, it, { qty: it.netQty !== undefined ? it.netQty : it.qty }));
      // 来源领料单号仍取自原 items（netItems 只有 requisitionId）
      const itemByMid = {};
      ((rec && rec.items) || []).forEach(it => { if (it && it.materialId && !itemByMid[it.materialId]) itemByMid[it.materialId] = it; });
      return raw.filter(it => it && it.materialId && Number(it.qty) > 0).map(it => Object.assign({}, it, {
        qty: Number(it.qty) || 0, netQty: Number(it.qty) || 0, returned: 0,
        reqNo: it.reqNo || (itemByMid[it.materialId] && itemByMid[it.materialId].reqNo) || ''
      }));
    }
    const ofiltered = computed(() => {
      let arr = orders.value;
      if (matFilter.value) arr = arr.filter(o => netRowsOf(o).some(it => it.materialId === matFilter.value.id));
      const k = oKeyword.value.trim();
      if (k) arr = arr.filter(o => String(o.outNo || '').includes(k) || String(o.project || '').includes(k) || String(o.receiver || '').includes(k));
      return arr;
    });
    const opaged = computed(() => ofiltered.value.slice((opage.value - 1) * opageSize.value, opage.value * opageSize.value));
    // 出库单行汇总：累计领取/累计归还/补回数量/净出库（作废单已补回，净出库为 0）
    // P4-9：累计领取/净出库按 netItems（entries 净额）汇总；归还仍按 items.returned
    function oTakeList(o) {
      const arr = netRowsOf(o);
      return matFilter.value ? arr.filter(i => i.materialId === matFilter.value.id) : arr;
    }
    function oTake(o) { return oTakeList(o).reduce((s, i) => s + (Number(i.qty) || 0), 0); }
    function oReturned(o) { return (o.items || []).reduce((s, i) => s + (Number(i.returned) || 0), 0); }
    function oCompensated(o) { return o.status === '已作废' ? Math.max(0, oTake(o) - oReturned(o)) : 0; }
    function oNet(o) { return o.status === '已作废' ? 0 : Math.max(0, oTake(o) - oReturned(o)); }
    function oRows(o) { return oTakeList(o).length; }
    function oReturnedM(o) {
      const its = matFilter.value ? (o.items || []).filter(i => i.materialId === matFilter.value.id) : (o.items || []);
      return its.reduce((s, i) => s + (Number(i.returned) || 0), 0);
    }
    function oTakeM(o) { return oTake(o); }
    function oCompensatedM(o) { return o.status === '已作废' ? Math.max(0, oTakeM(o) - oReturnedM(o)) : 0; }
    function oNetM(o) { return o.status === '已作废' ? 0 : Math.max(0, oTakeM(o) - oReturnedM(o)); }
    function returnedOfMaterial(rec, mid) {
      let sum = 0;
      (rec.returns || []).forEach(x => ((x && x.rows) || []).forEach(r => { if (r && r.materialId === mid) sum = round4(sum + (Number(r.qty) || 0)); }));
      if (sum) return sum;
      const it = (rec.items || []).find(i => i.materialId === mid);
      return it ? (Number(it.returned) || 0) : 0;
    }
    function round4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
    function obRemain(row, rec) {
      const qty = row && row.netQty !== undefined ? Number(row.netQty) : Number(row && row.qty) || 0;
      return Math.max(0, round4(qty - returnedOfMaterial(rec, row && row.materialId)));
    }
    function openReturn(o) {
      const rec = (o && o.items) ? o : od.rec; // 行内传入出库单；详情页按钮传 MouseEvent 时回退 od.rec
      if (!rec) return;
      rdlg.rec = rec;
      const netList = (rec.netItems && rec.netItems.length) ? rec.netItems : (rec.items || []);
      rdlg.rows = netList.map(it => ({ materialId: it.materialId, description: it.description, remaining: obRemain(it, rec), qty: 0 }));
      rdlg.returnDate = bizToday(); rdlg.returnDateReason = '';
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
        await api.put('/api/materialOutbound/' + rdlg.rec.id + '/return', { rows, returnDate: rdlg.returnDate || '', returnDateReason: rdlg.returnDateReason || '' });
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
    return { netRowsOf, tab, f1, f2, f3, project, keyword, projects, workers, loadImportMap, list, orders, loading, selection, outQty, mainTable, page, pageSize, opage, opageSize, paged, opaged, filtered, ofiltered, matFilter, oKeyword, load, onProjectChange, onSel, isSelected, openDlg, dlg, submitOut, od, openOrder, bizToday, oldLimit30, onWorkDateChange, outDateFallbackNow, needOutReason, outNoPreview, rdlg, openReturn, submitReturn, vdlg, openVoid, confirmVoid, deleteOrder, deleteVoided, printOrder, printRow, doPrint, pdlg, showMatOrders, clearMatFilter, chip, fmt, fmt4, sumQty, remaining, oTake, oReturned, oCompensated, oNet, oRows, oTakeM, oReturnedM, oCompensatedM, oNetM, planOptions, reqOptionsOf, ocdlg, openOutCorrect, submitOutCorrect, entryTag, entryTagType, entryMatText, canCorrectEntry, outMatOptions, outMatLabel, obRemain, returnedOfMaterial };
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
    <div class="ob-filters" style="display:flex;gap:10px;margin-bottom:14px">
      <el-select v-model="f1" style="width:130px">
        <el-option label="在建工程" value="在建工程" /><el-option label="已竣工工程" value="已竣工工程" />
      </el-select>
      <el-select v-model="f2" style="width:140px">
        <el-option label="全部工程类型" value="全部工程类型" /><el-option label="自有工程" value="自有工程" /><el-option label="客户工程" value="客户工程" />
      </el-select>
      <el-select v-model="f3" placeholder="全部导入状态" clearable style="width:150px"
        @change="loadImportMap" @visible-change="v => v && loadImportMap()">
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
              :page-sizes="[20, 50, 100, 200]" layout="prev, pager, next, sizes" background />
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
            <el-table-column label="出库日期" width="112"><template #default="{row}">{{ row.outDate || '—' }}</template></el-table-column>
            <el-table-column label="登记时间" width="160"><template #default="{row}">{{ fmtTime(row.createdAt) }}</template></el-table-column>
            <el-table-column label="操作" width="230">
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
          <el-select v-model="dlg.workerId" placeholder="选择领取人" filterable style="width:100%">
            <el-option v-for="w in workers" :key="w.id" :label="w.name" :value="w.id">
              <span>{{ w.name }}</span>
              <span v-if="w.team" style="float:right;color:var(--text-2);font-size:12px">{{ w.team }}</span>
            </el-option>
          </el-select>
        </el-form-item>
        <el-row :gutter="12" style="margin-top:-8px">
          <el-col :span="12" :xs="24">
            <el-form-item label="关联周计划（可选）">
              <el-select v-model="dlg.workPlanId" clearable filterable placeholder="不关联计划" style="width:100%">
                <el-option v-for="p in planOptions" :key="p.id" :label="p.name" :value="p.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="作业日（可选）">
              <el-date-picker v-model="dlg.workDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" @change="onWorkDateChange" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="工序 / 工作内容（可选）" style="margin-top:-8px">
          <el-input v-model="dlg.processName" placeholder="如：立杆、架线、安装开关" />
        </el-form-item>
        <el-row :gutter="12" style="margin-top:-8px">
          <el-col :span="12" :xs="24">
            <el-form-item label="出库日期" required>
              <el-date-picker v-model="dlg.outDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="即将生成的单号">
              <el-input :model-value="outNoPreview" readonly />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="needOutReason" label="出库日期早于 30 天，补录原因" required style="margin-top:-8px">
          <el-input v-model="dlg.outDateReason" placeholder="请说明补录原因" />
        </el-form-item>
        <div v-if="outDateFallbackNow" style="color:#E6A23C;font-size:12px;margin:-4px 0 8px">作业日晚于今天，出库日将按今天登记。</div>
      </el-form>
      <div style="color:var(--text-2);font-size:13px;margin:-6px 0 10px">已选择 {{ dlg.rows.length }} 种材料，提交时会再次核对当前可用库存。</div>
      <el-table :data="dlg.rows" size="small" border style="width:100%">
        <el-table-column prop="description" label="材料" min-width="160" />
        <el-table-column label="可用库存" width="100" align="right"><template #default="{row}">{{ fmt4(row.available) }}</template></el-table-column>
        <el-table-column label="本次出库" width="140">
          <template #default="{row}">
            <el-input-number v-model="row.qty" :min="0" :max="Number(row.available)" :precision="4" :controls="false" size="small" style="width:120px" />
          </template>
        </el-table-column>
        <el-table-column label="来源领料单（可选）" width="180">
          <template #default="{row}">
            <el-select v-model="row.requisitionId" clearable filterable placeholder="不指定" size="small" style="width:100%">
              <el-option v-for="rq in reqOptionsOf(row.id)" :key="rq.id" :label="rq.reqNo" :value="rq.id" />
            </el-select>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="dlg.visible=false">取 消</el-button>
        <el-button type="primary" :disabled="!dlg.workerId" @click="submitOut">确认出库</el-button>
      </template>
    </el-dialog>

    <el-dialog v-if="od.rec" :title="od.rec.outNo" v-model="od.visible" width="900px" top="6vh">
      <div style="display:grid;grid-template-columns:1fr 1fr;row-gap:8px;column-gap:16px;font-size:13px;margin-bottom:14px">
        <div>出库单号：{{ od.rec.outNo }}</div>
        <div>工程：{{ od.rec.project }}</div>
        <div>领取人：{{ od.rec.receiver }}</div>
        <div>单据状态：<el-tag size="small" :type="od.rec.status === '有效' ? 'success' : 'info'">{{ od.rec.status }}</el-tag></div>
        <div>补回未归还数量：{{ od.rec.compensated || 0 }}</div>
        <div>出库日期：{{ od.rec.outDate || '—' }}<span v-if="od.rec.outDateReason" style="color:var(--text-2)">（{{ od.rec.outDateReason }}）</span></div>
        <div>登记时间：{{ fmtTime(od.rec.createdAt) }}</div>
        <div>关联计划：{{ od.rec.workPlanName || '—' }}</div>
        <div>作业日：{{ od.rec.workDate || '—' }}</div>
        <div>工序 / 工作内容：{{ od.rec.processName || '—' }}</div>
      </div>
      <el-table :data="netRowsOf(od.rec)" size="small" border style="width:100%">
        <el-table-column prop="description" label="材料" min-width="180" />
        <el-table-column prop="code" label="编码" width="130" />
        <el-table-column prop="unit" label="单位" width="70" />
        <el-table-column label="来源领料单" width="140"><template #default="{row}">{{ row.reqNo || '—' }}</template></el-table-column>
        <el-table-column label="已出库" width="100" align="right"><template #default="{row}">{{ fmt4(row.netQty !== undefined ? row.netQty : row.qty) }}</template></el-table-column>
        <el-table-column label="已归还" width="100" align="right"><template #default="{row}">{{ fmt4(row.returned) }}</template></el-table-column>
        <el-table-column label="剩余未归还" width="120" align="right"><template #default="{row}">{{ fmt4(obRemain(row, od.rec)) }}</template></el-table-column>
        <el-table-column label="净出库" width="100" align="right"><template #default="{row}">{{ fmt4(Math.max(0, (row.netQty !== undefined ? row.netQty : row.qty) - row.returned)) }}</template></el-table-column>
      </el-table>
      <div style="font-weight:600;font-size:13px;margin:16px 0 8px">出库记录（原记录 / 冲销 / 更正）</div>
      <el-table :data="od.rec.entries || []" size="small" border style="width:100%">
        <el-table-column label="标签" width="130"><template #default="{row:e}"><el-tag size="small" :type="entryTagType(e)">{{ entryTag(e) }}</el-tag></template></el-table-column>
        <el-table-column label="出库日" width="110"><template #default="{row:e}">{{ e.outDate || od.rec.outDate || '—' }}</template></el-table-column>
        <el-table-column label="物料 / 数量" min-width="240"><template #default="{row:e}">{{ entryMatText(e) }}</template></el-table-column>
        <el-table-column label="原因" min-width="160"><template #default="{row:e}">{{ e.reason || '—' }}</template></el-table-column>
        <el-table-column label="操作" width="80" align="center"><template #default="{row:e}"><el-button v-if="canCorrectEntry(e)" link type="primary" size="small" @click="openOutCorrect(od.rec, e)">更正</el-button></template></el-table-column>
      </el-table>
      <template #footer>
        <el-button v-if="od.rec.status === '有效' && canWrite('materials')" @click="openReturn()">登记归还</el-button>
        <el-button v-if="od.rec.status === '有效' && canWrite('materials')" type="danger" plain @click="openVoid()">作废并补回</el-button>
        <el-button @click="printOrder">打 印</el-button>
        <el-button type="primary" @click="od.visible=false">关 闭</el-button>
      </template>
    </el-dialog>

    <el-dialog title="出库更正" v-model="ocdlg.visible" width="720px" top="10vh">
      <div v-if="ocdlg.entry" style="background:var(--surface-3);border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:13px;line-height:1.9">
        <div>出库单：<b>{{ ocdlg.rec && ocdlg.rec.outNo }}</b>　登记时间 {{ ocdlg.rec && fmtTime(ocdlg.rec.createdAt) }}</div>
        <div>原出库日：{{ ocdlg.entry.outDate || (ocdlg.rec && ocdlg.rec.outDate) }}　本次出库 {{ ocdlg.rows.length }} 行</div>
        <div style="color:var(--text-3)">可同时改型号、数量、出库日；单号、登记时间、领取人、来源领料单都不变。</div>
      </div>
      <el-form label-position="top">
        <el-row :gutter="12">
          <el-col :span="12" :xs="24">
            <el-form-item label="更正后出库日" required>
              <el-date-picker v-model="ocdlg.outDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12" :xs="24">
            <el-form-item label="更正原因" required>
              <el-input v-model="ocdlg.reason" placeholder="如：型号录入错误，应为 B" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="ocdlg.outDate && ocdlg.outDate < oldLimit30()" label="出库日早于 30 天，补录原因" required>
          <el-input v-model="ocdlg.outDateReason" placeholder="请说明补录原因" />
        </el-form-item>
        <el-table :data="ocdlg.rows" size="small" border style="width:100%">
          <el-table-column label="原型号" min-width="170"><template #default="{row}">{{ row.description }}</template></el-table-column>
          <el-table-column label="原数量" width="90" align="right"><template #default="{row}">{{ row.oldQty }}</template></el-table-column>
          <el-table-column label="新型号（可改）" min-width="230">
            <template #default="{row}">
              <el-select v-model="row.newMaterialId" filterable style="width:100%">
                <el-option v-for="m in outMatOptions" :key="m.id" :label="outMatLabel(m)" :value="m.id" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="新数量" width="130">
            <template #default="{row}">
              <el-input-number v-model="row.qty" :min="0" :precision="4" :controls="false" style="width:100%" />
            </template>
          </el-table-column>
        </el-table>
        <div v-if="ocdlg.showBundle && ocdlg.receiptCandidates.length" style="margin-top:12px;background:#FDF6EC;border:1px solid #FAECD8;border-radius:6px;padding:10px 12px">
          <div style="color:#E6A23C;font-size:13px;margin-bottom:6px">新型号未到库或可用不足，可一并更正来源入库（等同重新入库）：</div>
          <el-checkbox v-if="ocdlg.bundle" v-model="ocdlg.bundle.enabled">一并更正当次入库</el-checkbox>
          <template v-if="ocdlg.bundle && ocdlg.bundle.enabled">
            <div style="font-size:13px;line-height:1.8">{{ ocdlg.bundle.reqNo }}　入库日 {{ ocdlg.bundle.arrivalDate }}　数量 {{ ocdlg.bundle.qty }}</div>
            <el-row :gutter="8" style="margin-top:6px">
              <el-col :span="10" :xs="24">
                <el-select v-model="ocdlg.bundle.materialId" filterable style="width:100%">
                  <el-option v-for="m in outMatOptions" :key="m.id" :label="outMatLabel(m)" :value="m.id" />
                </el-select>
              </el-col>
              <el-col :span="5" :xs="24">
                <el-input-number v-model="ocdlg.bundle.qty" :min="0" :precision="4" :controls="false" style="width:100%" />
              </el-col>
              <el-col :span="9" :xs="24">
                <el-date-picker v-model="ocdlg.bundle.arrivalDate" type="date" value-format="YYYY-MM-DD" style="width:100%" />
              </el-col>
            </el-row>
            <div style="margin-top:6px;font-size:13px;color:var(--text-2)">附带入库更正原因（必填，不得沿用主更正原因）</div>
            <el-input v-model="ocdlg.bundle.reason" placeholder="请单独填写该次入库更正原因" style="margin-top:4px" />
          </template>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="ocdlg.visible=false">取 消</el-button>
        <el-button type="primary" :loading="ocdlg.saving" @click="submitOutCorrect">确认更正</el-button>
      </template>
    </el-dialog>

    <el-dialog title="登记归还" v-model="rdlg.visible" width="640px">
      <div v-if="rdlg.rec" style="display:grid;grid-template-columns:1fr 1fr;row-gap:8px;column-gap:16px;font-size:13px;margin-bottom:14px">
        <div>出库编号：{{ rdlg.rec.outNo }}</div>
        <div>工程：{{ rdlg.rec.project }}</div>
        <div>原领取人：{{ rdlg.rec.receiver }}</div>
        <div>登记时间：{{ fmtTime(rdlg.rec.createdAt) }}</div>
      </div>
      <el-row :gutter="12" style="margin-bottom:10px">
        <el-col :span="12" :xs="24">
          <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">归还日期</div>
          <el-date-picker v-model="rdlg.returnDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" />
        </el-col>
        <el-col :span="12" :xs="24" v-if="rdlg.rec && rdlg.returnDate && rdlg.returnDate < rdlg.rec.outDate">
          <div style="font-size:13px;color:#F56C6C;margin-top:22px">归还日期不能早于出库日期（{{ rdlg.rec.outDate }}）</div>
        </el-col>
      </el-row>
      <el-table :data="rdlg.rows" size="small" border style="width:100%">
        <el-table-column prop="description" label="材料" min-width="180" />
        <el-table-column label="剩余未归还" width="120" align="right"><template #default="{row}">{{ fmt4(row.remaining) }}</template></el-table-column>
        <el-table-column label="本次归还" width="160">
          <template #default="{row}">
            <el-input-number v-model="row.qty" :min="0" :max="Number(row.remaining)" :precision="4" :controls="false" size="small" style="width:130px" />
          </template>
        </el-table-column>
      </el-table>
      <div v-if="rdlg.rec && rdlg.returnDate && rdlg.returnDate < oldLimit30()" style="margin-top:10px">
        <div style="font-size:13px;color:var(--text-2);margin-bottom:4px">归还日期早于 30 天，补录原因</div>
        <el-input v-model="rdlg.returnDateReason" placeholder="请说明补录原因" />
      </div>
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
            <td style="border:1px solid var(--line-strong);padding:8px 10px;font-size:13px">{{ fmtTime(pdlg.rec.createdAt) }}</td>
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
            <tr v-for="(it, i) in netRowsOf(pdlg.rec)" :key="i">
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
