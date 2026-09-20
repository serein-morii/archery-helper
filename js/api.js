/**
 * Archery v1.9.1 API 客户端。
 *
 * 认证模型：Django session cookie。
 * - 扩展页面 fetch 使用 credentials:'include'，配合 manifest 的 host_permissions，
 *   浏览器会自动携带并保存目标 Archery 域的 sessionid。
 * - CSRF：POST 需要 X-CSRFToken，值通过 chrome.cookies 读取 csrftoken cookie
 *   （扩展页面读不到该域的 document.cookie，只能走 cookies API）。
 * - 会话过期时自动用保存的账号密码重登一次。
 */

const DEFAULT_CONFIG = {
  baseUrl: '', // 首次使用在弹窗里填写你的 Archery 地址，如 http://archery.example.com:9123
  username: '',
  password: '',
  totpSecret: '',
};

/* ---------------- TOTP（RFC 6238）本地计算 ---------------- */

/** 从 otpauth:// 链接或 base32 字符串中提取密钥 */
export function parseTotpSecret(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return (u.searchParams.get('secret') || '').replace(/\s+/g, '');
    } catch {
      return '';
    }
  }
  return s.replace(/\s+/g, '');
}

async function totpCode(base32Secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const norm = base32Secret.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const c of norm) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) throw new ArcheryApiError('TOTP 密钥不是合法的 base32 字符串');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(bytes),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint32(4, counter);
  const hmac = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1000000;
  return String(code).padStart(6, '0');
}

export async function loadConfig() {
  const { archeryConfig } = await chrome.storage.local.get('archeryConfig');
  return { ...DEFAULT_CONFIG, ...(archeryConfig || {}) };
}

export async function saveConfig(patch) {
  const cfg = { ...(await loadConfig()), ...patch };
  await chrome.storage.local.set({ archeryConfig: cfg });
  return cfg;
}

export function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

export class ArcheryApiError extends Error {
  constructor(message, { status = 0, needLogin = false, sessionKey = null } = {}) {
    super(message);
    this.status = status;
    this.needLogin = needLogin;
    this.sessionKey = sessionKey; // 2FA 待验证会话
  }
}

export class ArcheryApi {
  constructor(config) {
    this.config = config;
  }

  origin() {
    if (!this.config.baseUrl) throw new ArcheryApiError('尚未配置 Archery 地址：点击扩展图标，在「自动重登凭证」中填写并保存');
    const u = new URL(this.config.baseUrl);
    return `${u.protocol}//${u.host}`;
  }

  url(path) {
    return this.config.baseUrl + path;
  }

  /** 读取目标域的 cookie（chrome.cookies 需要 host_permissions 覆盖该域） */
  getCookie(name) {
    return chrome.cookies
      .get({ url: this.origin() + '/', name })
      .then((c) => (c ? c.value : null));
  }

  async csrfToken() {
    return (await this.getCookie('csrftoken')) || '';
  }

  async hasSession() {
    return !!(await this.getCookie('sessionid'));
  }

