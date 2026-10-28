/* ========== views/settings ========== */
/* 全局设置视图 SettingsView。 */
const SettingsView = {
  setup() {
    const active = ref('annualPlans');
    const site = reactive({ companyName: '', icp: '', systemName: '', defaultSource: '甲供材料', allowSelfPurchase: true, loginBg: '', loginBgMode: 'cover', loginBgRotate: 0, weekStart: 1, welcome: { greeting: '', logoUrl: '' } });
    const savedName = ref('');
    async function loadSite() {
      try {
        const s = await api.get('/api/settings');
        Object.assign(site, s);
        if (!site.welcome) site.welcome = { greeting: '', logoUrl: '' };
        if (!site.loginBgMode) site.loginBgMode = 'cover';
        if (![0, 90, 180, 270].includes(Number(site.loginBgRotate))) site.loginBgRotate = 0;
        savedName.value = s.companyName || '';
        // 星期开始于：非法值/未设置一律视为 1（星期一），下拉框与全局状态口径一致
        site.weekStart = window.normWeekStart(site.weekStart);
        window.WeekStart.value = site.weekStart;
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
        await api.put('/api/settings', { companyName: site.companyName, icp: site.icp, systemName: site.systemName, defaultSource: site.defaultSource, allowSelfPurchase: site.allowSelfPurchase, weekStart: window.normWeekStart(site.weekStart) });
        savedName.value = site.companyName;
        window.WeekStart.value = window.normWeekStart(site.weekStart); // 全局共享状态即时生效（SPA 内）
        ElementPlus.ElMessage.success('设置已保存');
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
          <el-form label-position="top" style="margin-top:16px">
            <el-form-item label="星期开始于">
              <el-select v-model="site.weekStart" style="max-width:220px">
                <el-option :value="1" label="星期一" />
                <el-option :value="2" label="星期二" />
                <el-option :value="3" label="星期三" />
                <el-option :value="4" label="星期四" />
                <el-option :value="5" label="星期五" />
                <el-option :value="6" label="星期六" />
                <el-option :value="0" label="星期日" />
              </el-select>
            </el-form-item>
          </el-form>
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
