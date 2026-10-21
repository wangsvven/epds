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
    if (!res.ok) throw new Error(data.error || '请求失败');
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

    onMounted(() => { loadRefs(); load(); });

    return { list, loading, dialogVisible, editing, form, openAdd, openEdit, submit, remove, fieldOptions, tagType };
  },
  template: `
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="openAdd">+ 新增</el-button>
      <span class="spacer"></span>
      <span style="color:#888;font-size:13px;">共 {{ list.length }} 条</span>
    </div>
    <el-table :data="list" v-loading="loading" border stripe style="width:100%">
      <el-table-column v-for="col in config.columns" :key="col.key" :prop="col.key" :label="col.label" :width="col.width">
        <template #default="{ row }">
          <el-tag v-if="col.tag" :type="tagType(row[col.key])">{{ row[col.key] }}</el-tag>
          <span v-else>{{ row[col.key] }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
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
    const docs = reactive({ categories: [], files: [], hazardLibrary: [], surveyTemplate: {} });
    const activeCat = ref('规范文件');
    const hazardOpen = ref(true);
    const hazardSearch = ref('');
    const hazardDialog = ref(false);
    const hazardEditing = ref(false);
    const hazardForm = reactive({ hazard: '', measure: '', category: '', sort: null });
    const HAZARD_CATEGORIES = ['有限空间', '机械伤害', '起重伤害', '触电', '高处坠落', '倒塔/坍塌', '跨越风险', '物体打击', '动火作业'];
    const filePage = ref(1);
    const filePageSize = ref(20);
    const uploadInput = ref(null);
    const importInput = ref(null);
    const replaceInput = ref(null);
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
        docs.categories = d.categories; docs.files = d.files;
        docs.hazardLibrary = d.hazardLibrary; docs.surveyTemplate = d.surveyTemplate;
        if (!docs.categories.includes(activeCat.value)) activeCat.value = docs.categories[0] || '';
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    const catFiles = computed(() => docs.files.filter(f => f.category === activeCat.value));
    const pagedFiles = computed(() => catFiles.value.slice((filePage.value - 1) * filePageSize.value, filePage.value * filePageSize.value));
    const sortedHazards = computed(() =>
      [...docs.hazardLibrary].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    );
    const filteredHazards = computed(() => {
      const k = hazardSearch.value.trim();
      if (!k) return sortedHazards.value;
      return sortedHazards.value.filter(h => (h.hazard || '').includes(k) || (h.measure || '').includes(k));
    });

    /* ---- 企业危险点库 ---- */
    function openHazardAdd() {
      Object.assign(hazardForm, { hazard: '', measure: '', category: '', sort: null });
      hazardEditing.value = false; hazardDialog.value = true;
    }
    function openHazardEdit(row) {
      Object.assign(hazardForm, { hazard: row.hazard, measure: row.measure, category: row.category || '', sort: row.sort, _id: row.id });
      hazardEditing.value = true; hazardDialog.value = true;
    }
    async function submitHazard() {
      const payload = { hazard: hazardForm.hazard, measure: hazardForm.measure, category: hazardForm.category, sort: hazardForm.sort };
      try {
        if (hazardEditing.value) await api.put('/api/documents/hazard/' + hazardForm._id, payload);
        else await api.post('/api/documents/hazard', payload);
        ElementPlus.ElMessage.success('已保存');
        hazardDialog.value = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function removeHazard(row) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认删除危险点「${row.hazard}」？`, '提示', { type: 'warning' });
        await api.del('/api/documents/hazard/' + row.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    function triggerHazardImport() { if (importInput.value) importInput.value.click(); }
    async function onHazardImport(ev) {
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
        ElementPlus.ElMessage.success(`导入完成：新增 ${data.added} 条，跳过 ${data.skipped} 条`);
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    /* ---- 固定系统文件：替换现场勘察记录模板 ---- */
    function triggerReplace() { if (replaceInput.value) replaceInput.value.click(); }
    async function onReplace(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/documents/template/replace', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '替换失败');
        ElementPlus.ElMessage.success('模板已替换');
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

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
        ElementPlus.ElMessage.success('上传成功');
        load();
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
        await api.put('/api/documents/files/' + f.id, { category: cat });
        ElementPlus.ElMessage.success(`已移动到「${cat}」`);
        load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    onMounted(load);
    return {
      docs, activeCat, hazardOpen, hazardSearch, hazardDialog, hazardEditing, hazardForm,
      filePage, filePageSize, catFiles, pagedFiles, filteredHazards,
      uploadInput, importInput, replaceInput, previewVisible, previewData,
      triggerReplace, onReplace,
      previewPage, previewSheet, previewHeader, previewRows, previewPaged, fmtCell,
      load, openHazardAdd, openHazardEdit, submitHazard, removeHazard, triggerHazardImport, onHazardImport, HAZARD_CATEGORIES,
      triggerUpload, onUpload, download, preview, printPreview,
      removeFile, moveFile
    };
  },
  template: `
  <div>
    <!-- 企业危险点库（可折叠） -->
    <el-card style="margin-bottom:14px" shadow="never">
      <div style="display:flex;align-items:center;cursor:pointer;user-select:none" @click="hazardOpen=!hazardOpen">
        <el-icon :size="16" style="margin-right:6px"><component :is="hazardOpen ? 'ArrowDown' : 'ArrowRight'" /></el-icon>
        <b>企业危险点库（{{ docs.hazardLibrary.length }} 条）</b>
      </div>
      <template v-if="hazardOpen">
        <div style="color:#666;font-size:13px;line-height:1.8;margin:10px 0">企业危险点库即作业计划「风险因素 / 风险管控措施」的选取来源。初始为空，需自行录入或导入：可手动新增、编辑、删除、排序，也可通过 Excel 批量导入补充：首个工作表 A 列危险点、C 列控制措施，最多 1000 行、2MB；相同危险点和措施自动跳过。</div>
        <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
          <el-input v-model="hazardSearch" placeholder="搜索危险点或措施" style="width:220px" clearable>
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
          <el-button @click="load">刷新</el-button>
          <el-button type="primary" @click="openHazardAdd">新增危险点</el-button>
          <el-button @click="triggerHazardImport">导入 Excel</el-button>
          <input ref="importInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onHazardImport" />
        </div>
        <el-table :data="filteredHazards" border stripe max-height="480">
          <el-table-column prop="sort" label="排序" width="70" />
          <el-table-column prop="hazard" label="危险点" min-width="200" show-overflow-tooltip />
          <el-table-column label="风险大类" width="118" align="center">
            <template #default="{row}">
              <el-tag v-if="row.category" size="small" effect="plain" style="white-space:nowrap">{{ row.category }}</el-tag>
              <span v-else style="color:#bbb">—</span>
            </template>
          </el-table-column>
          <el-table-column prop="measure" label="控制措施" min-width="360" show-overflow-tooltip />
          <el-table-column label="操作" width="130" fixed="right">
            <template #default="{row}">
              <el-button link type="primary" size="small" @click="openHazardEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="removeHazard(row)">删除</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <div style="padding:30px 0"><el-icon :size="44" color="#c0c4cc"><FolderOpened /></el-icon><div style="color:#999;margin-top:8px">暂无数据</div></div>
          </template>
        </el-table>
      </template>
    </el-card>

    <div style="color:#999;font-size:12px;margin-top:14px">支持上传任意文件，单文件不超过 20MB。xlsx、xls、docx 可预览，PDF 可在浏览器中打开。</div>

    <!-- 固定系统文件 -->
    <el-card style="margin:14px 0;--el-card-bg-color:#f4f8fe" shadow="never">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <div>
          <div style="font-weight:600">固定系统文件：{{ docs.surveyTemplate.name || '现场勘察记录模板.docx' }}</div>
          <div style="color:#888;font-size:12px;margin-top:6px">已上传：{{ docs.surveyTemplate.uploader }} · {{ docs.surveyTemplate.uploadedAt }}</div>
          <div style="color:#e6a23c;font-size:12px;margin-top:6px">生成现场勘察记录时使用此模板；固定文件不可移动或删除，只能替换。</div>
        </div>
        <div style="flex-shrink:0">
          <el-button type="primary" @click="triggerReplace">替换现场勘察记录模板</el-button>
        </div>
      </div>
      <input ref="replaceInput" type="file" accept=".docx" style="display:none" @change="onReplace" />
    </el-card>

    <!-- 分类文件 -->
    <el-tabs v-model="activeCat">
      <el-tab-pane v-for="c in docs.categories" :key="c" :label="c + '（' + docs.files.filter(f=>f.category===c).length + '）'" :name="c" />
    </el-tabs>
    <div style="margin-bottom:12px">
      <el-button type="primary" @click="triggerUpload">上传文件到「{{ activeCat }}」</el-button>
      <input ref="uploadInput" type="file" style="display:none" @change="onUpload" />
    </div>
    <el-table :data="pagedFiles" border stripe>
      <el-table-column prop="name" label="文件名" min-width="240" show-overflow-tooltip />
      <el-table-column prop="uploader" label="上传人" width="110" />
      <el-table-column prop="uploadedAt" label="上传时间" width="150" />
      <el-table-column label="移动到" width="130">
        <template #default="{row}">
          <el-select :model-value="row.category" size="small" style="width:112px" :disabled="!!row.fixed" @change="v=>moveFile(row,v)">
            <el-option v-for="c in docs.categories" :key="c" :label="c" :value="c" />
          </el-select>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{row}">
          <el-button link type="primary" size="small" @click="download(row)">下载</el-button>
          <el-button link type="primary" size="small" @click="preview(row)">预览</el-button>
          <el-tooltip v-if="row.fixed" content="固定系统文件不可删除" placement="top">
            <el-button link type="info" size="small" disabled>删除</el-button>
          </el-tooltip>
          <el-button v-else link type="danger" size="small" @click="removeFile(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:12px">
      <span style="color:#666;font-size:13px">共 {{ catFiles.length }} 条</span>
      <el-pagination background layout="prev, pager, next" :total="catFiles.length" :page-size="filePageSize" :current-page="filePage" @current-change="p=>filePage=p" />
      <el-select :model-value="filePageSize" size="small" style="width:104px" @change="n=>{filePageSize=n;filePage=1}">
        <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
      </el-select>
    </div>

    <!-- 新增/编辑危险点 -->
    <el-dialog :title="hazardEditing ? '编辑危险点' : '新增危险点'" v-model="hazardDialog" width="640px">
      <el-form :model="hazardForm" label-position="top">
        <el-form-item label="危险点" required>
          <el-input v-model="hazardForm.hazard" type="textarea" :rows="3" maxlength="1000" show-word-limit />
        </el-form-item>
        <el-form-item label="风险大类">
          <el-select v-model="hazardForm.category" placeholder="选择所属风险大类（影响计划里按类带出措施）" clearable style="width:100%">
            <el-option v-for="c in HAZARD_CATEGORIES" :key="c" :label="c" :value="c" />
            <el-option label="（未归类）" value="" />
          </el-select>
        </el-form-item>
        <el-form-item label="控制措施" required>
          <el-input v-model="hazardForm.measure" type="textarea" :rows="5" maxlength="4000" show-word-limit />
        </el-form-item>
        <el-form-item label="排序（小的在前；新增留空则排在末尾）">
          <el-input-number v-model="hazardForm.sort" :min="0" style="width:180px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hazardDialog=false">取消</el-button>
        <el-button type="primary" @click="submitHazard">确定</el-button>
      </template>
    </el-dialog>

    <!-- 预览 -->
    <el-dialog :title="'预览 - ' + previewData.name" v-model="previewVisible" width="1080px" top="5vh">
      <div v-if="previewData.kind==='docx'" style="max-height:66vh;overflow:auto;font-family:SimSun,serif;font-size:14px;line-height:1.9;border:1px solid #ebeef5;padding:16px 24px;background:#fff">
        <p v-for="(l,i) in previewData.lines" :key="i" style="margin:2px 0;white-space:pre-wrap">{{ l }}</p>
      </div>
      <div v-else-if="previewData.kind==='xlsx' && previewSheet" style="max-height:66vh;overflow:auto">
        <el-table :data="previewPaged" border size="small" max-height="560">
          <el-table-column v-for="(c,ci) in previewHeader.length" :key="ci" :label="String(previewHeader[ci] || ('列' + (ci+1)))"
            :width="ci < 2 ? 170 : undefined" :min-width="ci < 2 ? undefined : 300">
            <template #default="{row}">{{ fmtCell(row[ci]) }}</template>
          </el-table-column>
        </el-table>
        <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:10px">
          <span style="color:#666;font-size:13px">共 {{ previewRows.length }} 条</span>
          <el-pagination background layout="prev, pager, next" :total="previewRows.length" :page-size="100" :current-page="previewPage" @current-change="p=>previewPage=p" />
          <span style="color:#666;font-size:13px">100 条/页</span>
        </div>
      </div>
      <div v-else-if="previewData.kind==='pdf'" style="text-align:center;padding:40px 0">
        <p style="color:#666;margin-bottom:14px">PDF 文件可在浏览器中直接打开</p>
        <el-button type="primary" @click="window.open(previewData.url,'_blank')">在浏览器中打开</el-button>
      </div>
      <div v-else style="text-align:center;padding:40px 0;color:#999">{{ previewData.message || '该文件类型暂不支持预览' }}</div>
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
        await ElementPlus.ElMessageBox.confirm('确认删除该物料？', '提示', { type: 'warning' });
        await api.del('/api/materials/' + row.id); ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
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
      load, onSel, canSelect, openAdd, colFilters, tmpFilters, projectFilterOptions, unitOptions, sourceFilterOptions, statusFilterOptions, fActive, applyTmp, resetTmp, resetArr, openEdit, submit, remove, addStaging, showStaging, staging, stagingQty, mainTable, stagingVisible, stagingPage, stagingPageSize, stagingRows, stagedProjects, removeStaging, clearStaging, genRequisition, relDlg, relPaged, openRelated, relLoad, relItem, relHist, relStatusType, relDownload, relVoid, downloadTemplate, importMaterials, chipStyle, fmtQty, fmt2, outMap, goOutbound };
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
        <el-button @click="importMaterials">导入材料表</el-button>
        <el-button @click="openAdd">新增材料</el-button>
        <el-button :disabled="!selection.length" @click="addStaging">加入暂存（{{ selection.length }}）</el-button>
        <el-button @click="showStaging">暂存清单（{{ staging.length }}）</el-button>
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

      <div style="display:flex;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div style="background:#fff;border:1px solid #e7e9ec;border-radius:4px;padding:14px 20px;min-width:180px">
          <div style="color:#86909c;font-size:12px">材料（全部筛选结果）</div>
          <div style="font-size:24px;font-weight:700;color:#3370ff;margin-top:6px">{{ statCount }}</div>
        </div>
        <div style="background:#fff;border:1px solid #e7e9ec;border-radius:4px;padding:14px 20px;min-width:280px">
          <div style="color:#86909c;font-size:12px">全部需求总数量/已到/未到</div>
          <div style="font-size:18px;font-weight:700;color:#3370ff;margin-top:8px">{{ fmt2(sumRequired) }} / {{ fmt2(sumArrived) }} / {{ fmt2(sumNot) }}</div>
        </div>
        <div style="background:#fff;border:1px solid #e7e9ec;border-radius:4px;padding:14px 20px;min-width:150px">
          <div style="color:#86909c;font-size:12px">全部 / 部分</div>
          <div style="font-size:18px;font-weight:700;margin-top:8px"><span style="color:#389e0d">{{ fullCount }}</span>&nbsp;&nbsp;<span style="color:#e6932c">{{ partCount }}</span></div>
        </div>
        <div style="background:#fff;border:1px solid #e7e9ec;border-radius:4px;padding:14px 20px;min-width:170px">
          <div style="color:#86909c;font-size:12px">未到 / 异常 / 无效</div>
          <div style="font-size:18px;font-weight:700;margin-top:8px"><span style="color:#f56c6c">{{ notCount }}</span>&nbsp;&nbsp;<span style="color:#999">0</span>&nbsp;&nbsp;<span style="color:#999">0</span></div>
        </div>
      </div>

      <el-table ref="mainTable" :data="filtered" v-loading="loading" border stripe style="width:100%" @selection-change="onSel">
        <el-table-column type="selection" width="46" :selectable="canSelect" />
        <el-table-column prop="project" min-width="220" show-overflow-tooltip>
          <template #header><div class="th-inner"><span>项目名称</span>
            <el-popover placement="bottom-end" trigger="click" :width="200">
              <template #reference><funnel-icon :on="fActive('project')" /></template>
              <el-select v-model="colFilters.project" multiple filterable collapse-tags placeholder="筛选项目" size="small" style="width:100%">
                <el-option v-for="n in projectFilterOptions" :key="n" :label="n" :value="n" />
              </el-select>
              <div style="text-align:right;margin-top:8px"><el-button size="small" @click="resetArr('project')">重置</el-button></div>
            </el-popover>
          </template>
          <template #default="{row}">{{ row.project }}</template>
        </el-table-column>
        <el-table-column prop="description" min-width="200">
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
            <div>{{ row.description }}</div>
            <div v-if="outMap[row.id]" style="margin-top:4px;display:flex;align-items:center;gap:8px">
              <span :style="chipStyle('#3370ff')">有出库记录</span>
              <el-link type="primary" :underline="false" style="font-size:12px" @click="goOutbound(row)">查看出库单</el-link>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="数量" min-width="215" align="left">
          <template #header><span>数量</span></template>
          <template #default="{row}">
            <div style="white-space:nowrap">应到 {{ fmtQty(row.qtyRequired) }} / 已到 {{ fmtQty(row.qtyArrived) }} / 未到 {{ fmtQty(row.qtyNotArrived) }}</div>
            <div style="color:#3370ff;font-size:12px;line-height:18px;white-space:nowrap">已生成领料单 {{ fmtQty(row.qtyGenerated || 0) }} / 可继续领料 {{ fmtQty(row.qtyCanGen || 0) }}</div>
            <div style="margin-top:3px;display:flex;align-items:center;gap:8px;white-space:nowrap">
              <span v-if="(Number(row.qtyNotArrived) || 0) > 0" :style="chipStyle('#389e0d')">累计未入库</span>
              <span v-if="(Number(row.qtyArrived) || 0) > 0" style="color:#909399;font-size:12px">累计入库 {{ fmtQty(row.qtyArrived) }} {{ row.unit || '' }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="unit" width="80">
          <template #header><div class="th-inner"><span>单位</span>
            <el-popover placement="bottom-end" trigger="click" :width="140">
              <template #reference><funnel-icon :on="fActive('unit')" /></template>
              <el-checkbox-group v-model="colFilters.unit">
                <div v-for="u in unitOptions" :key="u" style="margin:2px 0"><el-checkbox :label="u">{{ u }}</el-checkbox></div>
              </el-checkbox-group>
              <div style="text-align:right;margin-top:6px"><el-button size="small" @click="resetArr('unit')">重置</el-button></div>
            </el-popover>
          </template>
          <template #default="{row}">{{ row.unit }}</template>
        </el-table-column>
        <el-table-column prop="code" width="130">
          <template #header><div class="th-inner"><span>物料编码</span>
            <el-popover placement="bottom-end" trigger="click" :width="210">
              <template #reference><funnel-icon :on="fActive('code')" /></template>
              <el-input v-model="tmpFilters.code" size="small" placeholder="筛选物料编码" @keyup.enter="applyTmp('code')" clearable />
              <div style="text-align:right;margin-top:8px">
                <el-button size="small" type="primary" @click="applyTmp('code')">筛选</el-button>
                <el-button size="small" @click="resetTmp('code')">重置</el-button>
              </div>
            </el-popover>
          </template>
          <template #default="{row}">{{ row.code }}</template>
        </el-table-column>
        <el-table-column prop="orderNo" width="115">
          <template #header><div class="th-inner"><span>采购订单号</span>
            <el-popover placement="bottom-end" trigger="click" :width="210">
              <template #reference><funnel-icon :on="fActive('orderNo')" /></template>
              <el-input v-model="tmpFilters.orderNo" size="small" placeholder="筛选采购订单号" @keyup.enter="applyTmp('orderNo')" clearable />
              <div style="text-align:right;margin-top:8px">
                <el-button size="small" type="primary" @click="applyTmp('orderNo')">筛选</el-button>
                <el-button size="small" @click="resetTmp('orderNo')">重置</el-button>
              </div>
            </el-popover>
          </template>
          <template #default="{row}">{{ row.orderNo }}</template>
        </el-table-column>
        <el-table-column prop="source" width="115">
          <template #header><div class="th-inner"><span>来源</span>
            <el-popover placement="bottom-end" trigger="click" :width="160">
              <template #reference><funnel-icon :on="fActive('source')" /></template>
              <el-checkbox-group v-model="colFilters.source">
                <div v-for="s in sourceFilterOptions" :key="s" style="margin:2px 0"><el-checkbox :label="s">{{ s }}</el-checkbox></div>
              </el-checkbox-group>
              <div style="text-align:right;margin-top:6px"><el-button size="small" @click="resetArr('source')">重置</el-button></div>
            </el-popover>
          </template>
          <template #default="{row}"><span :style="chipStyle(sourceColors[row.source] || '#909399')">{{ row.source }}</span></template>
        </el-table-column>
        <el-table-column prop="status" width="110">
          <template #header><div class="th-inner"><span>状态</span>
            <el-popover placement="bottom-end" trigger="click" :width="170">
              <template #reference><funnel-icon :on="fActive('status')" /></template>
              <el-checkbox-group v-model="colFilters.status">
                <div v-for="s in statusFilterOptions" :key="s.label" style="margin:2px 0">
                  <el-checkbox :label="s.label"><span v-if="s.color" :style="chipStyle(s.color)">{{ s.label }}</span><template v-else>{{ s.label }}</template></el-checkbox>
                </div>
              </el-checkbox-group>
              <div style="text-align:right;margin-top:6px"><el-button size="small" @click="resetArr('status')">重置</el-button></div>
            </el-popover>
          </template>
          <template #default="{row}"><span :style="chipStyle(statusColors[row.status] || '#909399') + 'cursor:pointer'" title="点击查看关联领料单" @click="openRelated(row)">{{ row.status }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{row}">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
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
              <div style="color:#999;font-size:12px;line-height:18px;margin-top:2px">可继续领料 {{ fmtQty(row.qtyCanGen) }} {{ row.unit }}（应到 {{ fmtQty(row.qtyRequired) }} / 已生成 {{ fmtQty(row.qtyGenerated) }}）</div>
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
            <div style="color:#999;font-size:12px;margin-top:4px">显示本材料关联的全部领料单，包含已入库和已作废记录；展开查看材料明细及入库记录。</div>
          </div>
        </template>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span style="font-weight:600">领料单</span>
          <el-button size="small" @click="relLoad">刷新领料单</el-button>
        </div>
        <el-table :data="relPaged" border style="width:100%">
          <el-table-column type="expand">
            <template #default="{row}">
              <div style="padding:10px 24px 16px;background:#fafbfc">
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
                <div v-else style="color:#999;font-size:12px">暂无入库记录（确认入库/补入库后按次记录）</div>
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
          <div style="color:#999;font-size:12px;margin-top:2px">{{ editingId ? '修改了应到数量时必填。' : '新增材料不需要填写。' }}</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible=false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>`
};

/* 领料单：暂存清单生成 → 下载 Excel → 确认入库/作废（按原系统截图实现） */
const importCfg = {
  endpoint: 'materialImports', title: '导入批次',
  columns: [
    { key: 'batch', label: '批次号', width: 140 }, { key: 'fileName', label: '文件名' }, { key: 'rows', label: '行数', width: 80 },
    { key: 'importedBy', label: '导入人', width: 100 }, { key: 'importedAt', label: '导入时间', width: 170 }, { key: 'status', label: '状态', tag: true, width: 90 }
  ],
  formFields: [
    { key: 'batch', label: '批次号' }, { key: 'fileName', label: '文件名' }, { key: 'rows', label: '行数', type: 'number' },
    { key: 'importedBy', label: '导入人' }, { key: 'importedAt', label: '导入时间' }, { key: 'status', label: '状态', type: 'select', options: [{ label: '成功', value: '成功' }, { label: '失败', value: '失败' }] }
  ]
};
const outboundCfg = {
  endpoint: 'materialOutbound', title: '出库管理',
  columns: [
    { key: 'project', label: '项目' }, { key: 'material', label: '物料' }, { key: 'qty', label: '数量', width: 80 },
    { key: 'recipient', label: '领用人', width: 120 }, { key: 'date', label: '日期', width: 120 }, { key: 'status', label: '状态', tag: true, width: 100 }
  ],
  formFields: [
    { key: 'project', label: '项目' }, { key: 'material', label: '物料' }, { key: 'qty', label: '数量', type: 'number' },
    { key: 'recipient', label: '领用人' }, { key: 'date', label: '日期' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '待出库', value: '待出库' }, { label: '已出库', value: '已出库' }] }
  ]
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
      <el-col :span="4" :xs="12"><div class="stat-card"><div class="num" style="color:#52c41a">在线</div><div class="label">当前用户：{{ me.name || me.username || '-' }}</div></div></el-col>
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
const materialCatalogCfg = {
  endpoint: 'materialCatalog', title: '材料目录', dialogTitle: '材料目录',
  columns: [ { key: 'name', label: '材料名称' }, { key: 'alias', label: '别名（不同写法）' }, { key: 'unit', label: '单位', width: 100 }, { key: 'baseQuantity', label: '基数', width: 90 } ],
  formFields: [ { key: 'name', label: '材料名称', required: true }, { key: 'alias', label: '别名（识别不同写法）' }, { key: 'unit', label: '单位' }, { key: 'baseQuantity', label: '材料基数', type: 'number' } ]
};