  /** 登录：GET /login/ 触发 csrftoken 下发，再 POST /authenticate/ 换 sessionid */
  async login() {
    // POST 同样受 Django CSRF Origin 校验，先确保 Origin 改写规则已注册
    await this.ensureDnrRule();
    // 先访问登录页，确保 csrftoken cookie 存在
    await fetch(this.url('/login/'), { credentials: 'include', signal: AbortSignal.timeout(15000) });
    const csrf = await this.csrfToken();
    const body = new URLSearchParams({
      username: this.config.username,
      password: this.config.password,
    });
    const resp = await fetch(this.url('/authenticate/'), {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-CSRFToken': csrf,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: this.url('/login/'),
      },
      body,
    });
    if (!resp.ok) {
      throw new ArcheryApiError(`登录请求失败（HTTP ${resp.status}）`, { status: resp.status });
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      throw new ArcheryApiError('登录响应解析失败，请检查服务器地址是否正确');
    }
    if (data.status !== 0) {
      throw new ArcheryApiError(`登录失败：${data.msg || '用户名或密码错误'}`);
    }
    if (data.data) {
      // 启用了 2FA：data 是待验证的 session key。
      // 有 TOTP 密钥则本地算码自动验证；否则抛出待验证会话，由 UI 收集动态码。
      const secret = parseTotpSecret(this.config.totpSecret);
      if (secret) {
        const otp = await totpCode(secret);
        await this.verifyTwoFa(data.data, otp);
        return true;
      }
      throw new ArcheryApiError(
        '该实例要求两步验证（2FA）：请填写当前动态验证码（可在 OTP Vault / 手机验证器中查看），或在设置中填写 TOTP 密钥实现全自动',
        { needLogin: true, sessionKey: data.data }
      );
    }
    if (!(await this.hasSession())) {
      throw new ArcheryApiError('登录成功但未获取到会话，请确认扩展已被授权访问该地址');
    }
    return true;
  }

  /**
   * Archery v1.9.1 2FA 流程（对应 /login/2fa/ 页面的行为）：
   * 1. 把待验证 session key 写入 sessionid cookie；
   * 2. POST /api/v1/user/2fa/verify/ {engineer, otp, auth_type:'totp'}；
   * 3. 校验通过后 Django 自动 login，set-cookie 覆盖为正式会话。
   */
  async verifyTwoFa(sessionKey, otp) {
    await chrome.cookies.set({
      url: this.origin() + '/',
      name: 'sessionid',
      value: sessionKey,
      path: '/',
      httpOnly: true,
    });
    const csrf = await this.csrfToken();
    const resp = await fetch(this.url('/api/v1/user/2fa/verify/'), {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        ...(csrf ? { 'X-CSRFToken': csrf } : {}),
      },
      body: JSON.stringify({
        engineer: this.config.username,
        otp,
        auth_type: 'totp',
      }),
    });
    let result;
    try {
      result = await resp.json();
    } catch {
      result = { status: 1, msg: `2FA 验证响应异常（HTTP ${resp.status}）` };
    }
    if (result.status !== 0) {
      await fetch(this.url('/logout/'), { credentials: 'include' }).catch(() => {});
      throw new ArcheryApiError(`两步验证失败：${result.msg || '验证码错误或已过期，请重试'}`, {
        needLogin: true,
      });
    }
    return true;
  }

  async ensureSession() {
    if (await this.hasSession()) return;
    if (!this.config.username || !this.config.password) {
      throw new ArcheryApiError('未配置账号密码，请打开扩展弹窗完成配置', { needLogin: true });
    }
    await this.login();
  }

  /**
   * 确保 service worker 已注册 Origin 改写规则：
   * Django 4.x 的 CSRF 校验 Origin，扩展页面 fetch 带的
   * chrome-extension:// origin 会被拒（403），需改写为同源。
   * 消息失败（sw 冷启动等）不阻塞请求：GET 不受影响，POST 由 403 重试兜底。
   */
  async ensureDnrRule() {
    if (this._dnrReady) return;
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'setup-dnr',
        baseUrl: this.config.baseUrl,
      });
      if (resp?.ok) this._dnrReady = true;
    } catch {
      /* sw 未就绪时静默跳过，由 403-CSRF 重试路径再次尝试 */
    }
  }

  /**
   * 统一请求入口。响应若为登录页 HTML（会话失效时 Django 返回 302→200 的
   * text/html），自动重登一次后重试。
   */
  async request(path, { method = 'GET', params, form, json, retry = true } = {}) {
    await this.ensureSession();
    await this.ensureDnrRule();
    let url = this.url(path);
    if (params) {
      const qs = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      );
      url += (url.includes('?') ? '&' : '?') + qs.toString();
    }
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-CSRFToken'] = await this.csrfToken();
      body = new URLSearchParams(form);
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
      headers['X-CSRFToken'] = await this.csrfToken();
      body = JSON.stringify(json);
    }
    const resp = await fetch(url, { method, credentials: 'include', headers, body, signal: AbortSignal.timeout(60000) });

    if (resp.status === 403) {
      // CSRF 校验失败或权限不足
      const text = await resp.text().catch(() => '');
      if (retry && text.includes('CSRF')) {
        // Origin 改写规则可能尚未生效，重新注册后再试一次
        this._dnrReady = false;
        await this.ensureDnrRule();
        return this.request(path, { method, params, form, json, retry: false });
      }
      throw new ArcheryApiError('请求被拒绝（403）：当前账号可能没有该功能的权限', {
        status: 403,
      });
    }
    if (resp.status === 401) {
      if (retry) {
        await this.login();
        return this.request(path, { method, params, form, json, retry: false });
      }
      throw new ArcheryApiError('登录状态已失效，请重新登录', { status: 401, needLogin: true });
    }
    const ctype = resp.headers.get('content-type') || '';
    if (ctype.includes('text/html')) {
      // Django 对未登录的页面请求返回登录页（200），视为会话失效
      if (retry) {
        await this.login();
        return this.request(path, { method, params, form, json, retry: false });
      }
      throw new ArcheryApiError('会话已失效，且自动重登失败，请检查账号密码', {
        needLogin: true,
      });
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new ArcheryApiError(`请求失败（HTTP ${resp.status}）${text.slice(0, 120)}`, {
        status: resp.status,
      });
    }
    try {
      return await resp.json();
    } catch {
      throw new ArcheryApiError('响应不是合法 JSON，请确认服务器地址指向 Archery');
    }
  }

  /* ---------------- 业务接口 ---------------- */

  /** 当前用户可查询的全部实例（按 db_type 分组展示用） */
  userInstances() {
    return this.request('/group/user_all_instances/', { params: { tag_codes: 'can_read' } });
  }

  /** 库 / 表 / 模式列表 */
  databases(instanceName) {
    return this.request('/instance/instance_resource/', {
      params: { instance_name: instanceName, resource_type: 'database' },
    });
  }

  schemas(instanceName, dbName) {
    return this.request('/instance/instance_resource/', {
      params: { instance_name: instanceName, db_name: dbName, resource_type: 'schema' },
    });
  }

  tables(instanceName, dbName, schemaName) {
    return this.request('/instance/instance_resource/', {
      params: {
        instance_name: instanceName,
        db_name: dbName,
        schema_name: schemaName,
        resource_type: 'table',
      },
    });
  }

  /** 表结构（show create table） */
  describe(instanceName, dbName, tbName, schemaName) {
    return this.request('/instance/describetable/', {
      method: 'POST',
      form: { instance_name: instanceName, db_name: dbName, tb_name: tbName, schema_name: schemaName || '' },
    });
  }

  /** 执行查询，返回 column_list/rows 等 */
  query({ instanceName, dbName, schemaName, sqlContent, limitNum }) {
    return this.request('/query/', {
      method: 'POST',
      form: {
        instance_name: instanceName,
        db_name: dbName,
        schema_name: schemaName || '',
        tb_name: '',
        sql_content: sqlContent,
        limit_num: String(limitNum ?? 100),
      },
    });
  }

  /** 查询历史（star=true 时为收藏列表） */
  queryLog({ limit = 20, offset = 0, search = '', star = '', queryLogId = '' } = {}) {
    return this.request('/query/querylog/', {
      params: { limit, offset, search, star, query_log_id: queryLogId },
    });
  }

  /** 收藏 / 取消收藏 */
  favorite(queryLogId, star, alias = '') {
    return this.request('/query/favorite/', {
      method: 'POST',
      form: { query_log_id: queryLogId, star: star ? 'true' : 'false', alias },
    });
  }

  /** SQL 上线工单列表（v1.9.1 为 POST 分页：GET 参数不生效会返回全量） */
  workflowList({ limit = 20, offset = 0, search = '' } = {}) {
    return this.request('/sqlworkflow_list/', { method: 'POST', form: { limit, offset, search } });
  }

  /** 工单内每条 SQL 的执行状态 */
  workflowDetail(workflowId) {
    return this.request('/sqlworkflow/detail_content/', {
      params: { workflow_id: workflowId },
    });
  }

  /** 工单回滚语句 */
  workflowBackup(workflowId) {
    return this.request('/sqlworkflow/backup_sql/', { params: { workflow_id: workflowId } });
  }

  /**
   * 提单上下文：解析 /submitsql/ 渲染页，取当前用户所在资源组
   * （group_id/group_name）与可上线（can_write）实例及其 id。
   */
  async submitContext() {
    const resp = await fetch(this.url('/submitsql/'), { credentials: 'include' });
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const groups = [...doc.querySelectorAll('#group_name option')].map((o) => ({
      groupId: o.value,
      groupName: o.textContent.trim(),
    }));
    const instances = [...doc.querySelectorAll('#instance_name option[instance-id]')].map((o) => ({
      id: o.getAttribute('instance-id'),
      instanceName: o.value,
    }));
    return { groups, instances };
  }

  /** 提交 SQL 上线工单（服务端会再做一次检测） */
  submitWorkflow({ sqlContent, groupId, instanceId, dbName, workflowName, isBackup }) {
    return this.request('/api/v1/workflow/', {
      method: 'POST',
      json: {
        sql_content: sqlContent,
        workflow: {
          group_id: Number(groupId),
          instance: Number(instanceId),
          db_name: dbName,
          workflow_name: workflowName,
          is_backup: !!isBackup,
          run_date_start: '',
          run_date_end: '',
        },
      },
    });
  }

  /** 审核工单：pass 通过 / cancel 驳回（需终止原因） */
  auditWorkflow({ workflowId, auditType, auditRemark = '' }) {
    return this.request('/api/v1/workflow/audit/', {
      method: 'POST',
      json: {
        audit_type: auditType,
        workflow_type: 2,
        workflow_id: workflowId,
        audit_remark: auditRemark,
      },
    });
  }

  /** 执行已审核通过的工单 */
  executeWorkflow({ workflowId, engineer, mode = 'auto' }) {
    return this.request('/api/v1/workflow/execute/', {
      method: 'POST',
      json: {
        workflow_type: 2,
        workflow_id: workflowId,
        mode,
        engineer,
      },
    });
  }

  /* ---------------- 数据字典 / 诊断 ---------------- */

  /** 数据字典：表清单（含注释） */
  dictTableList(instanceName, dbName, dbType = 'mysql') {
    return this.request('/data_dictionary/table_list/', {
      params: { instance_name: instanceName, db_name: dbName, db_type: dbType },
    });
  }

  /** 数据字典：表详情（字段/索引/建表语句/元信息） */
  dictTableInfo(instanceName, dbName, tbName, dbType = 'mysql') {
    return this.request('/data_dictionary/table_info/', {
      params: { instance_name: instanceName, db_name: dbName, tb_name: tbName, db_type: dbType },
    });
  }

  /** 表空间容量（全量表：大小/行数/索引） */
  tablespace(instanceName) {
    return this.request('/db_diagnostic/tablesapce/', {
      method: 'POST',
      form: { instance_name: instanceName },
    });
  }

  /** InnoDB 当前事务 */
  innodbTrx(instanceName) {
    return this.request('/db_diagnostic/innodb_trx/', {
      method: 'POST',
      form: { instance_name: instanceName },
    });
  }

  /** SQL 审核检查（goInception） */
  sqlCheck({ fullSql, instanceId, dbName }) {
    return this.request('/api/v1/workflow/sqlcheck/', {
      method: 'POST',
      json: { full_sql: fullSql, instance_id: instanceId, db_name: dbName },
    });
  }
}
