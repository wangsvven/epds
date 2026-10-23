/* ========== js/api ========== */
/* 只放请求封装：api 对象（GET/POST/PUT/DELETE 与上传、401 处理）。 */
/* Vue 全局解构：本文件是应用首个脚本，组合式 API 需在此统一取出供后续全部脚本使用 */
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
