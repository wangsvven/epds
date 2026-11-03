/* ========== views/borrow ========== */
/* 借工管理：借工明细 / 单位余额 两页签（独立视图，取代原 CrudView + borrowCfg）。 */
const BorrowView = {
  setup() {
    const list = ref([]);
    const loading = ref(false);
    const tab = ref('detail');
    const filters = reactive({ unit: '', direction: '', signStatus: '', dateRange: null, keyword: '' });
    const subOpts = ref([]);        // 属地供电所
    const unitOpts = ref([]);       // 兄弟单位（单位维护）
    const allUnitOpts = computed(() => [...new Set([...subOpts.value, ...unitOpts.value])]);

    const DIRECTIONS = ['我方借出', '我方借入'];
    const PROJECT_TYPES = ['抢险抢修', '运维检修', '运维值班', '相互往来'];
    const SIGN_STATUS = ['未签单', '已签单'];
    const EVIDENCE_MAX = 5;

    const dlg = reactive({ visible: false, editing: false, busy: false, id: '', form: {} });
    const evDlg = reactive({ visible: false, recordId: '', busy: false, thumbs: {} });    const evInput = ref(null);

    // 当天（优先取服务器北京时间；不可用时回落本地日期）
    function todayStr() {
      try { if (typeof ServerTime !== 'undefined' && ServerTime.ymd) return ServerTime.ymd(); } catch (e) {}
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function newForm() {
      return {
        unit: '', direction: '我方借出', projectType: '',
        projectName: '', workContent: '', applyDate: todayStr(), workDate: todayStr(),
        techCount: 0, workerCount: 0, vehicleCount: 0, signStatus: '未签单', remark: ''
      };
    }

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/api/borrowWorks');
        list.value = Array.isArray(r) ? r : (r.data || []);
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { loading.value = false; }
    }
    async function loadOpts() {
      const names = arr => (Array.isArray(arr) ? arr : []).map(x => String((x && x.name) || '').trim()).filter(Boolean);
      try {
        const [subs, units] = await Promise.all([
          api.get('/api/substations').catch(() => []),
          api.get('/api/units').catch(() => [])
        ]);
        subOpts.value = [...new Set(names(subs))];
        unitOpts.value = [...new Set(names(units))];
      } catch (e) {}
    }

    const filtered = computed(() => list.value.filter(r => {
      if (!r) return false;
      if (filters.unit && r.unit !== filters.unit) return false;
      if (filters.direction && r.direction !== filters.direction) return false;
      if (filters.signStatus && (r.signStatus || '未签单') !== filters.signStatus) return false;
      const wd = String(r.workDate || '');
      const dr = filters.dateRange;
      if (Array.isArray(dr) && dr.length === 2) {
        if (dr[0] && wd < dr[0]) return false;
        if (dr[1] && wd > dr[1]) return false;
      }
      if (filters.keyword) {
        const k = filters.keyword;
        if (!String(r.projectName || '').includes(k) && !String(r.workContent || '').includes(k)) return false;
      }
      return true;
    }));
    function reset() { Object.assign(filters, { unit: '', direction: '', signStatus: '', dateRange: null, keyword: '' }); }

    function openAdd() { dlg.id = ''; dlg.editing = false; dlg.form = newForm(); dlg.visible = true; }
    function openEdit(row) {
      dlg.id = row.id; dlg.editing = true;
      dlg.form = {
        unit: row.unit || '', direction: row.direction || '我方借出',
        projectType: row.projectType || '', projectName: row.projectName || '', workContent: row.workContent || '',
        applyDate: row.applyDate || '', workDate: row.workDate || '',
        techCount: Number(row.techCount) || 0, workerCount: Number(row.workerCount) || 0, vehicleCount: Number(row.vehicleCount) || 0,
        signStatus: row.signStatus || '未签单', remark: row.remark || ''
      };
      dlg.visible = true;
    }
    async function submit() {
      const f = dlg.form;
      if (!String(f.unit || '').trim()) { ElementPlus.ElMessage.warning('请选择往来单位'); return; }
      if (!String(f.direction || '').trim()) { ElementPlus.ElMessage.warning('请选择方向'); return; }
      dlg.busy = true;
      try {
        const payload = {
          unit: f.unit, direction: f.direction,
          projectType: f.projectType || '', projectName: (f.projectName || '').trim(),
          workContent: (f.workContent || '').trim(), applyDate: f.applyDate || '', workDate: f.workDate || '',
          techCount: Number(f.techCount) || 0, workerCount: Number(f.workerCount) || 0, vehicleCount: Number(f.vehicleCount) || 0,
          signStatus: f.signStatus || '未签单', remark: (f.remark || '').trim()
        };
        if (dlg.editing) await api.put('/api/borrowWorks/' + dlg.id, payload);
        else await api.post('/api/borrowWorks', Object.assign({ evidences: [], generatedFiles: [] }, payload));
        ElementPlus.ElMessage.success('已保存');
        dlg.visible = false; load();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { dlg.busy = false; }
    }
    async function remove(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除该借工记录？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try { await api.del('/api/borrowWorks/' + row.id); ElementPlus.ElMessage.success('已删除'); load(); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    /* ---------------- 佐证 ---------------- */
    function revokeThumbs() {
      Object.keys(evDlg.thumbs).forEach(k => { try { URL.revokeObjectURL(evDlg.thumbs[k]); } catch (e) {} });
      evDlg.thumbs = {};
    }
    const evRecord = computed(() => list.value.find(x => x.id === evDlg.recordId) || null);
    const evFiles = computed(() => (evRecord.value && Array.isArray(evRecord.value.evidences)) ? evRecord.value.evidences : []);
    async function openEvidences(row) {
      evDlg.recordId = row.id; evDlg.visible = true; revokeThumbs();
      const evs = Array.isArray(row.evidences) ? row.evidences : [];
      for (const f of evs) {
        try {
          const { blob } = await api.download('/api/borrowWorks/' + row.id + '/evidences/' + f.id + '/download');
          evDlg.thumbs[f.id] = URL.createObjectURL(blob);
        } catch (e) {}
      }
    }
    async function onEvidenceFile(ev) {
      const file = ev.target.files && ev.target.files[0]; ev.target.value = '';
      if (!file) return;
      const row = evRecord.value; if (!row) return;
      const fd = new FormData(); fd.append('file', file);
      evDlg.busy = true;
      try {
        const item = await api.upload('/api/borrowWorks/' + row.id + '/evidences', fd);
        const fresh = await api.get('/api/borrowWorks/' + row.id);
        Object.assign(row, fresh);
        if (item && item.id) {
          try { const { blob } = await api.download('/api/borrowWorks/' + row.id + '/evidences/' + item.id + '/download'); evDlg.thumbs[item.id] = URL.createObjectURL(blob); } catch (e) {}
        }
        ElementPlus.ElMessage.success('已上传');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { evDlg.busy = false; }
    }
    function previewEvidence(f) {
      const u = evDlg.thumbs[f.id];
      if (u) window.open(u, '_blank');
      else ElementPlus.ElMessage.info('图片加载中，请稍后重试');
    }
    async function removeEvidence(f) {
      const row = evRecord.value; if (!row) return;
      try { await ElementPlus.ElMessageBox.confirm('确认删除该佐证？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/borrowWorks/' + row.id + '/evidences/' + f.id);
        if (evDlg.thumbs[f.id]) { try { URL.revokeObjectURL(evDlg.thumbs[f.id]); } catch (e) {} delete evDlg.thumbs[f.id]; }
        const fresh = await api.get('/api/borrowWorks/' + row.id);
        Object.assign(row, fresh);
        ElementPlus.ElMessage.success('已删除');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    /* ---------------- 生成借工单（生成后直接下载，不再弹二级窗） ---------------- */
    function hasGen(row) { return !!(row && Array.isArray(row.generatedFiles) && row.generatedFiles.some(x => x && x.category === '借工单')); }
    async function downloadFile(recordId, f) {
      const { blob, name } = await api.download('/api/borrowWorks/' + recordId + '/generated/' + f.id + '/download');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name || f.name || '借工单.docx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
    }
    async function generate(row) {
      if (!row || !row.id) return;
      try {
        const item = await api.post('/api/borrowWorks/' + row.id + '/borrowForm/generate');
        const fresh = await api.get('/api/borrowWorks/' + row.id);
        Object.assign(row, fresh);
        const f = (row.generatedFiles || []).find(x => x && x.category === '借工单');
        if (f) await downloadFile(row.id, f);
        ElementPlus.ElMessage.success(item && item.updated ? '已重新生成并下载' : '已生成并下载');
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    /* ---------------- 单位余额（仅已签单、未删除；差额 = 借出 − 借入） ---------------- */
    const balanceRows = computed(() => {
      const map = new Map();
      list.value.filter(r => r && (r.signStatus === '已签单')).forEach(r => {
        const u = String(r.unit || '').trim() || '（未填单位）';
        let g = map.get(u);
        if (!g) { g = { unit: u, outTech: 0, outWorker: 0, outVehicle: 0, inTech: 0, inWorker: 0, inVehicle: 0 }; map.set(u, g); }
        const t = Number(r.techCount) || 0, w = Number(r.workerCount) || 0, v = Number(r.vehicleCount) || 0;
        if (r.direction === '我方借入') { g.inTech += t; g.inWorker += w; g.inVehicle += v; }
        else { g.outTech += t; g.outWorker += w; g.outVehicle += v; }
      });
      return [...map.values()]
        .map(g => Object.assign({}, g, { dTech: g.outTech - g.inTech, dWorker: g.outWorker - g.inWorker, dVehicle: g.outVehicle - g.inVehicle }))
        .sort((a, b) => String(a.unit).localeCompare(String(b.unit)));
    });

    function fmtTime(v) { return String(v || '').slice(0, 16).replace('T', ' '); }

    onMounted(() => { load(); loadOpts(); });
    onUnmounted(() => revokeThumbs());

    return {
      list, loading, tab, filters, subOpts, unitOpts, allUnitOpts,
      DIRECTIONS, PROJECT_TYPES, SIGN_STATUS, EVIDENCE_MAX,
      filtered, reset, dlg, openAdd, openEdit, submit, remove,
      evDlg, evInput, evRecord, evFiles, openEvidences, onEvidenceFile, previewEvidence, removeEvidence, revokeThumbs,
      hasGen, generate,
      balanceRows, fmtTime
    };
  },
  template: `
  <div>
    <el-tabs v-model="tab" class="plan-tabs">
      <el-tab-pane label="借工明细" name="detail" />
      <el-tab-pane label="单位余额" name="balance" />
    </el-tabs>

    <template v-if="tab === 'detail'">
      <div class="ct-toolbar">
        <el-button v-if="canWrite('borrow')" type="primary" size="small" @click="openAdd">新增借工</el-button>
      </div>

      <div class="wv-filters">
        <el-select v-model="filters.unit" placeholder="往来单位" clearable filterable style="width:160px">
          <el-option v-for="u in allUnitOpts" :key="u" :label="u" :value="u" />
        </el-select>
        <el-select v-model="filters.direction" placeholder="方向" clearable style="width:130px">
          <el-option v-for="d in DIRECTIONS" :key="d" :label="d" :value="d" />
        </el-select>
        <el-select v-model="filters.signStatus" placeholder="签单状态" clearable style="width:130px">
          <el-option v-for="s in SIGN_STATUS" :key="s" :label="s" :value="s" />
        </el-select>
        <el-date-picker v-model="filters.dateRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="用工起" end-placeholder="用工止" style="width:250px" />
        <el-input v-model="filters.keyword" placeholder="项目名称 / 工作内容" clearable style="width:200px" />
        <el-button @click="reset">重置</el-button>
        <span style="margin-left:auto;font-size:13px;color:var(--text-3)">共 {{ filtered.length }} 条</span>
      </div>

      <el-table :data="filtered" v-loading="loading" border stripe style="width:100%" empty-text="暂无数据">
        <el-table-column type="index" label="序号" width="60" align="center" />
        <el-table-column label="日期" width="100">
          <template #default="{ row }">{{ (row.workDate || '').replace(/-/g, '.') }}</template>
        </el-table-column>
        <el-table-column label="方向" width="96">
          <template #default="{ row }">
            <el-tag size="small" :type="row.direction === '我方借入' ? 'warning' : ''">{{ row.direction || '-' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="unit" label="往来单位" min-width="140" show-overflow-tooltip />
        <el-table-column prop="techCount" label="技工（人次）" width="104" align="center" />
        <el-table-column prop="workerCount" label="民工（人次）" width="104" align="center" />
        <el-table-column prop="vehicleCount" label="车辆（辆次）" width="104" align="center" />
        <el-table-column prop="workContent" label="工作内容" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="250">
          <template #default="{ row }">
            <div v-if="canWrite('borrow')" class="bw-acts">
              <el-button link type="warning" size="small" @click="generate(row)">{{ hasGen(row) ? '重新生成' : '生成借工单' }}</el-button>
              <el-button link type="primary" size="small" @click="openEvidences(row)">佐证（{{ (row.evidences || []).length }}）</el-button>
              <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
              <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
            </div>
            <span v-else style="color:var(--text-3)">-</span>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template v-else>
      <el-table :data="balanceRows" border stripe style="width:100%" empty-text="暂无已签单记录">
        <el-table-column prop="unit" label="单位" min-width="180" show-overflow-tooltip />
        <el-table-column prop="outTech" label="借出技工" width="100" align="center" />
        <el-table-column prop="outWorker" label="借出民工" width="100" align="center" />
        <el-table-column prop="outVehicle" label="借出车辆" width="100" align="center" />
        <el-table-column prop="inTech" label="借入技工" width="100" align="center" />
        <el-table-column prop="inWorker" label="借入民工" width="100" align="center" />
        <el-table-column prop="inVehicle" label="借入车辆" width="100" align="center" />
        <el-table-column prop="dTech" label="差额技工" width="100" align="center" />
        <el-table-column prop="dWorker" label="差额民工" width="100" align="center" />
        <el-table-column prop="dVehicle" label="差额车辆" width="100" align="center" />
      </el-table>
    </template>

    <!-- 新增/编辑弹窗 -->
    <el-dialog :title="dlg.editing ? '编辑借工' : '新增借工'" v-model="dlg.visible" width="min(760px, 94%)" label-position="top">
      <el-form :model="dlg.form" label-position="top">
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="往来单位" required>
              <el-select v-model="dlg.form.unit" filterable clearable placeholder="从属地供电所或兄弟单位选择" style="width:100%">
                <el-option-group v-if="subOpts.length" label="属地供电所">
                  <el-option v-for="u in subOpts" :key="'s-' + u" :label="u" :value="u" />
                </el-option-group>
                <el-option-group v-if="unitOpts.length" label="兄弟单位">
                  <el-option v-for="u in unitOpts" :key="'u-' + u" :label="u" :value="u" />
                </el-option-group>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="方向" required>
              <el-select v-model="dlg.form.direction" style="width:100%">
                <el-option v-for="d in DIRECTIONS" :key="d" :label="d" :value="d" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="项目类型">
              <el-select v-model="dlg.form.projectType" clearable placeholder="请选择" style="width:100%">
                <el-option v-for="t in PROJECT_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="项目名称">
              <el-input v-model="dlg.form.projectName" maxlength="100" placeholder="选填" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="工作内容">
          <el-input v-model="dlg.form.workContent" type="textarea" :rows="3" placeholder="选填" />
        </el-form-item>
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="申请日期">
              <el-date-picker v-model="dlg.form.applyDate" type="date" value-format="YYYY-MM-DD" placeholder="选填" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="用工日期">
              <el-date-picker v-model="dlg.form.workDate" type="date" value-format="YYYY-MM-DD" placeholder="选填" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :xs="8" :sm="8">
            <el-form-item label="技工（人次）">
              <el-input-number v-model="dlg.form.techCount" :min="0" :step="1" :precision="0" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="8" :sm="8">
            <el-form-item label="民工（人次）">
              <el-input-number v-model="dlg.form.workerCount" :min="0" :step="1" :precision="0" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :xs="8" :sm="8">
            <el-form-item label="车辆（辆次）">
              <el-input-number v-model="dlg.form.vehicleCount" :min="0" :step="1" :precision="0" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :xs="24" :sm="12">
            <el-form-item label="签单状态">
              <el-select v-model="dlg.form.signStatus" style="width:100%">
                <el-option v-for="s in SIGN_STATUS" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="dlg.form.remark" maxlength="200" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="dlg.busy" @click="submit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 佐证弹窗 -->
    <el-dialog v-model="evDlg.visible" title="佐证" width="min(720px, 94%)" @close="revokeThumbs">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px;color:var(--text-2)">已上传 {{ evFiles.length }} / {{ EVIDENCE_MAX }}</span>
        <el-button v-if="canWrite('borrow')" size="small" type="primary"
          :disabled="evFiles.length >= EVIDENCE_MAX || evDlg.busy" @click="evInput.click()">上传佐证</el-button>
        <input ref="evInput" type="file" accept="image/*" style="display:none" @change="onEvidenceFile" />
      </div>
      <div v-if="evFiles.length" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(140px, 1fr));gap:12px">
        <div v-for="f in evFiles" :key="f.id" style="border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface-2)">
          <div style="height:100px;display:flex;align-items:center;justify-content:center;background:var(--surface-3);overflow:hidden">
            <img v-if="evDlg.thumbs[f.id]" :src="evDlg.thumbs[f.id]" alt="" style="max-width:100%;max-height:100%;object-fit:contain" />
            <span v-else style="font-size:12px;color:var(--text-3)">加载中…</span>
          </div>
          <div style="padding:6px 8px;font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" :title="f.name">{{ f.name }}</div>
          <div style="display:flex;justify-content:space-between;padding:0 8px 8px">
            <el-button link type="primary" size="small" @click="previewEvidence(f)">预览</el-button>
            <el-button v-if="canWrite('borrow')" link type="danger" size="small" @click="removeEvidence(f)">删除</el-button>
          </div>
        </div>
      </div>
      <el-empty v-else description="暂无佐证" :image-size="64" />
    </el-dialog>
  </div>`
};