const SettingsView = {
  setup() {
    const active = ref('annualPlans');
    const site = reactive({ companyName: '', icp: '', systemName: '', defaultSource: '甲供材料', allowSelfPurchase: true, loginBg: '', loginBgMode: 'cover', welcome: { greeting: '', logoUrl: '' } });
    const savedName = ref('');
    async function loadSite() {
      try {
        const s = await api.get('/api/settings');
        Object.assign(site, s);
        if (!site.welcome) site.welcome = { greeting: '', logoUrl: '' };
        if (!site.loginBgMode) site.loginBgMode = 'cover';
        savedName.value = s.companyName || '';
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
      { key: 'ink-color', label: '千里江山', desc: '彩色水墨', url: '/login-bg/ink-color.jpg' },
      { key: 'ink-gray', label: '水墨烟山', desc: '青灰淡墨', url: '/login-bg/ink-gray.jpg' },
      { key: 'network', label: '网络节点', desc: '黑白科技', url: '/login-bg/network.jpg' }
    ];
    // 铺展方式（对齐 Windows 壁纸的几种模式）
    const LOGIN_BG_MODES = [
      { key: 'cover', label: '填充', desc: '等比放大铺满，多余裁掉' },
      { key: 'contain', label: '适应', desc: '完整显示，留出边距' },
      { key: 'stretch', label: '拉伸', desc: '强制拉满，可能变形' },
      { key: 'tile', label: '平铺', desc: '按原尺寸重复铺排' },
      { key: 'center', label: '居中', desc: '原尺寸居中，不缩放' }
    ];
    const bgSaving = ref(false);
    const bgUploading = ref(false);
    const bgDeleting = ref(false);
    // 设置页实时预览：跟随所选背景与铺展方式
    const previewStyle = computed(() => {
      const url = site.loginBg || '/login-bg/ink-color.jpg';
      const s = { backgroundImage: `url('${url}')`, backgroundColor: '#e9edf2' };
      switch (site.loginBgMode) {
        case 'contain': s.backgroundSize = 'contain'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center'; break;
        case 'stretch': s.backgroundSize = '100% 100%'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center'; break;
        case 'tile': s.backgroundSize = 'auto'; s.backgroundRepeat = 'repeat'; s.backgroundPosition = 'top left'; break;
        case 'center': s.backgroundSize = 'auto'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center'; break;
        default: s.backgroundSize = 'cover'; s.backgroundRepeat = 'no-repeat'; s.backgroundPosition = 'center';
      }
      return s;
    });
    async function saveLoginBg() {
      bgSaving.value = true;
      try {
        await api.put('/api/settings', { loginBg: site.loginBg, loginBgMode: site.loginBgMode });
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
    return { active, site, savedName, loadSite, saveSite, saveWelcome, annualPlanCfg, substationCfg, teamCfg, materialCatalogCfg, UNIT_TYPES, units, unitDlg, unitsOf, openUnitAdd, openUnitEdit, submitUnit, removeUnit, LOGIN_BG_PRESETS, LOGIN_BG_MODES, bgSaving, bgUploading, bgDeleting, previewStyle, saveLoginBg, uploadLoginBg, deleteLoginBg, isLoginBgPreset, isLoginBgCustom };
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
              <el-button type="primary" size="small" @click="openUnitAdd(t)">新 增</el-button>
            </div>
          </template>
          <el-table :data="unitsOf(t)" size="small">
            <el-table-column prop="name" label="单位名称" min-width="260" />
            <el-table-column prop="sort" label="排序" width="110" />
            <el-table-column label="操作" width="150" align="center">
              <template #default="{row}">
                <el-button link type="primary" size="small" @click="openUnitEdit(row)">编辑</el-button>
                <el-button link type="danger" size="small" @click="removeUnit(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty><span style="color:#909399;font-size:12px">暂无数据</span></template>
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
          <div style="color:#666;font-size:13px;line-height:1.8;margin-bottom:14px">
            选择预设背景或上传本机图片，作为访客登录页的全屏背景。建议使用 1920×1080 及以上的横图，JPG / PNG / WebP / GIF，不超过 10MB。
          </div>

          <!-- 当前背景预览 + 铺展方式 -->
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px;align-items:flex-start">
            <div style="flex:0 1 auto;max-width:100%;min-width:0">
              <div style="font-size:13px;color:#4e5969;margin-bottom:6px">实时预览</div>
              <div :style="previewStyle"
                   style="width:360px;max-width:100%;height:203px;border:1px solid #e7e9ec;border-radius:4px;overflow:hidden"></div>
            </div>
            <div style="flex:1 1 300px;min-width:260px">
              <div style="font-size:13px;color:#4e5969;margin-bottom:6px">铺展方式（同 Windows 壁纸）</div>
              <el-radio-group v-model="site.loginBgMode" size="small" style="display:flex;flex-wrap:wrap;gap:8px">
                <el-radio-button v-for="m in LOGIN_BG_MODES" :key="m.key" :value="m.key" :label="m.key">{{ m.label }}</el-radio-button>
              </el-radio-group>
              <div style="margin-top:8px;font-size:12px;color:#909399;line-height:1.7">
                {{ (LOGIN_BG_MODES.find(m => m.key === site.loginBgMode) || {}).desc || '' }}
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
                     border: site.loginBg === p.url ? '2px solid #3370ff' : '1px solid #e7e9ec',
                     borderRadius:'4px', height:'104px', backgroundSize:'cover', backgroundPosition:'center'
                   }"></div>
              <div style="margin-top:6px;font-size:13px;color:#1f2d3d;display:flex;justify-content:space-between;align-items:center">
                <span>{{ p.label }}</span>
                <el-tag v-if="site.loginBg === p.url" type="primary" size="small">使用中</el-tag>
              </div>
              <div style="font-size:12px;color:#999">{{ p.desc }}</div>
            </div>
            <div style="width:186px">
              <div style="border:1px dashed #d4d8de;border-radius:4px;height:104px;display:flex;align-items:center;justify-content:center;background:#fafbfc">
                <el-upload
                  :show-file-list="false"
                  accept=".jpg,.jpeg,.png,.webp,.gif,image/*"
                  :http-request="uploadLoginBg">
                  <el-button size="small" type="primary" plain :loading="bgUploading">上传本机图片</el-button>
                </el-upload>
              </div>
              <div style="margin-top:6px;font-size:12px;color:#999;line-height:1.6">
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
            <el-button type="primary" :loading="bgSaving" @click="saveLoginBg">保存背景设置</el-button>
            <el-button type="danger" plain :loading="bgDeleting" :disabled="!isLoginBgCustom(site.loginBg)" @click="deleteLoginBg">删除自定义背景</el-button>
          </div>
        </el-card>
      </el-tab-pane>
      <el-tab-pane label="网站设置" name="site">
        <el-card style="margin-bottom:16px">
          <template #header><b>网站标题（最多 128 个字符）</b></template>
          <div style="color:#666;font-size:13px;line-height:1.8;margin-bottom:12px">这里保存的网站标题作为初始化的企业名称。其他标签的设置不会代替企业名称保存；填写后点击下方"保存"。</div>
          <el-alert v-if="savedName" type="success" :closable="false" style="margin-bottom:12px">
            <template #title>已保存企业名称：{{ savedName }}</template>
          </el-alert>
          <el-input v-model="site.companyName" :placeholder="savedName || '请输入企业名称'" maxlength="128" show-word-limit style="max-width:640px" />
          <div style="margin-top:12px"><el-button type="primary" @click="saveSite">保存</el-button></div>
        </el-card>

        <el-card>
          <template #header>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <b>企业欢迎页</b>
              <el-button size="small" @click="loadSite">重新读取</el-button>
            </div>
          </template>
          <div style="color:#666;font-size:13px;line-height:1.8;margin-bottom:12px">设置访客登录前看到的企业介绍和 Logo。访客只会看到欢迎内容，不会看到企业内部资料。</div>
          <el-form label-position="top">
            <el-form-item label="欢迎语（最多 500 个字符）">
              <el-input v-model="site.welcome.greeting" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="欢迎来到我们的企业工作台" style="max-width:720px" />
            </el-form-item>
            <el-form-item label="企业 Logo 图片地址（最多 2048 个字符）">
              <el-input v-model="site.welcome.logoUrl" maxlength="2048" placeholder="https://... 或 /images/logo.png" style="max-width:720px" />
              <div style="color:#999;font-size:12px;margin-top:6px">建议使用 PNG、JPG、WebP。比例建议 1:1、推荐 512×512、最小建议 128×128，文件建议不超过 500KB。填写 https:// 图片地址或站内 / 图片路径；系统校验地址格式，不会读取或远程图片核验尺寸或文件大小。</div>
            </el-form-item>
            <el-button type="primary" @click="saveWelcome">保存欢迎页</el-button>
          </el-form>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>`
};

/* 用户管理 — 标签页1：登录账号列表 */
const userCfg = {
  endpoint: 'users', title: '用户',
  columns: [
    { key: 'username', label: '账号', width: 120 }, { key: 'name', label: '姓名', width: 120 },
    { key: 'role', label: '角色', width: 110 }, { key: 'spaceId', label: '绑定空间', width: 150 },
    { key: 'status', label: '状态', width: 90 }, { key: 'phone', label: '电话' }
  ],
  formFields: [
    { key: 'username', label: '账号', required: true }, { key: 'name', label: '姓名', required: true },
    { key: 'role', label: '角色', type: 'select', options: [{ label: '超级用户', value: '超级用户' }, { label: '资料员', value: '资料员' }, { label: '班组长', value: '班组长' }, { label: '访客', value: '访客' }] },
    { key: 'password', label: '密码' }, { key: 'phone', label: '电话' }
  ]
};

/* 用户管理 — 标签页3：外部通讯录 */
const contactCfg = {
  endpoint: 'contacts', title: '外部通讯录',
  columns: [
    { key: 'name', label: '姓名', width: 120 }, { key: 'unit', label: '单位' },
    { key: 'post', label: '职务', width: 140 }, { key: 'phone', label: '电话', width: 160 },
    { key: 'remark', label: '备注' }
  ],
  formFields: [
    { key: 'name', label: '姓名', required: true }, { key: 'unit', label: '单位' },
    { key: 'post', label: '职务' }, { key: 'phone', label: '电话' }, { key: 'remark', label: '备注' }
  ]
};

/* 用户管理 — 标签页2：作业人员名单（对齐原系统截图） */
const WORKER_IDENTITY_OPTIONS = ['技工（计入高处作业人员）', '民工', '其他技工（不计入高处作业人员）'];
const WORKER_CERT_OPTIONS = ['高压电工', '低压电工', '高处', '电力电缆作业', '电气试验', '司索工', '吊车司机', '挖机操作工'];

const WorkersPanel = {
  setup() {
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
      return (row.certTypes && row.certTypes.length) ? row.certTypes.join('、') : '-';
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
    return { list, teams, loading, filters, page, pageSize, filtered, paged, resetFilters, dialogVisible, editing, form, fileInput,
      openAdd, openEdit, submit, togglePending, remove, downloadTemplate, downloadExport, triggerImport, onFileChange,
      fmtValid, fmtCerts, WORKER_IDENTITY_OPTIONS, WORKER_CERT_OPTIONS };
  },
  template: `
  <div>
    <el-alert type="info" :closable="false" style="margin-bottom:14px">
      <template #title><b>配置说明</b></template>
      <div style="line-height:1.8">作业人员名单用于维护所参与现场作业、可在周计划和工作票中选择的人员，与登录账号分开管理，作业人员无需登录系统；建议维护姓名、电话、身份、班组、证件类型和准入有效期。移入待定后，该人员不再供周计划选择。</div>
    </el-alert>

    <div class="toolbar">
      <el-button type="primary" @click="openAdd">新增</el-button>
      <el-button type="primary" @click="triggerImport">选择文件导入</el-button>
      <span style="color:#888;font-size:12px;margin:0 6px">支持 .csv、.xls、.xlsx；请按模板填写，身份证号、手机号和有效期格式错误时整批不会导入。</span>
      <el-button link type="primary" @click="downloadExport">下载</el-button>
      <el-button link type="primary" @click="downloadTemplate">下载模板</el-button>
      <input ref="fileInput" type="file" accept=".csv,.xls,.xlsx" style="display:none" @change="onFileChange" />
    </div>

    <div class="toolbar">
      <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:150px" @input="page=1" />
      <el-select v-model="filters.identity" placeholder="身份" clearable style="width:230px" @change="page=1">
        <el-option v-for="o in WORKER_IDENTITY_OPTIONS" :key="o" :label="o" :value="o" />
      </el-select>
      <el-select v-model="filters.team" placeholder="班组" clearable style="width:150px" @change="page=1">
        <el-option v-for="t in teams" :key="t.id" :label="t.name" :value="t.name" />
      </el-select>
      <el-button @click="resetFilters">重置</el-button>
      <span style="color:#999;font-size:12px;margin-left:8px">由资料员或管理员维护，无需为每名作业人员创建登录账号</span>
    </div>

    <el-table :data="paged" v-loading="loading" border stripe style="width:100%">
      <el-table-column prop="name" label="姓名" min-width="90" />
      <el-table-column prop="identity" label="身份" min-width="190" />
      <el-table-column prop="team" label="班组" min-width="110" />
      <el-table-column label="证件类型" min-width="130"><template #default="{row}">{{ fmtCerts(row) }}</template></el-table-column>
      <el-table-column label="准入有效期" min-width="220"><template #default="{row}">{{ fmtValid(row) }}</template></el-table-column>
      <el-table-column prop="idNumber" label="身份证号" min-width="180" />
      <el-table-column prop="phone" label="电话号码" min-width="130" />
      <el-table-column label="状态" width="90">
        <template #default="{row}">
          <el-tag :type="row.status==='待定' ? 'warning' : 'success'" size="small">{{ row.status || '已准入' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{row}">
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" size="small" @click="togglePending(row)">{{ row.status==='待定' ? '恢复准入' : '待定库' }}</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div style="display:flex;justify-content:flex-end;margin-top:12px">
      <el-pagination background layout="prev, pager, next" :total="filtered.length" :page-size="pageSize" :current-page="page" @current-change="p=>page=p" />
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
  </div>`
};

/* 团队管理（母账号 + 团队子空间）
   母账号：全部团队；可新建/编辑/停启用/解散团队、一键清空、管理任意团队成员与权限、查看审计日志
   团队管理员：仅自己管理的团队；可添加成员并分配「查看/录入/导出/审批」权限；无新建/解散/清空权 */
const TeamsPanel = {
  setup() {
    const { ref, reactive, onMounted } = Vue;
    const EP = ElementPlus;
    const me = ref({ isParent: false, isTeamAdmin: false });
    const teams = ref([]);
    const audit = ref([]);
    const loading = ref(false);
    const PERMS = ['查看', '录入', '导出', '审批'];
    const STATUS_TAG = { active: 'success', disabled: 'danger' };

    const teamDlg = reactive({ visible: false, mode: 'create', id: '', name: '', busy: false });
    const resetDlg = reactive({ visible: false, team: null, reason: '', busy: false });
    const resetConfirm = ref('');
    const memberDlg = reactive({ visible: false, teamId: '', teamName: '', busy: false });
    const members = ref([]);
    const allAccounts = ref([]);
    const memberForm = reactive({ username: '', role: '团队成员', permissions: ['查看', '录入'] });

    async function load() {
      loading.value = true;
      try {
        teams.value = await api.get('/api/biz-teams');
        const m = await api.get('/api/me');
        me.value = m.user; me.value.isTeamAdmin = m.isTeamAdmin;
        if (m.user.isParent) { try { audit.value = await api.get('/api/audit-logs'); } catch (e) {} }
      } catch (e) { EP.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openCreate() { teamDlg.mode = 'create'; teamDlg.id = ''; teamDlg.name = ''; teamDlg.visible = true; }
    function openEdit(row) { teamDlg.mode = 'edit'; teamDlg.id = row.id; teamDlg.name = row.name; teamDlg.visible = true; }
    async function saveTeam() {
      if (!teamDlg.name.trim()) { EP.ElMessage.warning('请填写团队名称'); return; }
      teamDlg.busy = true;
      try {
        if (teamDlg.mode === 'create') await api.post('/api/biz-teams', { name: teamDlg.name.trim() });
        else await api.put('/api/biz-teams/' + teamDlg.id, { name: teamDlg.name.trim() });
        teamDlg.visible = false; EP.ElMessage.success('已保存'); load();
      } catch (e) { EP.ElMessage.error(e.message); }
      finally { teamDlg.busy = false; }
    }
    async function toggleStatus(row) {
      try { await api.put('/api/biz-teams/' + row.id, { status: row.status === 'active' ? 'disabled' : 'active' }); load(); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    async function removeTeam(row) {
      try {
        await EP.ElMessageBox.confirm('解散团队「' + row.name + '」将物理删除其全部业务数据与附件，且不可恢复。确定解散？', '解散团队（高危）', { type: 'error', confirmButtonText: '确定解散', cancelButtonText: '取消' });
      } catch (e) { return; }
      try { const r = await api.del('/api/biz-teams/' + row.id); EP.ElMessage.success('已解散，清除 ' + (r.deletedCount || 0) + ' 条数据'); load(); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    function openReset(row) { resetDlg.team = row; resetDlg.reason = ''; resetConfirm.value = ''; resetDlg.visible = true; }
    async function doReset() {
      if (!resetDlg.reason.trim()) { EP.ElMessage.warning('请填写清空原因'); return; }
      if (resetConfirm.value !== '确认清空') { EP.ElMessage.warning('请在下方输入「确认清空」以二次确认'); return; }
      resetDlg.busy = true;
      try {
        const r = await api.post('/api/biz-teams/' + resetDlg.team.id + '/reset', { reason: resetDlg.reason.trim() });
        EP.ElMessage.success('已清空：删除 ' + (r.deletedCount || 0) + ' 条业务数据、' + (r.fileCount || 0) + ' 个附件；团队与成员已保留');
        resetDlg.visible = false; load();
      } catch (e) { EP.ElMessage.error(e.message); }
      finally { resetDlg.busy = false; }
    }
    async function openMembers(row) {
      memberDlg.teamId = row.id; memberDlg.teamName = row.name; memberDlg.visible = true;
      memberForm.username = ''; memberForm.role = '团队成员'; memberForm.permissions = ['查看', '录入'];
      if (me.value.isParent) { try { allAccounts.value = await api.get('/api/users'); } catch (e) { allAccounts.value = []; } }
      await loadMembers();
    }
    async function loadMembers() {
      try { members.value = await api.get('/api/biz-teams/' + memberDlg.teamId + '/members'); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    async function addMember() {
      const username = (memberForm.username || '').trim();
      if (!username) { EP.ElMessage.warning('请填写账号'); return; }
      memberDlg.busy = true;
      try {
        await api.post('/api/biz-teams/' + memberDlg.teamId + '/members', { username, role: memberForm.role, permissions: memberForm.permissions });
        EP.ElMessage.success('已添加成员'); memberForm.username = ''; await loadMembers(); load();
      } catch (e) { EP.ElMessage.error(e.message); }
      finally { memberDlg.busy = false; }
    }
    async function updateMember(m) {
      try { await api.put('/api/team-members/' + m.id, { role: m.role, permissions: m.permissions }); EP.ElMessage.success('已更新'); }
      catch (e) { EP.ElMessage.error(e.message); await loadMembers(); }
    }
    async function removeMember(m) {
      try { await EP.ElMessageBox.confirm('确定将「' + m.name + '」移出团队？', '移除成员', { type: 'warning' }); }
      catch (e) { return; }
      try { await api.del('/api/team-members/' + m.id); EP.ElMessage.success('已移除'); await loadMembers(); load(); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    onMounted(load);
    return { me, teams, audit, loading, PERMS, STATUS_TAG, teamDlg, openCreate, openEdit, saveTeam, toggleStatus, removeTeam, resetDlg, resetConfirm, openReset, doReset, memberDlg, members, allAccounts, memberForm, openMembers, addMember, updateMember, removeMember };
  },
  template: `
  <div>
    <el-alert type="warning" :closable="false" show-icon title="团队 = 独立业务空间"
      :description="me.isParent ? '母账号可创建/停用/解散团队、一键清空指定团队全部业务数据（物理删除，保留团队/成员/字典/日志），并查看全部团队审计日志。团队成员仅见本团队数据，团队之间互相隔离。' : '您是本团队的管理员：可添加成员并分配「查看/录入/导出/审批」权限；团队空间清空权仅归母账号。'" style="margin-bottom:12px" />
    <div style="margin-bottom:12px" v-if="me.isParent">
      <el-button type="primary" @click="openCreate">+ 新建团队</el-button>
    </div>
    <el-table :data="teams" v-loading="loading" border stripe style="width:100%">
      <el-table-column prop="name" label="团队名称" min-width="150" />
      <el-table-column label="团队管理员" min-width="140">
        <template #default="{ row }">
          <span v-if="row.admins && row.admins.length">{{ row.admins.map(a => a.name).join('、') }}</span>
          <span v-else style="color:#c0c4cc">未设置</span>
        </template>
      </el-table-column>
      <el-table-column prop="memberCount" label="成员数" width="80" />
      <el-table-column prop="recordCount" label="业务记录" width="90" />
      <el-table-column prop="fileCount" label="附件" width="70" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }"><el-tag :type="STATUS_TAG[row.status] || 'info'">{{ row.status === 'active' ? '启用' : '已停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="290" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openMembers(row)">成员/权限</el-button>
          <template v-if="me.isParent">
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link size="small" @click="toggleStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
            <el-button link type="danger" size="small" @click="openReset(row)">一键清空</el-button>
            <el-button link type="danger" size="small" @click="removeTeam(row)">解散</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <template v-if="me.isParent">
      <h4 style="margin:18px 0 10px;color:#303133">审计日志（团队清空/解散永久留痕，不可被团队层面清除）</h4>
      <el-table :data="audit" border stripe style="width:100%" max-height="360">
        <el-table-column prop="at" label="时间" width="170" />
        <el-table-column prop="actor" label="操作人" width="100" />
        <el-table-column prop="action" label="动作" width="150" />
        <el-table-column prop="targetOwner" label="目标团队" width="150" />
        <el-table-column prop="deletedCount" label="清除记录" width="90" />
        <el-table-column prop="fileCount" label="清除附件" width="90" />
        <el-table-column prop="reason" label="原因" min-width="160" show-overflow-tooltip />
      </el-table>
    </template>

    <el-dialog :title="teamDlg.mode === 'create' ? '新建团队' : '编辑团队'" v-model="teamDlg.visible" width="440px">
      <el-form label-width="80px">
        <el-form-item label="团队名称" required><el-input v-model="teamDlg.name" placeholder="如：甲施工队" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="teamDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="teamDlg.busy" @click="saveTeam">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog title="一键清空团队空间（高危）" v-model="resetDlg.visible" width="540px">
      <el-alert type="error" :closable="false" show-icon title="此操作将物理删除该团队全部项目/表单/附件等业务数据，且不可恢复！"
        description="保留：团队本身、成员关系、全局字典模板、系统日志。" style="margin-bottom:12px" />
      <p style="margin:0 0 6px">目标团队：<b>{{ resetDlg.team && resetDlg.team.name }}</b></p>
      <el-form label-width="80px">
        <el-form-item label="清空原因" required>
          <el-input v-model="resetDlg.reason" type="textarea" :rows="3" placeholder="请填写清空原因（必填，记入审计日志）" />
        </el-form-item>
        <el-form-item label="二次确认">
          <el-input v-model="resetConfirm" placeholder="请输入「确认清空」以二次确认" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resetDlg.visible=false">取消</el-button>
        <el-button type="danger" :loading="resetDlg.busy" @click="doReset">确认清空</el-button>
      </template>
    </el-dialog>

    <el-dialog :title="'成员与权限 — ' + memberDlg.teamName" v-model="memberDlg.visible" width="680px">
      <div v-if="me.isParent && allAccounts.length" style="margin-bottom:10px">
        <span style="color:#909399;font-size:12px;margin-right:6px">已有账号快速加入：</span>
        <el-tag v-for="a in allAccounts.filter(a => !members.some(m => m.username === a.username))" :key="a.username"
          style="cursor:pointer;margin-right:6px" @click="memberForm.username = a.username">{{ a.username }}（{{ a.name }}）＋</el-tag>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:10px;align-items:flex-start">
        <el-input v-model="memberForm.username" placeholder="输入已有账号名（回车添加）" clearable style="flex:1" @keyup.enter="addMember" />
        <el-select v-model="memberForm.role" style="width:120px">
          <el-option label="团队成员" value="团队成员" />
          <el-option v-if="me.isParent" label="团队管理员" value="团队管理员" />
        </el-select>
        <el-button type="primary" :loading="memberDlg.busy" @click="addMember">添加</el-button>
      </div>
      <div style="margin-bottom:8px;color:#909399;font-size:12px">账号需先在「用户管理-登录账号列表」创建；在此将已有账号加入本团队并分配权限。</div>
      <el-table :data="members" border size="small">
        <el-table-column prop="name" label="姓名" width="100" />
        <el-table-column prop="username" label="账号" width="140" />
        <el-table-column label="角色" width="140">
          <template #default="{ row }">
            <el-select v-model="row.role" size="small" :disabled="!me.isParent && row.role === '团队管理员'" @change="updateMember(row)">
              <el-option label="团队成员" value="团队成员" />
              <el-option v-if="me.isParent" label="团队管理员" value="团队管理员" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="权限" min-width="210">
          <template #default="{ row }">
            <el-checkbox-group v-model="row.permissions" @change="updateMember(row)">
              <el-checkbox v-for="p in PERMS" :key="p" :label="p" />
            </el-checkbox-group>
          </template>
        </el-table-column>
        <el-table-column prop="accountStatus" label="账号状态" width="90" />
        <el-table-column label="操作" width="70" fixed="right">
          <template #default="{ row }">
            <el-button link type="danger" size="small" :disabled="!me.isParent && row.role === '团队管理员'" @click="removeMember(row)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer><el-button @click="memberDlg.visible=false">关闭</el-button></template>
    </el-dialog>
  </div>`
};

/* 登录账号列表（对齐原系统截图）：管理可登录系统的人员 */
const AccountsPanel = {
  setup() {
    const { ref, reactive, onMounted } = Vue;
    const EP = ElementPlus;
    const list = ref([]);
    const loading = ref(false);
    const showPwd = ref(false);
    const dlg = reactive({ visible: false, mode: 'create', id: '', loginName: '', email: '', password: '', name: '', phone: '', userGroup: '普通用户', busy: false });
    const detail = reactive({ visible: false, row: null });
    function openConfig() { window.dispatchEvent(new Event('nav-teamspace')); }
    async function load() {
      loading.value = true;
      try { list.value = await api.get('/api/users'); }
      catch (e) { EP.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    function openCreate() { Object.assign(dlg, { visible: true, mode: 'create', id: '', loginName: '', email: '', password: '', name: '', phone: '', userGroup: '普通用户', busy: false }); showPwd.value = false; }
    function openEdit(row) { Object.assign(dlg, { visible: true, mode: 'edit', id: row.id, loginName: row.loginName || row.username, email: row.email || '', password: '', name: row.name || '', phone: row.phone || '', userGroup: row.userGroup || '普通用户', busy: false }); showPwd.value = false; }
    function openDetail(row) { detail.row = row; detail.visible = true; }
    async function save() {
      if (!dlg.loginName.trim()) { EP.ElMessage.warning('请填写登录名'); return; }
      if (!dlg.email.trim()) { EP.ElMessage.warning('请填写邮箱'); return; }
      if (dlg.mode === 'create' && !dlg.password) { EP.ElMessage.warning('请填写密码'); return; }
      if (dlg.password && (dlg.password.length < 8 || dlg.password.length > 32)) { EP.ElMessage.warning('密码需为 8-32 位'); return; }
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
      try { await EP.ElMessageBox.confirm('确定删除账号「' + (row.loginName || row.username) + '」？删除后该账号将从所有团队移除。', '删除账号', { type: 'warning' }); }
      catch (e) { return; }
      try { await api.del('/api/users/' + row.id); EP.ElMessage.success('已删除'); load(); }
      catch (e) { EP.ElMessage.error(e.message); }
    }
    onMounted(load);
    return { list, loading, showPwd, dlg, detail, openConfig, openCreate, openEdit, openDetail, save, remove };
  },
  template: `
  <div>
    <el-alert type="info" :closable="false" show-icon style="margin-bottom:14px">
      <template #title><b>配置说明</b></template>
      <div>登录账号列表用于管理本企业需要登录系统的人员。新建时需设置登录名、邮箱与密码，建议补充姓名、电话，并按职责选择用户组。</div>
      <div style="margin-top:6px">仅为需要登录系统的人员创建账号，并按职责配置权限。
        <el-button size="small" type="primary" plain style="margin-left:8px" @click="openConfig">配置</el-button>
      </div>
    </el-alert>
    <div style="margin-bottom:12px;text-align:right">
      <el-button type="primary" @click="openCreate">+ 新增用户</el-button>
    </div>
    <el-table :data="list" v-loading="loading" border stripe style="width:100%">
      <el-table-column prop="email" label="邮箱" min-width="220" />
      <el-table-column label="电话" width="150">
        <template #default="{ row }">{{ row.phone || '-' }}</template>
      </el-table-column>
      <el-table-column label="用户组" width="110">
        <template #default="{ row }"><el-tag :type="row.userGroup === '超级用户' ? 'danger' : 'info'" size="small">{{ row.userGroup }}</el-tag></template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row)">详情</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="!row.isSelf" link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="dlg.mode === 'create' ? '新增用户' : '编辑用户'" v-model="dlg.visible" width="480px">
      <el-form label-width="72px">
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
            <el-option label="普通用户" value="普通用户" />
            <el-option label="超级用户" value="超级用户" />
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
        <el-descriptions-item label="所属团队">
          <span v-if="detail.row.teams && detail.row.teams.length">{{ detail.row.teams.map(t => t.teamName + '(' + t.role + ')').join('、') }}</span>
          <span v-else style="color:#c0c4cc">未加入团队</span>
        </el-descriptions-item>
        <el-descriptions-item label="状态">{{ detail.row.status }}</el-descriptions-item>
      </el-descriptions>
      <template #footer><el-button @click="detail.visible=false">关闭</el-button></template>
    </el-dialog>
  </div>`
};

/* 用户管理：登录账号列表 / 作业人员名单 / 外部通讯录 */
const UsersView = {
  setup() {
    const { ref } = Vue;
    const tab = ref('accounts');
    return { tab, contactCfg };
  },
  template: `
  <div>
    <el-tabs v-model="tab">
      <el-tab-pane label="登录账号列表" name="accounts"><AccountsPanel /></el-tab-pane>
      <el-tab-pane label="作业人员名单" name="workers" lazy><WorkersPanel /></el-tab-pane>
      <el-tab-pane label="外部通讯录" name="contacts" lazy><CrudView :config="contactCfg" :key="contactCfg.endpoint" /></el-tab-pane>
    </el-tabs>
  </div>`
};

/* 项目/计划/借工/竣工资料 配置 */
const projectCfg = {
  endpoint: 'projects', title: '项目',
  refs: {
    annualPlan: { endpoint: 'annualPlans', label: 'name', value: 'name' },
    substation: { endpoint: 'substations', label: 'name', value: 'name' }
  },
  columns: [
    { key: 'name', label: '项目名称' }, { key: 'annualPlan', label: '年度计划', width: 150 }, { key: 'substation', label: '供电所', width: 110 },
    { key: 'voltage', label: '电压等级', width: 90 }, { key: 'type', label: '类型', width: 110 },
    { key: 'manager', label: '经理', width: 100 }, { key: 'status', label: '状态', tag: true, width: 100 },
    { key: 'progress', label: '进度%', width: 90 }, { key: 'start', label: '开工', width: 120 }, { key: 'end', label: '竣工', width: 120 }
  ],
  formFields: [
    { key: 'name', label: '项目名称（包）', required: true },
    { key: 'annualPlan', label: '年度计划', type: 'select' },
    { key: 'substation', label: '属地供电所', type: 'select' },
    { key: 'voltage', label: '电压等级', type: 'select', options: [{ label: '10kV', value: '10kV' }, { label: '0.4kV', value: '0.4kV' }] },
    { key: 'type', label: '类型' }, { key: 'manager', label: '经理' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '未开工', value: '未开工' }, { label: '进行中', value: '进行中' }, { label: '已完工', value: '已完工' }] },
    { key: 'progress', label: '进度%', type: 'number' }, { key: 'start', label: '开工日期' }, { key: 'end', label: '竣工日期' }
  ]
};
const planCfg = {
  endpoint: 'plans', title: '计划',
  columns: [
    { key: 'title', label: '计划名称' }, { key: 'owner', label: '负责人', width: 100 }, { key: 'startDate', label: '开始', width: 120 },
    { key: 'dueDate', label: '截止', width: 120 }, { key: 'status', label: '状态', tag: true, width: 100 }, { key: 'progress', label: '进度%', width: 90 }
  ],
  formFields: [
    { key: 'title', label: '计划名称', required: true }, { key: 'owner', label: '负责人' },
    { key: 'startDate', label: '开始日期' }, { key: 'dueDate', label: '截止日期' },
    { key: 'status', label: '状态', type: 'select', options: [{ label: '未开始', value: '未开始' }, { label: '进行中', value: '进行中' }, { label: '已完成', value: '已完成' }] },
    { key: 'progress', label: '进度%', type: 'number' }
  ]
};
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
    const filters = reactive({ keyword: '', annualPlan: '', batch: '', substation: '', leader: '' });
    const page = ref(1);
    const pageSize = ref(50);

    const dialogVisible = ref(false);
    const editingId = ref(null);
    const emptyForm = () => ({ annualPlan: '', batch: '', name: '', workType: '', specialty: '', provincialDept: '', substation: '', leader: '', startDate: '', endDate: '', subProjects: [], category: '', completed: false });
    const form = reactive(emptyForm());

    const workTypes = ['配农网工程', '生产检修改造', '外部工程', '业扩工程', '迁改工程', '借工'];
    const specialties = ['运检', '营销'];
    const provincialDepts = ['设备部', '产业部'];

    async function load() {
      try {
        const [p, a, ss, u, ms, wp] = await Promise.all([
          api.get('/api/projects'), api.get('/api/annualPlans'), api.get('/api/substations'), api.get('/api/users'),
          api.get('/api/materials'), api.get('/api/workPlans')
        ]);
        projects.value = p; annualPlans.value = a; substations.value = ss; users.value = u;
        materials.value = Array.isArray(ms) ? ms : (ms.data || []);
        workPlans.value = Array.isArray(wp) ? wp : (wp.data || []);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
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
    // 材料类型归类：电杆 / 线材 / 设备（用于核错汇总）
    function matType(desc) {
      const s = String(desc || '');
      if (s.includes('电杆')) return 'pole';
      if (s.includes('导线') || s.includes('电缆') || s.includes('线') || s.includes('绞线')) return 'cable';
      return 'device';
    }
    // 按桶汇总：电杆 / 线材 / 设备（设备含变压器、隔离开关、一二次融合断路器等）
    const ledger = computed(() => {
      const ms = projMaterials.value;
      const sum = (k) => ms.reduce((s, m) => s + (Number(m[k]) || 0), 0);
      const rows = LEDGER_CONF.map(([k, label, unit]) => {
        const typed = ms.filter(m => matType(m.description) === k);
        const erp = typed.reduce((s, m) => s + (Number(m.qtyRequired) || 0), 0);
        const planned = typed.reduce((s, m) => s + (Number(m.qtyGenerated) || 0), 0);
        const pct = erp > 0 ? Math.min(100, Math.floor(planned / erp * 100)) : 0;
        return { key: k, label, unit, erp, planned, pct, need: Math.max(0, erp - planned), items: typed };
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
    function enterPlans(kind) {
      window.dispatchEvent(new CustomEvent('plans-filter-project', { detail: { project: detail.value.name } }));
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
      const conf = [['pole', '电杆', '#3370ff'], ['cable', '线材', '#7aa7ff'], ['device', '设备', '#c3c9d4']];
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
      if (!form.leader) return ElementPlus.ElMessage.error('请选择班组长');
      for (let i = 0; i < form.subProjects.length; i++) {
        const s = form.subProjects[i];
        if (!s.name || !s.substation || !s.leader) return ElementPlus.ElMessage.error('子项目 ' + (i + 1) + '：名称、属地供电所、班组长均为必填');
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
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
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
    function downloadProjFile(f) {
      fetch('/api/projects/' + detail.value.id + '/files/' + f.id + '/download', {
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
    function todoTip(name) { ElementPlus.ElMessage.info(name + '功能待「计划管理」等后续模块完成后开放'); }

    // ---- 详情页材料台账汇总（材料台账/周计划模块完成前，按项目进度推导的占位数据） ----
    const LEDGER_CONF = [['pole', '电杆', '根'], ['cable', '线材', '千米'], ['device', '设备', '台']];
    // 桶配色（与项目列表局计划进度色一致：深蓝=电杆、浅蓝=线材、灰=设备）
    function bucketColor(key) { return { pole: '#3370ff', cable: '#7aa7ff', device: '#86909c' }[key] || '#86909c'; }
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
      openAdd, openEdit, addSub, removeSub, submit,
      detail, showDetail, backToList, completeProject, removeProject,
      projFileInput, projFiles, triggerProjUpload, onProjUpload, downloadProjFile, delProjFile, packProjDownload, fmtDT, todoTip,
      projMaterials, projPlans, ledger, enterMaterials, enterPlans, fmtQty, bucketColor, statusTagType
    };
  },
  template: `
  <div>
   <template v-if="!detail">
    <!-- 顶部页签 -->
    <div style="display:flex;gap:10px;margin-bottom:16px">
      <div v-for="t in ['自有工程','客户工程','已竣工']" :key="t" @click="switchTab(t)"
        :style="{padding:'7px 18px',borderRadius:'6px',cursor:'pointer',fontSize:'14px',
          border: activeTab===t ? '1px solid #3370ff' : '1px solid #e4e7ed',
          background: activeTab===t ? '#3370ff' : '#f5f7fa',
          color: activeTab===t ? '#fff' : '#606266'}">{{ t }}</div>
    </div>

    <el-button v-if="activeTab!=='已竣工'" type="primary" @click="openAdd">新增项目</el-button>

    <!-- 筛选 -->
    <div style="background:#fff;border-radius:4px;padding:14px 16px;margin:14px 0 4px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:14px;color:#303133">筛选：</span>
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
      <div style="color:#999;font-size:12px;margin-top:10px">过滤分组排序：电杆、线材、设备；深蓝=电杆，浅蓝=线材，灰=设备（括内显示数量，完成 100% 时隐藏，超额时显示超出比例）</div>
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
      <span style="color:#666;font-size:13px">共 {{ filteredList.length }} 条</span>
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
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:600">项目信息</span>
          <div style="display:flex;align-items:center;gap:4px">
            <el-button type="primary" size="small" @click="completeProject">竣工</el-button>
            <el-button size="small" @click="openEdit(detail)">编辑</el-button>
            <el-button link type="danger" size="small" @click="removeProject" style="margin-left:8px">删除项目</el-button>
          </div>
        </div>
      </template>
      <div v-for="r in [
        ['项目名称（包）', detail.name || '-'],
        ['项目名称(自定义)', detail.customName || '-'],
        ['年度计划', detail.annualPlan || '-'],
        ['批次', detail.batch || '-'],
        ['分包单位', detail.subcontractor || '-'],
        ['合同编号', detail.contractNo || '-'],
        ['作业类型', detail.workType || '-'],
        ['作业专业', detail.specialty || '-'],
        ['省专业管理部门', detail.provincialDept || '-'],
        ['子项目列表', (detail.subProjects && detail.subProjects.length) ? detail.subProjects.map(s => s.name).join('、') : '无'],
        ['属地供电所', detail.substation || '-'],
        ['班组长', detail.leader || '-'],
        ['开工日期', detail.startDate || '-'],
        ['预期竣工日期', detail.endDate || '-'],
        ['创建时间', fmtDT(detail.createdAt)],
        ['周计划进度', '-']
      ]" :key="r[0]" style="display:flex;border-bottom:1px solid #ebeef5;font-size:14px;line-height:22px">
        <div style="width:280px;flex-shrink:0;background:#fafafa;padding:10px 16px;color:#606266">{{ r[0] }}</div>
        <div style="flex:1;padding:10px 16px;color:#303133">{{ r[1] }}</div>
      </div>
    </el-card>

    <!-- 资料管理 -->
    <el-card shadow="never" style="margin-bottom:14px">
      <template #header><span style="font-weight:600">资料管理</span></template>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 48px">
        <div>
          <div style="font-weight:600;font-size:14px;margin-bottom:14px">图纸</div>
          <div style="margin-bottom:20px">
            <div style="font-size:14px;color:#303133;margin-bottom:8px">设计图纸</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button type="primary" size="small" @click="triggerProjUpload('design')">上传设计图纸</el-button>
              <el-button size="small" :disabled="!projFiles('design').length" @click="packProjDownload('design')">打包下载（{{ projFiles('design').length }}）</el-button>
              <span style="color:#999;font-size:12px">可多选，单文件不超过 2MB</span>
            </div>
            <div v-for="f in projFiles('design')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed #ebeef5">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#303133">{{ f.name }}</span>
              <el-button link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:#999;font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('design').length" style="color:#999;font-size:12px;padding:8px 0">暂无设计图纸，可点击上传</div>
          </div>
          <div>
            <div style="font-size:14px;color:#303133;margin-bottom:8px">奥维地图</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button type="primary" size="small" @click="triggerProjUpload('map')">上传奥维地图</el-button>
              <el-button size="small" :disabled="!projFiles('map').length" @click="packProjDownload('map')">打包下载（{{ projFiles('map').length }}）</el-button>
              <span style="color:#999;font-size:12px">单文件不超过 2MB</span>
            </div>
            <div v-for="f in projFiles('map')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed #ebeef5">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#303133">{{ f.name }}</span>
              <el-button link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:#999;font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('map').length" style="color:#999;font-size:12px;padding:8px 0">暂无奥维地图，可点击上传</div>
          </div>
        </div>
        <div>
          <div style="font-weight:600;font-size:14px;margin-bottom:14px">现场资料</div>
          <div style="margin-bottom:20px">
            <div style="font-size:14px;color:#303133;margin-bottom:8px">现场照片</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button type="primary" size="small" @click="triggerProjUpload('photo')">上传现场照片</el-button>
              <el-button size="small" :disabled="!projFiles('photo').length" @click="packProjDownload('photo')">打包下载（{{ projFiles('photo').length }}）</el-button>
              <span style="color:#999;font-size:12px">可多选，单张不超过 10MB</span>
            </div>
            <div v-for="f in projFiles('photo')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed #ebeef5">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#303133">{{ f.name }}</span>
              <el-button link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:#999;font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('photo').length" style="color:#999;font-size:12px;padding:8px 0">暂无现场照片，可点击上传</div>
          </div>
          <div>
            <div style="font-size:14px;color:#303133;margin-bottom:8px">规范图纸</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
              <el-button type="primary" size="small" @click="triggerProjUpload('spec')">上传规范图纸</el-button>
              <el-button size="small" :disabled="!projFiles('spec').length" @click="packProjDownload('spec')">打包下载（{{ projFiles('spec').length }}）</el-button>
              <span style="color:#999;font-size:12px">可多选，单文件不超过 3MB</span>
            </div>
            <div v-for="f in projFiles('spec')" :key="f.id" style="display:flex;align-items:center;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px dashed #ebeef5">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#303133">{{ f.name }}</span>
              <el-button link type="danger" size="small" @click="delProjFile(f)">删除</el-button>
              <span style="color:#999;font-size:12px;flex-shrink:0">{{ fmtDT(f.uploadedAt) }}</span>
            </div>
            <div v-if="!projFiles('spec').length" style="color:#999;font-size:12px;padding:8px 0">暂无规范图纸，可点击上传</div>
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
        <div v-else style="color:#999;font-size:13px">暂无与本项目关联的月计划，可在「计划管理」-「月计划管理」中新增计划并关联本项目。</div>
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
        <div v-else style="color:#999;font-size:13px">暂无与本项目关联的周计划，可在「计划管理」-「周计划管理」中新增计划并关联本项目。</div>
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
        <div style="border:1px solid #e7e9ec;border-radius:4px;padding:12px 16px;background:#fff">
          <div style="font-size:20px;font-weight:700;color:#3370ff;line-height:26px">{{ ledger.count }}</div>
          <div style="color:#86909c;font-size:12px;margin-top:2px">材料行</div>
        </div>
        <div style="border:1px solid #e7e9ec;border-radius:4px;padding:12px 16px;background:#fff">
          <div style="display:flex;gap:18px">
            <div style="white-space:nowrap"><div style="font-size:17px;font-weight:700;color:#3370ff;line-height:24px">{{ fmtQty(ledger.required) }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">应到</div></div>
            <div style="white-space:nowrap"><div style="font-size:17px;font-weight:700;color:#389e0d;line-height:24px">{{ fmtQty(ledger.arrived) }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">已到</div></div>
            <div style="white-space:nowrap"><div style="font-size:17px;font-weight:700;color:#f56c6c;line-height:24px">{{ fmtQty(ledger.notArrived) }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">未到</div></div>
          </div>
        </div>
        <div style="border:1px solid #e7e9ec;border-radius:4px;padding:12px 16px;background:#fff">
          <div style="display:flex;gap:18px">
            <div><div style="font-size:20px;font-weight:700;color:#389e0d;line-height:26px">{{ ledger.allCount }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">全部到库</div></div>
            <div><div style="font-size:20px;font-weight:700;color:#e6932c;line-height:26px">{{ ledger.partCount }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">部分到库</div></div>
          </div>
        </div>
        <div style="border:1px solid #e7e9ec;border-radius:4px;padding:12px 16px;background:#fff">
          <div style="display:flex;gap:18px">
            <div><div style="font-size:20px;font-weight:700;color:#f56c6c;line-height:26px">{{ ledger.notArrived }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">未到</div></div>
            <div><div style="font-size:20px;font-weight:700;color:#e6a23c;line-height:26px">{{ ledger.abnormal }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">异常</div></div>
            <div><div style="font-size:20px;font-weight:700;color:#909399;line-height:26px">{{ ledger.invalid }}</div><div style="color:#86909c;font-size:12px;margin-top:2px">无效</div></div>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-weight:600;font-size:14px">按桶汇总</span>
        <span style="color:#86909c;font-size:12px">台账应到 / 已报计划量 / 需补计划量</span>
      </div>
      <el-table :data="ledger.rows" border size="small">
        <el-table-column type="expand">
          <template #default="{row}">
            <div style="padding:8px 16px 12px;background:#fafbfc">
              <el-table :data="row.items" size="small" border>
                <el-table-column prop="description" label="物料描述" min-width="240" show-overflow-tooltip />
                <el-table-column label="应到" width="120" align="right"><template #default="{row}">{{ fmtQty(row.qtyRequired) }}</template></el-table-column>
                <el-table-column label="已到" width="120" align="right"><template #default="{row}">{{ fmtQty(row.qtyArrived) }}</template></el-table-column>
                <el-table-column label="未到" width="120" align="right"><template #default="{row}">{{ fmtQty(row.qtyNotArrived) }}</template></el-table-column>
                <el-table-column prop="unit" label="单位" width="80" align="center" />
                <el-table-column label="状态" width="110" align="center">
                  <template #default="{row}"><el-tag size="small" effect="plain" :type="statusTagType(row.status)">{{ row.status }}</el-tag></template>
                </el-table-column>
                <template #empty><span style="color:#909399;font-size:12px">该类暂无材料</span></template>
              </el-table>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="桶" width="90" align="center">
          <template #default="{row}">
            <span style="display:inline-flex;align-items:center;gap:6px;font-weight:600">
              <span :style="{width:'8px',height:'8px',borderRadius:'2px',background:bucketColor(row.key),display:'inline-block'}"></span>{{ row.label }}
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="unit" label="单位" width="90" align="center" />
        <el-table-column label="ERP应到" width="140" align="right"><template #default="{row}"><span style="font-weight:600">{{ fmtQty(row.erp) }}</span></template></el-table-column>
        <el-table-column label="已报计划量（周计划）" min-width="240">
          <template #default="{row}">
            <div style="display:flex;align-items:center;gap:10px;padding:3px 0">
              <span style="font-size:13px;min-width:56px;text-align:right;white-space:nowrap">{{ fmtQty(row.planned) }}</span>
              <div style="flex:1;height:6px;background:#f0f2f5;border-radius:3px;overflow:hidden">
                <div :style="{ width: row.pct + '%', background: row.pct >= 100 ? '#389e0d' : '#3370ff', height: '100%', transition: 'width .3s' }"></div>
              </div>
              <span :style="{fontSize:'12px',flexShrink:0,color: row.pct >= 100 ? '#389e0d' : '#606266',whiteSpace:'nowrap'}">已报 {{ row.pct }}%</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="需补计划量" width="140" align="right">
          <template #default="{row}"><span :style="{fontWeight:600,color: row.need > 0 ? '#f56c6c' : '#c9cdd4'}">{{ fmtQty(row.need) }}</span></template>
        </el-table-column>
      </el-table>
    </el-card>

    <input ref="projFileInput" type="file" style="display:none" :multiple="['design','photo','spec'].includes(projUploadType)" @change="onProjUpload" />
   </template>

    <!-- 新增/编辑项目 -->
    <el-dialog :title="editingId ? '编辑项目' : '新增项目'" v-model="dialogVisible" width="720px" top="4vh">
      <div style="max-height:68vh;overflow:auto;padding-right:8px">
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>年度计划名称</div>
          <el-select v-model="form.annualPlan" placeholder="请选择" style="width:100%">
            <el-option v-for="a in annualPlans" :key="a.id" :label="a.name" :value="a.name" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">批次</div>
          <el-input v-model="form.batch" placeholder="请输入（选填）" />
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>项目名称（包）</div>
          <el-input v-model="form.name" placeholder="请输入项目名称（包）" />
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">作业类型</div>
          <el-select v-model="form.workType" placeholder="请选择" style="width:100%">
            <el-option v-for="t in workTypes" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">作业专业</div>
          <el-select v-model="form.specialty" placeholder="请选择" style="width:100%">
            <el-option v-for="t in specialties" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">省专业管理部门</div>
          <el-select v-model="form.provincialDept" placeholder="请选择" style="width:100%">
            <el-option v-for="t in provincialDepts" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>属地供电所</div>
          <el-select v-model="form.substation" placeholder="请选择" style="width:100%">
            <el-option v-for="s in substations" :key="s.id" :label="s.name" :value="s.name" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>班组长</div>
          <el-select v-model="form.leader" placeholder="请选择（班组长用户组）" style="width:100%">
            <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.name" />
          </el-select>
        </div>
        <div style="margin-bottom:16px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">子项目（选填）</div>
          <div v-for="(sp,si) in form.subProjects" :key="si" style="border:1px solid #e4e7ed;border-radius:4px;padding:14px 16px;margin-bottom:12px">
            <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>子项目名称</div>
            <el-input v-model="sp.name" placeholder="请输入子项目名称" style="margin-bottom:12px" />
            <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>属地供电所</div>
            <el-select v-model="sp.substation" placeholder="请选择" style="width:100%;margin-bottom:12px">
              <el-option v-for="s in substations" :key="s.id" :label="s.name" :value="s.name" />
            </el-select>
            <div style="font-size:14px;color:#303133;margin-bottom:6px"><span style="color:#f56c6c;margin-right:2px">*</span>班组长</div>
            <el-select v-model="sp.leader" placeholder="请选择（班组长用户组）" style="width:100%;margin-bottom:8px">
              <el-option v-for="u in users" :key="u.id" :label="u.name" :value="u.name" />
            </el-select>
            <el-button link type="danger" @click="removeSub(si)">删除</el-button>
          </div>
          <div style="border:1px dashed #dcdfe6;border-radius:4px;text-align:center;padding:12px;cursor:pointer;color:#606266;font-size:14px" @click="addSub">+ 添加子项目</div>
        </div>
        <div style="margin-bottom:8px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">开工日期</div>
          <el-date-picker v-model="form.startDate" type="date" placeholder="请选择日期" value-format="YYYY-MM-DD" style="width:100%" />
        </div>
        <div style="margin-bottom:8px">
          <div style="font-size:14px;color:#303133;margin-bottom:6px">预期竣工日期</div>
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
const App = {
  setup() {
    const { onUnmounted } = Vue;
    const token = ref(localStorage.getItem('erp_token'));
    const me = reactive({ name: '', role: '', isParent: false, isTeamAdmin: false, activeTeamId: '', parentViewingTeam: false, teams: [] });
    const viewVersion = ref(0);
    const tenant = ref('');
    const sysName = ref('电网生产ERP（本地版）');
    // 移动端（<768px）默认收起侧栏，避免抽屉一进来就压住内容
    const collapsed = ref(typeof window !== 'undefined' && window.innerWidth < 768);
    const route = ref('home');
    const loginForm = reactive({ username: '', password: '' });
    const loginLoading = ref(false);
    // 登录页背景 / 品牌：背景由服务端直出到 CSS 变量 --login-bg（无闪跳），
    // 这里仅作为回退（如从非 / 路径进入）与品牌名同步。
    const loginBg = ref('');
    const loginBrand = reactive({ systemName: '', companyName: '' });

    const allMenu = [
      { key: 'home', label: '用户中心', comp: 'Dashboard' },
      { key: 'projects', label: '项目列表', comp: 'ProjectsView' },
      { key: 'materials', label: '材料台账', comp: 'MaterialsView' },
      { key: 'plans', label: '计划管理', comp: 'PlansView' },
      { key: 'borrow', label: '借工管理', comp: 'CrudView', cfg: borrowCfg },
      { key: 'completion', label: '竣工资料（开发中）', comp: 'CrudView', cfg: completionCfg },
      { key: 'documents', label: '文档中心', comp: 'DocumentsView' },
      { key: 'settings', label: '全局设置', comp: 'SettingsView' },
      { key: 'users', label: '用户管理', comp: 'UsersView' },
      { key: 'teamspace', label: '团队管理', comp: 'TeamsPanel', adminOnly: true }
    ];
    // 「团队管理」仅母账号 / 团队管理员可见
    const menu = computed(() => allMenu.filter(m => !m.adminOnly || me.isParent || me.isTeamAdmin));
    const current = computed(() => menu.value.find(m => m.key === route.value) || menu.value[0]);

    async function fetchMe() {
      try {
        const r = await api.get('/api/me');
        me.name = r.user.name; me.role = r.user.role;
        me.isParent = !!r.user.isParent; me.isTeamAdmin = !!r.isTeamAdmin;
        me.teams = r.teams || []; me.activeTeamId = r.activeTeamId || '';
        me.parentViewingTeam = !!r.user.parentViewingTeam;
        // 顶栏企业名跟随「网站设置-企业名称」，未设置时回退租户名
        tenant.value = (r.settings && r.settings.companyName) || r.tenant.name;
        sysName.value = r.settings.systemName;
        document.title = r.settings.systemName || document.title;
        // 若当前路由变为不可见（如非管理员停留在团队管理），回退用户中心
        const cur = allMenu.find(m => m.key === route.value);
        if (cur && cur.adminOnly && !(me.isParent || me.isTeamAdmin)) route.value = 'home';
      } catch (e) {}
    }
    // 切换当前团队（成员）/ 或母账号审计查看某团队；切换后重挂当前视图按新上下文重取数据
    async function switchTeam(teamId) {
      try {
        await api.post('/api/active-team', { teamId: teamId || '' });
        await fetchMe();
        viewVersion.value++;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
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
    function logout() { localStorage.removeItem('erp_token'); token.value = ''; location.reload(); }
    // 移动端点击菜单后自动收起抽屉
    function go(key) { route.value = key; if (typeof window !== 'undefined' && window.innerWidth < 768) collapsed.value = true; }

    onMounted(() => {
      if (token.value) fetchMe();
      // 登录页公开配置（无需登录）：背景图 + 系统名 / 企业名
      api.get('/api/public-config').then(c => {
        const bg = c.loginBg || '/login-bg/ink-color.jpg';
        loginBg.value = bg;
        // 回退设置：仅当服务端未注入（值为 none）时才覆盖，避免覆盖正确的直出值造成闪跳
        const cur = getComputedStyle(document.documentElement).getPropertyValue('--login-bg').trim();
        if (!cur || cur === 'none') document.documentElement.style.setProperty('--login-bg', "url('" + bg + "')");
        loginBrand.systemName = c.systemName || '';
        loginBrand.companyName = c.companyName || '';
      }).catch(() => {});
      // 项目详情跳转：进入材料台账 / 计划管理（跨模块导航）
      function navMaterials() { route.value = 'materials'; }
      function navPlans() { route.value = 'plans'; }
      function navTeamspace() { route.value = 'teamspace'; }
      window.addEventListener('nav-materials', navMaterials);
      window.addEventListener('nav-plans', navPlans);
      window.addEventListener('nav-teamspace', navTeamspace);
      onUnmounted(() => {
        window.removeEventListener('nav-materials', navMaterials);
        window.removeEventListener('nav-plans', navPlans);
        window.removeEventListener('nav-teamspace', navTeamspace);
      });
    });
    // 网站设置保存后实时刷新顶部标题/企业名称
    window.addEventListener('brand-changed', fetchMe);

    return { token, me, tenant, sysName, collapsed, route, loginForm, loginLoading, loginBg, loginBrand, menu, current, login, logout, go, switchTeam, viewVersion };
  },
  template: `
  <div v-if="!token">
    <div class="login-wrap">
      <div class="login-bg-lqip"></div>
      <div class="login-bg-layer"></div>
      <div class="login-card">
        <div class="brand">
          <h2>{{ loginBrand.systemName || '电网生产ERP' }}</h2>
          <div class="sub">本地自托管版 · 请登录</div>
        </div>
        <el-form @submit.prevent="login">
          <el-form-item><el-input v-model="loginForm.username" placeholder="账号" size="large" :prefix-icon="'User'" /></el-form-item>
          <el-form-item><el-input v-model="loginForm.password" type="password" placeholder="密码" size="large" show-password :prefix-icon="'Lock'" /></el-form-item>
          <el-button type="primary" size="large" style="width:100%" :loading="loginLoading" @click="login">登 录</el-button>
        </el-form>
        <div class="login-tip">默认账号 <b>admin</b> / <b>admin123</b></div>
      </div>
      <div class="login-page-footer">
        <div class="company" v-if="loginBrand.companyName">{{ loginBrand.companyName }}</div>
        <div v-else>{{ loginBrand.systemName || '' }}</div>
      </div>
    </div>
  </div>
  <div v-else style="height:100%">
    <div class="app-header">
      <div class="left">
        <span style="cursor:pointer;font-size:20px" @click="collapsed=!collapsed">☰</span>
        <span class="sysname">{{ sysName }}</span>
        <span v-if="tenant" class="tenant-name" style="color:#8fb8e0;font-size:13px">{{ tenant }}</span>
      </div>
      <div class="right">
        <el-tag v-if="me.parentViewingTeam" type="warning" size="small" style="margin-right:8px">审计只读</el-tag>
        <span class="user-name" style="margin-right:8px">{{ me.name || me.username }}（{{ me.role }}）</span>
        <el-select v-if="!me.isParent && me.teams.length" :model-value="me.activeTeamId" @change="switchTeam" size="small" class="team-select" placeholder="切换团队">
          <el-option v-for="t in me.teams" :key="t.teamId" :label="t.name" :value="t.teamId" />
        </el-select>
        <el-select v-else-if="me.isParent" :model-value="me.parentViewingTeam ? me.activeTeamId : ''" @change="switchTeam" size="small" class="team-select team-select-wide" placeholder="母账号 · 自有空间">
          <el-option label="母账号 · 自有空间" value="" />
          <el-option v-for="t in me.teams" :key="t.teamId" :label="'审计查看：' + t.name" :value="t.teamId" />
        </el-select>
        <el-button size="small" @click="logout">退出登录</el-button>
      </div>
    </div>
    <div class="layout">
      <div class="aside" :class="{ collapsed }">
        <div v-for="m in menu" :key="m.key" class="menu-item" :class="{ active: route===m.key }" @click="go(m.key)">{{ m.label }}</div>
      </div>
      <div class="aside-mask" v-if="!collapsed" @click="collapsed = true"></div>
      <div class="main">
        <h2 class="page-title">{{ current.label }}</h2>
        <component :is="current.comp" v-if="current.comp==='CrudView'" :config="current.cfg" :key="current.key + '-' + viewVersion" />
        <component :is="current.comp" v-else :key="current.key + '-' + viewVersion" />
      </div>
    </div>
  </div>`
};

const app = createApp(App);
const lp = (ElementPlus.lang && ElementPlus.lang.zhCn) ? { locale: ElementPlus.lang.zhCn } : {};
app.use(ElementPlus, lp);
app.component('FunnelIcon', { props: { on: Boolean },
  template: `<svg class="col-funnel" :class="{on}" viewBox="0 0 1024 1024" width="12" height="12"><path fill="currentColor" d="M384 523.392V928a32 32 0 0 0 46.336 28.608l192-96A32 32 0 0 0 640 832V523.392l280.768-343.104a32 32 0 0 0-24.768-52.288H128a32 32 0 0 0-24.768 52.288L384 523.392z"/></svg>` });
app.component('CrudView', CrudView);
app.component('ProjectsView', ProjectsView);
app.component('DocumentsView', DocumentsView);
app.component('MaterialsView', MaterialsView);
app.component('Dashboard', Dashboard);
app.component('SettingsView', SettingsView);
app.component('WorkersPanel', WorkersPanel);
app.component('UsersView', UsersView);
app.component('TeamsPanel', TeamsPanel);
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
      if (rec.status === '已作废') return { text: '异常 0', type: 'danger' };
      const cr = (rec.confirmRows || []).find(x => x.materialId === it.materialId);
      if (cr && cr.abnormal) return { text: '异常', type: 'danger' };
      if (cr) return { text: '已到 ' + (Math.round((Number(cr.thisQty) || 0) * 10000) / 10000), type: 'success' };
      return { text: '已入库', type: 'success' };
    }
    function stockReason(rec, it) {
      if (rec.status === '已作废') return '领料单作废冲销: ' + (rec.voidReason || '');
      const cr = (rec.confirmRows || []).find(x => x.materialId === it.materialId);
      return (cr && cr.reason) || '-';
    }
    function expRowClass(req) { return () => (req.status === '已作废' ? 'rq-ab-row' : ''); }
    // 某物料在领料单内的全部入库/补入库操作记录（按时间顺序，N 次操作 N 条）
    function itemHistory(rec, materialId) {
      const out = [];
      ((rec && rec.history) || []).forEach(h => (h.rows || []).forEach(r => {
        if (r.materialId === materialId) out.push({ at: h.at, thisQty: r.thisQty, abnormal: r.abnormal, reason: r.reason });
      }));
      return out;
    }
    return { list, loading, filters, projectOptions, dlg, vdlg, filtered, load, resetFilters, sumQty, statusType, download, openConfirm, openSupplement, rowFlag, supDone, rowClass, onModeChange, qtyInput, doConfirm, voidReq, voidDeduct, confirmVoid, deleteReq, stockInfo, stockReason, expRowClass, itemHistory };
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
          <div style="padding:6px 18px 14px 48px">
            <el-table :data="row.items" size="small" border :row-class-name="expRowClass(row)">
              <el-table-column type="expand" width="40">
                <template #default="{ row: it }">
                  <div style="padding:8px 14px 10px 48px;background:#fafafa">
                    <div style="font-size:12px;color:#909399;margin-bottom:8px">入库记录（共 {{ itemHistory(row, it.materialId).length }} 次）</div>
                    <el-table v-if="itemHistory(row, it.materialId).length" :data="itemHistory(row, it.materialId)" size="small" border style="max-width:860px">
                      <el-table-column prop="at" label="入库时间" width="150" />
                      <el-table-column prop="thisQty" label="本次入库数量" width="120" align="right" />
                      <el-table-column label="入库情况" width="100">
                        <template #default="{ row: h }">
                          <el-tag size="small" :type="h.abnormal ? 'danger' : 'success'">{{ h.abnormal ? '异常' : '正常' }}</el-tag>
                        </template>
                      </el-table-column>
                      <el-table-column prop="reason" label="异常原因" min-width="200">
                        <template #default="{ row: h }">{{ h.reason || '-' }}</template>
                      </el-table-column>
                    </el-table>
                    <div v-else style="color:#c0c4cc;font-size:12px">暂无入库记录（确认入库/补入库后按次记录）</div>
                  </div>
                </template>
              </el-table-column>
              <el-table-column prop="project" label="项目名称" min-width="220" show-overflow-tooltip />
              <el-table-column prop="description" label="物料描述" min-width="200" show-overflow-tooltip />
              <el-table-column prop="qty" label="数量" width="90" align="right" />
              <el-table-column label="入库情况" width="110">
                <template #default="{ $index }">
                  <el-tag size="small" :type="stockInfo(row, row.items[$index]).type">{{ stockInfo(row, row.items[$index]).text }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="异常原因" width="150">
                <template #default="{ $index }">{{ stockReason(row, row.items[$index]) }}</template>
              </el-table-column>
              <el-table-column prop="unit" label="单位" width="70" />
              <el-table-column prop="code" label="物料编码" width="130" />
              <el-table-column prop="orderNo" label="采购订单号" width="120" />
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
          <el-button v-if="row.status==='待入库'" link type="primary" size="small" @click="openConfirm(row)">确认入库</el-button>
          <el-button v-if="row.status==='部分到库'" link type="primary" size="small" @click="openSupplement(row)">补入库</el-button>
          <el-button v-if="row.status!=='已作废'" link type="danger" size="small" @click="voidReq(row)">作 废</el-button>
          <el-button v-if="row.status==='已作废'" link type="danger" size="small" @click="deleteReq(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dlg.visible" width="1080px" top="8vh" :show-close="true">
      <template #header>
        <div>
          <div style="font-size:16px;font-weight:600">{{ dlg.type==='supplement' ? '补入库' : '确认入库' }}</div>
          <div style="margin-top:6px"><span style="font-weight:600">{{ dlg.rec && dlg.rec.reqNo }}</span>
            <span style="color:#999;margin-left:10px">请核对领料单明细后{{ dlg.type==='supplement' ? '补入库' : '确认入库' }}</span></div>
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
      <div style="background:#f5f7fa;border-radius:6px;padding:14px 18px;margin:14px 0">
        <div style="color:#999;font-size:13px">将冲销已入库数量</div>
        <div style="font-size:24px;font-weight:700;color:#222;margin-top:4px">{{ voidDeduct(vdlg.rec || {}) }}</div>
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
    onMounted(load);
    return { list, loading, filters, page, pageSize, projects, filtered, paged, load, doSearch };
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
          <div style="padding:12px 24px 16px;background:#fafbfc">
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
              <span style="color:#666">该次导入已读取完成，确认没有调整明细。</span>
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
    </el-table>
    <div style="display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:12px">
      <span style="color:#606266;font-size:13px">共 {{ filtered.length }} 个批次</span>
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
    function doPrint() {
      const el = document.getElementById('ob-print-area');
      if (!el) return;
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(iframe);
      const doc = iframe.contentWindow.document;
      doc.open();
      doc.write('<html><head><meta charset="utf8"><title>材料出库单</title><style>' +
        'body{margin:0;padding:24px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}' +
        '.obp-title{text-align:center;font-size:20px;font-weight:700;margin-bottom:16px}' +
        'table{width:100%;border-collapse:collapse}td,th{border:1px solid #666;padding:8px 10px;font-size:13px;text-align:left}' +
        '.obp-th{background:#f5f7fa;font-weight:600;text-align:center}' +
        '@page{size:A4;margin:12mm}</style></head><body>' + el.innerHTML + '</body></html>');
      doc.close();
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 1500);
    }
    onMounted(() => { loadMeta(); if (window.__obFocusMaterial) { const d = window.__obFocusMaterial; delete window.__obFocusMaterial; focusMaterial({ detail: d }); } });
    return { tab, f1, f2, f3, project, keyword, projects, workers, list, orders, loading, selection, outQty, mainTable, page, pageSize, opage, opageSize, paged, opaged, filtered, ofiltered, matFilter, oKeyword, load, onProjectChange, onSel, isSelected, openDlg, dlg, submitOut, od, openOrder, rdlg, openReturn, submitReturn, vdlg, openVoid, confirmVoid, deleteOrder, deleteVoided, printOrder, printRow, doPrint, pdlg, showMatOrders, clearMatFilter, chip, fmt, fmt4, sumQty, remaining, oTake, oReturned, oCompensated, oNet, oRows, oTakeM, oReturnedM, oCompensatedM, oNetM };
  },
  template: `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:17px;font-weight:600">请选择项目</div>
      <div>
        <el-button type="primary" :disabled="!selection.length" @click="openDlg">登记出库（{{ selection.length }}）</el-button>
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
      <el-button v-if="tab==='orders'" type="danger" plain style="margin-left:auto" @click="deleteVoided">删除出库记录</el-button>
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
                  <span :style="chip('#909399')">有出库记录</span>
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
            <span style="color:#606266;font-size:13px">共 {{ filtered.length }} 行</span>
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
                <el-button v-if="row.status === '有效'" link type="primary" size="small" @click="openReturn(row)">登记归还</el-button>
                <el-button v-if="row.status === '有效'" link type="danger" size="small" @click="openVoid(row)">作废</el-button>
                <el-button v-if="row.status === '已作废'" link type="danger" size="small" @click="deleteOrder(row)">删除</el-button>
                <el-button link type="primary" size="small" @click="printRow(row)">打印</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div style="display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:12px">
            <span style="color:#606266;font-size:13px">共 {{ ofiltered.length }} 个出库单</span>
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
      <div style="color:#666;font-size:13px;margin:-6px 0 10px">已选择 {{ dlg.rows.length }} 种材料，提交时会再次核对当前可用库存。</div>
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
        <el-button v-if="od.rec.status === '有效'" @click="openReturn()">登记归还</el-button>
        <el-button v-if="od.rec.status === '有效'" type="danger" plain @click="openVoid()">作废并补回</el-button>
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
      <div v-if="rdlg.rec" style="color:#909399;font-size:13px;margin-top:12px">领取人固定为原记录中的 {{ rdlg.rec.receiver }}。</div>
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
      <div style="background:#f5f7fa;border-radius:6px;padding:14px 18px;margin:14px 0">
        <div style="color:#999;font-size:13px">将补回可用库存</div>
        <div style="font-size:24px;font-weight:700;color:#222;margin-top:4px">{{ oNet(vdlg.rec || {}) }}</div>
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
            <td style="width:90px;background:#f5f7fa;font-weight:600;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">出库批次</td>
            <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">{{ pdlg.rec.outNo }}</td>
            <td style="width:90px;background:#f5f7fa;font-weight:600;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">登记时间</td>
            <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">{{ pdlg.rec.createdAt }}</td>
          </tr>
          <tr>
            <td style="background:#f5f7fa;font-weight:600;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">工程</td>
            <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">{{ pdlg.rec.project }}</td>
            <td style="background:#f5f7fa;font-weight:600;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">领取人</td>
            <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">{{ pdlg.rec.receiver }}</td>
          </tr>
        </table>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="width:60px;background:#f5f7fa;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">序号</th>
              <th style="background:#f5f7fa;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">材料名称</th>
              <th style="background:#f5f7fa;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">材料编码</th>
              <th style="width:70px;background:#f5f7fa;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">单位</th>
              <th style="width:100px;background:#f5f7fa;border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">数量</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in pdlg.rec.items" :key="i">
              <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">{{ i + 1 }}</td>
              <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">{{ it.description }}</td>
              <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px">{{ it.code }}</td>
              <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:center">{{ it.unit }}</td>
              <td style="border:1px solid #dcdfe6;padding:8px 10px;font-size:13px;text-align:right">{{ fmt(it.qty) }}</td>
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
      { key: 'executed', label: '已执行' }, { key: 'settled', label: '已结算零计划' }, { key: 'canceled', label: '已取消周计划' }
    ];
    const TICKET_TYPES = ['配电：配电第一种工作票', '配电：配电第二种工作票', '低压：低压工作票', '线路：线路第一种工作票', '线路：线路第二种工作票', '配电：低压工作票'];
    const VOLTAGE_LEVELS = ['0.4kV', '10kV', '20kV', '35kV', '110kV', '220kV'];
    const PLAN_STATUS = ['未执行', '已执行', '已归档', '已取消', '已结算'];
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
    const filters = reactive({ startDate: '', endDate: '', name: '', content: '', keyword: '', noProject: false, team: '', leader: '', ticketType: '' });
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
      if (filters.startDate && p.startDate < filters.startDate) return false;
      if (filters.endDate && p.endDate > filters.endDate) return false;
      if (filters.name && !String(p.name || '').includes(filters.name)) return false;
      if (filters.keyword) {
        const k = filters.keyword;
        const hit = [p.name, p.content, p.team, p.leader, p.chargePerson, p.project, p.station].some(v => String(v || '').includes(k));
        if (!hit) return false;
      }
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
    const todayPlans = computed(() => {
      const t = fmtDate(new Date());
      return upcoming.value.filter(p => daySlice(p.startDate) <= t && daySlice(p.endDate) >= t);
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
    function statusType(s) { return s === '已执行' ? 'success' : s === '已取消' ? 'danger' : s === '未执行' ? 'warning' : 'info'; }
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
    // 项目详情「查看月/周计划」：带入项目关键词筛选
    function onFilterProject(e) {
      const name = e.detail && e.detail.project;
      if (!name) return;
      filters.keyword = name;
      page.value = 1;
    }
    window.addEventListener('plans-filter-project', onFilterProject);
    onUnmounted(() => window.removeEventListener('plans-filter-project', onFilterProject));
    onMounted(() => { loadMeta(); load(); });
    return { TABS, tab, list, loading, projects, projectsFull, teams, workers, riskFactors, filters, page, pageSize, paged, filtered, dlg, upcoming, todayPlans, calendarDays, fmtDT, dash, rowClass, copyPlan, execPlan, cancelPlan, notePlan, addMaterialFor, TICKET_TYPES, VOLTAGE_LEVELS, PLAN_STATUS, WORK_TYPES, SPECIALTIES, DEPTS, RISK_LEVELS, GRID_RISKS, MAJOR_RISKS, genMeasures, subProjectOptions, substations, unitsByType, workersFull, contacts, staffPick, groupedTeams, staffKey, openStaffPick, confirmStaffPick, toggleIdentity, onChargePersonInput, oneKeyFill, load, onTab, statusType, openAdd, openEdit, onProjectSelect, submit, remove, importPlans, exportPlans };
  },
  template: `
  <div>
    <div style="background:#fff;border:1px solid #ebeef5;border-radius:4px;padding:16px 18px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:17px;font-weight:600">日计划日历</div>
      </div>
      <div style="color:#909399;font-size:12px;margin-top:6px">未来 21 天共 {{ upcoming.length }} 个日历安排，跨日计划按覆盖日期展示</div>
      <div v-if="!calendarDays.length" style="margin-top:12px;background:#f7f8fa;border:1px solid #ebeef5;border-radius:6px;padding:16px;font-size:13px;color:#909399">未来 21 天暂无施工计划</div>
      <div v-else style="display:flex;gap:12px;overflow-x:auto;padding:12px 2px 4px">
        <div v-for="d in calendarDays" :key="d.ds" style="min-width:250px;max-width:280px;flex:0 0 auto;background:#fff;border:1px solid #ebeef5;border-radius:6px;padding:12px 14px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b style="font-size:14px">{{ d.label }}</b>
            <span style="background:#3370ff;color:#fff;border-radius:10px;font-size:12px;padding:1px 9px">{{ d.plans.length }} 条</span>
          </div>
          <div style="color:#606266;font-size:13px;margin-top:8px">班组长：{{ d.plans[0].leader || d.plans[0].team || '-' }}</div>
          <div v-for="p in d.plans" :key="p.id" style="color:#606266;font-size:13px;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            <span v-if="(p.startDate || '').length > 10" style="margin-right:4px">{{ p.startDate.slice(11, 16) }}</span>{{ p.name }}
          </div>
        </div>
      </div>
    </div>

    <el-tabs v-model="tab" @tab-change="onTab">
      <el-tab-pane v-for="t in TABS" :key="t.key" :label="t.label" :name="t.key" />
    </el-tabs>

    <div style="background:#fff;border:1px solid #e7e9ec;border-radius:4px;padding:14px 16px">
      <div style="display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;margin-bottom:2px">
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">开始日期</span>
          <el-date-picker v-model="filters.startDate" type="date" placeholder="选择日期" value-format="YYYY-MM-DD" style="width:132px" size="default" @change="page=1" />
        </div>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">结束日期</span>
          <el-date-picker v-model="filters.endDate" type="date" placeholder="选择日期" value-format="YYYY-MM-DD" style="width:132px" @change="page=1" />
        </div>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">作业计划名称</span>
          <el-input v-model="filters.name" placeholder="关键词" clearable style="width:132px" />
        </div>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">工作内容</span>
          <el-input v-model="filters.content" placeholder="关键词" clearable style="width:132px" />
        </div>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">关键词</span>
          <el-input v-model="filters.keyword" placeholder="关键词" clearable style="width:120px" />
        </div>
        <el-checkbox v-model="filters.noProject">未关联项目</el-checkbox>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">作业班组</span>
          <el-select v-model="filters.team" placeholder="全部" clearable style="width:116px">
            <el-option v-for="t in teams" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">班组长</span>
          <el-select v-model="filters.leader" placeholder="全部" clearable style="width:116px">
            <el-option v-for="w in workers" :key="w" :label="w" :value="w" />
          </el-select>
        </div>
        <div style="display:flex;align-items:center;gap:6px"><span class="f-label">工作票类型</span>
          <el-select v-model="filters.ticketType" placeholder="全部" clearable style="width:168px">
            <el-option v-for="t in TICKET_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <el-button type="primary" @click="openAdd">新增</el-button>
        <el-button @click="importPlans">导入 xlsx</el-button>
        <el-button @click="exportPlans">导出 xlsx</el-button>
      </div>

      <el-table :data="paged" v-loading="loading" border style="width:100%" :row-class-name="rowClass">
        <el-table-column type="index" label="序号" width="60" align="center" />
        <el-table-column prop="name" label="作业计划名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="team" label="作业班组" width="140" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="leader" label="班组长" width="100" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="startDate" label="计划开始" width="118" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="endDate" label="计划结束" width="118" :formatter="(r,c,v)=>fmtDT(v)" />
        <el-table-column prop="ticketType" label="工作票类型" width="170" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="voltage" label="电压等级" width="100" align="center" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="station" label="变电站/线路" min-width="130" show-overflow-tooltip :formatter="(r,c,v)=>dash(v)" />
        <el-table-column prop="chargePerson" label="工作负责人" width="110" :formatter="(r,c,v)=>dash(v)" />
        <el-table-column label="操作" width="168" fixed="right">
          <template #default="{row}">
            <div style="line-height:1.7">
              <el-button link type="warning" size="small" @click="addMaterialFor(row)">添加资料</el-button>
              <el-button link type="warning" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="warning" size="small" @click="copyPlan(row)">复制</el-button>
              <el-button link type="warning" size="small" @click="execPlan(row)">执行</el-button>
              <el-button link type="warning" size="small" @click="notePlan(row)">备注</el-button>
              <el-button link type="danger" size="small" @click="cancelPlan(row)">取消</el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty><el-empty description="暂无数据" :image-size="70" /></template>
      </el-table>

      <div style="display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:12px">
        <span style="color:#606266;font-size:13px">共 {{ filtered.length }} 条，第 {{ page }} 页</span>
        <el-select v-model="pageSize" size="small" style="width:110px" @change="page=1">
          <el-option v-for="s in [20, 50, 100]" :key="s" :label="s + ' 条/页'" :value="s" />
        </el-select>
        <el-button size="small" :disabled="page <= 1" @click="page = page - 1">上一页</el-button>
        <el-button size="small" :disabled="page >= Math.max(1, Math.ceil(filtered.length / pageSize))" @click="page = page + 1">下一页</el-button>
      </div>
    </div>

    <el-dialog :title="(dlg.editingId ? '编辑' : '新增') + (dlg.form && dlg.form.planType === '月计划' ? '月计划' : '周计划')" v-model="dlg.visible" width="min(1180px, 94%)" top="4vh">
      <el-form v-if="dlg.form" label-position="top" style="max-height:72vh;overflow:auto;padding-right:6px">
        <div style="border:1px solid #e7e9ec;border-radius:6px;padding:16px 20px 2px;margin:2px 0 14px;background:#fff">
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
            <el-form-item label="计划开始时间"><el-date-picker v-model="dlg.form.startDate" type="datetime" placeholder="请选择日期时间" value-format="YYYY-MM-DD HH:mm" style="width:100%" /></el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="计划结束时间"><el-date-picker v-model="dlg.form.endDate" type="datetime" placeholder="请选择日期时间" value-format="YYYY-MM-DD HH:mm" style="width:100%" /></el-form-item>
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

        <div style="border:1px solid #e7e9ec;border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:#fff">
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

        <div style="border:1px solid #e7e9ec;border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:#fff">
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

        <div style="border:1px solid #e7e9ec;border-radius:6px;padding:16px 20px 2px;margin:6px 0 14px;background:#fff">
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
        <div v-for="g in groupedTeams" :key="g.team" style="border:1px solid #e7e9ec;border-radius:6px;padding:12px 16px;margin-bottom:12px">
          <div style="font-weight:600;margin-bottom:8px">班组：{{ g.team }}</div>
          <div v-for="it in g.identities" :key="it.identity" style="margin-bottom:8px">
            <div style="margin-bottom:4px">身份：{{ it.identity }}<el-link type="primary" :underline="false" style="margin-left:10px" @click="toggleIdentity(it)">全选</el-link></div>
            <el-checkbox v-for="w in it.list" :key="w.id" v-model="staffPick.checked[staffKey(w)]" style="margin-right:16px">{{ w.name }} / {{ w.phone || '-' }}</el-checkbox>
          </div>
        </div>
        <div v-if="!groupedTeams.length" style="color:#909399;font-size:13px;text-align:center;padding:20px 0">暂无已准入的作业人员，请先在「用户管理-作业人员名单」中维护</div>
      </div>
      <template #footer>
        <el-button @click="staffPick.visible=false">取 消</el-button>
        <el-button type="primary" @click="confirmStaffPick">确 定</el-button>
      </template>
    </el-dialog>
  </div>`
};
app.component('PlansView', PlansView);
app.mount('#app');
