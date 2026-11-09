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
    // 导入：选文件 → 选模式（默认增量）→ 预览 →（同名组弹窗）→ 确认落库
    const impModeDlg = reactive({ visible: false, file: null, mode: 'merge' });
    const imp = reactive({ visible: false, busy: false, file: null, mode: 'merge',
      rows: [], summary: {}, errors: [], deleteList: [], changeList: [] });
    const sameDlg = reactive({ visible: false, busy: false, items: [] });

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
    function impKindType(k) {
      return { '新增': 'success', '更新': 'warning', '无变化': 'info', '同名待确认': 'warning', '冲突': 'danger' }[k] || 'info';
    }
    function triggerImport() { if (fileInput.value) fileInput.value.click(); }
    function onFileChange(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      impModeDlg.file = file;
      impModeDlg.mode = 'merge'; // 增量导入为默认
      impModeDlg.visible = true;
    }
    function impFormData(file, mode, decisions) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      if (decisions) fd.append('decisions', JSON.stringify(decisions));
      return fd;
    }
    async function impPost(path, fd) {
      const r = await fetch(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') },
        body: fd
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    }
    async function runPreview() {
      impModeDlg.visible = false;
      imp.file = impModeDlg.file; imp.mode = impModeDlg.mode;
      imp.rows = []; imp.summary = {}; imp.errors = [];
      imp.deleteList = []; imp.changeList = [];
      imp.visible = true; imp.busy = true;
      try {
        const r = await impPost('/api/contacts/import/preview', impFormData(imp.file, imp.mode));
        if (r.status >= 400) {
          imp.errors = Array.isArray(r.data.errors) && r.data.errors.length ? r.data.errors : [r.data.error || '预览失败'];
          return;
        }
        imp.rows = r.data.rows || []; imp.summary = r.data.summary || {};
        imp.deleteList = r.data.deleteList || []; imp.changeList = r.data.changeList || [];
      } catch (e) { imp.errors = [e.message || '预览失败']; }
      finally { imp.busy = false; }
    }
    function confirmImport() {
      if (!imp.file || imp.busy) return;
      const same = imp.mode === 'merge' ? imp.rows.filter(r => r.kind === '同名待确认') : [];
      if (same.length) {
        sameDlg.items = same.map(r => ({
          rowNo: r.rowNo, name: r.name, phone: r.phone, dept: r.dept, post: r.post,
          candidates: r.candidates || [], action: 'add',
          // 库内同名有多个时必须显式指明目标；只有一个时自动指向它
          targetId: (r.candidates && r.candidates.length === 1) ? r.candidates[0].id : ''
        }));
        sameDlg.visible = true;
        return; // 处置未完成（关闭 / 取消）不落库
      }
      doConfirm([]);
    }
    function sameDecisions() {
      return sameDlg.items.map(it => ({
        rowNo: it.rowNo,
        action: it.action === 'update' && it.targetId ? 'update' : 'add',
        targetId: it.action === 'update' ? it.targetId : ''
      }));
    }
    async function doConfirm(decisions) {
      if (!imp.file || imp.busy) return;
      imp.busy = true; sameDlg.busy = true;
      try {
        const r = await impPost('/api/contacts/import/confirm', impFormData(imp.file, imp.mode, decisions || []));
        if (r.status >= 400) {
          imp.errors = Array.isArray(r.data.errors) && r.data.errors.length ? r.data.errors : [r.data.error || '导入失败'];
          imp.rows = []; imp.summary = {}; imp.deleteList = []; imp.changeList = [];
          sameDlg.visible = false;
          return;
        }
        const d = r.data;
        let msg = '新增 ' + (d.added || 0) + ' 人、更新 ' + (d.updated || 0) + ' 人、跳过 ' + (d.skipped || 0) + ' 人';
        if (d.mode === 'replace') msg += '、删除 ' + (d.deleted || 0) + ' 人';
        ElementPlus.ElMessage.success(msg);
        sameDlg.visible = false; imp.visible = false;
        load(); loadSnapshots();
      } catch (e) { ElementPlus.ElMessage.error(e.message || '导入失败'); }
      finally { imp.busy = false; sameDlg.busy = false; }
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
      loadSnapshots, openRestore, doRestore,
      impModeDlg, imp, sameDlg, impKindType, runPreview, confirmImport, sameDecisions, doConfirm };
  },
  template: `
  <div>
    <div class="wv-alert">
      <span class="wv-alert-icon">i</span>
      <div class="wv-alert-main">
        <div class="wv-alert-title">配置说明</div>
        <div class="wv-alert-text">外部通讯录用于维护工作票和施工资料中需要引用的联系人，与登录账号、作业人员名单分开维护。建议至少填写姓名和手机；系统会按姓名匹配联系方式。导入默认为增量导入（新人追加、旧人有值更新，文件中没有的联系人保持不动），也可显式选择全量覆盖；两种模式都会先预览确认并在导入前自动保存快照，可在「恢复导入前备份」中还原；导出文件可直接再次导入。</div>
      </div>
    </div>

    <div class="ct-toolbar">
      <el-button v-if="canWrite('users')" type="primary" size="small" @click="openAdd">新增</el-button>
      <el-button v-if="canWrite('users')" size="small" @click="triggerImport">导入</el-button>
      <el-button size="small" :disabled="!list.length" @click="doExport">导出</el-button>
      <el-button v-if="canWrite('users')" size="small" :disabled="!snapshots.length" @click="openRestore">恢复导入前备份</el-button>
      <input ref="fileInput" type="file" accept=".xls,.xlsx,.csv" style="display:none" @change="onFileChange" />
    </div>
    <div class="ct-hint-line">支持含「员工」sheet 的 xls/xlsx；标准表头：部门、姓名、职务、手机、移动短号、备注。导入默认为增量导入，全量覆盖需在选择模式时显式指定；两种模式均先预览确认，导入前自动保存快照。</div>

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

    <el-dialog title="导入外部通讯录 — 选择模式" v-model="impModeDlg.visible" width="min(520px, 94%)">
      <el-radio-group v-model="impModeDlg.mode" style="display:flex;flex-direction:column;gap:12px;align-items:flex-start">
        <el-radio label="merge" value="merge">增量导入（默认）：新人追加、旧人有值更新，文件中没有的联系人保持不动</el-radio>
        <el-radio label="replace" value="replace">全量覆盖：整体替换当前通讯录</el-radio>
      </el-radio-group>
      <div v-if="impModeDlg.mode==='replace'" style="margin-top:12px;color:var(--danger-text);font-size:13px;line-height:1.7">
        警示：全量覆盖会整体替换当前通讯录，文件中没有的联系人会被删除。系统会在导入前自动保存快照，可在「恢复导入前备份」中还原。
      </div>
      <template #footer>
        <el-button @click="impModeDlg.visible=false">取消</el-button>
        <el-button type="primary" @click="runPreview">下一步：预览</el-button>
      </template>
    </el-dialog>

    <el-dialog :title="'导入预览 — ' + (imp.mode==='replace' ? '全量覆盖' : '增量导入')" v-model="imp.visible" width="min(900px, 96%)" top="6vh">
      <div v-if="imp.errors.length" style="color:var(--danger-text);line-height:1.8">
        <div style="font-weight:600;margin-bottom:8px">文件存在错误，请修改后重新导入：</div>
        <div v-for="(e,i) in imp.errors" :key="i">{{ e }}</div>
      </div>
      <template v-else>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px">
          <span v-for="(n,k) in imp.summary" :key="k" style="font-size:12.5px;color:var(--text-2)">{{ k }} {{ n }}</span>
        </div>
        <div v-if="imp.mode==='replace'" style="margin-bottom:12px;padding:10px 12px;border:1px solid var(--danger-line);background:var(--danger-bg);border-radius:6px">
          <div style="font-weight:600;color:var(--danger-text);margin-bottom:6px">将删除以下 {{ imp.deleteList.length }} 名联系人（文件中没有）</div>
          <div v-for="(d,i) in imp.deleteList" :key="i" style="font-size:12.5px;line-height:1.8">{{ d.name || '—' }} · {{ d.phone || '无手机号' }}</div>
          <div v-if="!imp.deleteList.length" style="font-size:12.5px;color:var(--text-3)">无</div>
          <div v-if="imp.changeList.length" style="margin-top:10px">
            <div style="font-size:12.5px;font-weight:600;margin-bottom:4px">将变更 {{ imp.changeList.length }} 人：</div>
            <div v-for="(c,i) in imp.changeList" :key="i" style="font-size:12.5px;line-height:1.8">
              {{ c.name || '—' }} · {{ c.phone || '无手机号' }}
              <span v-for="(d,j) in c.diffs" :key="j" style="color:var(--text-2)"> ｜ {{ d.field }}：{{ d.old || '空' }} → {{ d.next || '空' }}</span>
            </div>
          </div>
        </div>
        <div v-if="imp.summary['同名待确认']" style="margin-bottom:10px;font-size:13px;color:var(--warn-text)">有 {{ imp.summary['同名待确认'] }} 名同名联系人需确认处置，点击「确认导入」后逐人选择。</div>
        <el-table v-if="imp.mode!=='replace'" :data="imp.rows" border size="small" max-height="340" empty-text="没有可导入的数据行">
          <el-table-column prop="rowNo" label="行" width="56" />
          <el-table-column prop="name" label="姓名" min-width="110" />
          <el-table-column prop="phone" label="手机" min-width="140" />
          <el-table-column label="分类" width="150">
            <template #default="{row}"><el-tag size="small" :type="impKindType(row.kind)">{{ row.kind }}</el-tag></template>
          </el-table-column>
          <el-table-column label="差异 / 原因" min-width="240">
            <template #default="{row}">
              <div v-for="(d,i) in row.diffs" :key="i" style="font-size:12.5px;line-height:1.7">{{ d.field }}：{{ d.old || '空' }} → {{ d.next || '空' }}</div>
              <span v-if="!row.diffs.length" style="font-size:12.5px;color:var(--text-3)">{{ row.reason || '-' }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <template #footer>
        <el-button @click="imp.visible=false">取消</el-button>
        <el-button v-if="!imp.errors.length" type="primary" :loading="imp.busy" :disabled="imp.busy" @click="confirmImport">确认导入</el-button>
      </template>
    </el-dialog>

    <el-dialog title="同名联系人处置" v-model="sameDlg.visible" width="min(760px, 96%)" top="6vh">
      <div style="font-size:13px;color:var(--text-2);margin-bottom:12px">以下联系人与库内同名但号码对不上，请逐人选择处置方式；未完成处置不会写入任何数据。</div>
      <div v-for="it in sameDlg.items" :key="it.rowNo" style="border:1px solid var(--line);border-radius:6px;padding:12px;margin-bottom:12px">
        <div style="font-weight:600;margin-bottom:8px">第 {{ it.rowNo }} 行 · {{ it.name }}</div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--text-2);margin-bottom:10px">
          <div><span style="color:var(--text-3)">文件行：</span>新号码 {{ it.phone || '无' }} · 部门 {{ it.dept || '—' }} · 职务 {{ it.post || '—' }}</div>
          <div v-for="c in it.candidates" :key="c.id"><span style="color:var(--text-3)">库内同名：</span>号码 {{ c.phone || '无' }} · 部门 {{ c.dept || '—' }} · 职务 {{ c.post || '—' }}</div>
        </div>
        <el-radio-group v-model="it.action">
          <el-radio label="add" value="add">新增联系人（默认）</el-radio>
          <el-radio label="update" value="update" :disabled="!it.candidates.length">更新此人号码</el-radio>
        </el-radio-group>
        <div v-if="it.action==='update' && it.candidates.length > 1" style="margin-top:8px">
          <el-select v-model="it.targetId" placeholder="请选择要更新的库内联系人" style="width:min(320px,100%)">
            <el-option v-for="c in it.candidates" :key="c.id" :label="(c.phone || '无号码') + ' · ' + (c.dept || '无部门')" :value="c.id" />
          </el-select>
        </div>
        <div v-else-if="it.action==='update'" style="margin-top:8px;font-size:12px;color:var(--text-3)">将更新该库内联系人的号码及其余有值字段。</div>
      </div>
      <template #footer>
        <el-button @click="sameDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="sameDlg.busy" @click="doConfirm(sameDecisions())">确定并导入</el-button>
      </template>
    </el-dialog>
  </div>`
};

