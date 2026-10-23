/* 电网生产ERP（本地版）前端 — Vue3 + Element Plus（运行时编译，无需构建） */
const { createApp, ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } = Vue;

/* ---------------- API 助手 ---------------- */
const api = {
  async req(method, url, body) {
    const token = localStorage.getItem('erp_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { localStorage.removeItem('erp_token'); location.reload(); throw new Error('unauth'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || '请求失败');
      err.status = res.status;
      err.data = data; // 保留后端附加信息（如删除校验的引用清单 refs）
      throw err;
    }
    return data;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b); },
  put(u, b) { return this.req('PUT', u, b); },
  del(u) { return this.req('DELETE', u); },
  // 文件上传（multipart/form-data）
  async upload(u, fd) {
    const token = localStorage.getItem('erp_token');
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(u, { method: 'POST', headers, body: fd });
    if (res.status === 401) { localStorage.removeItem('erp_token'); location.reload(); throw new Error('unauth'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '上传失败');
    return data;
  }
};

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

/* ---------------- 当前用户权限（由 /api/me 填充；全局 mixin 暴露 canWrite） ---------------- */
const Auth = reactive({ loaded: false, isAdmin: false, group: '班组长', writeModules: [] });

/* ---------------- 通用 CRUD 视图（覆盖项目/计划/借工/竣工资料/用户/领料单/导入批次/出库） ---------------- */
const CrudView = {
  props: {
    config: { type: Object, required: true }
  },
  setup(props) {
    const list = ref([]);
    const loading = ref(false);
    const dialogVisible = ref(false);
    const editing = ref(false);
    const form = reactive({});
    const refOptions = reactive({});

    async function loadRefs() {
      if (props.config.refs) {
        for (const [field, cfg] of Object.entries(props.config.refs)) {
          try {
            const data = await api.get(cfg.endpoint);
            refOptions[field] = data.map(d => ({ label: d[cfg.label], value: d[cfg.value] }));
          } catch (e) { refOptions[field] = []; }
        }
      }
    }
    async function load() {
      loading.value = true;
      try { list.value = await api.get('/api/' + props.config.endpoint); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openAdd() {
      Object.keys(form).forEach(k => delete form[k]);
      props.config.formFields.forEach(f => { form[f.key] = f.default !== undefined ? f.default : (f.type === 'number' ? 0 : ''); });
      editing.value = false; dialogVisible.value = true;
    }
    function openEdit(row) {
      Object.keys(form).forEach(k => delete form[k]);
      props.config.formFields.forEach(f => { form[f.key] = row[f.key] ?? ''; });
      form._id = row.id; editing.value = true; dialogVisible.value = true;
    }
    async function submit() {
      try {
        if (editing.value) await api.put('/api/' + props.config.endpoint + '/' + form._id, form);
        else await api.post('/api/' + props.config.endpoint, form);
        ElementPlus.ElMessage.success('已保存');
        dialogVisible.value = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除该记录？', '提示', { type: 'warning' });
        await api.del('/api/' + props.config.endpoint + '/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function fieldOptions(key) { return refOptions[key] || []; }
    function cfgModule() {
      const e = props.config.endpoint;
      if (e === 'borrowWorks') return 'borrow';
      if (e === 'completionDocuments') return 'completion';
      return 'settings';
    }

    onMounted(() => { loadRefs(); load(); });

    return { list, loading, dialogVisible, editing, form, openAdd, openEdit, submit, remove, fieldOptions, tagType, cfgModule };
  },
  template: `
  <div>
    <div class="toolbar">
      <el-button v-if="canWrite(cfgModule())" type="primary" @click="openAdd">+ 新增</el-button>
      <span class="spacer"></span>
      <span style="color:var(--text-3);font-size:13px;">共 {{ list.length }} 条</span>
    </div>
    <el-table :data="list" v-loading="loading" border stripe style="width:100%">
      <el-table-column v-for="col in config.columns" :key="col.key" :prop="col.key" :label="col.label" :width="col.width">
        <template #default="{ row }">
          <el-tag v-if="col.tag" :type="tagType(row[col.key])">{{ row[col.key] }}</el-tag>
          <span v-else>{{ row[col.key] }}</span>
        </template>
      </el-table-column>
      <el-table-column v-if="canWrite(cfgModule())" label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="(editing ? '编辑' : '') + (config.dialogTitle || config.title)" v-model="dialogVisible" width="520px">
      <el-form :model="form" label-width="100px">
        <el-form-item v-for="f in config.formFields" :key="f.key" :label="f.label" :required="f.required">
          <el-select v-if="f.type==='select'" v-model="form[f.key]" placeholder="请选择" style="width:100%">
            <el-option v-for="o in f.options || fieldOptions(f.key)" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-input-number v-else-if="f.type==='number'" v-model="form[f.key]" :min="0" style="width:100%" />
          <el-input v-else-if="f.type==='textarea'" v-model="form[f.key]" type="textarea" :rows="3" />
          <el-input v-else v-model="form[f.key]" :placeholder="f.placeholder || ''" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>`
};

/* ---------------- 文档中心（对齐原系统截图 2026-10-12） ---------------- */
const DocumentsView = {
  setup() {
    const docs = reactive({ categories: [], files: [] });
    const docTab = ref('resources');
    const activeCat = ref('规范文件');
    const filePage = ref(1);
    const filePageSize = ref(20);
    const uploadInput = ref(null);
    const previewVisible = ref(false);
    const previewData = reactive({ kind: '', name: '', lines: [], sheets: [], message: '', url: '' });
    const previewPage = ref(1);
    // xlsx 预览：仅首个工作表，首行作表头，100 条/页
    const previewSheet = computed(() => (previewData.sheets && previewData.sheets[0]) || null);
    const previewHeader = computed(() => (previewSheet.value && previewSheet.value.rows[0]) || []);
    const previewRows = computed(() => (previewSheet.value && previewSheet.value.rows.slice(1)) || []);
    const previewPaged = computed(() => previewRows.value.slice((previewPage.value - 1) * 100, previewPage.value * 100));
    function fmtCell(v) { return (v === '' || v === null || v === undefined) ? '–' : v; }

    async function load() {
      try {
        const d = await api.get('/api/documents');
        docs.categories = d.categories || []; docs.files = d.files || [];
        if (!docs.categories.includes(activeCat.value)) activeCat.value = docs.categories[0] || '';
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    const catFiles = computed(() => docs.files.filter(f => f.category === activeCat.value));
    function catCount(c) { return docs.files.filter(f => f.category === c).length; }

    /* ---- 工作票自动化配置：配置状态 ---- */
    const wt = reactive({ loading: false, ready: false, versionLabel: 'v2', updatedAt: '', sha256: '', items: [], hazardCount: 0 });
    const wtHazardOpen = ref(false);
    const wtHazards = ref([]);
    // 企业危险点库：全量列表 + 搜索 + 分页 + 新增/编辑
    const hazLoading = ref(false);
    const hazSearch = ref('');
    const hazKeyword = ref('');
    const hazPage = ref(1);
    const hazPageSize = ref(10);
    const hazDlg = reactive({ visible: false, editing: false, busy: false, id: '', hazard: '', measure: '', sort: null });
    const hazView = reactive({ visible: false, hazard: '', measure: '' });
    const hazImportInput = ref(null);
    function openHazView(row) { Object.assign(hazView, { visible: true, hazard: row.hazard || '', measure: row.measure || '' }); }
    const hazFiltered = computed(() => {
      const k = hazKeyword.value.trim();
      if (!k) return wtHazards.value;
      return wtHazards.value.filter(h => (h.hazard || '').includes(k) || (h.measure || '').includes(k));
    });
    const hazPaged = computed(() => hazFiltered.value.slice((hazPage.value - 1) * hazPageSize.value, hazPage.value * hazPageSize.value));
    async function loadHazards() {
      hazLoading.value = true;
      try { wtHazards.value = await api.get('/api/workticket/hazards'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { hazLoading.value = false; }
    }
    function applyHazSearch() { hazKeyword.value = hazSearch.value; hazPage.value = 1; }
    function reloadHazards() { hazSearch.value = ''; hazKeyword.value = ''; hazPage.value = 1; loadHazards(); }
    function openHazAdd() {
      Object.assign(hazDlg, { visible: true, editing: false, busy: false, id: '', hazard: '', measure: '', sort: null });
    }
    function openHazEdit(row) {
      Object.assign(hazDlg, { visible: true, editing: true, busy: false, id: row.id, hazard: row.hazard || '', measure: row.measure || '', sort: row.sort ?? null });
    }
    async function submitHaz() {
      if (!hazDlg.hazard.trim()) { ElementPlus.ElMessage.warning('请填写危险点'); return; }
      if (!hazDlg.measure.trim()) { ElementPlus.ElMessage.warning('请填写控制措施'); return; }
      hazDlg.busy = true;
      try {
        const payload = { hazard: hazDlg.hazard.trim(), measure: hazDlg.measure.trim(), sort: hazDlg.sort };
        if (hazDlg.editing) await api.put('/api/documents/hazard/' + hazDlg.id, payload);
        else await api.post('/api/documents/hazard', payload);
        ElementPlus.ElMessage.success('已保存');
        hazDlg.visible = false;
        await loadHazards(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { hazDlg.busy = false; }
    }
    async function removeHaz(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除危险点「' + (row.hazard || '').slice(0, 20) + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/documents/hazard/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadHazards(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function triggerHazImport() { if (hazImportInput.value) hazImportInput.value.click(); }
    async function onHazImport(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/documents/hazard/import', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success('导入完成：新增 ' + data.added + ' 条，跳过 ' + data.skipped + ' 条');
        await loadHazards(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadWt() {
      wt.loading = true;
      try {
        const st = await api.get('/api/workticket/config-status');
        Object.assign(wt, st);
        if (wtHazardOpen.value) await loadHazards();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { wt.loading = false; }
    }
    /* ---- 资料库（作业内容匹配规则 / 技术措施 / 安全措施 / 医院联系方式 / 默认应急医院） ---- */
    const lib = reactive({ groups: [], categories: [], techOptions: [], safetyOptions: [] });
    /* 各分组可独立展开（互不影响） */
    const libOpen = reactive({ rules: false, tech: false, safety: false, hospitals: false, emergency: false });
    const rules = ref([]);
    const ruleDlg = reactive({ visible: false, editing: false, busy: false, id: '', workType: '', category: '', keywords: '', techId: '', techName: '', techIds: [], safetyId: '', safetyName: '', safetyIds: [] });
    const ruleImportInput = ref(null);
    const rulePreview = reactive({ visible: false, busy: false, rows: [], errors: [] });
    /* 施工技术 / 安全措施原文（同结构，kind = tech | safety） */
    const measures = reactive({ tech: [], safety: [] });
    /* 默认模板（载入默认 / 清除） */
    const defaultMea = reactive({ tech: 0, safety: 0, savedAt: '', busy: false });
    async function loadDefaultMeta() {
      try {
        const d = await api.get('/api/workticket/measures/default');
        defaultMea.tech = d.tech || 0; defaultMea.safety = d.safety || 0; defaultMea.savedAt = d.savedAt || '';
      } catch (e) { /* 忽略 */ }
    }
    // 清除：清空「施工技术措施原文」「施工安全措施原文」两个列表（默认配置保留，可用「载入默认」恢复）
    const cntOfGroup = key => { const g = (lib.groups || []).find(x => x.key === key); return g ? (g.count || 0) : 0; };
    async function clearAllMeasures() {
      const tN = cntOfGroup('tech'), sN = cntOfGroup('safety');
      if (!tN && !sN) { ElementPlus.ElMessage.info('当前没有可清除的措施原文'); return; }
      try {
        await ElementPlus.ElMessageBox.confirm(
          `确定清除「施工技术措施原文」与「施工安全措施原文」的全部内容（技术 ${tN} 条 / 安全 ${sN} 条）？清除后可通过「载入默认」重新载入。`,
          '清除措施原文', { type: 'warning', confirmButtonText: '确定清除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' });
      } catch (e) { return; }
      defaultMea.busy = true;
      try {
        const d = await api.post('/api/workticket/measures/clear-all');
        ElementPlus.ElMessage.success(`已清除：技术 ${d.clearedTech} 条 / 安全 ${d.clearedSafety} 条`);
        await loadMeasures('tech'); await loadMeasures('safety'); await loadLib(); await loadWt();
        meaPage.tech = 1; meaPage.safety = 1;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { defaultMea.busy = false; }
    }
    /* 措施原文分页：默认每页 10 条，可切换 10/20/50 */
    const MEA_PAGE_SIZE = 10;
    const meaPage = reactive({ tech: 1, safety: 1 });
    const meaPageSize = reactive({ tech: 10, safety: 10 });
    const meaTotal = kind => (measures[kind] || []).length;
    const meaPaged = kind => {
      const list = measures[kind] || [];
      const size = meaPageSize[kind] || MEA_PAGE_SIZE;
      const start = (meaPage[kind] - 1) * size;
      return list.slice(start, start + size);
    };
    function meaSetPageSize(kind, n) { meaPageSize[kind] = n; meaPage[kind] = 1; }
    watch(() => [measures.tech.length, measures.safety.length, meaPageSize.tech, meaPageSize.safety], () => {
      ['tech', 'safety'].forEach(k => {
        const size = meaPageSize[k] || MEA_PAGE_SIZE;
        const maxP = Math.max(1, Math.ceil((measures[k] || []).length / size));
        if (meaPage[k] > maxP) meaPage[k] = maxP;
      });
    });
    async function loadDefaultMeasures() {
      if (!defaultMea.tech && !defaultMea.safety) await loadDefaultMeta();
      if (!defaultMea.tech && !defaultMea.safety) { ElementPlus.ElMessage.warning('默认配置为空，无内容可载入'); return; }
      defaultMea.busy = true;
      try {
        const d = await api.post('/api/workticket/measures/default/load');
        const r = d.result || {};
        const t = r.tech || { added: 0, skipped: 0 }, s = r.safety || { added: 0, skipped: 0 };
        const added = (t.added || 0) + (s.added || 0);
        ElementPlus.ElMessage.success(added
          ? `已载入默认：技术新增 ${t.added} / 跳过 ${t.skipped}，安全新增 ${s.added} / 跳过 ${s.skipped}`
          : '默认内容已全部存在，无需载入');
        await loadMeasures('tech'); await loadMeasures('safety'); await loadLib(); await loadWt(); await loadDefaultMeta();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { defaultMea.busy = false; }
    }
    const meaDlg = reactive({ visible: false, editing: false, busy: false, kind: 'tech', id: '', sort: '', title: '', content: '' });
    /* 措施原文全文查看（二级页面） */
    const meaView = reactive({ visible: false, kind: 'tech', title: '', sort: '', content: '' });
    function openMeaView(kind, row) {
      Object.assign(meaView, {
        visible: true, kind,
        title: row.title || '',
        sort: row.sort === undefined || row.sort === null ? '' : String(row.sort),
        content: row.content || ''
      });
    }
    /* 措施原文解析：原文中的表格以「制表符 Tab」分列（Excel 粘贴即带 Tab），
       连续 ≥2 行且每行 ≥2 个非空单元格即识别为表格；散文里的 Tab 只是行首缩进（仅 1 个非空格），不会误判。 */
    const meaViewBlocks = computed(() => {
      const lines = String(meaView.content || '').split(/\r?\n/);
      const splitTab = line => {
        const raw = line.split('\t').map(s => s.trim());
        while (raw.length && raw[raw.length - 1] === '') raw.pop(); // 去掉行尾空列
        return raw;
      };
      const nonEmpty = cells => cells.filter(c => c !== '').length;
      // 值单元格：含数字且不含中文（"800" / "450/600" / "＜1" / "1.9（2.2）" 视为值；"120及以下" 不是）
      const valueLike = c => /[\d０-９]/.test(c) && !/[\u4e00-\u9fa5]/.test(c);
      const blocks = [];
      let textBuf = [];
      const flushText = () => {
        if (!textBuf.length) return;
        const t = textBuf.join('\n');
        if (t.trim()) blocks.push({ type: 'text', text: t });
        textBuf = [];
      };
      let i = 0;
      while (i < lines.length) {
        if (nonEmpty(splitTab(lines[i])) < 2) { textBuf.push(lines[i]); i++; continue; }
        // 收集连续的可表格化行
        let j = i;
        const rows = [];
        while (j < lines.length) {
          const c = splitTab(lines[j]);
          if (nonEmpty(c) < 2) break;
          rows.push(c); j++;
        }
        if (rows.length >= 2) {
          flushText();
          const cols = Math.max(...rows.map(r => r.length));
          const grid = rows.map(r => { const c = r.slice(); while (c.length < cols) c.push(''); return c; });
          // 首行全为文字、且后续行含数值 → 视作表头
          const header = !grid[0].some(valueLike) && grid.slice(1).some(r => r.some(valueLike));
          blocks.push({ type: 'table', header, cols, headCells: rows[0].slice(), rows: grid });
          i = j;
        } else {
          textBuf.push(lines[i]); i++;
        }
      }
      flushText();
      return blocks;
    });
    const measureLabel = kind => (kind === 'safety' ? '施工安全措施原文' : '施工技术措施原文');
    /* 医院联系方式 */
    const hospitals = ref([]);
    const hosDlg = reactive({ visible: false, editing: false, busy: false, id: '', area: '', name: '', address: '', phone: '' });
    /* 默认应急医院（单条配置，失焦即保存） */
    const emergency = reactive({ name: '', phone: '', saving: false, pending: false });
    /* 通用导入预览（技术/安全措施原文、医院联系方式共用） */
    const impPreview = reactive({ visible: false, busy: false, kind: '', rows: [], errors: [] });
    const impInput = ref(null);

    async function loadLib() {
      try {
        const d = await api.get('/api/workticket/library');
        lib.groups = d.groups || []; lib.categories = d.categories || [];
        lib.techOptions = d.techOptions || []; lib.safetyOptions = d.safetyOptions || [];
        const em = d.emergency || {};
        emergency.name = em.name || ''; emergency.phone = em.phone || '';
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadRules() {
      try { rules.value = await api.get('/api/workticket/rules'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadMeasures(kind) {
      try { measures[kind] = await api.get('/api/workticket/measures/' + kind); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadHospitals() {
      try { hospitals.value = await api.get('/api/workticket/hospitals'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function toggleLib(key) {
      libOpen[key] = !libOpen[key];
      if (!libOpen[key]) return;
      if (key === 'rules') await loadRules();
      else if (key === 'tech' || key === 'safety') await loadMeasures(key);
      else if (key === 'hospitals') await loadHospitals();
    }
    /* ---- 施工技术 / 安全措施原文 ---- */
    function openMeaAdd(kind) {
      Object.assign(meaDlg, { visible: true, editing: false, busy: false, kind, id: '', sort: '', title: '', content: '' });
    }
    function openMeaEdit(kind, row) {
      Object.assign(meaDlg, {
        visible: true, editing: true, busy: false, kind, id: row.id,
        sort: row.sort === undefined || row.sort === null ? '' : String(row.sort),
        title: row.title || '', content: row.content || ''
      });
    }
    // 措施原文输入框：按 Tab 插入制表符（避免跳焦点），便于手工录入「Tab 分列」的表格
    function meaInsertTab(e) {
      const el = e && e.target;
      if (!el || el.tagName !== 'TEXTAREA') return;
      const start = el.selectionStart, end = el.selectionEnd, val = el.value;
      el.value = val.slice(0, start) + '\t' + val.slice(end);
      el.selectionStart = el.selectionEnd = start + 1;
      el.dispatchEvent(new Event('input', { bubbles: true })); // 同步 v-model
    }
    async function submitMea() {
      if (!String(meaDlg.title || '').trim()) { ElementPlus.ElMessage.warning('请填写条文标题 / 关键字'); return; }
      if (!String(meaDlg.content || '').trim()) { ElementPlus.ElMessage.warning('请填写措施原文'); return; }
      meaDlg.busy = true;
      try {
        const payload = { sort: String(meaDlg.sort || '').trim(), title: meaDlg.title, content: meaDlg.content };
        if (meaDlg.editing) await api.put('/api/workticket/measures/' + meaDlg.kind + '/' + meaDlg.id, payload);
        else await api.post('/api/workticket/measures/' + meaDlg.kind, payload);
        ElementPlus.ElMessage.success('已保存');
        meaDlg.visible = false;
        await loadMeasures(meaDlg.kind); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { meaDlg.busy = false; }
    }
    async function removeMea(kind, row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除「' + (row.title || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/workticket/measures/' + kind + '/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadMeasures(kind); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    /* ---- 医院联系方式 ---- */
    function openHosAdd() {
      Object.assign(hosDlg, { visible: true, editing: false, busy: false, id: '', area: '', name: '', address: '', phone: '' });
    }
    function openHosEdit(row) {
      Object.assign(hosDlg, {
        visible: true, editing: true, busy: false, id: row.id,
        area: row.area || '', name: row.name || '', address: row.address || '', phone: row.phone || ''
      });
    }
    async function submitHos() {
      if (!hosDlg.area.trim()) { ElementPlus.ElMessage.warning('请填写作业地址匹配词'); return; }
      if (!hosDlg.name.trim()) { ElementPlus.ElMessage.warning('请填写医院名称'); return; }
      if (!hosDlg.address.trim()) { ElementPlus.ElMessage.warning('请填写医院地址'); return; }
      if (!hosDlg.phone.trim()) { ElementPlus.ElMessage.warning('请填写联系电话'); return; }
      hosDlg.busy = true;
      try {
        const payload = { area: hosDlg.area, name: hosDlg.name, address: hosDlg.address, phone: hosDlg.phone };
        if (hosDlg.editing) await api.put('/api/workticket/hospitals/' + hosDlg.id, payload);
        else await api.post('/api/workticket/hospitals', payload);
        ElementPlus.ElMessage.success('已保存');
        hosDlg.visible = false;
        await loadHospitals(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { hosDlg.busy = false; }
    }
    async function removeHos(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除「' + (row.name || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/workticket/hospitals/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadHospitals(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function saveEmergency() {
      // 连续切换输入框时逐个排队，避免前一次保存未返回而丢失后一次输入
      if (emergency.saving) { emergency.pending = true; return; }
      emergency.saving = true;
      let ok = false;
      do {
        emergency.pending = false;
        try {
          await api.put('/api/workticket/emergency-hospital', { name: emergency.name, phone: emergency.phone });
          ok = true;
        } catch (e) { ElementPlus.ElMessage.error(e.message); break; }
      } while (emergency.pending);
      emergency.saving = false;
      if (ok) ElementPlus.ElMessage.success('已保存');
    }

    /* ---- 通用导入预览（措施原文 / 医院联系方式） ---- */
    function triggerImp(kind) {
      impPreview.kind = kind;
      if (impInput.value) impInput.value.click();
    }
    function impUrl(kind, tail) {
      return kind === 'hospitals' ? '/api/workticket/hospitals/' + tail : '/api/workticket/measures/' + kind + '/' + tail;
    }
    async function onImp(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch(impUrl(impPreview.kind, 'import-preview'), {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '解析失败');
        impPreview.rows = data.rows || []; impPreview.errors = data.errors || [];
        impPreview.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function confirmImp() {
      if (!impPreview.rows.length) { ElementPlus.ElMessage.warning('没有可导入的数据'); return; }
      impPreview.busy = true;
      try {
        const r = await api.post(impUrl(impPreview.kind, 'import'), { rows: impPreview.rows });
        ElementPlus.ElMessage.success('已导入 ' + (r.added || 0) + ' 条');
        impPreview.visible = false;
        const kind = impPreview.kind;
        if (kind === 'hospitals') await loadHospitals(); else await loadMeasures(kind);
        await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { impPreview.busy = false; }
    }

    // 规则里「关联措施」用多选：id ↔ 名称互转（兼容历史单值/分号拼接数据）
    function ruleOptions(kind) { return (kind === 'tech' ? lib.techOptions : lib.safetyOptions) || []; }
    function ruleIdsOfKind(kind, row) {
      const opts = ruleOptions(kind);
      const idStr = kind === 'tech' ? (row.techId || '') : (row.safetyId || '');
      const nameStr = kind === 'tech' ? (row.techName || '') : (row.safetyName || '');
      let ids = String(idStr).split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
      const names = String(nameStr).split(/[；;]/).map(s => s.trim()).filter(Boolean);
      if (!ids.length || ids.length !== names.length) {
        ids = names.map(n => { const o = opts.find(x => x.name === n); return o ? o.id : ''; }).filter(Boolean);
      }
      return ids;
    }
    function ruleNamesOfKind(kind, ids) {
      const opts = ruleOptions(kind);
      return (ids || []).map(id => { const o = opts.find(x => x.id === id); return o ? o.name : ''; }).filter(Boolean);
    }
    function openRuleAdd() {
      Object.assign(ruleDlg, { visible: true, editing: false, busy: false, id: '', workType: '', category: '', keywords: '', techId: '', techName: '', techIds: [], safetyId: '', safetyName: '', safetyIds: [] });
    }
    function openRuleEdit(row) {
      Object.assign(ruleDlg, {
        visible: true, editing: true, busy: false, id: row.id,
        workType: row.workType || '', category: row.category || '',
        keywords: row.keywordsRaw || (row.keywords || []).join('、'),
        techId: row.techId || '', techName: row.techName || '',
        techIds: ruleIdsOfKind('tech', row),
        safetyId: row.safetyId || '', safetyName: row.safetyName || '',
        safetyIds: ruleIdsOfKind('safety', row)
      });
    }
    async function submitRule() {
      if (!ruleDlg.workType.trim()) { ElementPlus.ElMessage.warning('请填写作业类型名称'); return; }
      if (!ruleDlg.category && !ruleDlg.keywords.trim()) { ElementPlus.ElMessage.warning('请选择匹配类别或填写自定义匹配词'); return; }
      ruleDlg.busy = true;
      try {
        const techNames = ruleNamesOfKind('tech', ruleDlg.techIds);
        const safetyNames = ruleNamesOfKind('safety', ruleDlg.safetyIds);
        const payload = {
          workType: ruleDlg.workType.trim(), category: ruleDlg.category || '',
          keywords: ruleDlg.keywords.trim(),
          techId: (ruleDlg.techIds || []).join(','), techName: techNames.join('；'),
          safetyId: (ruleDlg.safetyIds || []).join(','), safetyName: safetyNames.join('；')
        };
        if (ruleDlg.editing) await api.put('/api/workticket/rules/' + ruleDlg.id, payload);
        else await api.post('/api/workticket/rules', payload);
        ElementPlus.ElMessage.success('已保存');
        ruleDlg.visible = false;
        await loadRules(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { ruleDlg.busy = false; }
    }
    async function removeRule(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除规则「' + (row.workType || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/workticket/rules/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadRules(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function triggerRuleImport() { if (ruleImportInput.value) ruleImportInput.value.click(); }
    async function onRuleImport(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/workticket/rules/import-preview', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '解析失败');
        rulePreview.rows = data.rows || []; rulePreview.errors = data.errors || [];
        rulePreview.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function confirmRuleImport() {
      if (!rulePreview.rows.length) { ElementPlus.ElMessage.warning('没有可导入的数据'); return; }
      rulePreview.busy = true;
      try {
        const r = await api.post('/api/workticket/rules/import', { rows: rulePreview.rows });
        ElementPlus.ElMessage.success('已导入 ' + (r.added || 0) + ' 条');
        rulePreview.visible = false;
        await loadRules(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { rulePreview.busy = false; }
    }
    async function toggleWtHazards() {
      wtHazardOpen.value = !wtHazardOpen.value;
      if (wtHazardOpen.value) await loadHazards();
    }
    watch(docTab, v => { if (v === 'automation') loadWt(); });
    const pagedFiles = computed(() => catFiles.value.slice((filePage.value - 1) * filePageSize.value, filePage.value * filePageSize.value));
    /* ---- 文件上传 / 下载 / 预览 / 删除 / 移动 ---- */
    function triggerUpload() { if (uploadInput.value) uploadInput.value.click(); }
    async function onUpload(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { ElementPlus.ElMessage.error('单文件不超过 20MB'); return; }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', activeCat.value);
      try {
        const res = await fetch('/api/documents/files', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '上传失败');
        load();
        const hi = data.hazardImport;
        if (hi && hi.error) {
          ElementPlus.ElMessage.warning('上传成功，但危险点解析失败：' + hi.error);
        } else if (hi && hi.unsupported) {
          ElementPlus.ElMessage.success('上传成功（非 Excel/CSV 文件，未解析入库）');
        } else if (hi) {
          ElementPlus.ElMessage.success(`上传成功，已解析入危险点库：新增 ${hi.added} 条，跳过 ${hi.skipped} 条`);
          loadHazards(); loadWt();
        } else {
          ElementPlus.ElMessage.success('上传成功');
        }
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function download(f) {
      fetch('/api/documents/files/' + f.id + '/download', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }
      })
        .then(r => { if (!r.ok) throw new Error('下载失败'); return r.blob(); })
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = f.name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        })
        .catch(e => ElementPlus.ElMessage.error(e.message));
    }
    async function preview(f) {
      try {
        const d = await api.get('/api/documents/files/' + f.id + '/preview');
        Object.assign(previewData, { kind: d.kind, name: d.name, lines: d.lines || [], sheets: d.sheets || [], message: d.message || '', url: d.url || '' });
        previewPage.value = 1;
        previewVisible.value = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function printPreview() {
      const p = previewData;
      let bodyHtml = '';
      if (p.kind === 'docx') {
        bodyHtml = p.lines.map(l => `<p style="margin:4px 0;white-space:pre-wrap">${l.replace(/</g, '&lt;')}</p>`).join('');
      } else if (p.kind === 'xlsx') {
        const s = p.sheets[0];
        if (s && s.rows.length) {
          const header = s.rows[0];
          const body = s.rows.slice(1);
          bodyHtml = `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:12px"><thead><tr>${header.map(c => `<th>${String(c ?? '').replace(/</g, '&lt;')}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${header.map((_, ci) => `<td>${String(r[ci] ?? '').replace(/</g, '&lt;') || '–'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        }
      } else {
        bodyHtml = `<p>${(p.message || '').replace(/</g, '&lt;')}</p>`;
      }
      const w = window.open('', '_blank');
      if (!w) { ElementPlus.ElMessage.error('浏览器拦截了打印窗口'); return; }
      w.document.write(`<html><head><meta charset="utf-8"><title>${p.name}</title></head><body style="font-family:SimSun,serif;padding:24px"><h2 style="text-align:center">${p.name}</h2>${bodyHtml}</body></html>`);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    }
    async function removeFile(f) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认删除「${f.name}」？`, '提示', { type: 'warning' });
        await api.del('/api/documents/files/' + f.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    async function moveFile(f, cat) {
      try {
        const data = await api.put('/api/documents/files/' + f.id, { category: cat });
        const hi = data && data.hazardImport;
        if (hi && hi.error) {
          ElementPlus.ElMessage.warning(`已移动到「${cat}」，但危险点解析失败：${hi.error}`);
        } else if (hi && hi.unsupported) {
          ElementPlus.ElMessage.success(`已移动到「${cat}」（非 Excel/CSV 文件，未解析入库）`);
        } else if (hi) {
          ElementPlus.ElMessage.success(`已移动到「${cat}」，已解析入危险点库：新增 ${hi.added} 条，跳过 ${hi.skipped} 条`);
        } else {
          ElementPlus.ElMessage.success(`已移动到「${cat}」`);
        }
        load();
        if (cat === '危险点') { loadHazards(); loadWt(); }
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    onMounted(() => { load(); loadWt(); loadLib(); loadDefaultMeta(); });
    return {
      docs, docTab, activeCat, catCount,
      wt, wtHazardOpen, wtHazards, loadWt, toggleWtHazards,
      lib, libOpen, rules, ruleDlg, ruleImportInput, rulePreview,
      loadLib, loadRules, toggleLib, openRuleAdd, openRuleEdit, submitRule, removeRule,
      measures, meaDlg, measureLabel, openMeaAdd, openMeaEdit, submitMea, removeMea, meaView, openMeaView, meaViewBlocks, meaInsertTab,
      defaultMea, loadDefaultMeta, clearAllMeasures, loadDefaultMeasures,
      meaPaged, meaTotal, meaPage, meaPageSize, meaSetPageSize, MEA_PAGE_SIZE,
      hospitals, hosDlg, openHosAdd, openHosEdit, submitHos, removeHos,
      emergency, saveEmergency,
      impPreview, impInput, triggerImp, onImp, confirmImp,
      triggerRuleImport, onRuleImport, confirmRuleImport,
      hazLoading, hazSearch, hazPage, hazPageSize, hazFiltered, hazPaged, hazDlg, hazView, hazImportInput,
      loadHazards, applyHazSearch, reloadHazards, openHazAdd, openHazEdit, submitHaz, removeHaz, openHazView,
      triggerHazImport, onHazImport,
      filePage, filePageSize, catFiles, pagedFiles,
      uploadInput, previewVisible, previewData,
      previewPage, previewSheet, previewHeader, previewRows, previewPaged, fmtCell,
      load, triggerUpload, onUpload, download, preview, printPreview,
      removeFile, moveFile
    };
  },
  template: `
  <div>
    <div class="doc-card">
      <div class="doc-title">文档中心</div>
      <el-tabs v-model="docTab" class="doc-tabs">
        <el-tab-pane label="文档资源" name="resources">
          <div class="doc-hint">支持上传任意文件，单文件不超过 20MB。xlsx、xls、docx 可预览，PDF 可在浏览器中打开。</div>
          <div v-if="activeCat === '危险点'" class="doc-hint" style="color:var(--brand)">
            上传到此分类的 Excel / CSV 会自动解析入「企业危险点库」：首个工作表 A 列为危险点、C 列为控制措施，相同条目自动跳过；也可把已有文件「移动到」本分类触发解析。
          </div>

          <el-tabs v-model="activeCat" class="doc-cats">
            <el-tab-pane v-for="c in docs.categories" :key="c" :label="c + ' (' + catCount(c) + ')'" :name="c" />
          </el-tabs>

          <div class="doc-upload">
            <el-button v-if="canWrite('documents')" type="primary" @click="triggerUpload">上传文件到「{{ activeCat }}」</el-button>
            <input ref="uploadInput" type="file" style="display:none" @change="onUpload" />
          </div>

          <el-table class="flat-table doc-file-table" :data="pagedFiles" empty-text="暂无数据" style="width:100%">
            <el-table-column label="文件名" min-width="260" show-overflow-tooltip>
              <template #default="{row}"><span class="doc-fname">{{ row.name }}</span></template>
            </el-table-column>
            <el-table-column prop="uploader" label="上传人" width="110">
              <template #default="{row}"><span class="doc-meta">{{ row.uploader }}</span></template>
            </el-table-column>
            <el-table-column prop="uploadedAt" label="上传时间" width="152">
              <template #default="{row}"><span class="doc-meta">{{ row.uploadedAt }}</span></template>
            </el-table-column>
            <el-table-column label="移动到" width="152">
              <template #default="{row}">
                <el-select class="doc-move" :model-value="row.category" size="small" :disabled="!!row.fixed || !canWrite('documents')" @change="v=>moveFile(row,v)">
                  <el-option v-for="c in docs.categories" :key="c" :label="c" :value="c" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="168">
              <template #default="{row}">
                <el-button link type="primary" size="small" @click="download(row)">下载</el-button>
                <el-button link type="primary" size="small" @click="preview(row)">预览</el-button>
                <el-tooltip v-if="row.fixed" content="固定系统文件不可删除" placement="top">
                  <el-button link type="info" size="small" disabled>删除</el-button>
                </el-tooltip>
                <el-button v-else-if="canWrite('documents')" link type="danger" size="small" @click="removeFile(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="doc-empty">
                <svg class="doc-empty-icon" viewBox="0 0 64 56" width="56" height="49" fill="none" aria-hidden="true"><path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/><circle cx="51.5" cy="11.5" r="7.5" fill="#fff" stroke="currentColor" stroke-width="1.6"/><circle cx="48" cy="11.5" r="1.1" fill="var(--text-3)"/><circle cx="51.5" cy="11.5" r="1.1" fill="var(--text-3)"/><circle cx="55" cy="11.5" r="1.1" fill="var(--text-3)"/></svg>
                <div class="doc-empty-text">暂无数据</div>
              </div>
            </template>
          </el-table>

          <div v-if="catFiles.length" class="doc-pager">
            <span style="color:var(--text-2);font-size:13px">共 {{ catFiles.length }} 条</span>
            <el-pagination background layout="prev, pager, next" :total="catFiles.length" :page-size="filePageSize" :current-page="filePage" @current-change="p=>filePage=p" />
            <el-select :model-value="filePageSize" size="small" style="width:104px" @change="n=>{filePageSize=n;filePage=1}">
              <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
            </el-select>
          </div>

        </el-tab-pane>

        <el-tab-pane label="工作票自动化配置" name="automation">
          <div class="wt-card" v-loading="wt.loading">
            <div class="wt-head">
              <span class="wt-title">配置状态</span>
              <span class="wt-state" :class="wt.ready ? 'ok' : 'pending'">{{ wt.ready ? '可用于工作票自动化' : '配置未完成' }}</span>
            </div>
            <div class="wt-grid">
              <div v-for="it in wt.items" :key="it.key" class="wt-item">
                <span class="wt-chip" :class="it.ready ? 'ok' : 'no'">{{ it.ready ? '已就绪' : '未配置' }}</span>
                <div class="wt-item-main">
                  <div class="wt-item-title">{{ it.title }}</div>
                  <div class="wt-item-sub">{{ it.desc }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 资料库 -->
          <div class="lib-card">
            <div class="lib-head">
              <span class="lib-title">资料库</span>
              <div class="lib-head-actions">
                <el-button v-if="canWrite('documents')" link type="danger" @click="clearAllMeasures">清除</el-button>
                <el-button v-if="canWrite('documents')" size="small" type="primary" :loading="defaultMea.busy" @click="loadDefaultMeasures">载入默认</el-button>
              </div>
            </div>

            <div class="lib-list">
              <div v-for="g in lib.groups" :key="g.key" class="lib-group">
                <div class="lib-group-head" @click="toggleLib(g.key)">
                  <span class="lib-group-title">{{ g.title }}<span v-if="g.showCount !== false" class="lib-count">（{{ g.count }}）</span></span>
                  <span class="lib-arrow" :class="{ open: libOpen[g.key] }"></span>
                </div>

                <div v-if="libOpen[g.key]" class="lib-group-body">
                  <!-- 作业内容匹配规则 -->
                  <template v-if="g.key === 'rules'">
                    <div class="lib-sub">
                      <div class="lib-sub-head">
                        <span class="lib-sub-title">作业内容匹配规则（{{ rules.length }}）</span>
                        <div class="lib-sub-actions">
                          <el-button v-if="canWrite('documents')" @click="triggerRuleImport">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:5px;vertical-align:-2px" aria-hidden="true">
                              <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                              <path d="M4 17v2.5h16V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                            </svg>导入预览
                          </el-button>
                          <el-button v-if="canWrite('documents')" @click="openRuleAdd">＋ 新增</el-button>
                          <input ref="ruleImportInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onRuleImport" />
                        </div>
                      </div>

                      <el-table class="flat-table" :data="rules" empty-text="暂无数据" style="width:100%">
                        <el-table-column prop="workType" label="作业类型" min-width="130" show-overflow-tooltip />
                        <el-table-column label="规则" min-width="170">
                          <template #default="{row}">
                            <span v-if="row.category" class="lib-cat">{{ row.category }}</span>
                            <span v-if="row.keywordsRaw">{{ row.keywordsRaw }}</span>
                            <span v-if="!row.category && !row.keywordsRaw">—</span>
                          </template>
                        </el-table-column>
                        <el-table-column label="施工技术措施" min-width="220">
                          <template #default="{row}"><span class="rule-names">{{ row.techName || '—' }}</span></template>
                        </el-table-column>
                        <el-table-column label="安全措施" min-width="220">
                          <template #default="{row}"><span class="rule-names">{{ row.safetyName || '—' }}</span></template>
                        </el-table-column>
                        <el-table-column label="操作" width="110">
                          <template #default="{row}">
                            <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openRuleEdit(row)">编辑</el-button>
                            <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeRule(row)">删除</el-button>
                          </template>
                        </el-table-column>
                        <template #empty>
                          <div class="doc-empty">
                            <svg class="doc-empty-icon" viewBox="0 0 64 56" width="52" height="45" fill="none" aria-hidden="true">
                              <path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                              <path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                            <div class="doc-empty-text">暂无数据</div>
                          </div>
                        </template>
                      </el-table>
                    </div>
                  </template>

                  <!-- 施工技术措施原文 / 施工安全措施原文 -->
                  <template v-else-if="g.key === 'tech' || g.key === 'safety'">
                    <div class="lib-sub">
                      <div class="lib-sub-head">
                        <span class="lib-sub-title">{{ measureLabel(g.key) }}（{{ (measures[g.key] || []).length }}）</span>
                        <div class="lib-sub-actions">
                          <el-button v-if="canWrite('documents')" @click="triggerImp(g.key)">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:5px;vertical-align:-2px" aria-hidden="true">
                              <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                              <path d="M4 17v2.5h16V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                            </svg>导入预览
                          </el-button>
                          <el-button v-if="canWrite('documents')" @click="openMeaAdd(g.key)">＋ 新增</el-button>
                        </div>
                      </div>

                      <el-table class="flat-table" :data="meaPaged(g.key)" empty-text="暂无数据" style="width:100%">
                        <el-table-column prop="sort" label="序号" width="90" />
                        <el-table-column prop="title" label="条文" min-width="200" show-overflow-tooltip />
                        <el-table-column label="措施原文预览" min-width="340">
                          <template #default="{row}">
                            <div class="mea-preview" :class="{ empty: !row.content }">{{ row.content || '—' }}</div>
                            <a v-if="row.content" class="mea-more" @click="openMeaView(g.key, row)">查看原文</a>
                          </template>
                        </el-table-column>
                        <el-table-column label="操作" width="110">
                          <template #default="{row}">
                            <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openMeaEdit(g.key, row)">编辑</el-button>
                            <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeMea(g.key, row)">删除</el-button>
                          </template>
                        </el-table-column>
                        <template #empty>
                          <div class="doc-empty">
                            <svg class="doc-empty-icon" viewBox="0 0 64 56" width="52" height="45" fill="none" aria-hidden="true">
                              <path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                              <path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                            <div class="doc-empty-text">暂无数据</div>
                          </div>
                        </template>
                      </el-table>
                      <div v-if="meaTotal(g.key)" class="mea-pager">
                        <span class="mea-total">共 {{ meaTotal(g.key) }} 条</span>
                        <el-pagination background layout="prev, pager, next"
                          :total="meaTotal(g.key)" :page-size="meaPageSize[g.key]" :current-page="meaPage[g.key]"
                          @current-change="p=>meaPage[g.key]=p" />
                        <el-select :model-value="meaPageSize[g.key]" size="small" style="width:104px" @change="n=>meaSetPageSize(g.key,n)">
                          <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
                        </el-select>
                      </div>
                    </div>
                  </template>

                  <!-- 医院联系方式 -->
                  <template v-else-if="g.key === 'hospitals'">
                    <div class="lib-sub">
                      <div class="lib-sub-head">
                        <span class="lib-sub-title">医院联系方式（{{ hospitals.length }}）</span>
                        <div class="lib-sub-actions">
                          <el-button v-if="canWrite('documents')" @click="triggerImp(g.key)">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:5px;vertical-align:-2px" aria-hidden="true">
                              <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                              <path d="M4 17v2.5h16V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                            </svg>导入预览
                          </el-button>
                          <el-button v-if="canWrite('documents')" @click="openHosAdd">＋ 新增</el-button>
                        </div>
                      </div>

                      <el-table class="flat-table" :data="hospitals" empty-text="暂无数据" style="width:100%">
                        <el-table-column prop="area" label="作业地址匹配词" min-width="160" show-overflow-tooltip />
                        <el-table-column prop="name" label="医院" min-width="150" show-overflow-tooltip />
                        <el-table-column prop="address" label="地址" min-width="240" show-overflow-tooltip />
                        <el-table-column prop="phone" label="电话" min-width="130" />
                        <el-table-column label="操作" width="110">
                          <template #default="{row}">
                            <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openHosEdit(row)">编辑</el-button>
                            <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeHos(row)">删除</el-button>
                          </template>
                        </el-table-column>
                        <template #empty>
                          <div class="doc-empty">
                            <svg class="doc-empty-icon" viewBox="0 0 64 56" width="52" height="45" fill="none" aria-hidden="true">
                              <path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                              <path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                            <div class="doc-empty-text">暂无数据</div>
                          </div>
                        </template>
                      </el-table>
                    </div>
                  </template>

                  <!-- 默认应急医院 -->
                  <template v-else-if="g.key === 'emergency'">
                    <div class="lib-emergency">
                      <el-input v-model="emergency.name" class="em-input" maxlength="100" placeholder="医院名称" :disabled="!canWrite('documents')"
                        @blur="saveEmergency" @keyup.enter="saveEmergency" />
                      <el-input v-model="emergency.phone" class="em-input" maxlength="50" placeholder="联系电话" :disabled="!canWrite('documents')"
                        @blur="saveEmergency" @keyup.enter="saveEmergency" />
                    </div>
                  </template>

                </div>
              </div>
            </div>
          </div>

          <div class="wt-collapse">
            <div class="wt-collapse-head" @click="toggleWtHazards()">
              <span class="wt-arrow" :class="{ open: wtHazardOpen }"></span>
              <span>企业危险点库（{{ wt.hazardCount }} 条）</span>
            </div>
            <div v-if="wtHazardOpen" class="wt-collapse-body">
              <div class="hz-hint">可直接新增、编辑、删除和排序。Excel 仅用于追加导入：首个工作表 A 列危险点、C 列控制措施，最多 1000 行、2MB；相同危险点和措施自动跳过。</div>

              <div class="hz-toolbar">
                <div class="hz-search">
                  <el-input v-model="hazSearch" placeholder="搜索危险点或措施" clearable
                    @keyup.enter="applyHazSearch" @clear="applyHazSearch" />
                  <el-button class="hz-icon-btn" title="搜索" @click="applyHazSearch">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                      <circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.8"/>
                      <path d="M15.6 15.6 20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </el-button>
                </div>
                <el-button @click="reloadHazards">重新读取</el-button>
                <el-button v-if="canWrite('documents')" type="primary" @click="openHazAdd">新增危险点</el-button>
                <el-button v-if="canWrite('documents')" @click="triggerHazImport">导入 Excel</el-button>
                <input ref="hazImportInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onHazImport" />
              </div>

              <el-table class="flat-table" :data="hazPaged" v-loading="hazLoading" empty-text="暂无数据" style="width:100%">
                <el-table-column prop="sort" label="排序" width="72" align="center" />
                <el-table-column prop="hazard" label="危险点" min-width="180">
                  <template #default="{row}">
                    <span class="hz-hazard">{{ row.hazard || '-' }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="measure" label="控制措施" min-width="400">
                  <template #default="{row}">
                    <div class="hz-measure" @click="openHazView(row)">{{ row.measure || '-' }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="168">
                  <template #default="{row}">
                    <el-button link type="primary" size="small" @click="openHazView(row)">查看</el-button>
                    <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openHazEdit(row)">编辑</el-button>
                    <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeHaz(row)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>

              <div class="hz-pager">
                <span class="hz-total">共 {{ hazFiltered.length }} 条</span>
                <el-pagination background layout="prev, pager, next" :total="hazFiltered.length"
                  :page-size="hazPageSize" :current-page="hazPage" @current-change="p=>hazPage=p" />
                <el-select :model-value="hazPageSize" size="small" style="width:104px" @change="n=>{hazPageSize=n;hazPage=1}">
                  <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
                </el-select>
              </div>
            </div>
          </div>

          <div class="wv-alert wt-alert">
            <span class="wv-alert-icon">i</span>
            <div class="wv-alert-main">
              <div class="wv-alert-text">工作票自动化配置独立于企业初始化。配置完成后，超级用户或资料员可使用自动化，材料员与班组长仅可查看。</div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 新增/编辑配置行（作业内容匹配规则） -->
    <el-dialog :title="ruleDlg.editing ? '编辑配置行' : '新增配置行'" v-model="ruleDlg.visible" width="620px" label-position="top">
      <el-form :model="ruleDlg" label-position="top">
        <el-form-item label="作业类型名称" required>
          <el-input v-model="ruleDlg.workType" maxlength="120" />
        </el-form-item>
        <el-form-item label="匹配类别">
          <el-select v-model="ruleDlg.category" clearable filterable style="width:100%"
            placeholder="选择固定活动类别；留空可设置自定义匹配词">
            <el-option v-for="c in lib.categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!ruleDlg.category" label="自定义匹配词（逗号或换行分隔）" required>
          <el-input v-model="ruleDlg.keywords" type="textarea" :rows="4" maxlength="2000" />
        </el-form-item>
        <el-form-item label="关联施工技术措施">
          <el-select v-model="ruleDlg.techIds" multiple filterable clearable style="width:100%" class="rule-measure-select" placeholder="选填，可多选">
            <el-option v-for="o in lib.techOptions" :key="o.id" :label="(o.sort ? o.sort + ' · ' : '') + o.name" :value="o.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联施工安全措施">
          <el-select v-model="ruleDlg.safetyIds" multiple filterable clearable style="width:100%" class="rule-measure-select" placeholder="选填，可多选">
            <el-option v-for="o in lib.safetyOptions" :key="o.id" :label="(o.sort ? o.sort + ' · ' : '') + o.name" :value="o.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="ruleDlg.busy" @click="submitRule">确定</el-button>
      </template>
    </el-dialog>

    <!-- 导入预览 -->
    <el-dialog title="导入预览" v-model="rulePreview.visible" width="900px" top="6vh">
      <div class="lib-preview-tip">共解析到 <b>{{ rulePreview.rows.length }}</b> 条（A 列作业类型、B 列自定义匹配词、C 列施工技术措施、D 列安全措施）。确认后追加导入，不会覆盖已有数据。</div>
      <div v-if="rulePreview.errors.length" class="lib-preview-err">
        <div v-for="(e, i) in rulePreview.errors.slice(0, 8)" :key="i">{{ e }}</div>
        <div v-if="rulePreview.errors.length > 8">……共 {{ rulePreview.errors.length }} 处问题</div>
      </div>
      <el-table :data="rulePreview.rows" border size="small" max-height="420" empty-text="没有可导入的数据">
        <el-table-column prop="workType" label="作业类型" min-width="160" show-overflow-tooltip />
        <el-table-column prop="keywordsRaw" label="自定义匹配词" min-width="220" show-overflow-tooltip />
        <el-table-column label="施工技术措施" min-width="180" show-overflow-tooltip><template #default="{row}">{{ row.techName || '—' }}</template></el-table-column>
        <el-table-column label="安全措施" min-width="180" show-overflow-tooltip><template #default="{row}">{{ row.safetyName || '—' }}</template></el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="rulePreview.visible=false">取消</el-button>
        <el-button type="primary" :loading="rulePreview.busy" :disabled="!rulePreview.rows.length" @click="confirmRuleImport">确认导入</el-button>
      </template>
    </el-dialog>

    <input ref="impInput" type="file" accept=".xlsx,.xls,.csv" data-imp="1" style="display:none" @change="onImp" />

    <!-- 新增/编辑配置行（施工技术 / 安全措施原文） -->
    <el-dialog :title="meaDlg.editing ? '编辑配置行' : '新增配置行'" v-model="meaDlg.visible" width="620px" label-position="top" class="cfg-row-dlg">
      <el-form :model="meaDlg" label-position="top">
        <el-form-item label="序号">
          <el-input v-model="meaDlg.sort" maxlength="9" />
        </el-form-item>
        <el-form-item label="条文标题 / 关键字" required>
          <el-input v-model="meaDlg.title" type="textarea" :rows="3" maxlength="200" />
        </el-form-item>
        <el-form-item label="措施原文" required>
          <div style="width:100%" @keydown.tab.prevent="meaInsertTab">
            <el-input v-model="meaDlg.content" type="textarea" :rows="8" maxlength="20000" show-word-limit />
          </div>
          <div class="mea-input-hint">
            表格请用 <b>Tab 键</b>分列（或直接从 Excel 复制粘贴）：<b>一行一条记录</b>、至少两行、每行不少于两列，即可在「查看原文」中显示为表格；第一行可作表头。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="meaDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="meaDlg.busy" @click="submitMea">确定</el-button>
      </template>
    </el-dialog>

    <!-- 措施原文全文（二级页面） -->
    <el-dialog :title="'措施原文 · ' + (meaView.title || '未命名条文')" v-model="meaView.visible" width="620px" top="8vh" class="mea-view-dlg">
      <div class="mea-view-body">
        <template v-for="(b, bi) in meaViewBlocks" :key="bi">
          <div v-if="b.type === 'text'" class="mea-view-text">{{ b.text }}</div>
          <div v-else class="mea-view-tablewrap">
            <table class="mea-view-table">
              <thead v-if="b.header">
                <tr>
                  <th v-for="(c, ci) in b.headCells" :key="ci" class="mea-cell-head"
                    :colspan="(ci === b.headCells.length - 1 && b.headCells.length < b.cols) ? (b.cols - b.headCells.length + 1) : 1">{{ c }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, ri) in (b.header ? b.rows.slice(1) : b.rows)" :key="ri">
                  <th scope="row" class="mea-cell-label" :class="{ 'is-blank': r[0] === '' }">{{ r[0] }}</th>
                  <td v-for="(c, ci) in r.slice(1)" :key="ci" class="mea-cell-num">{{ c }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </el-dialog>

    <!-- 新增/编辑配置行（医院联系方式） -->
    <el-dialog :title="hosDlg.editing ? '编辑配置行' : '新增配置行'" v-model="hosDlg.visible" width="620px" label-position="top" class="cfg-row-dlg">
      <el-form :model="hosDlg" label-position="top">
        <el-form-item label="作业地址匹配词" required>
          <el-input v-model="hosDlg.area" maxlength="200" />
        </el-form-item>
        <el-form-item label="医院名称" required>
          <el-input v-model="hosDlg.name" maxlength="100" />
        </el-form-item>
        <el-form-item label="医院地址" required>
          <el-input v-model="hosDlg.address" type="textarea" :rows="2" maxlength="300" />
        </el-form-item>
        <el-form-item label="联系电话" required>
          <el-input v-model="hosDlg.phone" maxlength="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hosDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="hosDlg.busy" @click="submitHos">确定</el-button>
      </template>
    </el-dialog>

    <!-- 导入预览（措施原文 / 医院联系方式） -->
    <el-dialog title="导入预览" v-model="impPreview.visible" width="900px" top="6vh">
      <div class="lib-preview-tip">
        共解析到 <b>{{ impPreview.rows.length }}</b> 条（
        <template v-if="impPreview.kind === 'hospitals'">A 列作业地址匹配词、B 列医院、C 列地址、D 列电话</template>
        <template v-else>A 列序号（可空）、B 列条文标题 / 关键字、C 列措施原文</template>
        ）。确认后追加导入，不会覆盖已有数据。
      </div>
      <div v-if="impPreview.errors.length" class="lib-preview-err">
        <div v-for="(e, i) in impPreview.errors.slice(0, 8)" :key="i">{{ e }}</div>
        <div v-if="impPreview.errors.length > 8">……共 {{ impPreview.errors.length }} 处问题</div>
      </div>
      <el-table :data="impPreview.rows" border size="small" max-height="420" empty-text="没有可导入的数据">
        <template v-if="impPreview.kind === 'hospitals'">
          <el-table-column prop="area" label="作业地址匹配词" min-width="150" show-overflow-tooltip />
          <el-table-column prop="name" label="医院" min-width="140" show-overflow-tooltip />
          <el-table-column prop="address" label="地址" min-width="200" show-overflow-tooltip />
          <el-table-column prop="phone" label="电话" min-width="120" />
        </template>
        <template v-else>
          <el-table-column prop="sort" label="序号" width="80" />
          <el-table-column prop="title" label="条文" min-width="180" show-overflow-tooltip />
          <el-table-column prop="content" label="措施原文" min-width="300" show-overflow-tooltip />
        </template>
      </el-table>
      <template #footer>
        <el-button @click="impPreview.visible=false">取消</el-button>
        <el-button type="primary" :loading="impPreview.busy" :disabled="!impPreview.rows.length" @click="confirmImp">确认导入</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑危险点 -->
    <el-dialog :title="hazDlg.editing ? '编辑危险点' : '新增危险点'" v-model="hazDlg.visible" width="640px" label-position="top">
      <el-form :model="hazDlg" label-position="top">
        <el-form-item label="危险点" required>
          <el-input v-model="hazDlg.hazard" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="如：双电源杆" />
        </el-form-item>
        <el-form-item label="控制措施" required>
          <el-input v-model="hazDlg.measure" type="textarea" :rows="6" maxlength="4000" show-word-limit placeholder="如：工作前确认同杆的双电源均已停电。" />
        </el-form-item>
        <el-form-item label="排序（小的在前；留空则排在末尾）">
          <el-input-number v-model="hazDlg.sort" :min="0" style="width:180px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hazDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="hazDlg.busy" @click="submitHaz">确定</el-button>
      </template>
    </el-dialog>

    <!-- 查看危险点全文 -->
    <el-dialog v-model="hazView.visible" title="危险点详情" width="720px" top="8vh">
      <div class="hz-view">
        <div class="hz-view-label">危险点</div>
        <div class="hz-view-hazard">{{ hazView.hazard || '-' }}</div>
        <div class="hz-view-label">控制措施</div>
        <div class="hz-view-measure">{{ hazView.measure || '-' }}</div>
      </div>
      <template #footer>
        <el-button @click="hazView.visible=false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 预览 -->
    <el-dialog :title="'预览 - ' + previewData.name" v-model="previewVisible" width="1080px" top="5vh">
      <div v-if="previewData.kind==='docx'" style="max-height:66vh;overflow:auto;font-family:SimSun,serif;font-size:14px;line-height:1.9;border:1px solid var(--line);padding:16px 24px;background:var(--surface)">
        <p v-for="(l,i) in previewData.lines" :key="i" style="margin:2px 0;white-space:pre-wrap">{{ l }}</p>
      </div>
      <div v-else-if="previewData.kind==='xlsx' && previewSheet" style="display:flex;flex-direction:column;max-height:70vh">
        <div style="flex:1 1 auto;min-height:0;overflow:auto">
          <el-table :data="previewPaged" border size="small" max-height="520">
            <el-table-column v-for="(c,ci) in previewHeader.length" :key="ci" :label="String(previewHeader[ci] || ('列' + (ci+1)))"
              :width="ci < 2 ? 170 : undefined" :min-width="ci < 2 ? undefined : 300">
              <template #default="{row}">{{ fmtCell(row[ci]) }}</template>
            </el-table-column>
          </el-table>
        </div>
        <div style="flex:0 0 auto;display:flex;justify-content:flex-end;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 2px 2px">
          <span style="color:var(--text-2);font-size:13px">共 {{ previewRows.length }} 条</span>
          <el-pagination background layout="prev, pager, next" :total="previewRows.length" :page-size="100" :current-page="previewPage" @current-change="p=>previewPage=p" />
          <span style="color:var(--text-2);font-size:13px">100 条/页</span>
        </div>
      </div>
      <div v-else-if="previewData.kind==='pdf'" style="text-align:center;padding:40px 0">
        <p style="color:var(--text-2);margin-bottom:14px">PDF 文件可在浏览器中直接打开</p>
        <el-button type="primary" @click="window.open(previewData.url,'_blank')">在浏览器中打开</el-button>
      </div>
      <div v-else style="text-align:center;padding:40px 0;color:var(--text-3)">{{ previewData.message || '该文件类型暂不支持预览' }}</div>
      <template #footer>
        <el-button @click="previewVisible=false">关闭</el-button>
        <el-button type="primary" @click="printPreview">打印</el-button>
      </template>
    </el-dialog>
  </div>`
};

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
      load, onSel, canSelect, openAdd, colFilters, tmpFilters, projectFilterOptions, unitOptions, sourceFilterOptions, statusFilterOptions, fActive, applyTmp, resetTmp, resetArr, openEdit, submit, remove, addStaging, showStaging, staging, stagingQty, mainTable, stagingVisible, stagingPage, stagingPageSize, stagingRows, stagedProjects, removeStaging, clearStaging, genRequisition, relDlg, relPaged, openRelated, relLoad, relItem, relHist, relStatusType, relDownload, relVoid, downloadTemplate, importMaterials, chipStyle, inOver, inRemain, fmtQty, fmt2, outMap, goOutbound };
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
                <div style="font-weight:600;margin-bottom:8px">材料明细</div>
                <el-table :data="[relItem(row)]" size="small" border>
                  <el-table-column prop="code" label="物料编码" width="130" />
                  <el-table-column prop="description" label="物料描述" min-width="180" />
                  <el-table-column label="领料数量" width="100" align="right"><template #default="{row}">{{ fmtQty(row.qty) }}</template></el-table-column>
                  <el-table-column label="已到数量" width="100" align="right"><template #default="{row}">{{ fmtQty(row.arrivedBefore) }}</template></el-table-column>
                  <el-table-column prop="unit" label="单位" width="70" />
                </el-table>
                <div style="font-weight:600;margin:12px 0 8px">入库记录（共 {{ relHist(row).length }} 次）</div>
                <el-table v-if="relHist(row).length" :data="relHist(row)" size="small" border>
                  <el-table-column prop="at" label="入库时间" width="170" />
                  <el-table-column label="本次入库数量" width="120" align="right"><template #default="{row}">{{ fmtQty(row.thisQty) }}</template></el-table-column>
                  <el-table-column label="入库情况" width="100"><template #default="{row}"><span :style="chipStyle(row.abnormal ? '#f56c6c' : '#389e0d')">{{ row.abnormal ? '异常' : '正常' }}</span></template></el-table-column>
                  <el-table-column prop="reason" label="异常原因"><template #default="{row}">{{ row.reason || '—' }}</template></el-table-column>
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

/* ---------------- 首页仪表盘 ---------------- */
const Dashboard = {
  setup() {
    const stats = reactive({ projects: 0, materials: 0, requisitions: 0, documents: 0, borrow: 0 });
    const me = ref({});
    async function load() {
      try {
        const [p, m, r, d, b] = await Promise.all([
          api.get('/api/projects'), api.get('/api/materials'), api.get('/api/materialRequisitions'),
          api.get('/api/documents'), api.get('/api/borrowWorks')
        ]);
        stats.projects = p.length; stats.materials = m.length; stats.requisitions = r.length;
        stats.documents = d.files.length; stats.borrow = b.length;
      } catch (e) {}
      try { me.value = (await api.get('/api/me')).user; } catch (e) {}
    }
    onMounted(load);
    return { stats, me };
  },
  template: `
  <div>
    <el-row :gutter="16">
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.projects }}</div><div class="label">在建/在管项目</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.materials }}</div><div class="label">物料明细条目</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.requisitions }}</div><div class="label">领料单</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.documents }}</div><div class="label">文档中心文件</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num">{{ stats.borrow }}</div><div class="label">借工记录</div></div></el-col>
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num" style="color:var(--ok-text)">在线</div><div class="label">当前用户：{{ me.name || me.username || '-' }}</div></div></el-col>
    </el-row>
  </div>`
};

/* ---------------- 全局设置（对齐真实系统截图：年度计划名称/属地供电所/班组管理/网站设置） ---------------- */
const annualPlanCfg = {
  endpoint: 'annualPlans', title: '年度计划名称', dialogTitle: '年度计划名称',
  columns: [ { key: 'name', label: '年度计划名称' }, { key: 'sort', label: '排序', width: 100 } ],
  formFields: [
    { key: 'name', label: '名称', required: true, placeholder: '如：2025年度配网工程' },
    { key: 'sort', label: '排序', type: 'number', default: 0 }
  ]
};
const substationCfg = {
  endpoint: 'substations', title: '属地供电所', dialogTitle: '属地供电所',
  columns: [ { key: 'name', label: '属地供电所' }, { key: 'sort', label: '排序', width: 100 } ],
  formFields: [
    { key: 'name', label: '名称', required: true, placeholder: '如：XX供电所' },
    { key: 'sort', label: '排序', type: 'number', default: 0 }
  ]
};
const teamCfg = {
  endpoint: 'teams', title: '班组管理', dialogTitle: '班组管理',
  columns: [
    { key: 'name', label: '班组名称' },
    { key: 'showOnDeploy', label: '当前部署展示', width: 140 },
    { key: 'inWorkerList', label: '是否列入作业人员名单', width: 190 },
    { key: 'sort', label: '排序', width: 90 }
  ],
  formFields: [
    { key: 'name', label: '班组名称', required: true, placeholder: '如：一班、机械施工' },
    { key: 'showOnDeploy', label: '当前部署展示', type: 'select', default: '展示', options: [{ label: '展示', value: '展示' }, { label: '隐藏', value: '隐藏' }] },
    { key: 'inWorkerList', label: '是否列入作业人员名单', type: 'select', default: '列入', options: [{ label: '列入', value: '列入' }, { label: '不列入', value: '不列入' }] },
    { key: 'sort', label: '排序', type: 'number', default: 0 }
  ]
};
const SettingsView = {
  setup() {
    const active = ref('annualPlans');
    const site = reactive({ companyName: '', icp: '', systemName: '', defaultSource: '甲供材料', allowSelfPurchase: true, loginBg: '', loginBgMode: 'cover', loginBgRotate: 0, welcome: { greeting: '', logoUrl: '' } });
    const savedName = ref('');
    async function loadSite() {
      try {
        const s = await api.get('/api/settings');
        Object.assign(site, s);
        if (!site.welcome) site.welcome = { greeting: '', logoUrl: '' };
        if (!site.loginBgMode) site.loginBgMode = 'cover';
        if (![0, 90, 180, 270].includes(Number(site.loginBgRotate))) site.loginBgRotate = 0;
        savedName.value = s.companyName || '';
        // 从初始化向导「在网站设置中编辑」跳转而来：自动切到「网站设置」标签页
        if (window.__pendingSettingsTab) { active.value = window.__pendingSettingsTab; window.__pendingSettingsTab = ''; }
        // 旧上传图若缺占位元数据，用浏览器补算并回填，消除首帧黑闪
        if (isLoginBgCustom(site.loginBg) && !site.loginBgMeta) {
          const m = await makeLqip(site.loginBg);
          if (m.lqip || m.avg) {
            try { const r = await api.put('/api/settings/login-bg/meta', m); site.loginBgMeta = r.meta; } catch (e) {}
          }
        }
      } catch (e) {}
    }
    async function saveSite() {
      try {
        await api.put('/api/settings', { companyName: site.companyName, icp: site.icp, systemName: site.systemName, defaultSource: site.defaultSource, allowSelfPurchase: site.allowSelfPurchase });
        savedName.value = site.companyName;
        ElementPlus.ElMessage.success('已保存企业名称');
        window.dispatchEvent(new CustomEvent('brand-changed')); // 顶部标题/企业名称实时刷新
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function saveWelcome() {
      try {
        await api.put('/api/settings', { welcome: { greeting: site.welcome.greeting, logoUrl: site.welcome.logoUrl } });
        ElementPlus.ElMessage.success('欢迎页已保存');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    // ---------- 登录界面：背景图（预设 + 本地上传 + 铺展方式） ----------
    const LOGIN_BG_PRESETS = [
      { key: 'valley', label: '草原雪山', desc: '高原草甸 · 远山雪线', url: '/login-bg/valley.jpg' },
      { key: 'ice', label: '冰川落日', desc: '冰原浮冰 · 暖阳天际', url: '/login-bg/ice.jpg' },
      { key: 'ridge', label: '层峦叠嶂', desc: '青蓝山峦 · 晨雾光影', url: '/login-bg/ridge.jpg' }
    ];
    // 铺展方式（对齐 Windows 壁纸的几种模式）
    const LOGIN_BG_MODES = [
      { key: 'cover', label: '填充', desc: '等比放大铺满，多余裁掉' },
      { key: 'contain', label: '适应', desc: '完整显示，留出边距' },
      { key: 'stretch', label: '拉伸', desc: '强制拉满，可能变形' },
      { key: 'tile', label: '平铺', desc: '按原尺寸重复铺排' },
      { key: 'center', label: '居中', desc: '原尺寸居中，不缩放' }
    ];
    // 旋转角度：手机/相机照片常带方向问题，可转正
    const LOGIN_BG_ROTATES = [
      { key: 0, label: '0°' }, { key: 90, label: '90°' }, { key: 180, label: '180°' }, { key: 270, label: '270°' }
    ];
    const bgSaving = ref(false);
    const bgUploading = ref(false);
    const bgDeleting = ref(false);
    // 设置页实时预览：跟随所选背景与铺展方式（旋转由 CSS 类控制）
    const previewStyle = computed(() => {
      const url = site.loginBg || '/login-bg/valley.jpg';
      const s = { backgroundImage: `url('${url}')`, backgroundColor: 'var(--surface-3)' };
      switch (site.loginBgMode) {
        case 'contain': s.backgroundSize = 'contain'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center'; break;
        case 'stretch': s.backgroundSize = '100% 100%'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center'; break;
        case 'tile': s.backgroundSize = 'auto'; s.backgroundRepeat = 'repeat'; s.backgroundPosition = 'top left'; break;
        case 'center': s.backgroundSize = 'auto'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center'; break;
        default: s.backgroundSize = 'cover'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center';
      }
      return s;
    });
    const previewRotClass = computed(() => 'rot-' + (Number(site.loginBgRotate) || 0));
    function rotateBy(delta) {
      const cur = Number(site.loginBgRotate) || 0;
      site.loginBgRotate = ((cur + delta) % 360 + 360) % 360;
    }
    async function saveLoginBg() {
      bgSaving.value = true;
      try {
        await api.put('/api/settings', { loginBg: site.loginBg, loginBgMode: site.loginBgMode, loginBgRotate: Number(site.loginBgRotate) || 0 });
        ElementPlus.ElMessage.success('登录页背景已保存');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { bgSaving.value = false; }
    }
    // 浏览器端生成 LQIP（24px 小图）与平均色，随上传一并提交，供首帧占位
    function makeLqip(src) {
      return new Promise((resolve) => {
        try {
          const isBlob = (typeof Blob !== 'undefined') && (src instanceof Blob);
          const url = isBlob ? URL.createObjectURL(src) : String(src);
          const revoke = () => { if (isBlob) { try { URL.revokeObjectURL(url); } catch (e) {} } };
          const img = new Image();
          img.onload = () => {
            const out = { lqip: '', avg: '' };
            try {
              const w = 24, h = Math.max(1, Math.round(24 * img.naturalHeight / img.naturalWidth));
              const c = document.createElement('canvas'); c.width = w; c.height = h;
              const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
              try { out.lqip = c.toDataURL('image/jpeg', 0.6); } catch (e) {}
              const d = ctx.getImageData(0, 0, w, h).data;
              let r = 0, g = 0, b = 0, n = 0;
              for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
              const hex = v => Math.max(0, Math.min(255, Math.round(v / n))).toString(16).padStart(2, '0');
              out.avg = '#' + hex(r) + hex(g) + hex(b);
            } catch (e) {}
            revoke();
            resolve(out);
          };
          img.onerror = () => { revoke(); resolve({ lqip: '', avg: '' }); };
          img.src = url;
        } catch (e) { resolve({ lqip: '', avg: '' }); }
      });
    }
    async function uploadLoginBg(opt) {
      const file = opt && opt.file;
      if (!file) return;
      if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(file.name)) { ElementPlus.ElMessage.error('仅支持 JPG / PNG / WebP / GIF 图片'); return; }
      if (file.size > 10 * 1024 * 1024) { ElementPlus.ElMessage.error('图片不超过 10MB'); return; }
      bgUploading.value = true;
      try {
        const meta = await makeLqip(file);
        const fd = new FormData();
        fd.append('file', file);
        if (meta.lqip) fd.append('lqip', meta.lqip);
        if (meta.avg) fd.append('avg', meta.avg);
        const r = await api.upload('/api/settings/login-bg', fd);
        site.loginBg = r.loginBg;
        ElementPlus.ElMessage.success('背景已上传并应用');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { bgUploading.value = false; }
    }
    async function deleteLoginBg() {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除已上传的背景图？将恢复为默认预设（千里江山）。', '提示', { type: 'warning' });
      } catch (e) { return; }
      bgDeleting.value = true;
      try {
        const r = await api.del('/api/settings/login-bg');
        site.loginBg = r.loginBg;
        site.loginBgMode = r.loginBgMode || 'cover';
        site.loginBgRotate = 0;
        ElementPlus.ElMessage.success('已删除自定义背景，恢复默认预设');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { bgDeleting.value = false; }
    }
    function isLoginBgPreset(url) { return LOGIN_BG_PRESETS.some(p => p.url === url); }
    function isLoginBgCustom(url) { return String(url || '').startsWith('/api/login-bg/'); }
    // ---------- 单位维护（分包/兄弟/监理/抄送 + 作业建管/实施单位） ----------
    const UNIT_TYPES = ['分包单位', '兄弟单位', '监理单位', '抄送单位'];
    const units = ref([]);
    const unitDlg = reactive({ visible: false, editingId: null, form: { type: '', name: '', sort: 0 } });
    async function loadUnits() {
      try {
        const r = await api.get('/api/units');
        units.value = (Array.isArray(r) ? r : (r.data || []));
      } catch (e) {}
    }
    function unitsOf(type) {
      return units.value.filter(u => u.type === type).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    }
    function openUnitAdd(type) { unitDlg.editingId = null; unitDlg.form = { type, name: '', sort: 0 }; unitDlg.visible = true; }
    function openUnitEdit(row) { unitDlg.editingId = row.id; unitDlg.form = { type: row.type, name: row.name, sort: row.sort ?? 0 }; unitDlg.visible = true; }
    async function submitUnit() {
      if (!unitDlg.form.type) { ElementPlus.ElMessage.warning('请选择单位类别'); return; }
      if (!String(unitDlg.form.name || '').trim()) { ElementPlus.ElMessage.warning('请填写单位名称'); return; }
      try {
        const body = { type: unitDlg.form.type, name: String(unitDlg.form.name).trim(), sort: Number(unitDlg.form.sort) || 0 };
        if (unitDlg.editingId) await api.put('/api/units/' + unitDlg.editingId, body);
        else await api.post('/api/units', body);
        ElementPlus.ElMessage.success('已保存');
        unitDlg.visible = false; loadUnits();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function removeUnit(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除单位「' + row.name + '」？如已被业务数据引用，请先确认影响范围。', '提示', { type: 'warning' });
        await api.del('/api/units/' + row.id);
        ElementPlus.ElMessage.success('已删除'); loadUnits();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    onMounted(() => { loadSite(); loadUnits(); });
    return { active, site, savedName, loadSite, saveSite, saveWelcome, annualPlanCfg, substationCfg, teamCfg, UNIT_TYPES, units, unitDlg, unitsOf, openUnitAdd, openUnitEdit, submitUnit, removeUnit, LOGIN_BG_PRESETS, LOGIN_BG_MODES, LOGIN_BG_ROTATES, bgSaving, bgUploading, bgDeleting, previewStyle, previewRotClass, rotateBy, saveLoginBg, uploadLoginBg, deleteLoginBg, isLoginBgPreset, isLoginBgCustom };
  },
  template: `
  <div>
    <el-tabs v-model="active">
      <el-tab-pane label="年度计划名称" name="annualPlans"><CrudView :config="annualPlanCfg" :key="annualPlanCfg.endpoint" /></el-tab-pane>
      <el-tab-pane label="属地供电所" name="substations"><CrudView :config="substationCfg" :key="substationCfg.endpoint" /></el-tab-pane>
      <el-tab-pane label="单位维护" name="units">
        <el-alert type="info" :closable="false" style="margin-bottom:16px">
          <template #title>引用说明</template>
          <div style="font-size:13px;line-height:1.9">周计划的分包单位、监理单位和抄送单位分别从对应类别选择：分包与监理默认排序第一条，抄送默认排序前两条。项目分包单位仅可从“分包（已方）单位”选择；借工管理仅使用“兄弟单位”。修改或删除已被业务数据引用的单位，请先确认影响范围。</div>
        </el-alert>
        <el-card v-for="t in UNIT_TYPES" :key="t" style="margin-bottom:16px">
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>{{ t === '分包单位' ? '分包（已方）单位' : t }}</b>
              <el-button v-if="canWrite('settings')" type="primary" size="small" @click="openUnitAdd(t)">新 增</el-button>
            </div>
          </template>
          <el-table :data="unitsOf(t)" size="small">
            <el-table-column prop="name" label="单位名称" min-width="260" />
            <el-table-column prop="sort" label="排序" width="110" />
            <el-table-column label="操作" width="150" align="center">
              <template #default="{row}">
                <el-button v-if="canWrite('settings')" link type="primary" size="small" @click="openUnitEdit(row)">编辑</el-button>
                <el-button v-if="canWrite('settings')" link type="danger" size="small" @click="removeUnit(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty><span style="color:var(--text-3);font-size:12px">暂无数据</span></template>
          </el-table>
        </el-card>

        <el-dialog v-model="unitDlg.visible" title="单位维护" width="min(520px, 92%)">
          <el-form label-position="top">
            <el-form-item label="单位类别" required>
              <el-select v-model="unitDlg.form.type" placeholder="请选择" style="width:100%">
                <el-option v-for="t in UNIT_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
            <el-form-item label="名称" required>
              <el-input v-model="unitDlg.form.name" placeholder="如：XX供电公司" />
            </el-form-item>
            <el-form-item label="排序">
              <el-input-number v-model="unitDlg.form.sort" :min="0" :controls="false" style="width:100%" />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="unitDlg.visible = false">取 消</el-button>
            <el-button type="primary" @click="submitUnit">确 定</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>
      <el-tab-pane label="班组管理" name="teams"><CrudView :config="teamCfg" :key="teamCfg.endpoint" /></el-tab-pane>
      <el-tab-pane label="登录界面" name="loginBg">
        <el-card>
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>登录页背景</b>
              <el-button size="small" @click="loadSite">重新读取</el-button>
            </div>
          </template>
          <div style="color:var(--text-2);font-size:13px;line-height:1.8;margin-bottom:14px">
            选择预设背景或上传本机图片，作为访客登录页的全屏背景。建议使用 1920×1080 及以上的横图，JPG / PNG / WebP / GIF，不超过 10MB。
          </div>

          <!-- 当前背景预览 + 铺展方式 -->
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px;align-items:flex-start">
            <div style="flex:0 1 auto;max-width:100%;min-width:0">
              <div style="font-size:13px;color:var(--text-2);margin-bottom:6px">实时预览</div>
              <div class="login-preview">
                <div class="login-preview-inner" :class="previewRotClass" :style="previewStyle"></div>
              </div>
            </div>
            <div style="flex:1 1 300px;min-width:260px">
              <div style="font-size:13px;color:var(--text-2);margin-bottom:6px">铺展方式（同 Windows 壁纸）</div>
              <el-radio-group v-model="site.loginBgMode" size="small" style="display:flex;flex-wrap:wrap;gap:8px">
                <el-radio-button v-for="m in LOGIN_BG_MODES" :key="m.key" :value="m.key" :label="m.key">{{ m.label }}</el-radio-button>
              </el-radio-group>
              <div style="margin-top:8px;font-size:12px;color:var(--text-3);line-height:1.7">
                {{ (LOGIN_BG_MODES.find(m => m.key === site.loginBgMode) || {}).desc || '' }}
              </div>
              <div style="margin-top:14px;font-size:13px;color:var(--text-2);margin-bottom:6px">旋转（照片方向不对时转正）</div>
              <el-radio-group v-model="site.loginBgRotate" size="small" style="display:flex;flex-wrap:wrap;gap:8px">
                <el-radio-button v-for="r in LOGIN_BG_ROTATES" :key="r.key" :value="r.key" :label="r.key">{{ r.label }}</el-radio-button>
              </el-radio-group>
              <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
                <el-button size="small" @click="rotateBy(-90)">逆时针 90°</el-button>
                <el-button size="small" @click="rotateBy(90)">顺时针 90°</el-button>
              </div>
            </div>
          </div>

          <!-- 预设 + 上传 -->
          <div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:18px">
            <div v-for="p in LOGIN_BG_PRESETS" :key="p.key"
                 style="width:186px;cursor:pointer"
                 @click="site.loginBg = p.url">
              <div :style="{
                     backgroundImage:'url(' + p.url + ')',
                     border: site.loginBg === p.url ? '2px solid #3370ff' : '1px solid var(--line)',
                     borderRadius:'4px', height:'104px', backgroundSize:'cover', backgroundPosition:'center'
                   }"></div>
              <div style="margin-top:6px;font-size:13px;color:var(--text-1);display:flex;justify-content:space-between;align-items:center">
                <span>{{ p.label }}</span>
                <el-tag v-if="site.loginBg === p.url" type="primary" size="small">使用中</el-tag>
              </div>
              <div style="font-size:12px;color:var(--text-3)">{{ p.desc }}</div>
            </div>
            <div style="width:186px">
              <div style="border:1px dashed var(--line-strong);border-radius:4px;height:104px;display:flex;align-items:center;justify-content:center;background:var(--surface-2)">
                <el-upload
                  :show-file-list="false"
                  accept=".jpg,.jpeg,.png,.webp,.gif,image/*"
                  :disabled="!canWrite('settings')"
                  :http-request="uploadLoginBg">
                  <el-button size="small" type="primary" plain :loading="bgUploading">上传本机图片</el-button>
                </el-upload>
              </div>
              <div style="margin-top:6px;font-size:12px;color:var(--text-3);line-height:1.6">
                自定义上传；上传后自动应用
              </div>
            </div>
          </div>

          <el-alert :type="isLoginBgCustom(site.loginBg) ? 'success' : 'info'" :closable="false" style="margin-bottom:16px">
            <template #title>当前背景</template>
            <div style="font-size:13px;line-height:1.9;word-break:break-all">
              地址：<span style="font-family:monospace">{{ site.loginBg || '（未设置）' }}</span>
              <span v-if="isLoginBgPreset(site.loginBg)" style="margin-left:8px;color:#3370ff">· 预设图</span>
              <span v-else-if="isLoginBgCustom(site.loginBg)" style="margin-left:8px;color:#00b42a">· 自定义上传</span>
            </div>
          </el-alert>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <el-button v-if="canWrite('settings')" type="primary" :loading="bgSaving" @click="saveLoginBg">保存背景设置</el-button>
            <el-button v-if="canWrite('settings')" type="danger" plain :loading="bgDeleting" :disabled="!isLoginBgCustom(site.loginBg)" @click="deleteLoginBg">删除自定义背景</el-button>
          </div>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="网站设置" name="site">
        <el-card style="margin-bottom:16px">
          <template #header><b>网站标题（最多 128 个字符）</b></template>
          <div style="color:var(--text-2);font-size:13px;line-height:1.8;margin-bottom:12px">这里保存的网站标题作为初始化的企业名称。其他标签的设置不会代替企业名称保存；填写后点击下方"保存"。</div>
          <el-alert v-if="savedName" type="success" :closable="false" style="margin-bottom:12px">
            <template #title>已保存企业名称：{{ savedName }}</template>
          </el-alert>
          <el-input v-model="site.companyName" :placeholder="savedName || '请输入企业名称'" maxlength="128" show-word-limit style="max-width:640px" />
          <div v-if="canWrite('settings')" style="margin-top:12px"><el-button type="primary" @click="saveSite">保存</el-button></div>
        </el-card>

        <el-card>
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>企业欢迎页</b>
              <el-button size="small" @click="loadSite">重新读取</el-button>
            </div>
          </template>
          <div style="color:var(--text-2);font-size:13px;line-height:1.8;margin-bottom:12px">设置访客登录前看到的企业介绍和 Logo。访客只会看到欢迎内容，不会看到企业内部资料。</div>
          <el-form label-position="top">
            <el-form-item label="欢迎语（最多 500 个字符）">
              <el-input v-model="site.welcome.greeting" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="欢迎来到我们的企业工作台" style="max-width:720px" />
            </el-form-item>
            <el-form-item label="企业 Logo 图片地址（最多 2048 个字符）">
              <el-input v-model="site.welcome.logoUrl" maxlength="2048" placeholder="https://... 或 /images/logo.png" style="max-width:720px" />
              <div style="color:var(--text-3);font-size:12px;margin-top:6px">建议使用 PNG、JPG、WebP。比例建议 1:1、推荐 512×512、最小建议 128×128，文件建议不超过 500KB。填写 https:// 图片地址或站内 / 图片路径；系统校验地址格式，不会读取或远程图片核验尺寸或文件大小。</div>
            </el-form-item>
            <el-button v-if="canWrite('settings')" type="primary" @click="saveWelcome">保存欢迎页</el-button>
          </el-form>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>`
};

/* ---------------- 首次使用初始化（前期检查：5 项基础设置） ---------------- */
const InitView = {
  setup() {
    const status = reactive({ initialized: false, companyName: '', workers: 0, workersWithTeam: 0 });
    const loading = ref(true);
    const finishing = ref(false);

    async function loadStatus() {
      try {
        const s = await api.get('/api/init-status');
        Object.assign(status, s);
      } catch (e) {}
      finally { loading.value = false; }
    }

    // 各项完成度：全部基于后端真实数据（外部通讯录不列入初始化必填项，可后续在「用户管理」补充）
    const doneMap = computed(() => ({
      company: !!status.companyName,
      workers: status.workersWithTeam > 0
    }));

    const steps = computed(() => {
      const d = doneMap.value;
      return [
        { key: 'company', title: '企业名称', target: 'settings',
          desc: '网站标题作为企业在页面显示的名称，点击下方按钮前往「全局设置 · 网站设置」填写。',
          statusText: d.company ? status.companyName : '尚未填写企业名称' },
        { key: 'workers', title: '班组与施工人员', target: 'workers',
          desc: '至少建立一个班组和一位已确认的施工人员。账号与施工人员分开维护。',
          statusText: d.workers ? '已建立班组和施工人员' : '请建立班组并添加施工人员' }
      ];
    });

    const doneCount = computed(() => Object.values(doneMap.value).filter(Boolean).length);
    const pct = computed(() => Math.round(doneCount.value / steps.value.length * 100));
    // 企业名称为必填项；其余为基础配置项，可在对应模块随时补充
    const canStart = computed(() => doneMap.value.company);

    function goTarget(t, tab) {
      if (t === 'settings') window.__pendingSettingsTab = 'site';
      if (t === 'users' && tab) window.__pendingUsersTab = tab;
      window.dispatchEvent(new CustomEvent('nav-to', { detail: t }));
    }
    async function finish() {
      if (!canStart.value) { ElementPlus.ElMessage.warning('请先填写并保存企业名称'); return; }
      finishing.value = true;
      try {
        await api.put('/api/settings', { initialized: true });
        ElementPlus.ElMessage.success('初始化完成，欢迎使用');
        // 刷新顶栏企业名/标题，并标记初始化完成（App 监听到后放行并进入用户中心）
        window.dispatchEvent(new CustomEvent('brand-changed'));
        window.dispatchEvent(new CustomEvent('init-done'));
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { finishing.value = false; }
    }

    // 从网站设置保存后返回向导时同步刷新完成情况
    function onBrandChanged() { loadStatus(); }
    onMounted(() => { loadStatus(); window.addEventListener('brand-changed', onBrandChanged); });
    onUnmounted(() => window.removeEventListener('brand-changed', onBrandChanged));
    return { status, loading, finishing, doneMap, doneCount, pct, canStart, steps, goTarget, finish };
  },
  template: `
  <div class="init-page">
    <div class="init-tabs"><span class="init-tab">前期检查</span></div>

    <div class="init-intro"><span class="dot"></span>首次使用请完成以下基础设置，完成后即可开始使用系统。</div>

    <div class="init-progress-row">
      <div class="init-progress"><div class="init-progress-inner" :style="{ width: pct + '%' }"></div></div>
      <span class="init-progress-num">{{ doneCount }}/{{ steps.length }}</span>
    </div>

    <div class="init-grid">
      <div v-for="s in steps" :key="s.key" class="init-block">
        <div class="init-block-head">
          <span class="init-block-title">{{ s.title }}</span>
          <span class="init-badge" :class="doneMap[s.key] ? 'done' : 'pending'">{{ doneMap[s.key] ? '已完成' : '待完成' }}</span>
        </div>
        <div class="init-block-desc">{{ s.desc }}</div>
        <div class="init-block-status" :class="{ pending: !doneMap[s.key] }">{{ s.statusText }}</div>

        <!-- 本页仅做引导：企业名称统一在「全局设置 · 网站设置」中填写与修改 -->
        <div class="init-block-actions">
          <el-button size="small" @click="goTarget(s.target, s.tab)">{{ doneMap[s.key] ? '查看或修改' : '去设置' }}</el-button>
        </div>
      </div>
    </div>

    <div class="init-footer">
      <span class="tip">企业名称为必填项；班组与施工人员可稍后补充，外部通讯录可在「用户管理」中随时维护。</span>
      <el-button type="primary" :loading="finishing" :disabled="!canStart" @click="finish">开始使用</el-button>
    </div>
  </div>`
};

/* 用户管理 — 标签页3：外部通讯录 */
/* 用户管理 — 外部通讯录（对齐截图：配置说明 + 新增/导入/导出 + 部门表） */
const ContactsPanel = {
  setup() {
    const list = ref([]);
    const loading = ref(false);
    const filters = reactive({ dept: '', name: '' });
    const dlg = reactive({ visible: false, editing: false, busy: false, id: '', dept: '', name: '', post: '', phone: '', shortNo: '' });
    const fileInput = ref(null);

    const filtered = computed(() => list.value.filter(c => {
      if (filters.dept && !(c.dept || c.unit || '').includes(filters.dept)) return false;
      if (filters.name && !(c.name || '').includes(filters.name)) return false;
      return true;
    }));
    function reset() { filters.dept = ''; filters.name = ''; }

    async function load() {
      loading.value = true;
      try { list.value = await api.get('/api/contacts'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openAdd() {
      Object.assign(dlg, { visible: true, editing: false, busy: false, id: '', dept: '', name: '', post: '', phone: '', shortNo: '' });
    }
    function openEdit(row) {
      Object.assign(dlg, {
        visible: true, editing: true, busy: false, id: row.id,
        dept: row.dept || row.unit || '', name: row.name || '', post: row.post || '',
        phone: row.phone || '', shortNo: row.shortNo || ''
      });
    }
    async function submit() {
      const name = (dlg.name || '').trim();
      if (!name) { ElementPlus.ElMessage.warning('请填写姓名'); return; }
      dlg.busy = true;
      try {
        const payload = {
          dept: (dlg.dept || '').trim(), name,
          post: (dlg.post || '').trim(), phone: (dlg.phone || '').trim(), shortNo: (dlg.shortNo || '').trim()
        };
        if (dlg.editing) await api.put('/api/contacts/' + dlg.id, payload);
        else await api.post('/api/contacts', payload);
        ElementPlus.ElMessage.success('已保存');
        dlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { dlg.busy = false; }
    }
    async function remove(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除联系人「' + row.name + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try { await api.del('/api/contacts/' + row.id); ElementPlus.ElMessage.success('已删除'); load(); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function triggerImport() { if (fileInput.value) fileInput.value.click(); }
    async function onFileChange(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/contacts/import', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
          body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success('导入完成：' + data.imported + ' 位联系人（覆盖原有 ' + (data.replaced || 0) + ' 条）');
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function doExport() {
      const token = localStorage.getItem('erp_token');
      fetch('/api/contacts/export', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => { if (!r.ok) throw new Error('导出失败'); return r.blob(); })
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = '外部通讯录.xlsx'; a.click();
        })
        .catch(e => ElementPlus.ElMessage.error(e.message));
    }
    function deptOf(row) { return row.dept || row.unit || '-'; }

    onMounted(load);
    return { list, loading, filters, filtered, reset, dlg, fileInput, openAdd, openEdit, submit, remove,
      triggerImport, onFileChange, doExport, deptOf };
  },
  template: `
  <div>
    <div class="wv-alert">
      <span class="wv-alert-icon">i</span>
      <div class="wv-alert-main">
        <div class="wv-alert-title">配置说明</div>
        <div class="wv-alert-text">外部通讯录用于维护工作票和施工资料中需要引用的联系人，与登录账号、作业人员名单分开维护。建议至少填写姓名和手机；系统会按姓名匹配联系方式。导入会覆盖现有数据，请先导出备份；导出文件可直接再次导入。</div>
      </div>
    </div>

    <div class="ct-toolbar">
      <el-button v-if="canWrite('users')" type="primary" size="small" @click="openAdd">新增</el-button>
      <el-button v-if="canWrite('users')" size="small" @click="triggerImport">导入</el-button>
      <span class="ct-hint">导入会覆盖现有外部通讯录；建议先导出备份。支持含「员工」sheet 的 xls/xlsx，新标准表头为部门、姓名、职务、手机、移动短号。</span>
      <el-button size="small" :disabled="!list.length" @click="doExport">导出</el-button>
      <input ref="fileInput" type="file" accept=".xls,.xlsx,.csv" style="display:none" @change="onFileChange" />
    </div>

    <div class="wv-filters">
      <el-input v-model="filters.dept" placeholder="按部门筛选" clearable style="width:180px" />
      <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:180px" />
      <el-button @click="reset">重置</el-button>
    </div>

    <el-table class="flat-table" :data="filtered" v-loading="loading" style="width:100%" empty-text="暂无数据">
      <el-table-column label="部门" min-width="200"><template #default="{row}">{{ deptOf(row) }}</template></el-table-column>
      <el-table-column prop="name" label="姓名" min-width="140" />
      <el-table-column prop="post" label="职务" min-width="160" />
      <el-table-column prop="phone" label="手机" min-width="160" />
      <el-table-column prop="shortNo" label="移动短号" min-width="140" />
      <el-table-column label="操作" width="150">
        <template #default="{row}">
          <el-button v-if="canWrite('users')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="canWrite('users')" link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="dlg.editing ? '编辑通讯录' : '新增通讯录'" v-model="dlg.visible" width="560px" label-position="top">
      <el-form :model="dlg" label-position="top">
        <el-form-item label="部门">
          <el-input v-model="dlg.dept" placeholder="如：公司领导、办公室" maxlength="60" />
        </el-form-item>
        <el-form-item label="姓名" required>
          <el-input v-model="dlg.name" placeholder="姓名" maxlength="40" />
        </el-form-item>
        <el-form-item label="职务">
          <el-input v-model="dlg.post" placeholder="选填" maxlength="40" />
        </el-form-item>
        <el-form-item label="手机">
          <el-input v-model="dlg.phone" placeholder="选填" maxlength="20" />
        </el-form-item>
        <el-form-item label="移动短号">
          <el-input v-model="dlg.shortNo" placeholder="选填" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="dlg.busy" @click="submit">确定</el-button>
      </template>
    </el-dialog>
  </div>`
};

/* 用户管理 — 标签页2：作业人员名单（对齐原系统截图） */
const WORKER_IDENTITY_OPTIONS = ['技工（计入高处作业人员）', '民工', '其他技工（不计入高处作业人员）'];
const WORKER_CERT_OPTIONS = ['高压电工', '低压电工', '高处', '电力电缆作业', '电气试验', '司索工', '吊车司机', '挖机操作工'];

const WorkersPanel = {
  // variant: 'page' = 独立二级页「作业人员与班组」（含卡片头与班组维护）
  //          'tab'  = 用户管理 → 作业人员名单标签（无卡片头、无班组区块，列含身份证号）
  props: { variant: { type: String, default: 'page' } },
  setup(props) {
    const isTab = computed(() => props.variant === 'tab');
    const list = ref([]);
    const teams = ref([]);
    const loading = ref(false);
    const filters = reactive({ name: '', identity: '', team: '' });
    const page = ref(1);
    const pageSize = 20;
    const dialogVisible = ref(false);
    const editing = ref(false);
    const form = reactive({ name: '', idNumber: '', phone: '', identity: '', team: '', certTypes: [], validRange: null });
    const fileInput = ref(null);
    // 班组维护（新增 / 编辑 / 删除）：班组即全局字典 teams，周计划选项对应 showOnDeploy
    const teamDlg = reactive({ visible: false, editing: false, busy: false, id: '', name: '', showOnDeploy: '展示', sort: 0, inWorkerList: '列入' });
    const sortedTeams = computed(() => [...teams.value].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)));
    function openTeamAdd() {
      Object.assign(teamDlg, { visible: true, editing: false, id: '', name: '', showOnDeploy: '展示', sort: sortedTeams.value.length, inWorkerList: '列入' });
    }
    function openTeamEdit(row) {
      Object.assign(teamDlg, {
        visible: true, editing: true, id: row.id, name: row.name || '',
        showOnDeploy: row.showOnDeploy || '展示', sort: Number(row.sort) || 0, inWorkerList: row.inWorkerList || '列入'
      });
    }
    async function saveTeam() {
      const name = (teamDlg.name || '').trim();
      if (!name) { ElementPlus.ElMessage.warning('请填写班组名称'); return; }
      teamDlg.busy = true;
      try {
        const payload = { name, showOnDeploy: teamDlg.showOnDeploy, inWorkerList: teamDlg.inWorkerList, sort: Number(teamDlg.sort) || 0 };
        if (teamDlg.editing) await api.put('/api/teams/' + teamDlg.id, payload);
        else await api.post('/api/teams', payload);
        ElementPlus.ElMessage.success('已保存');
        teamDlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { teamDlg.busy = false; }
    }
    async function removeTeam(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除班组「' + row.name + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/teams/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    // 「周计划选项」列：展示/隐藏 以「显示/隐藏」呈现（对齐截图口径）
    function weekOption(row) { return row.showOnDeploy === '隐藏' ? '隐藏' : '显示'; }

    async function load() {
      loading.value = true;
      try {
        list.value = await api.get('/api/workers');
        try { teams.value = await api.get('/api/teams'); } catch (e) { teams.value = []; }
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    const filtered = computed(() => list.value.filter(w => {
      if (filters.name && !(w.name || '').includes(filters.name)) return false;
      if (filters.identity && w.identity !== filters.identity) return false;
      if (filters.team && w.team !== filters.team) return false;
      return true;
    }));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize));
    function resetFilters() { filters.name = ''; filters.identity = ''; filters.team = ''; page.value = 1; }

    function fmtCN(d) {
      if (!d) return '';
      const [y, m, dd] = d.split('-');
      return `${y}年${m}月${dd}日`;
    }
    function fmtValid(row) {
      if (!row.validStart && !row.validEnd) return '-';
      return (fmtCN(row.validStart) || '?') + (row.validEnd ? ' - ' + fmtCN(row.validEnd) : '');
    }
    function fmtCerts(row) {
      return (row.certTypes && row.certTypes.length) ? row.certTypes.join('；') : '-';
    }

    function openAdd() {
      Object.assign(form, { name: '', idNumber: '', phone: '', identity: '', team: '', certTypes: [], validRange: null });
      editing.value = false; dialogVisible.value = true;
    }
    function openEdit(row) {
      Object.assign(form, {
        name: row.name || '', idNumber: row.idNumber || '', phone: row.phone || '',
        identity: row.identity || '', team: row.team || '',
        certTypes: [...(row.certTypes || [])],
        validRange: (row.validStart && row.validEnd) ? [row.validStart, row.validEnd] : null,
        _id: row.id
      });
      editing.value = true; dialogVisible.value = true;
    }
    function validate() {
      if (!form.name.trim()) { ElementPlus.ElMessage.error('请填写姓名'); return false; }
      if (form.idNumber && !/^\d{17}[\dXx]$/.test(form.idNumber)) { ElementPlus.ElMessage.error('身份证号需为18位数字，末位可为X'); return false; }
      if (form.phone && !/^1\d{10}$/.test(form.phone)) { ElementPlus.ElMessage.error('电话号码需为11位手机号'); return false; }
      return true;
    }
    async function submit() {
      if (!validate()) return;
      const payload = {
        name: form.name.trim(), idNumber: form.idNumber.trim(), phone: form.phone.trim(),
        identity: form.identity, team: form.team, certTypes: form.certTypes,
        validStart: form.validRange ? form.validRange[0] : '',
        validEnd: form.validRange ? form.validRange[1] : ''
      };
      try {
        if (editing.value) await api.put('/api/workers/' + form._id, payload);
        else await api.post('/api/workers', payload);
        ElementPlus.ElMessage.success('已保存');
        dialogVisible.value = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function togglePending(row) {
      const to = row.status === '待定' ? '已准入' : '待定';
      try {
        await api.put('/api/workers/' + row.id, { status: to });
        ElementPlus.ElMessage.success(to === '待定' ? '已移入待定库，该人员不再供周计划选择' : '已恢复准入');
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认删除作业人员「${row.name}」？`, '提示', { type: 'warning' });
        await api.del('/api/workers/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }

    function downloadTemplate() {
      const a = document.createElement('a');
      a.href = '/assets/worker_import_template.xlsx';
      a.download = '作业人员名单导入模板.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
    }
    function downloadExport() {
      const token = localStorage.getItem('erp_token');
      fetch('/api/workers/export', { headers: { Authorization: 'Bearer ' + token } })
        .then(r => { if (!r.ok) throw new Error('导出失败'); return r.blob(); })
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob); a.download = '作业人员名单.xlsx'; a.click();
        })
        .catch(e => ElementPlus.ElMessage.error(e.message));
    }
    function triggerImport() { if (fileInput.value) fileInput.value.click(); }
    async function onFileChange(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/workers/import', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
          body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success('成功导入 ' + data.added + ' 名作业人员');
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    onMounted(load);
    return { isTab, list, teams, sortedTeams, loading, filters, page, pageSize, filtered, paged, resetFilters, dialogVisible, editing, form, fileInput,
      openAdd, openEdit, submit, togglePending, remove, downloadTemplate, downloadExport, triggerImport, onFileChange, load,
      teamDlg, openTeamAdd, openTeamEdit, saveTeam, removeTeam, weekOption,
      fmtValid, fmtCerts, WORKER_IDENTITY_OPTIONS, WORKER_CERT_OPTIONS };
  },
  template: `
  <div>
    <input ref="fileInput" type="file" accept=".csv,.xls,.xlsx" style="display:none" @change="onFileChange" />

    <!-- 独立二级页：作业人员与班组 -->
    <div v-if="!isTab" class="wv-card">
      <div class="wv-head">
        <span class="wv-title">作业人员与班组</span>
        <div class="wv-actions">
          <el-button v-if="canWrite('users')" @click="openTeamAdd">新增班组</el-button>
          <el-button v-if="canWrite('users')" type="primary" @click="openAdd">新增人员</el-button>
          <el-button v-if="canWrite('users')" @click="triggerImport">选择文件导入</el-button>
          <el-button @click="downloadExport">下载</el-button>
          <el-button @click="downloadTemplate">下载模板</el-button>
          <el-button :loading="loading" @click="load">刷新人员</el-button>
        </div>
      </div>

      <div class="wv-body">
        <div class="wv-alert">
          <span class="wv-alert-icon">i</span>
          <div class="wv-alert-main">
            <div class="wv-alert-title">配置说明</div>
            <div class="wv-alert-text">作业人员名单用于周计划和工作票的现场人员选择，与登录账号分开管理。导入支持 CSV、XLS、XLSX，身份证号填写18位数字（末位可为X），手机号填写11位数字；准入有效期填写完整范围，如 2026-01-01 - 2026-12-31，也可用 2026年1月1日 - 2026年12月31日。证件类型支持多个，手动填写时只能使用模板「选项」表中的名称，并用中文分号（；）分隔。导入前会检查整份文件，存在错误时不会提交。</div>
          </div>
        </div>

        <div class="wv-section">作业人员名单</div>
        <div class="wv-filters">
          <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:200px" @input="page=1" />
          <el-select v-model="filters.identity" placeholder="身份" clearable style="width:230px" @change="page=1">
            <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
          <el-select v-model="filters.team" placeholder="班组" clearable style="width:170px" @change="page=1">
            <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
          </el-select>
          <el-button @click="resetFilters">重置</el-button>
        </div>

        <el-table class="flat-table" :data="paged" v-loading="loading" style="width:100%" empty-text="暂无人员">
          <el-table-column prop="name" label="姓名" min-width="90" />
          <el-table-column prop="identity" label="身份" min-width="185" />
          <el-table-column prop="team" label="班组" min-width="100" />
          <el-table-column prop="phone" label="电话" min-width="120" />
          <el-table-column label="证件" min-width="120"><template #default="{row}">{{ fmtCerts(row) }}</template></el-table-column>
          <el-table-column label="准入有效期" min-width="190"><template #default="{row}">{{ fmtValid(row) }}</template></el-table-column>
          <el-table-column label="状态" width="95">
            <template #default="{row}">
              <el-tag :type="row.status==='待定' ? 'warning' : 'success'" size="small">{{ row.status || '已准入' }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170">
            <template #default="{row}">
              <el-button v-if="canWrite('users')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button v-if="canWrite('users')" link type="primary" size="small" @click="togglePending(row)">{{ row.status==='待定' ? '恢复准入' : '待定库' }}</el-button>
              <el-button v-if="canWrite('users')" link type="danger" size="small" @click="remove(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="filtered.length > pageSize" style="display:flex;justify-content:flex-end;margin-top:12px">
          <el-pagination background layout="prev, pager, next" :total="filtered.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
        </div>

        <div class="wv-section">班组</div>
        <el-table class="flat-table" :data="sortedTeams" v-loading="loading" style="width:100%" empty-text="暂无班组">
          <el-table-column prop="name" label="班组" min-width="200" />
          <el-table-column label="周计划选项" min-width="200"><template #default="{row}">{{ weekOption(row) }}</template></el-table-column>
          <el-table-column label="排序" min-width="120"><template #default="{row}">{{ Number(row.sort) || 0 }}</template></el-table-column>
          <el-table-column label="操作" width="180">
            <template #default="{row}">
              <el-button v-if="canWrite('users')" size="small" @click="openTeamEdit(row)">编辑</el-button>
              <el-button v-if="canWrite('users')" size="small" class="wv-del-btn" @click="removeTeam(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 用户管理 → 作业人员名单标签：不出现卡片头与班组区块 -->
    <div v-else>
      <div class="wv-alert">
        <span class="wv-alert-icon">i</span>
        <div class="wv-alert-main">
          <div class="wv-alert-title">配置说明</div>
          <div class="wv-alert-text">作业人员名单用于维护实际参与现场作业、可在周计划和工作票中选择的人员，与登录账号分开管理。作业人员无需登录系统；建议维护姓名、电话、身份、班组、证件类型和准入有效期。移入待定后，该人员不再供周计划选择。</div>
        </div>
      </div>

      <div class="ck-toolbar">
        <el-button v-if="canWrite('users')" type="primary" size="small" @click="openAdd">新增</el-button>
        <el-button v-if="canWrite('users')" size="small" @click="triggerImport">选择文件导入</el-button>
        <span class="ck-hint">支持 .csv、.xls、.xlsx；请按模板填写，身份证号、手机号和有效期格式错误时整批不会导入。</span>
        <el-button size="small" @click="downloadExport">下载</el-button>
        <el-button link type="primary" @click="downloadTemplate">下载模板</el-button>
      </div>

      <div class="wv-filters">
        <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:160px" @input="page=1" />
        <el-select v-model="filters.identity" placeholder="身份" clearable style="width:230px" @change="page=1">
          <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
        </el-select>
        <el-select v-model="filters.team" placeholder="班组" clearable style="width:150px" @change="page=1">
          <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
        </el-select>
        <el-button @click="resetFilters">重置</el-button>
        <span class="ck-note">由资料员维护，无需为每名作业人员创建登录账号</span>
      </div>

      <el-table class="flat-table" :data="paged" v-loading="loading" style="width:100%" empty-text="暂无人员">
        <el-table-column prop="name" label="姓名" min-width="90" />
        <el-table-column prop="identity" label="身份" min-width="190" />
        <el-table-column prop="team" label="班组" min-width="100" />
        <el-table-column label="证件类型" min-width="170"><template #default="{row}">{{ fmtCerts(row) }}</template></el-table-column>
        <el-table-column label="准入有效期" min-width="200"><template #default="{row}">{{ fmtValid(row) }}</template></el-table-column>
        <el-table-column prop="idNumber" label="身份证号" min-width="180" />
        <el-table-column prop="phone" label="电话号码" min-width="140" />
        <el-table-column label="状态" width="100">
          <template #default="{row}">
            <el-tag :type="row.status==='待定' ? 'warning' : 'success'" size="small">{{ row.status || '已准入' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{row}">
            <el-button v-if="canWrite('users')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="canWrite('users')" link type="primary" size="small" @click="togglePending(row)">{{ row.status==='待定' ? '恢复准入' : '待定库' }}</el-button>
            <el-button v-if="canWrite('users')" link type="danger" size="small" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <el-pagination background layout="prev, pager, next" :total="filtered.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
      </div>
    </div>

    <el-dialog :title="editing ? '编辑人员' : '新增人员'" v-model="dialogVisible" width="620px" label-position="top">
      <el-form :model="form" label-position="top">
        <el-form-item label="姓名" required>
          <el-input v-model="form.name" placeholder="姓名" />
        </el-form-item>
        <el-form-item label="身份证号">
          <el-input v-model="form.idNumber" placeholder="选填，18位数字，末位可为X" />
        </el-form-item>
        <el-form-item label="电话号码">
          <el-input v-model="form.phone" placeholder="选填，11位手机号" />
        </el-form-item>
        <el-form-item label="身份">
          <el-select v-model="form.identity" placeholder="选填" style="width:100%" clearable>
            <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="班组">
          <el-select v-model="form.team" placeholder="选填" style="width:100%" clearable>
            <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="证件类型">
          <el-select v-model="form.certTypes" placeholder="选填，可多选" style="width:100%" multiple clearable filterable>
            <el-option v-for="o in WORKER_CERT_OPTIONS" :key="o" :label="o" :value="o" />
          </el-select>
        </el-form-item>
        <el-form-item label="准入有效期">
          <el-date-picker v-model="form.validRange" type="daterange" range-separator="→"
            start-placeholder="开始日期" end-placeholder="结束日期"
            value-format="YYYY-MM-DD" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog :title="teamDlg.editing ? '编辑班组' : '新增班组'" v-model="teamDlg.visible" width="480px" label-position="top">
      <el-form :model="teamDlg" label-position="top">
        <el-form-item label="班组" required>
          <el-input v-model="teamDlg.name" placeholder="如：施工一队" maxlength="60" />
        </el-form-item>
        <el-form-item label="周计划选项">
          <el-select v-model="teamDlg.showOnDeploy" style="width:100%">
            <el-option label="显示" value="展示" />
            <el-option label="隐藏" value="隐藏" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-input-number v-model="teamDlg.sort" :min="0" :max="999" style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="teamDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="teamDlg.busy" @click="saveTeam">确定</el-button>
      </template>
    </el-dialog>
  </div>`
};

/* 作业人员与班组：独立二级页（初始化向导「班组与施工人员 → 去设置」跳转落地页）
   与「用户管理 → 作业人员名单」标签共用同一个 WorkersPanel 组件 */
const WorkersView = {
  template: `<div class="wv-page"><WorkersPanel /></div>`
};

/* 登录账号列表（对齐原系统截图）：管理可登录系统的人员 */
const AccountsPanel = {
  setup() {
    const { ref, reactive, onMounted } = Vue;
    const EP = ElementPlus;
    const list = ref([]);
    const loading = ref(false);
    const showPwd = ref(false);
    const GROUPS = ['超级用户', '资料员', '材料员', '班组长'];
    const dlg = reactive({ visible: false, mode: 'create', id: '', loginName: '', email: '', password: '', name: '', phone: '', userGroup: '班组长', busy: false });
    const detail = reactive({ visible: false, row: null });
    async function load() {
      loading.value = true;
      try { list.value = await api.get('/api/users'); }
      catch (e) { EP.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openCreate() { Object.assign(dlg, { visible: true, mode: 'create', id: '', loginName: '', email: '', password: '', name: '', phone: '', userGroup: '班组长', busy: false }); showPwd.value = false; }
    function openEdit(row) { Object.assign(dlg, { visible: true, mode: 'edit', id: row.id, loginName: row.loginName || row.username, email: row.email || '', password: '', name: row.name || '', phone: row.phone || '', userGroup: row.userGroup || '班组长', busy: false }); showPwd.value = false; }
    function openDetail(row) { detail.row = row; detail.visible = true; }
    async function save() {
      if (!dlg.loginName.trim()) { EP.ElMessage.warning('请填写登录名'); return; }
      if (!dlg.email.trim()) { EP.ElMessage.warning('请填写邮箱'); return; }
      if (dlg.mode === 'create' && !dlg.password) { EP.ElMessage.warning('请填写密码'); return; }
      if (dlg.password) {
        if (dlg.password.length < 8 || dlg.password.length > 32) { EP.ElMessage.warning('密码需为 8-32 位'); return; }
        let cls = 0;
        if (/[a-z]/.test(dlg.password)) cls++;
        if (/[A-Z]/.test(dlg.password)) cls++;
        if (/\d/.test(dlg.password)) cls++;
        if (/[^A-Za-z0-9]/.test(dlg.password)) cls++;
        if (cls < 3) { EP.ElMessage.warning('密码需包含大写/小写/数字/符号中的至少三类'); return; }
      }
      dlg.busy = true;
      try {
        const body = { loginName: dlg.loginName.trim(), email: dlg.email.trim(), name: dlg.name.trim(), phone: dlg.phone.trim(), userGroup: dlg.userGroup };
        if (dlg.password) body.password = dlg.password;
        if (dlg.mode === 'create') await api.post('/api/users', body);
        else await api.put('/api/users/' + dlg.id, body);
        dlg.visible = false; EP.ElMessage.success('已保存'); load();
      } catch (e) { EP.ElMessage.error(e.message); }
      finally { dlg.busy = false; }
    }
    async function remove(row) {
      try { await EP.ElMessageBox.confirm('确定删除账号「' + (row.loginName || row.username) + '」？', '删除账号', { type: 'warning' }); }
      catch (e) { return; }
      try { await api.del('/api/users/' + row.id); EP.ElMessage.success('已删除'); load(); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    function groupTag(g) { return g === '超级用户' ? 'danger' : (g === '资料员' ? 'success' : (g === '材料员' ? 'warning' : 'info')); }
    onMounted(load);
    return { list, loading, showPwd, dlg, detail, GROUPS, groupTag, openCreate, openEdit, openDetail, save, remove };
  },
  template: `
  <div>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom:14px">
      <template #title><b>配置说明</b></template>
      <div>登录账号列表用于管理本企业需要登录系统的人员、登录资料和操作权限，与作业人员名单、外部通讯录分开维护。仅为需要使用系统的人员创建账号，无需为每名现场作业人员开通账号。</div>
      <div style="margin-top:6px">新增时填写登录名、邮箱和密码，建议补充姓名、电话，并按职责选择用户组。账号的新增、编辑与删除仅超级用户可操作。</div>
    </el-alert>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <span style="color:var(--text-2);font-size:13px">仅为需要登录系统的人员创建账号，并按职责分配权限</span>
      <el-button v-if="canAdmin()" type="primary" @click="openCreate">新增用户</el-button>
    </div>
    <el-table :data="list" v-loading="loading" border stripe style="width:100%">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column label="姓名" min-width="120"><template #default="{ row }">{{ row.name || '-' }}</template></el-table-column>
      <el-table-column label="电话" width="150">
        <template #default="{ row }">{{ row.phone || '-' }}</template>
      </el-table-column>
      <el-table-column label="用户组" width="110">
        <template #default="{ row }"><el-tag :type="groupTag(row.userGroup)" size="small">{{ row.userGroup }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <el-button v-if="canAdmin()" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="canAdmin() && !row.isSelf" link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="dlg.mode === 'create' ? '新增用户' : '编辑用户'" v-model="dlg.visible" width="480px">
      <el-form label-position="top">
        <el-form-item label="登录名" required>
          <el-input v-model="dlg.loginName" placeholder="CloudBase 登录名" :disabled="dlg.mode === 'edit'" />
        </el-form-item>
        <el-form-item label="邮箱" required>
          <el-input v-model="dlg.email" placeholder="用于登录" />
        </el-form-item>
        <el-form-item label="密码" :required="dlg.mode === 'create'">
          <el-input v-model="dlg.password" :type="showPwd ? 'text' : 'password'" placeholder="8-32 位，至少三类字符">
            <template #suffix><span style="cursor:pointer;font-size:12px" @click="showPwd = !showPwd">{{ showPwd ? '隐藏' : '显示' }}</span></template>
          </el-input>
        </el-form-item>
        <el-form-item label="姓名">
          <el-input v-model="dlg.name" placeholder="选填，用于班组长下拉展示" />
        </el-form-item>
        <el-form-item label="电话">
          <el-input v-model="dlg.phone" placeholder="选填，用于资料填报联系方式" />
        </el-form-item>
        <el-form-item label="用户组" required>
          <el-select v-model="dlg.userGroup" style="width:100%">
            <el-option v-for="g in GROUPS" :key="g" :label="g" :value="g" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="dlg.busy" @click="save">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog title="账号详情" v-model="detail.visible" width="460px">
      <el-descriptions v-if="detail.row" :column="1" border>
        <el-descriptions-item label="登录名">{{ detail.row.loginName || detail.row.username }}</el-descriptions-item>
        <el-descriptions-item label="邮箱">{{ detail.row.email || '-' }}</el-descriptions-item>
        <el-descriptions-item label="姓名">{{ detail.row.name || '-' }}</el-descriptions-item>
        <el-descriptions-item label="电话">{{ detail.row.phone || '-' }}</el-descriptions-item>
        <el-descriptions-item label="用户组">{{ detail.row.userGroup }}</el-descriptions-item>
        <el-descriptions-item label="可写模块">{{ ['超级用户','资料员'].includes(detail.row.userGroup) ? '全部模块' : (detail.row.userGroup === '材料员' ? '材料台账' : (detail.row.userGroup === '班组长' ? '计划管理 · 当日计划工作量' : '只读')) }}</el-descriptions-item>
        <el-descriptions-item label="状态">{{ detail.row.status }}</el-descriptions-item>
      </el-descriptions>
      <template #footer><el-button @click="detail.visible=false">关闭</el-button></template>
    </el-dialog>
  </div>`
};

/* 用户管理：登录账号列表 / 作业人员名单 / 外部通讯录 */
const UsersView = {
  setup() {
    const { ref, onMounted } = Vue;
    const tab = ref('accounts');
    // 支持从其它页面编程式跳转到指定标签页（如外部通讯录）
    onMounted(() => {
      if (window.__pendingUsersTab) { tab.value = window.__pendingUsersTab; window.__pendingUsersTab = ''; }
    });
    return { tab };
  },
  template: `
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="登录账号列表" name="accounts"><AccountsPanel /></el-tab-pane>
      <el-tab-pane label="作业人员名单" name="workers" lazy><WorkersPanel variant="tab" /></el-tab-pane>
      <el-tab-pane label="外部通讯录" name="contacts" lazy><ContactsPanel /></el-tab-pane>
    </el-tabs>
  </div>`
};

/* 项目/计划/借工/竣工资料 配置 */
const borrowCfg = {
  endpoint: 'borrowWorks', title: '借工',
  columns: [
    { key: 'fromTeam', label: '借出班组' }, { key: 'toTeam', label: '借入班组' }, { key: 'reason', label: '事由' },
    { key: 'headcount', label: '人数', width: 80 }, { key: 'startDate', label: '开始', width: 120 }, { key: 'endDate', label: '结束', width: 120 },
    { key: 'status', label: '状态', tag: true, width: 100 }
  ],
  formFields: [
    { key: 'fromTeam', label: '借出班组' }, { key: 'toTeam', label: '借入班组' }, { key: 'reason', label: '事由', type: 'textarea' },
    { key: 'headcount', label: '人数', type: 'number' }, { key: 'startDate', label: '开始日期' }, { key: 'endDate', label: '结束日期' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '进行中', value: '进行中' }, { label: '已归还', value: '已归还' }] }
  ]
};
const completionCfg = {
  endpoint: 'completionDocuments', title: '竣工资料',
  columns: [
    { key: 'name', label: '资料名称' }, { key: 'category', label: '类别', width: 100 }, { key: 'status', label: '状态', tag: true, width: 100 }, { key: 'updatedAt', label: '更新时间', minWidth: 160 }
  ],
  formFields: [
    { key: 'name', label: '资料名称', required: true }, { key: 'category', label: '类别' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '编制中', value: '编制中' }, { label: '待审核', value: '待审核' }, { label: '已归档', value: '已归档' }] }
  ]
};

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

/* ---------------- 根组件：登录 + 布局 + 路由 ---------------- */
// 侧栏菜单图标（内联 SVG，随文字颜色变化，暗色模式无需另配图）
const _ico = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const MENU_ICONS = {
  home: _ico('<path d="M4 10.6 12 4l8 6.6V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>'),
  projects: _ico('<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  materials: _ico('<path d="M20.5 8 12 3.5 3.5 8v8L12 20.5 20.5 16z"/><path d="M3.5 8 12 12.5 20.5 8M12 12.5v8"/>'),
  plans: _ico('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/>'),
  borrow: _ico('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),
  completion: _ico('<path d="M14 3.5H7A2 2 0 0 0 5 5.5v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9z"/><path d="M14 3.5v5h5"/><path d="m9 14.5 2 2 4-4.5"/>'),
  actualWorks: _ico('<path d="M4 20h16"/><rect x="6" y="11" width="3" height="6" rx=".6"/><rect x="10.5" y="7" width="3" height="10" rx=".6"/><rect x="15" y="13" width="3" height="4" rx=".6"/>'),
  documents: _ico('<path d="M6 3.5h8l4 4v13H6z"/><path d="M14 3.5v4h4M9 12h6M9 16h4.5"/>'),
  settings: _ico('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  users: _ico('<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/>'),
  workers: _ico('<circle cx="9" cy="8" r="3.2"/><path d="M2.8 19.5a6.2 6.2 0 0 1 12.4 0"/><path d="M16.5 5.6a3 3 0 0 1 0 5.6M17.6 19.5a6.4 6.4 0 0 0-1.6-4.2"/>'),
  init: _ico('<path d="M12 3.5l1.7 4.3 4.3 1.7-4.3 1.7L12 15.5l-1.7-4.3L6 9.5l4.3-1.7z"/><path d="M18.3 15.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>')
};

const App = {
  setup() {
    const { onUnmounted } = Vue;
    const token = ref(localStorage.getItem('erp_token'));
    const me = reactive({ name: '', role: '' });
    const viewVersion = ref(0);
    const tenant = ref('');
    const sysName = ref('电网生产ERP（本地版）');
    // 首次使用初始化向导是否已完成
    const initialized = ref(true);
    const initMode = computed(() => !!token.value && !initialized.value);
    // 移动端（<768px）默认收起侧栏，避免抽屉一进来就压住内容
    const collapsed = ref(typeof window !== 'undefined' && window.innerWidth < 768);
    const route = ref('home');
    const loginForm = reactive({ username: '', password: '' });
    const loginLoading = ref(false);
    // 登录页背景 / 品牌：背景由服务端直出到 CSS 变量 --login-bg（无闪跳），
    // 这里仅作为回退（如从非 / 路径进入）与品牌名同步。
    const loginBg = ref('');
    const loginBrand = reactive({ systemName: '', companyName: '' });

    // ===== 明暗主题：首屏由 index.html 内联脚本预先定好，这里只做切换与持久化 =====
    const theme = ref(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    function applyTheme(next) {
      theme.value = next;
      document.documentElement.classList.toggle('dark', next === 'dark');
      try { localStorage.setItem('erp_theme', next); } catch (e) {}
    }
    function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark'); }
    function menuIcon(key) { return MENU_ICONS[key] || MENU_ICONS.home; }

    // 首次初始化未完成时仅以下页面可访问，其余点击一律转跳初始化向导
    const INIT_ALLOWED = ['init', 'documents', 'settings', 'users', 'workers'];
    const allMenu = [
      { key: 'home', label: '用户中心', sub: '数据概览与常用入口', comp: 'Dashboard' },
      { key: 'projects', label: '项目列表', sub: '工程项目台账 · 进度与资料', comp: 'ProjectsView' },
      { key: 'materials', label: '材料台账', sub: '材料明细 · 领料出库与库存', comp: 'MaterialsView' },
      { key: 'plans', label: '计划管理', sub: '周计划 / 月计划 / 当日施工量', comp: 'PlansView' },
      { key: 'borrow', label: '借工管理', sub: '借工登记与用工台账', comp: 'CrudView', cfg: borrowCfg },
      { key: 'completion', label: '竣工资料（开发中）', sub: '竣工资料归档', comp: 'CrudView', cfg: completionCfg },
      { key: 'actualWorks', label: '工程实际施工量', comp: 'ActualConstructionView', hideTitle: true },
      { key: 'documents', label: '文档中心', comp: 'DocumentsView', hideTitle: true },
      { key: 'settings', label: '全局设置', sub: '系统参数 · 单位与字典维护', comp: 'SettingsView' },
      { key: 'users', label: '用户管理', sub: '登录账号 · 作业人员 · 外部通讯录', comp: 'UsersView' },
      { key: 'workers', label: '作业人员与班组', sub: '人员名单与班组', comp: 'WorkersView', hidden: true, hideTitle: true },
      { key: 'init', label: '初始化设置', sub: '首次使用引导', comp: 'InitView', hidden: true }
    ];
    // init 为首次向导隐藏入口
    const visibleMenu = computed(() => allMenu.filter(m => !m.hidden));
    const current = computed(() => allMenu.find(m => m.key === route.value) || visibleMenu.value[0] || allMenu[0]);

    async function fetchMe() {
      try {
        const r = await api.get('/api/me');
        me.name = r.user.name; me.role = r.user.role;
        Auth.loaded = true;
        Auth.isAdmin = !!r.user.isAdmin;
        Auth.group = r.user.role;
        Auth.writeModules = (r.user.permissions && r.user.permissions.writeModules) || [];
        // 顶栏企业名跟随「网站设置-企业名称」，未设置时回退租户名
        tenant.value = (r.settings && r.settings.companyName) || r.tenant.name;
        sysName.value = r.settings.systemName;
        document.title = r.settings.systemName || document.title;
        // 首次使用初始化向导：未完成时进入「初始化设置」首屏
        initialized.value = !!(r.settings && r.settings.initialized);
        // 首次初始化未完成：若当前停留在非允许页面（含首页），强制转跳回初始化向导
        if (!initialized.value && !INIT_ALLOWED.includes(route.value)) route.value = 'init';
      } catch (e) {}
    }
    async function login() {
      loginLoading.value = true;
      try {
        const r = await api.post('/api/login', loginForm);
        localStorage.setItem('erp_token', r.token);
        token.value = r.token; me.name = r.user.name; me.role = r.user.role;
        await fetchMe();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loginLoading.value = false; }
    }
    function logout() { localStorage.removeItem('erp_token'); Auth.loaded = false; Auth.isAdmin = false; Auth.writeModules = []; token.value = ''; location.reload(); }
    // 页面跳转：移动端自动收起抽屉；未完成初始化时，除「文档中心/全局设置/用户管理」外一律转跳回初始化向导
    function go(key) {
      if (initMode.value && !INIT_ALLOWED.includes(key)) {
        route.value = 'init';
        if (typeof window !== 'undefined' && window.innerWidth < 768) collapsed.value = true;
        ElementPlus.ElMessage.info('请先完成系统初始化设置');
        return;
      }
      route.value = key;
      if (typeof window !== 'undefined' && window.innerWidth < 768) collapsed.value = true;
    }

    // 安全网：任何非经 go() 直接修改 route 的路径，未初始化时若落在受限页面，强制转跳
    watch(route, (v) => { if (initMode.value && !INIT_ALLOWED.includes(v)) route.value = 'init'; });
    // 初始化完成：放行业务页面并进入用户中心（不依赖 fetchMe 异步时序）
    function onInitDone() { initialized.value = true; route.value = 'home'; }

    onMounted(() => {
      if (token.value) fetchMe();
      // 登录页公开配置（无需登录）：背景图 + 系统名 / 企业名
      api.get('/api/public-config').then(c => {
        const bg = c.loginBg || '/login-bg/valley.jpg';
        loginBg.value = bg;
        // 回退设置：仅当服务端未注入（值为 none）时才覆盖，避免覆盖正确的直出值造成闪跳
        const cur = getComputedStyle(document.documentElement).getPropertyValue('--login-bg').trim();
        if (!cur || cur === 'none') document.documentElement.style.setProperty('--login-bg', "url('" + bg + "')");
        loginBrand.systemName = c.systemName || '';
        loginBrand.companyName = c.companyName || '';
      }).catch(() => {});
      // 项目详情跳转：进入材料台账 / 计划管理（跨模块导航）
      // 跨模块跳转同样受初始化守卫约束：未初始化时业务页面一律转跳初始化向导
      function navMaterials() { go('materials'); }
      function navPlans() { go('plans'); }
      function navTo(e) { go(e.detail); }
      window.addEventListener('nav-materials', navMaterials);
      window.addEventListener('nav-plans', navPlans);
      window.addEventListener('nav-to', navTo);
      window.addEventListener('init-done', onInitDone);
      onUnmounted(() => {
        window.removeEventListener('nav-materials', navMaterials);
        window.removeEventListener('nav-plans', navPlans);
        window.removeEventListener('nav-to', navTo);
        window.removeEventListener('init-done', onInitDone);
      });
    });
    // 网站设置保存后实时刷新顶部标题/企业名称
    window.addEventListener('brand-changed', fetchMe);

    return { token, me, tenant, sysName, initialized, initMode, collapsed, route, loginForm, loginLoading, loginBg, loginBrand, visibleMenu, current, login, logout, go, viewVersion, theme, toggleTheme, menuIcon };
  },
  template: `
  <div v-if="!token">
    <div class="login-wrap">
      <div class="login-bg-rotate">
        <div class="login-bg-lqip"></div>
        <div class="login-bg-layer"></div>
      </div>
      <div class="login-ambient" aria-hidden="true"><span class="b1"></span><span class="b2"></span><span class="b3"></span></div>
      <div class="login-card">
        <div class="login-inner">
          <div class="brand">
            <h2>{{ loginBrand.systemName || '电网生产ERP' }}</h2>
            <div class="sub">本地自托管版 · 请登录</div>
          </div>
          <el-form @submit.prevent="login">
            <el-form-item><el-input v-model="loginForm.username" placeholder="账号" size="large" autocomplete="username" @keyup.enter="login" /></el-form-item>
            <el-form-item><el-input v-model="loginForm.password" type="password" placeholder="密码" size="large" show-password autocomplete="current-password" @keyup.enter="login" /></el-form-item>
            <el-button type="primary" size="large" class="login-btn" :loading="loginLoading" @click="login">登录</el-button>
          </el-form>
        </div>
      </div>
      <div class="login-page-footer">
        <div class="company" v-if="loginBrand.companyName">{{ loginBrand.companyName }}</div>
        <div v-else>{{ loginBrand.systemName || '' }}</div>
      </div>
    </div>
  </div>
  <div v-else class="app-shell">
    <header class="app-header">
      <div class="left">
        <button class="icon-btn" @click="collapsed=!collapsed" :title="collapsed?'展开菜单':'收起菜单'" aria-label="菜单">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 7h17M3.5 12h17M3.5 17h17"/></svg>
        </button>
        <div class="app-brand" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 2.5 5 13.4h5.6l-1 8.1 8.4-11.3h-5.7z"/></svg>
        </div>
        <span class="sysname">{{ sysName }}</span>
        <span v-if="tenant" class="tenant-name">{{ tenant }}</span>
      </div>
      <div class="right">
        <button class="theme-toggle" @click="toggleTheme" :title="theme==='dark' ? '切换到浅色模式' : '切换到深色模式'">
          <svg v-if="theme==='dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4 8.4 8.4 0 1 0 20 14.2z"/>
          </svg>
          <span>{{ theme==='dark' ? '浅色' : '深色' }}</span>
        </button>
        <span class="user-name">{{ me.name || me.username }}</span>
        <span v-if="me.role" class="user-role">{{ me.role }}</span>
        <span class="logout-btn" @click="logout">退出登录</span>
      </div>
    </header>
    <div class="layout">
      <aside class="aside" :class="{ collapsed }">
        <div v-for="m in visibleMenu" :key="m.key" class="menu-item" :class="{ active: route===m.key || (m.key==='home' && route==='init') }" @click="go(m.key)">
          <span class="mi" v-html="menuIcon(m.key)"></span>
          <span class="mt">{{ m.label }}</span>
        </div>
      </aside>
      <div class="aside-mask" v-if="!collapsed" @click="collapsed = true"></div>
      <main class="main">
        <div v-if="initMode && route!=='init'" class="init-bar">
          <span>企业初始化尚未完成。</span>
          <span class="link" @click="go('init')">返回初始化卡片</span>
        </div>
        <div class="page-head" v-if="!current.hideTitle">
          <h2 class="page-title">{{ current.label }}</h2>
          <div class="page-sub" v-if="current.sub">{{ current.sub }}</div>
        </div>
        <InitView v-if="route==='init'" />
        <component :is="current.comp" v-else-if="current.comp==='CrudView'" :config="current.cfg" :key="current.key + '-' + viewVersion" />
        <component :is="current.comp" v-else :key="current.key + '-' + viewVersion" />
      </main>
    </div>
  </div>`
};

const app = createApp(App);

// 全局权限助手：各组件模板可直接用 canWrite('模块') / canAdmin()
app.mixin({
  methods: {
    canWrite(mod) {
      if (!Auth.loaded) return false;
      return Auth.writeModules.includes('*') || Auth.writeModules.includes(mod);
    },
    canAdmin() { return !!Auth.isAdmin; }
  }
});
const lp = (typeof ElementPlusLocaleZhCn !== 'undefined') ? { locale: ElementPlusLocaleZhCn } : ((ElementPlus.lang && ElementPlus.lang.zhCn) ? { locale: ElementPlus.lang.zhCn } : {});
app.use(ElementPlus, lp);
app.component('FunnelIcon', { props: { on: Boolean },
  template: `<svg class="col-funnel" :class="{on}" viewBox="0 0 1024 1024" width="12" height="12"><path fill="currentColor" d="M384 523.392V928a32 32 0 0 0 46.336 28.608l192-96A32 32 0 0 0 640 832V523.392l280.768-343.104a32 32 0 0 0-24.768-52.288H128a32 32 0 0 0-24.768 52.288L384 523.392z"/></svg>` });
app.component('CrudView', CrudView);
app.component('ProjectsView', ProjectsView);
app.component('DocumentsView', DocumentsView);
app.component('MaterialsView', MaterialsView);
app.component('Dashboard', Dashboard);
app.component('SettingsView', SettingsView);
app.component('InitView', InitView);
app.component('WorkersPanel', WorkersPanel);
app.component('ContactsPanel', ContactsPanel);
app.component('WorkersView', WorkersView);
app.component('UsersView', UsersView);
app.component('AccountsPanel', AccountsPanel);
app.component('Requisitions', {
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
    }));
    function resetFilters() { filters.project = ''; filters.status = ''; filters.keyword = ''; }
    function sumQty(r) { return r.items.reduce((s, i) => s + (Number(i.qty) || 0), 0); }
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
    return { list, loading, filters, projectOptions, dlg, vdlg, filtered, load, resetFilters, sumQty, statusType, download, openConfirm, openSupplement, rowFlag, supDone, rowClass, onModeChange, qtyInput, doConfirm, voidReq, voidDeduct, confirmVoid, deleteReq, stockInfo, stockReason, itemHistory };
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
              <span class="rq-exp-hint">点击行首 + 查看入库记录</span>
            </div>
            <el-table :data="row.items" size="small" border class="rq-detail">
              <el-table-column type="expand" width="46" label="记录">
                <template #default="{ row: it }">
                  <div class="rq-hist">
                    <div class="rq-hist-head">入库记录<span class="rq-hist-n">共 {{ itemHistory(row, it.materialId).length }} 次</span></div>
                    <el-table v-if="itemHistory(row, it.materialId).length" :data="itemHistory(row, it.materialId)" size="small" border class="rq-hist-table">
                      <el-table-column prop="at" label="入库时间" width="160" />
                      <el-table-column prop="thisQty" label="本次入库数量" width="120" align="right" />
                      <el-table-column label="入库情况" width="100" align="center">
                        <template #default="{ row: h }">
                          <el-tag size="small" :type="h.abnormal ? 'danger' : 'success'">{{ h.abnormal ? '异常' : '正常' }}</el-tag>
                        </template>
                      </el-table-column>
                      <el-table-column prop="reason" label="异常原因" min-width="200">
                        <template #default="{ row: h }">{{ h.reason || '-' }}</template>
                      </el-table-column>
                    </el-table>
                    <div v-else class="rq-hist-empty">暂无入库记录（确认入库 / 补入库后按次记录）</div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="project" label="项目名称" min-width="160">
                <template #default="{ row: it }"><span class="rq-wrap">{{ it.project }}</span></template>
              </el-table-column>
              <el-table-column prop="description" label="物料描述" min-width="210">
                <template #default="{ row: it }"><span class="rq-wrap">{{ it.description }}</span></template>
              </el-table-column>
              <el-table-column label="数量" width="74" align="right">
                <template #default="{ row: it }"><span class="rq-num">{{ it.qty }}</span></template>
              </el-table-column>
              <el-table-column label="入库情况" width="96" align="center">
                <template #default="{ row: it }"><el-tag size="small" :type="stockInfo(row, it).type">{{ stockInfo(row, it).text }}</el-tag></template>
              </el-table-column>
              <el-table-column label="异常原因" min-width="140">
                <template #default="{ row: it }">
                  <span class="rq-reason" :class="{ 'is-empty': !stockReason(row, it) || stockReason(row, it) === '-' }">{{ stockReason(row, it) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="单位" width="52" align="center">
                <template #default="{ row: it }"><span class="rq-sub">{{ it.unit || '—' }}</span></template>
              </el-table-column>
              <el-table-column label="物料编码" width="116">
                <template #default="{ row: it }"><span class="rq-code">{{ it.code || '—' }}</span></template>
              </el-table-column>
              <el-table-column label="采购订单号" width="106">
                <template #default="{ row: it }"><span class="rq-code">{{ it.orderNo || '—' }}</span></template>
              </el-table-column>
            </el-table>
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
});
app.component('Imports', {
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
});
app.component('Outbounds', {
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
});

/* ---------------- 计划管理（周计划 / 月计划 / 日计划日历） ---------------- */
const PlansView = {
  setup() {
    const { ref, reactive, computed, onMounted, onUnmounted } = Vue;
    const TABS = [
      { key: 'week', label: '周计划管理' }, { key: 'month', label: '月计划管理' }, { key: 'archived', label: '已归档月计划' },
      { key: 'executed', label: '已执行' }, { key: 'settled', label: '已结算零星计划' }, { key: 'canceled', label: '已取消周计划' }
    ];
    const TICKET_TYPES = ['配电：配电第一种工作票', '配电：配电第二种工作票', '低压：低压工作票', '线路：线路第一种工作票', '线路：线路第二种工作票', '配电：低压工作票'];
    const VOLTAGE_LEVELS = ['0.4kV', '10kV', '20kV', '35kV', '110kV', '220kV'];
    const WORK_TYPES = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
    const SPECIALTIES = ['运检', '营销'];
    const DEPTS = ['设备部', '产业部'];
    // 风险因素 = 9 个固定大类（规范文件危险点库的分类口径）；风险管控措施按所选大类从库的对应明细自动带出，非硬编码
    const RISK_CATEGORIES = ['有限空间', '机械伤害', '起重伤害', '触电', '高处坠落', '倒塔/坍塌', '跨越风险', '物体打击', '动火作业'];
    const riskFactors = ref(RISK_CATEGORIES.slice());   // 下拉选项：9 个风险大类
    const hazardLibrary = ref([]);                      // 危险点库全部明细（含 category 字段）
    const substations = ref([]);                        // 属地供电所（全局设置）
    const units = ref([]);                              // 单位维护（分包/兄弟/监理/抄送）
    function unitsByType(type) { return units.value.filter(u => u.type === type); }
    async function loadHazards() {
      try {
        const d = await api.get('/api/documents');
        hazardLibrary.value = ((d && d.hazardLibrary) || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      } catch (e) {}
      try {
        const r = await api.get('/api/substations');
        substations.value = (Array.isArray(r) ? r : (r.data || [])).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      } catch (e) {}
      try {
        const r = await api.get('/api/units');
        units.value = (Array.isArray(r) ? r : (r.data || [])).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      } catch (e) {}
    }
    // 9 大类的规范化简写管控措施（源自文档中心规范文件，按类固化，非随机生成）
    const RISK_CATEGORY_MEASURES = {
      '有限空间': '①进入有限空间作业前，必须申请办理好进出申请单。②进入前，先排风后检测。气体检测工作应实时进行。③有限空间设置专责监护人，有限空间监护应在有限空间外持续监护。④有限空间施工应打开井口，井口设专人看护，二级及以上环境，应进行强制通风。⑤井口围栏上应挂有限空间警示牌和信息牌。⑥如气体检测不合格，达到二级及以上环境指标时，作业人员必须马上撤出。⑦有限空间工作完毕撤出时应清点人数。⑧作业人员必须正确佩戴和使用劳动防护用品，与外部有可靠的通讯联络；监护人不得离开作业现场，并与作业人员保持联系。⑨使用鼓风机通风。⑩现场配备正压式呼吸机。⑪现场配备救生设备担架、软梯、三脚架各1付。',
      '机械伤害': '①投入使用的机械设备必须完好，安全防护措施齐全，机械设备有生产许可证、出厂合格证。②作业人员必须佩戴好劳动保护用品，严格按说明书及安全操作规程进行操作。',
      '起重伤害': '①工作负责人负责指定吊车停靠位置。②吊车停稳后放下两侧支脚，保持车身平稳，并铺好垫木，垫木长度不小于1.2m。③吊装过程中基坑内、吊件垂直下方、受力钢丝绳的内角侧严禁有人；除指挥人及指定人员外，其他人员应在离开箱变高度的1.2倍距离以外。④系好临时风绳控制箱变。⑤在起吊、牵引过程中，受力钢丝绳的周围、上下方、内角侧和起吊物的下面，严禁有人逗留和通过；吊运中不得从人员上方通过，吊臂下严禁站人；不准用手拉或跨越钢丝绳。',
      '触电': '分别在有可能送电到作业地点的各个线路端口验无电后装设相应电压等级的接地线；作业人员施工作业时不能超出接地线保护范围。',
      '高处坠落': '正确使用安全带，在杆上不能失去安全带、安全绳的保护，安全带、绳应高挂低用；工作人员上杆时安全带、后背保护绳交替使用，杆上工作时安全带和安全绳应分别挂在电杆不同部位的牢固构件上；上下杆过程中注意安全，全过程安全带保护，匀步上下杆，翻越横担或杆上构件过程中不得失去安全保护；工作人员应相互加强监护，随时提醒杆上工作人员注意安全。',
      '倒塔/坍塌': '登杆前检查杆根是否牢固，如杆根不牢固应采取可靠安全措施后再行登杆。',
      '跨越风险': '在跨越特殊地形、障碍物时，派驻专职安全员全程监护。',
      '物体打击': '使用合格的安全帽、安全带，正确佩戴安全帽、安全带；传递工具材料使用绳索，严禁抛扔；登杆前检查杆根是否牢固。',
      '动火作业': '制作专项施工方案，经审批后实施。'
    };
    // 按已选风险大类顺序，带出对应分类的规范化简写管控措施
    function genMeasures(factors) {
      const lines = [];
      let ci = 0;
      (factors || []).forEach(cat => {
        const m = RISK_CATEGORY_MEASURES[cat];
        if (!m) return;
        ci++;
        lines.push('(' + ci + ') ' + cat);
        lines.push(m);
      });
      return lines.join('\n');
    }
    const RISK_LEVELS = ['三级', '四级', '五级'];
    const GRID_RISKS = ['无', '一级', '二级', '三级'];
    const MAJOR_RISKS = ['无', '有'];
    const tab = ref('week');
    const list = ref([]);
    const loading = ref(false);
    const projects = ref([]); const projectsFull = ref([]); const teams = ref([]); const workers = ref([]);
    const filters = reactive({ startDate: '', endDate: '', name: '', content: '', noProject: false, team: '', leader: '', ticketType: '', projectScope: [] });
    const page = ref(1); const pageSize = ref(20);
    const dlg = reactive({ visible: false, editingId: null, form: null });
    const emptyForm = () => ({
      name: '', content: '', shadowContent: '', planType: '周计划',
      project: '', subProject: '', workType: '配农网工程',
      startDate: '', endDate: '', specialty: '运检', dept: '设备部',
      voltage: '10kV', ticketType: '配电：配电第一种工作票',
      address: '', station: '', machine: '是', riskLevel: '四级', controlMeasures: '',
      gridRisk: '无', riskFactors: [], majorRisk: '无',
      buildCity: '', buildCounty: '', execCity: '', execCounty: '',
      substation: '', subcontractors: [], supervisor: '', ccUnits: [],
      staffText: '', teamLeader: '', staffCount: '', highStaff: '', gasTester: '', guardian: '',
      chargePerson: '', chargePersonPhone: '', arrivalPersons: '', safetyPatrol: '',
      wlPole: '', wlLine1035: '', wlCable: '', wlRing: '', wlVacuum: '', wlTransformer: '', wlLine04: '',
      outageRange: '', outageHours: '', surveyNo: '', workTicketNo: '',
      workUnit: '', chargePersons: [], staff: [],
      finishDate: '', planNote: '',
      teams: [], materials: [], status: '未执行'
    });

    function fmtDate(d) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    async function loadMeta() {
      try {
        const r = await api.get('/api/projects');
        const arr = Array.isArray(r) ? r : (r.data || []);
        projectsFull.value = arr;
        projects.value = arr.map(p => p.name || p.projectName).filter(Boolean);
      } catch (e) {}
      try { const r = await api.get('/api/teams'); teams.value = (Array.isArray(r) ? r : (r.data || [])).map(t => t.name).filter(Boolean); } catch (e) {}
      try { const r = await api.get('/api/workers'); const arr = Array.isArray(r) ? r : (r.data || []); workersFull.value = arr; workers.value = arr.map(w => w.name).filter(Boolean); } catch (e) {}
      try { const r = await api.get('/api/contacts'); contacts.value = Array.isArray(r) ? r : (r.data || []); } catch (e) {}
      await loadHazards();
    }
    // 选中关联项目 → 自动读取项目信息回填（名称/作业类型/专业/部门/电压/作业地址/变电站线路）
    function onProjectSelect(name) {
      const p = projectsFull.value.find(x => (x.name || x.projectName) === name);
      if (!p) return;
      const f = dlg.form;
      if (f) {
        f.name = p.name || name;
        if (p.workType && WORK_TYPES.includes(p.workType)) f.workType = p.workType;
        if (p.specialty && SPECIALTIES.includes(p.specialty)) f.specialty = p.specialty;
        if (p.provincialDept && DEPTS.includes(p.provincialDept)) f.dept = p.provincialDept;
        if (p.voltage && VOLTAGE_LEVELS.includes(p.voltage)) f.voltage = p.voltage;
        const addrParts = [p.address, p.substation].filter(Boolean);
        const coords = (p.lng && p.lat) ? ('（' + p.lng + ',' + p.lat + '）') : '';
        if (addrParts.length || coords) f.address = addrParts.join('/') + coords;
        if (p.substation) f.station = p.substation;
        f.subProject = '';
      }
    }
    const subProjectOptions = computed(() => {
      const p = projectsFull.value.find(x => (x.name || x.projectName) === (dlg.form && dlg.form.project));
      return (p && Array.isArray(p.subProjects)) ? p.subProjects.map(s => s.name || s).filter(Boolean) : [];
    });
    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/api/workPlans');
        const arr = Array.isArray(r) ? r : (r.data || []);
        arr.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        list.value = arr;
      } catch (e) { ElementPlus.ElMessage.error(e.message); } finally { loading.value = false; }
    }
    const tabList = computed(() => list.value.filter(p => {
      if (tab.value === 'week') return p.planType === '周计划' && !['已归档', '已取消', '已执行', '已结算'].includes(p.status);
      if (tab.value === 'month') return p.planType === '月计划' && !['已归档', '已取消', '已执行', '已结算'].includes(p.status);
      if (tab.value === 'archived') return p.planType === '月计划' && p.status === '已归档';
      if (tab.value === 'executed') return p.status === '已执行';
      if (tab.value === 'settled') return p.status === '已结算';
      if (tab.value === 'canceled') return p.planType === '周计划' && p.status === '已取消';
      return true;
    }));
    const filtered = computed(() => tabList.value.filter(p => {
      // 项目详情跳转带入的项目范围（项目名 + 其子项目名），精确匹配，不受关键词模糊匹配影响
      if (filters.projectScope.length && !filters.projectScope.includes(p.project)) return false;
      if (filters.startDate && p.startDate < filters.startDate) return false;
      if (filters.endDate && p.endDate > filters.endDate) return false;
      if (filters.name && !String(p.name || '').includes(filters.name)) return false;
      if (filters.content && !String(p.content || '').includes(filters.content)) return false;
      if (filters.noProject && p.project) return false;
      if (filters.team && p.team !== filters.team) return false;
      if (filters.leader && p.leader !== filters.leader) return false;
      if (filters.ticketType && p.ticketType !== filters.ticketType) return false;
      return true;
    }));
    const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
    // 日计划日历概览：未来 21 天内的有效计划（跨日计划按覆盖日期展示）
    const daySlice = v => String(v || '').slice(0, 10);
    const upcoming = computed(() => {
      const today = fmtDate(new Date());
      const end21 = fmtDate(new Date(Date.now() + 21 * 86400000));
      return list.value.filter(p => !['已取消', '已归档'].includes(p.status) && p.startDate && p.endDate && daySlice(p.endDate) >= today && daySlice(p.startDate) <= end21);
    });
    // 日历卡片：按有安排的日期展示（10月16日 周五 / 条数徽标 / 班组长 / 时间+计划名）
    const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const calendarDays = computed(() => {
      const days = [];
      for (let i = 0; i <= 21; i++) {
        const d = new Date(Date.now() + i * 86400000);
        const ds = fmtDate(d);
        const plans = upcoming.value.filter(p => daySlice(p.startDate) <= ds && daySlice(p.endDate) >= ds);
        if (plans.length) days.push({ ds, label: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_CN[d.getDay()], plans });
      }
      return days;
    });
    // 表格展示：日期 MM-DD HH:mm，空值显示 -
    function fmtDT(v) { if (!v) return '-'; const s = String(v); return s.length > 10 ? s.slice(5, 16) : s.slice(5); }
    function dash(v) { const s = String(v == null ? '' : v).trim(); return s || '-'; }
    // 行高亮：覆盖今天且未取消/归档的计划（进行中）
    function rowClass({ row }) {
      const t = fmtDate(new Date());
      return (!['已取消', '已归档'].includes(row.status) && daySlice(row.startDate) <= t && daySlice(row.endDate) >= t) ? 'plan-ongoing' : '';
    }
    // 操作列：复制 / 执行 / 备注 / 取消
    async function copyPlan(row) {
      try {
        const body = JSON.parse(JSON.stringify(row));
        delete body.id; delete body.createdAt;
        body.name = (row.name || '') + '（副本）'; body.status = '未执行';
        await api.post('/api/workPlans', body);
        ElementPlus.ElMessage.success('已复制为新计划'); load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function execPlan(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认将该计划标记为已执行？', '提示', { type: 'warning' });
        await api.put('/api/workPlans/' + row.id, { status: '已执行' });
        ElementPlus.ElMessage.success('已执行'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    async function cancelPlan(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认取消该计划？取消后可在「已取消周计划」中查看。', '提示', { type: 'warning' });
        await api.put('/api/workPlans/' + row.id, { status: '已取消' });
        ElementPlus.ElMessage.success('已取消'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    async function notePlan(row) {
      try {
        const { value } = await ElementPlus.ElMessageBox.prompt('请输入备注内容', '备注', { inputValue: row.planNote || '', inputType: 'textarea', inputPlaceholder: '选填' });
        await api.put('/api/workPlans/' + row.id, { planNote: value || '' });
        ElementPlus.ElMessage.success('备注已保存'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function addMaterialFor(row) { ElementPlus.ElMessage.info('请在「项目列表」对应项目详情中上传该计划的施工资料'); }
    // ---------- 人员安排：从作业人员名单勾选（按班组/身份分组，全选支持） ----------
    const workersFull = ref([]);
    const contacts = ref([]);
    const staffPick = reactive({ visible: false, checked: {} });
    function staffKey(w) { return w.id || ((w.name || '') + '|' + (w.phone || '')); }
    const groupedTeams = computed(() => {
      const admitted = workersFull.value.filter(w => w.status !== '待定');
      const byTeam = {};
      admitted.forEach(w => { const t = w.team || '未分组'; (byTeam[t] = byTeam[t] || []).push(w); });
      return Object.keys(byTeam).sort().map(team => ({
        team,
        identities: Object.entries(byTeam[team].reduce((m, w) => {
          const id = w.identity || '其他';
          (m[id] = m[id] || []).push(w); return m;
        }, {})).map(([identity, list]) => ({ identity, list }))
      }));
    });
    function openStaffPick() {
      if (!workersFull.value.length) loadMeta();
      staffPick.checked = {};
      staffPick.visible = true;
    }
    function toggleIdentity(it) {
      const keys = it.list.map(staffKey);
      const all = keys.every(k => staffPick.checked[k]);
      keys.forEach(k => { staffPick.checked[k] = !all; });
    }
    function confirmStaffPick() {
      const sel = workersFull.value.filter(w => staffPick.checked[staffKey(w)]);
      dlg.form.staffText = sel.map(w => w.name + '/' + (w.phone || '')).join('；');
      dlg.form.staffCount = sel.length ? String(sel.length) : '';
      dlg.form.highStaff = sel.filter(w => String(w.identity || '').includes('计入高处作业人员')).map(w => w.name).join('；');
      staffPick.visible = false;
    }
    // 工作负责人：外部通讯录中匹配姓名自动带出手机号
    function onChargePersonInput() {
      const n = String(dlg.form.chargePerson || '').trim();
      const c = n && contacts.value.find(x => x.name === n);
      if (c && c.phone) dlg.form.chargePersonPhone = c.phone;
    }
    // 一键填入：按关联项目进度填入杆塔/电缆完成量
    function oneKeyFill() {
      const f = dlg.form;
      const p = projectsFull.value.find(x => (x.name || x.projectName) === f.project);
      if (!p || !p.progress) { ElementPlus.ElMessage.warning('请先选择关联项目，且项目需有进度数据'); return; }
      const pr = p.progress;
      if (pr.pole && pr.pole.done != null) f.wlPole = String(pr.pole.done);
      if (pr.cable && pr.cable.done != null) f.wlCable = String(pr.cable.done);
      ElementPlus.ElMessage.success('已按项目进度填入杆塔、电缆完成量，其余请自行填写');
    }
    let unitsLoaded = false;
    async function openAdd() {
      if (!unitsLoaded) { await loadHazards(); unitsLoaded = true; }
      dlg.editingId = null; dlg.form = emptyForm();
      // 计划类型跟随当前所在 tab：月计划管理 tab 新增存为月计划，其余存周计划
      dlg.form.planType = tab.value === 'month' ? '月计划' : '周计划';
      // 从项目详情跳转过来时，关联项目默认带入（避免新增后因项目筛选而"消失"）
      if (filters.projectScope.length) dlg.form.project = filters.projectScope[0];
      // 作业单位联动：分包与监理默认排序第一条，抄送默认排序前两条；建管/实施单位留空由用户自行编辑
      const fb = unitsByType('分包单位'); if (fb.length) dlg.form.subcontractors = [fb[0].name];
      const sj = unitsByType('监理单位'); if (sj.length) dlg.form.supervisor = sj[0].name;
      const cs = unitsByType('抄送单位'); if (cs.length) dlg.form.ccUnits = cs.slice(0, 2).map(u => u.name);
      // 编号规则：年+月+流水号，自动带出年+月（如 202610），流水号由用户续填
      const d0 = new Date();
      const ym = d0.getFullYear() + String(d0.getMonth() + 1).padStart(2, '0');
      dlg.form.surveyNo = ym; dlg.form.workTicketNo = ym;
      dlg.visible = true;
    }
    function openEdit(row) {
      dlg.editingId = row.id; dlg.form = JSON.parse(JSON.stringify(row)); dlg.visible = true;
      if (!dlg.form.controlMeasures && (dlg.form.riskFactors || []).length) dlg.form.controlMeasures = genMeasures(dlg.form.riskFactors);
      // 字段规范化（老数据补齐）
      ['subcontractors', 'ccUnits', 'chargePersons'].forEach(k => { if (!Array.isArray(dlg.form[k])) dlg.form[k] = []; });
      ['staffText', 'teamLeader', 'staffCount', 'highStaff', 'gasTester', 'guardian', 'chargePerson', 'chargePersonPhone', 'arrivalPersons', 'safetyPatrol', 'wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04', 'outageRange', 'outageHours', 'surveyNo', 'workTicketNo'].forEach(k => { if (dlg.form[k] === undefined || dlg.form[k] === null) dlg.form[k] = ''; });
    }
    async function submit() {
      const f = dlg.form;
      // 统一为 YYYY-MM-DD HH:mm:ss（历史数据为 HH:mm），保证下面的字符串比较与导出稳定
      const normDT = v => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(v || '').trim()) ? String(v).trim() + ':00' : v);
      f.startDate = normDT(f.startDate); f.endDate = normDT(f.endDate);
      if (!String(f.name || '').trim()) { ElementPlus.ElMessage.warning('请填写作业计划名称'); return; }
      if (!f.startDate || !f.endDate) { ElementPlus.ElMessage.warning('请选择计划开始/结束日期'); return; }
      if (f.endDate < f.startDate) { ElementPlus.ElMessage.warning('计划结束日期不能早于开始日期'); return; }
      if (!f.substation) { ElementPlus.ElMessage.warning('请选择作业班组（属地供电所）'); return; }
      if (!String(f.staffText || '').trim()) { ElementPlus.ElMessage.warning('请选择作业实施（施工）人员'); return; }
      if (!f.teamLeader) { ElementPlus.ElMessage.warning('请选择班组长'); return; }
      // 当日计划工作量：数字格式校验
      const INT_RE = /^\d+$/, DEC3_RE = /^\d+(\.\d{1,3})?$/, DEC_RE = /^\d+(\.\d+)?$/;
      const numChecks = [['杆塔（基）', f.wlPole, INT_RE], ['10kV/35kV线路（km/单线）', f.wlLine1035, DEC3_RE], ['电缆（千米）', f.wlCable, DEC3_RE], ['环网柜（个）', f.wlRing, INT_RE], ['真空开关（个）', f.wlVacuum, INT_RE], ['变压器（个）', f.wlTransformer, INT_RE], ['0.4/0.22kV线路（km/单线）', f.wlLine04, DEC3_RE], ['时户数', f.outageHours, DEC_RE]];
      for (const [lb, v, re] of numChecks) {
        const s = String(v == null ? '' : v).trim();
        if (s && !re.test(s)) { ElementPlus.ElMessage.warning('「' + lb + '」格式不正确，请检查'); return; }
      }
      try {
        const body = { ...f, name: String(f.name).trim() };
        // 施工班组首行同步到列表的作业班组/班组长展示字段
        if (Array.isArray(f.teams) && f.teams.length) {
          if (f.teams[0].team) body.team = f.teams[0].team;
          if (f.teams[0].leader) body.leader = f.teams[0].leader;
        }
        if (Array.isArray(f.chargePersons) && f.chargePersons.length) body.chargePerson = f.chargePersons[0];
        if (dlg.editingId) await api.put('/api/workPlans/' + dlg.editingId, body);
        else await api.post('/api/workPlans', body);
        ElementPlus.ElMessage.success(dlg.editingId ? '计划已更新' : '计划已新增');
        dlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function remove(row) {
      try {
        await ElementPlus.ElMessageBox.confirm('确认删除作业计划「' + row.name + '」？', '提示', { type: 'warning' });
        await api.del('/api/workPlans/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function importPlans() {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = '.xlsx,.xls,.csv';
      input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const fd = new FormData(); fd.append('file', file);
        try {
          const res = await fetch('/api/workPlans/import', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd });
          const d = await res.json();
          if (!res.ok) throw new Error(d.error || '导入失败');
          ElementPlus.ElMessage.success('已导入 ' + d.added + ' 条作业计划');
          load();
        } catch (e) { ElementPlus.ElMessage.error(e.message); }
      };
      input.click();
    }
    async function exportPlans() {
      try {
        const token = localStorage.getItem('erp_token');
        const res = await fetch('/api/workPlans/export', { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('导出失败');
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'workPlans_export.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function onTab() { page.value = 1; }
    // 项目详情「查看月/周计划」：切到对应页签，并把列表限定在该项目（含其子项目）
    const scopeLabel = ref('');
    function clearProjectScope() { filters.projectScope = []; scopeLabel.value = ''; page.value = 1; }
    function applyProjectNav(nav) {
      if (!nav) return;
      if (nav.tab && TABS.some(t => t.key === nav.tab)) tab.value = nav.tab;
      // 清掉可能把目标计划筛掉的其它条件，保证跳转后一定看得到本项目的计划
      Object.assign(filters, { startDate: '', endDate: '', name: '', content: '', noProject: false, team: '', leader: '', ticketType: '' });
      filters.projectScope = (Array.isArray(nav.names) ? nav.names : []).filter(Boolean);
      scopeLabel.value = nav.label || filters.projectScope[0] || '';
      page.value = 1;
    }
    function onFilterProject(e) {
      const d = e.detail || {};
      applyProjectNav({ tab: d.tab, label: d.project, names: d.project ? [d.project] : [] });
    }
    // 计划管理为懒挂载：跳转前暂存的意图在本次 setup 中消费（首次挂载即可落到正确页签与范围）
    if (window.__pendingPlansNav) { applyProjectNav(window.__pendingPlansNav); window.__pendingPlansNav = null; }
    window.addEventListener('plans-filter-project', onFilterProject);
    onUnmounted(() => window.removeEventListener('plans-filter-project', onFilterProject));
    onMounted(() => { loadMeta(); load(); });
    const qtyDlg = reactive({ visible: false, id: '', name: '', busy: false, form: {} });
    const QTY_FIELDS = [
      { key: 'wlPole', label: '杆塔（基）' },
      { key: 'wlLine1035', label: '10kV/35kV线路（km/单线）' },
      { key: 'wlCable', label: '电缆（千米）' },
      { key: 'wlRing', label: '环网柜（个）' },
      { key: 'wlVacuum', label: '真空开关（个）' },
      { key: 'wlTransformer', label: '变压器（个）' },
      { key: 'wlLine04', label: '0.4/0.22kV线路（km/单线）' }
    ];
    function openQuantities(row) {
      const f = {};
      QTY_FIELDS.forEach(x => { f[x.key] = row[x.key] || ''; });
      Object.assign(qtyDlg, { visible: true, id: row.id, name: row.name || '', busy: false, form: f });
    }
    async function submitQuantities() {
      qtyDlg.busy = true;
      try {
        await api.put('/api/workPlans/' + qtyDlg.id + '/quantities', qtyDlg.form);
        ElementPlus.ElMessage.success('施工量已保存');
        qtyDlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { qtyDlg.busy = false; }
    }

    return { TABS, tab, list, loading, projects, projectsFull, teams, workers, riskFactors, filters, page, pageSize, paged, filtered, scopeLabel, clearProjectScope, dlg, upcoming, calendarDays, fmtDT, dash, rowClass, copyPlan, execPlan, cancelPlan, notePlan, addMaterialFor, TICKET_TYPES, VOLTAGE_LEVELS, WORK_TYPES, SPECIALTIES, DEPTS, RISK_LEVELS, GRID_RISKS, MAJOR_RISKS, genMeasures, subProjectOptions, substations, unitsByType, workersFull, contacts, staffPick, groupedTeams, staffKey, openStaffPick, confirmStaffPick, toggleIdentity, onChargePersonInput, oneKeyFill, load, onTab, openAdd, openEdit, onProjectSelect, submit, remove, importPlans, exportPlans, qtyDlg, QTY_FIELDS, openQuantities, submitQuantities };
  },
  template: `
  <div>
    <div style="background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:16px 18px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:17px;font-weight:600">日计划日历</div>
      </div>
      <div style="color:var(--text-3);font-size:12px;margin-top:6px">未来 21 天共 {{ upcoming.length }} 个日历安排，跨日计划按覆盖日期展示</div>
      <div v-if="!calendarDays.length" style="margin-top:12px;background:var(--surface-3);border:1px solid var(--line);border-radius:6px;padding:16px;font-size:13px;color:var(--text-3)">未来 21 天暂无施工计划</div>
      <div v-else style="display:flex;gap:12px;overflow-x:auto;padding:12px 2px 4px">
        <div v-for="d in calendarDays" :key="d.ds" style="min-width:250px;max-width:280px;flex:0 0 auto;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px 14px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b style="font-size:14px">{{ d.label }}</b>
            <span style="background:#3370ff;color:#fff;border-radius:10px;font-size:12px;padding:1px 9px">{{ d.plans.length }} 条</span>
          </div>
          <div style="color:var(--text-2);font-size:13px;margin-top:8px">班组长：{{ d.plans[0].leader || d.plans[0].team || '-' }}</div>
          <div v-for="p in d.plans" :key="p.id" style="color:var(--text-2);font-size:13px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            <span v-if="(p.startDate || '').length > 10" style="margin-right:4px">{{ p.startDate.slice(11, 16) }}</span>{{ p.name }}
          </div>
        </div>
      </div>
    </div>

    <div class="plan-card">
      <el-tabs v-model="tab" class="plan-tabs" @tab-change="onTab">
        <el-tab-pane v-for="t in TABS" :key="t.key" :label="t.label" :name="t.key" />
      </el-tabs>

      <div v-if="filters.projectScope.length" class="plan-scope">
        <span class="pf-label">关联项目：</span>
        <el-tag closable effect="plain" type="primary" @close="clearProjectScope">
          {{ scopeLabel }}<template v-if="filters.projectScope.length > 1">（含 {{ filters.projectScope.length - 1 }} 个子项目）</template>
        </el-tag>
        <span class="plan-scope-tip">由项目详情「查看月计划 / 查看周计划」带入，关闭标签可查看全部计划</span>
      </div>

      <div class="plan-filters">
        <el-date-picker v-model="filters.startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" class="pf-date" @change="page=1" />
        <el-date-picker v-model="filters.endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" class="pf-date" @change="page=1" />
        <div class="pf-item"><span class="pf-label">作业计划名称：</span>
          <el-input v-model="filters.name" placeholder="关键词" clearable class="pf-input" @input="page=1" />
        </div>
        <div class="pf-item"><span class="pf-label">工作内容：</span>
          <el-input v-model="filters.content" placeholder="关键词" clearable class="pf-input" @input="page=1" />
        </div>
        <el-checkbox v-model="filters.noProject" class="pf-check" @change="page=1">未关联项目</el-checkbox>
        <div class="pf-item"><span class="pf-label">作业班组：</span>
          <el-select v-model="filters.team" placeholder="全部" clearable class="pf-select" @change="page=1">
            <el-option v-for="t in teams" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div class="pf-item"><span class="pf-label">班组长：</span>
          <el-select v-model="filters.leader" placeholder="全部" clearable class="pf-select" @change="page=1">
            <el-option v-for="w in workers" :key="w" :label="w" :value="w" />
          </el-select>
        </div>
        <div class="pf-item"><span class="pf-label">工作票类型：</span>
          <el-select v-model="filters.ticketType" placeholder="全部" clearable class="pf-select pf-select-wide" @change="page=1">
            <el-option v-for="t in TICKET_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
      </div>

      <div class="plan-toolbar">
        <el-button v-if="canWrite('plans')" type="primary" size="small" @click="openAdd">新增</el-button>
        <el-button v-if="canWrite('plans')" size="small" @click="importPlans">导入 xlsx</el-button>
        <el-button size="small" @click="exportPlans">导出 xlsx</el-button>
      </div>

      <el-table :data="paged" v-loading="loading" class="plan-table" style="width:100%" :row-class-name="rowClass">
        <el-table-column type="index" label="序号" width="50" align="center" />
        <el-table-column prop="name" label="作业计划名称" min-width="160" show-overflow-tooltip />
        <el-table-column prop="team" label="作业班组" min-width="100" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="leader" label="班组长" width="84" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="startDate" label="计划开始" width="100" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="endDate" label="计划结束" width="100" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="ticketType" label="工作票类型" min-width="140" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="voltage" label="电压等级" width="84" align="center" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="station" label="变电站/线路" min-width="110" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePerson" label="工作负责人" width="96" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePersonPhone" label="工作负责人联系电话" width="142" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{row}">
            <div v-if="canWrite('plans')" class="plan-acts">
              <el-button link type="warning" size="small" @click="addMaterialFor(row)">添加资料</el-button>
              <el-button link type="warning" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="warning" size="small" @click="copyPlan(row)">复制</el-button>
              <el-button link type="warning" size="small" @click="execPlan(row)">执行</el-button>
              <el-button link type="warning" size="small" @click="notePlan(row)">备注</el-button>
              <el-button link type="danger" size="small" @click="cancelPlan(row)">取消</el-button>
            </div>
            <el-button v-else-if="canWrite('planQuantities')" link type="primary" size="small" @click="openQuantities(row)">填写施工量</el-button>
            <span v-else style="color:var(--text-3)">-</span>
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

      <el-dialog title="填写工程实际施工量" v-model="qtyDlg.visible" width="620px" label-position="top">
        <div style="color:var(--text-2);font-size:13px;margin-bottom:12px">计划：{{ qtyDlg.name }}</div>
        <el-form label-position="top">
          <el-row :gutter="20">
            <el-col v-for="f in QTY_FIELDS" :key="f.key" :xs="24" :sm="12">
              <el-form-item :label="f.label">
                <el-input v-model="qtyDlg.form[f.key]" placeholder="选填" />
              </el-form-item>
            </el-col>
          </el-row>
        </el-form>
        <template #footer>
          <el-button @click="qtyDlg.visible=false">取消</el-button>
          <el-button type="primary" :loading="qtyDlg.busy" @click="submitQuantities">保存</el-button>
        </template>
      </el-dialog>

      <div class="plan-pager">
        <span class="pp-total">共 {{ filtered.length }} 条，第 {{ page }} 页</span>
        <el-select v-model="pageSize" size="small" class="pp-size" @change="page=1">
          <el-option v-for="s in [20, 50, 100]" :key="s" :label="s + ' 条/页'" :value="s" />
        </el-select>
        <el-button size="small" :disabled="page <= 1" @click="page = page - 1">上一页</el-button>
        <el-button size="small" :disabled="page >= Math.max(1, Math.ceil(filtered.length / pageSize))" @click="page = page + 1">下一页</el-button>
      </div>
    </div>

    <el-dialog :title="(dlg.editingId ? '编辑' : '新增') + (dlg.form && dlg.form.planType === '月计划' ? '月计划' : '周计划')" v-model="dlg.visible" width="min(1180px, 94%)" top="4vh">
      <el-form v-if="dlg.form" label-position="top" style="max-height:72vh;overflow:auto;padding-right:6px">
        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:2px 0 14px;background:var(--surface)">
          <div style="font-size:15px;font-weight:600;margin-bottom:14px">项目与作业风险</div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="关联项目">
              <el-select v-model="dlg.form.project" placeholder="请选择，关联后作业内容将同步到该项目已报计划量" filterable clearable style="width:100%" @change="onProjectSelect">
                <el-option v-for="p in projects" :key="p" :label="p" :value="p" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="子项目">
              <el-select v-model="dlg.form.subProject" :placeholder="subProjectOptions.length ? '请选择子项目' : '当前包下无其他子项目'" :disabled="!subProjectOptions.length" clearable style="width:100%">
                <el-option v-for="s in subProjectOptions" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业计划名称" required><el-input v-model="dlg.form.name" placeholder="请输入作业计划名称" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业类型" required>
              <el-select v-model="dlg.form.workType" style="width:100%">
                <el-option v-for="t in WORK_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划开始时间"><plan-date-time v-model="dlg.form.startDate" placeholder="请选择日期" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划结束时间"><plan-date-time v-model="dlg.form.endDate" placeholder="请选择日期" /></el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业专业">
              <el-select v-model="dlg.form.specialty" style="width:100%">
                <el-option v-for="s in SPECIALTIES" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="省专业管理部门">
              <el-select v-model="dlg.form.dept" style="width:100%">
                <el-option v-for="d in DEPTS" :key="d" :label="d" :value="d" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="电压等级">
              <el-select v-model="dlg.form.voltage" style="width:100%">
                <el-option v-for="v in VOLTAGE_LEVELS" :key="v" :label="v" :value="v" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作票类型">
              <el-select v-model="dlg.form.ticketType" style="width:100%">
                <el-option v-for="t in TICKET_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业地址"><el-input v-model="dlg.form.address" placeholder="可修改默认地址" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="变电站/线路"><el-input v-model="dlg.form.station" placeholder="如：10kV怀农线" /></el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业内容">
              <el-input v-model="dlg.form.content" type="textarea" :rows="3" placeholder="请规范使用动、名词，动词在前，名词和数量在后。比如：开挖坑洞 5个；安装开关 1台" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="影子作业内容">
              <el-input v-model="dlg.form.shadowContent" type="textarea" :rows="3" placeholder="请填；生成工作票时优先使用，留空则使用作业内容" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="是否涉及机械施工">
              <el-select v-model="dlg.form.machine" style="width:100%">
                <el-option label="是" value="是" /><el-option label="否" value="否" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业风险等级">
              <el-select v-model="dlg.form.riskLevel" style="width:100%">
                <el-option v-for="r in RISK_LEVELS" :key="r" :label="r" :value="r" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="电网风险等级">
              <el-select v-model="dlg.form.gridRisk" style="width:100%">
                <el-option v-for="g in GRID_RISKS" :key="g" :label="g" :value="g" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="风险因素">
              <el-select v-model="dlg.form.riskFactors" multiple filterable style="width:100%" placeholder="请选择风险因素（来自规范文件危险点库）" @change="f => dlg.form.controlMeasures = genMeasures(f)">
                <el-option v-for="r in riskFactors" :key="r" :label="r" :value="r" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="重特大人身事故风险">
              <el-select v-model="dlg.form.majorRisk" style="width:100%">
                <el-option v-for="m in MAJOR_RISKS" :key="m" :label="m" :value="m" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="风险管控措施">
              <el-input v-model="dlg.form.controlMeasures" type="textarea" :autosize="{ minRows: 1, maxRows: 24 }" placeholder="选择风险因素后自动带出对应措施，可手工修改" style="--el-input-height:32px" />
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:var(--surface)">
          <div style="font-size:15px;font-weight:600;margin-bottom:14px">作业单位</div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业建管单位（市）">
              <el-input v-model="dlg.form.buildCity" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业建管单位（县）">
              <el-input v-model="dlg.form.buildCounty" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业实施单位（市）">
              <el-input v-model="dlg.form.execCity" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业实施单位（县）">
              <el-input v-model="dlg.form.execCounty" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业班组（属地供电所）" required>
              <el-select v-model="dlg.form.substation" placeholder="请选择" filterable clearable style="width:100%">
                <el-option v-for="s in substations" :key="s.id || s.name" :label="s.name" :value="s.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="分包单位">
              <el-select v-model="dlg.form.subcontractors" multiple filterable placeholder="可多选" style="width:100%">
                <el-option v-for="u in unitsByType('分包单位')" :key="u.id" :label="u.name" :value="u.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="监理单位">
              <el-select v-model="dlg.form.supervisor" placeholder="请选择" filterable clearable style="width:100%">
                <el-option v-for="u in unitsByType('监理单位')" :key="u.id" :label="u.name" :value="u.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="抄送单位">
              <el-select v-model="dlg.form.ccUnits" multiple filterable placeholder="请选择" style="width:100%">
                <el-option v-for="u in unitsByType('抄送单位')" :key="u.id" :label="u.name" :value="u.name" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:var(--surface)">
          <div style="font-size:15px;font-weight:600;margin-bottom:14px">人员安排</div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业实施（施工）人员（不包含工作负责人）" required>
              <el-button @click="openStaffPick">从作业人员名单选择</el-button>
              <el-input v-model="dlg.form.staffText" type="textarea" :rows="3" placeholder="点击上方「从作业人员名单选择」勾选后自动填入" style="margin-top:8px" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="班组长" required>
              <el-select v-model="dlg.form.teamLeader" placeholder="请选择" filterable clearable style="width:100%">
                <el-option v-for="w in workers" :key="w" :label="w" :value="w" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="作业人员（共多少人）">
              <el-input v-model="dlg.form.staffCount" placeholder="由上方人员选择自动带出" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="其中高处作业人员">
              <el-input v-model="dlg.form.highStaff" placeholder="由上方人员选择自动带出（仅「技工（计入高处作业人员）」身份计入）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="气体检测人员">
              <el-input v-model="dlg.form.gasTester" placeholder="如：不涉及" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="专责监护人">
              <el-input v-model="dlg.form.guardian" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作负责人">
              <el-input v-model="dlg.form.chargePerson" placeholder="请输入姓名，无默认值" @input="onChargePersonInput" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作负责人联系方式">
              <el-input v-model="dlg.form.chargePersonPhone" placeholder="手机号（外部通讯录中匹配姓名将自动带出）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="到岗到位人员">
              <el-input v-model="dlg.form.arrivalPersons" placeholder="请输入" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="安全巡查人员">
              <el-input v-model="dlg.form.safetyPatrol" placeholder="选填" />
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <div style="border:1px solid var(--line);border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:var(--surface)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <span style="font-size:15px;font-weight:600">当日计划工作量</span>
            <el-link type="primary" :underline="false" @click="oneKeyFill">一键填入</el-link>
          </div>
        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="杆塔（基）">
              <el-input v-model="dlg.form.wlPole" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="10kV/35kV线路（km/单线）">
              <el-input v-model="dlg.form.wlLine1035" placeholder="选填，最多三位小数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="电缆（千米）">
              <el-input v-model="dlg.form.wlCable" placeholder="选填，最多三位小数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="环网柜（个）">
              <el-input v-model="dlg.form.wlRing" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="真空开关（个）">
              <el-input v-model="dlg.form.wlVacuum" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="变压器（个）">
              <el-input v-model="dlg.form.wlTransformer" placeholder="选填，整数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24">
            <el-form-item label="0.4/0.22kV线路（km/单线）">
              <el-input v-model="dlg.form.wlLine04" placeholder="选填，最多三位小数" />
            </el-form-item>
          </el-col>
        </el-row>
        </div>

        <el-row :gutter="20">
          <el-col :xs="24" :sm="12">
            <el-form-item label="停电范围">
              <el-input v-model="dlg.form.outageRange" placeholder="选填" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="时户数">
              <el-input v-model="dlg.form.outageHours" placeholder="选填，支持小数" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="勘察编号">
              <el-input v-model="dlg.form.surveyNo" placeholder="年+月+流水号（年月已自动带出）" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="工作票编号">
              <el-input v-model="dlg.form.workTicketNo" placeholder="年+月+流水号（年月已自动带出）" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">取 消</el-button>
        <el-button type="primary" @click="submit">确 定</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="staffPick.visible" title="从作业人员名单选择（作业实施人员，不包含工作负责人）" width="min(760px, 94%)">
      <div style="max-height:56vh;overflow:auto">
        <div v-for="g in groupedTeams" :key="g.team" style="border:1px solid var(--line);border-radius:6px;padding:12px 16px;margin-bottom:12px">
          <div style="font-weight:600;margin-bottom:8px">班组：{{ g.team }}</div>
          <div v-for="it in g.identities" :key="it.identity" style="margin-bottom:8px">
            <div style="margin-bottom:4px">身份：{{ it.identity }}<el-link type="primary" :underline="false" style="margin-left:10px" @click="toggleIdentity(it)">全选</el-link></div>
            <el-checkbox v-for="w in it.list" :key="w.id" v-model="staffPick.checked[staffKey(w)]" style="margin-right:16px">{{ w.name }} / {{ w.phone || '-' }}</el-checkbox>
          </div>
        </div>
        <div v-if="!groupedTeams.length" style="color:var(--text-3);font-size:13px;text-align:center;padding:20px 0">暂无已准入的作业人员，请先在「用户管理-作业人员名单」中维护</div>
      </div>
      <template #footer>
        <el-button @click="staffPick.visible=false">取 消</el-button>
        <el-button type="primary" @click="confirmStaffPick">确 定</el-button>
      </template>
    </el-dialog>
  </div>`
};
/* ===== 日期时间选择器：日历 + 时/分/秒三列 + 此刻/确定（对齐原系统截图，用于计划开始/结束时间） ===== */
const PlanDateTime = {
  props: {
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '请选择日期' },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const { ref, reactive, computed, nextTick, onBeforeUnmount } = Vue;
    const pad = n => String(n).padStart(2, '0');
    const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
    const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
    const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));
    const SECONDS = Array.from({ length: 60 }, (_, i) => pad(i));
    const open = ref(false);
    const triggerEl = ref(null);
    const panelEl = ref(null);
    const colH = ref(null); const colM = ref(null); const colS = ref(null);
    const pos = reactive({ top: 0, left: 0, width: 460 });
    const now0 = new Date();
    const view = reactive({ y: now0.getFullYear(), m: now0.getMonth() + 1 });
    const sel = reactive({ y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0, has: false });

    function parse(v) {
      const t = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
      if (!t) return null;
      return { y: +t[1], m: +t[2], d: +t[3], h: t[4] ? +t[4] : 0, mi: t[5] ? +t[5] : 0, s: t[6] ? +t[6] : 0 };
    }
    const text = computed(() => {
      const p = parse(props.modelValue);
      return p ? p.y + '-' + pad(p.m) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s) : '';
    });
    const cells = computed(() => {
      // 以周一为首日：把 getDay()(周日=0) 折算成 0..6
      const lead = (new Date(view.y, view.m - 1, 1).getDay() + 6) % 7;
      const list = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(view.y, view.m - 1, 1 - lead + i);
        list.push({ y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), cur: d.getMonth() + 1 === view.m });
      }
      return list;
    });
    function isToday(c) {
      const t = new Date();
      return c.y === t.getFullYear() && c.m === t.getMonth() + 1 && c.d === t.getDate();
    }
    function isSel(c) { return sel.has && sel.y === c.y && sel.m === c.m && sel.d === c.d; }
    function move(n) {
      const d = new Date(view.y, view.m - 1 + n, 1);
      view.y = d.getFullYear(); view.m = d.getMonth() + 1;
    }
    function applyPos() {
      const el = triggerEl.value; if (!el) return;
      const r = el.getBoundingClientRect();
      const pw = Math.min(460, window.innerWidth - 24);
      const ph = panelEl.value ? panelEl.value.offsetHeight : 338;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
      pos.width = pw; pos.left = left; pos.top = top;
    }
    function scrollCols() {
      [[colH, sel.h], [colM, sel.mi], [colS, sel.s]].forEach(pair => {
        const el = pair[0].value; if (!el) return;
        const idx = sel.has ? Number(pair[1]) : 0;
        el.scrollTop = Math.max(0, idx * 26 - 104);
      });
    }
    function onDocDown(e) {
      if (panelEl.value && panelEl.value.contains(e.target)) return;
      if (triggerEl.value && triggerEl.value.contains(e.target)) return;
      close();
    }
    function onKey(e) {
      if (e.key !== 'Escape' || !open.value) return;
      // 只关选择器，不要把整个弹窗一起关掉（ElDialog 的 Esc 监听在 document 冒泡阶段）
      e.stopPropagation(); e.preventDefault();
      close();
    }
    function bindEvents() {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', applyPos);
      window.addEventListener('scroll', applyPos, true);
    }
    function unbindEvents() {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', applyPos);
      window.removeEventListener('scroll', applyPos, true);
    }
    function doOpen() {
      if (props.disabled) return;
      const p = parse(props.modelValue);
      if (p) Object.assign(sel, p, { has: true });
      else Object.assign(sel, { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0, has: false });
      const t = new Date();
      view.y = p ? p.y : t.getFullYear();
      view.m = p ? p.m : t.getMonth() + 1;
      open.value = true;
      applyPos(); bindEvents();
      nextTick(() => { applyPos(); scrollCols(); });
    }
    function close() { open.value = false; unbindEvents(); }
    function toggle() { open.value ? close() : doOpen(); }
    function pickDay(c) {
      sel.y = c.y; sel.m = c.m; sel.d = c.d; sel.has = true;
      if (c.m !== view.m || c.y !== view.y) { view.y = c.y; view.m = c.m; }
    }
    function pickTime(key, v) {
      sel[key] = Number(v);
      if (!sel.has) {
        const t = new Date();
        sel.y = t.getFullYear(); sel.m = t.getMonth() + 1; sel.d = t.getDate(); sel.has = true;
      }
    }
    function confirm() {
      if (!sel.has) return;
      emit('update:modelValue', sel.y + '-' + pad(sel.m) + '-' + pad(sel.d) + ' ' + pad(sel.h) + ':' + pad(sel.mi) + ':' + pad(sel.s));
      close();
    }
    function pickNow() {
      const t = new Date();
      Object.assign(sel, { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: t.getSeconds(), has: true });
      view.y = sel.y; view.m = sel.m;
      confirm();
    }
    function clear() { emit('update:modelValue', ''); }
    onBeforeUnmount(unbindEvents);

    return { pad, WEEK, HOURS, MINUTES, SECONDS, open, triggerEl, panelEl, colH, colM, colS, pos, view, sel, text, cells, isToday, isSel, move, toggle, close, pickDay, pickTime, confirm, pickNow, clear };
  },
  template: `
  <div class="pdt" :class="{ 'is-open': open }">
    <div class="pdt-input" :class="{ 'is-empty': !text, 'is-disabled': disabled }" ref="triggerEl" tabindex="0" @click="toggle" @keydown.enter.prevent="toggle" @keydown.space.prevent="toggle">
      <span class="pdt-text">{{ text || placeholder }}</span>
      <span v-if="text && !disabled" class="pdt-clear" title="清空" @click.stop="clear">
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </span>
      <span class="pdt-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><rect x="3.6" y="5.4" width="16.8" height="15" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.6 10.2h16.8M8.2 3.4v3.6M15.8 3.4v3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </span>
    </div>
    <teleport to="body">
      <div v-if="open" class="pdt-panel" ref="panelEl" :style="{ top: pos.top + 'px', left: pos.left + 'px', width: pos.width + 'px' }">
        <div class="pdt-body">
          <div class="pdt-cal">
            <div class="pdt-head">
              <button type="button" class="pdt-nav" title="上一年" @click="move(-12)">«</button>
              <button type="button" class="pdt-nav" title="上个月" @click="move(-1)">‹</button>
              <div class="pdt-title"><span>{{ view.y }}年</span><span>{{ view.m }}月</span></div>
              <button type="button" class="pdt-nav" title="下个月" @click="move(1)">›</button>
              <button type="button" class="pdt-nav" title="下一年" @click="move(12)">»</button>
            </div>
            <div class="pdt-week"><span v-for="w in WEEK" :key="w">{{ w }}</span></div>
            <div class="pdt-grid">
              <div v-for="(c, i) in cells" :key="i" class="pdt-day" :class="{ out: !c.cur, today: isToday(c), on: isSel(c) }" @click="pickDay(c)">{{ c.d }}</div>
            </div>
          </div>
          <div class="pdt-time">
            <div class="pdt-col" ref="colH"><div v-for="h in HOURS" :key="h" class="pdt-cell" :class="{ on: sel.has && pad(sel.h) === h }" @click="pickTime('h', h)">{{ h }}</div></div>
            <div class="pdt-col" ref="colM"><div v-for="m in MINUTES" :key="m" class="pdt-cell" :class="{ on: sel.has && pad(sel.mi) === m }" @click="pickTime('mi', m)">{{ m }}</div></div>
            <div class="pdt-col" ref="colS"><div v-for="s in SECONDS" :key="s" class="pdt-cell" :class="{ on: sel.has && pad(sel.s) === s }" @click="pickTime('s', s)">{{ s }}</div></div>
          </div>
        </div>
        <div class="pdt-foot">
          <button type="button" class="pdt-now" @click="pickNow">此刻</button>
          <button type="button" class="pdt-ok" :disabled="!sel.has" @click="confirm">确定</button>
        </div>
      </div>
    </teleport>
  </div>`
};
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

app.component('PlanDateTime', PlanDateTime);
app.component('PlansView', PlansView);
app.component('ActualConstructionView', ActualConstructionView);
app.mount('#app');
