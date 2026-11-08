/* ========== views/contacts ========== */
/* 用户管理 · 外部通讯录面板 ContactsPanel。 */
/* 用户管理 — 标签页3：外部通讯录 */
/* 用户管理 — 外部通讯录（对齐截图：配置说明 + 新增/导入/导出 + 部门表） */
const ContactsPanel = {
  setup() {
    const list = ref([]);
    const loading = ref(false);
    const filters = reactive({ dept: '', name: '' });
    const dlg = reactive({ visible: false, editing: false, busy: false, id: '', dept: '', name: '', post: '', phone: '', shortNo: '', remark: '' });
    const fileInput = ref(null);
    const snapshots = ref([]);
    const restoreDlg = reactive({ visible: false, busy: false, selected: '' });

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
      Object.assign(dlg, { visible: true, editing: false, busy: false, id: '', dept: '', name: '', post: '', phone: '', shortNo: '', remark: '' });
    }
    function openEdit(row) {
      Object.assign(dlg, {
        visible: true, editing: true, busy: false, id: row.id,
        dept: row.dept || row.unit || '', name: row.name || '', post: row.post || '',
        phone: row.phone || '', shortNo: row.shortNo || '', remark: row.remark || ''
      });
    }
    async function submit() {
      const name = (dlg.name || '').trim();
      if (!name) { ElementPlus.ElMessage.warning('请填写姓名'); return; }
      dlg.busy = true;
      try {
        const payload = {
          dept: (dlg.dept || '').trim(), name,
          post: (dlg.post || '').trim(), phone: (dlg.phone || '').trim(), shortNo: (dlg.shortNo || '').trim(),
          remark: (dlg.remark || '').trim()
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
      try {
        await ElementPlus.ElMessageBox.confirm(
          '将以「' + file.name + '」的内容整体替换当前通讯录（当前共 ' + list.value.length + ' 人）。导入前系统会自动保存快照，可在「恢复导入前备份」中还原。是否继续？',
          '导入并覆盖通讯录', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' });
      } catch (e) { return; }
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/contacts/import', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
          body: fd
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success('导入完成：' + data.imported + ' 位联系人（覆盖原有 ' + (data.replaced || 0) + ' 条），已保存导入前快照');
        load(); loadSnapshots();
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
    async function loadSnapshots() {
      try { snapshots.value = await api.get('/api/contacts/import-snapshots'); }
      catch (e) { snapshots.value = []; }
    }
    function openRestore() {
      if (!snapshots.value.length) return;
      restoreDlg.selected = snapshots.value[0].file;
      restoreDlg.visible = true;
    }
    async function doRestore() {
      if (!restoreDlg.selected) return;
      const item = snapshots.value.find(s => s.file === restoreDlg.selected);
      try {
        await ElementPlus.ElMessageBox.confirm(
          '确认将通讯录恢复到「' + (item ? item.createdAt : restoreDlg.selected) + '」的快照（' + (item ? item.count : 0) + ' 条）？当前数据会在恢复前自动保存一份快照，可再恢复回来。',
          '恢复导入前备份', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' });
      } catch (e) { return; }
      restoreDlg.busy = true;
      try {
        const r = await api.post('/api/contacts/restore-snapshot', { file: restoreDlg.selected });
        ElementPlus.ElMessage.success('已恢复 ' + r.restored + ' 条联系人');
        restoreDlg.visible = false;
        load(); await loadSnapshots();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { restoreDlg.busy = false; }
    }
    function deptOf(row) { return row.dept || row.unit || '-'; }

    onMounted(() => { load(); loadSnapshots(); });
    return { list, loading, filters, filtered, reset, dlg, fileInput, snapshots, restoreDlg,
      openAdd, openEdit, submit, remove, triggerImport, onFileChange, doExport, deptOf,
      loadSnapshots, openRestore, doRestore };
  },
  template: `
  <div>
    <div class="wv-alert">
      <span class="wv-alert-icon">i</span>
      <div class="wv-alert-main">
        <div class="wv-alert-title">配置说明</div>
        <div class="wv-alert-text">外部通讯录用于维护工作票和施工资料中需要引用的联系人，与登录账号、作业人员名单分开维护。建议至少填写姓名和手机；系统会按姓名匹配联系方式。导入会整体替换现有通讯录，系统会在替换前自动保存快照，可在「恢复导入前备份」中还原；导出文件可直接再次导入。</div>
      </div>
    </div>

    <div class="ct-toolbar">
      <el-button v-if="canWrite('users')" type="primary" size="small" @click="openAdd">新增</el-button>
      <el-button v-if="canWrite('users')" size="small" @click="triggerImport">导入</el-button>
      <el-button size="small" :disabled="!list.length" @click="doExport">导出</el-button>
      <el-button v-if="canWrite('users')" size="small" :disabled="!snapshots.length" @click="openRestore">恢复导入前备份</el-button>
      <input ref="fileInput" type="file" accept=".xls,.xlsx,.csv" style="display:none" @change="onFileChange" />
    </div>
    <div class="ct-hint-line">支持含「员工」sheet 的 xls/xlsx；标准表头：部门、姓名、职务、手机、移动短号、备注。导入会整体替换现有通讯录，系统会自动保存导入前快照，可随时恢复。</div>

    <div class="wv-filters">
      <el-input v-model="filters.dept" placeholder="按部门筛选" clearable style="width:180px" />
      <el-input v-model="filters.name" placeholder="按姓名筛选" clearable style="width:180px" />
      <el-button @click="reset">重置</el-button>
    </div>

    <el-table class="flat-table" :data="filtered" v-loading="loading" style="width:100%" empty-text="暂无数据">
      <el-table-column label="部门" min-width="150"><template #default="{row}">{{ deptOf(row) }}</template></el-table-column>
      <el-table-column prop="name" label="姓名" min-width="96" />
      <el-table-column prop="post" label="职务" min-width="116" />
      <el-table-column prop="phone" label="手机" min-width="124" />
      <el-table-column prop="shortNo" label="移动短号" min-width="104" />
      <el-table-column prop="remark" label="备注" min-width="280" class-name="ct-remark-cell" />
      <el-table-column label="操作" width="132">
        <template #default="{row}">
          <el-button v-if="canWrite('users')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="canWrite('users')" link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog :title="dlg.editing ? '编辑通讯录' : '新增通讯录'" v-model="dlg.visible" width="min(640px, 94%)" label-position="top">
      <el-form :model="dlg" label-position="top">
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="部门">
              <el-input v-model="dlg.dept" placeholder="如：公司领导、办公室" maxlength="60" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="姓名" required>
              <el-input v-model="dlg.name" placeholder="姓名" maxlength="40" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="职务">
              <el-input v-model="dlg.post" placeholder="选填" maxlength="40" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="手机">
              <el-input v-model="dlg.phone" placeholder="选填" maxlength="20" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="移动短号">
          <el-input v-model="dlg.shortNo" placeholder="选填" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="dlg.remark" type="textarea" :rows="3" placeholder="选填，可填写负责片区、村社等" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="dlg.busy" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog title="恢复导入前备份" v-model="restoreDlg.visible" width="min(520px, 94%)">
      <div style="font-size:13px;color:var(--text-2);margin-bottom:12px">选择一份导入前自动保存的快照，恢复后当前通讯录会被整体替换；系统会在恢复前再保存一份快照，可再恢复回来。</div>
      <el-radio-group v-model="restoreDlg.selected" style="display:flex;flex-direction:column;gap:10px;align-items:flex-start">
        <el-radio v-for="s in snapshots" :key="s.file" :label="s.file" :value="s.file">{{ s.createdAt || s.file }} · {{ s.count }} 条</el-radio>
      </el-radio-group>
      <template #footer>
        <el-button @click="restoreDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="restoreDlg.busy" :disabled="!restoreDlg.selected" @click="doRestore">恢复</el-button>
      </template>
    </el-dialog>
  </div>`
};

