import { loadConfig, saveConfig, normalizeBase, ArcheryApi } from './api.js';
import { mountIcons, icon } from './icons.js';

mountIcons();
document.querySelector('#popup-version').textContent = `版本 ${chrome.runtime.getManifest().version} · 对应 Archery v1.9.1`;

const $ = (s) => document.querySelector(s);
const message = (text, isError = false) => {
  const box = $('#popup-message');
  box.hidden = !text;
  box.textContent = text || '';
  box.classList.toggle('error', isError);
};

function setStatus(ok, text) {
  const status = $('#popup-status');
  status.classList.toggle('ok', ok);
  status.innerHTML = `<i></i>${text}`;
}

/**
 * 地址未配置时，探测当前标签页是否为 Archery 站点：
 * 抓取该站点的 /login/ 页面，按 Archery 特征判断——
 * - 未登录：登录页 <title> 恰为 Archery；
 * - 已登录：Django 会 302 到站内页，标题含 Archery 且导航栏
 *   品牌链接指向 /index/（Archery v1.9.1 base.html 的固定结构）。
 * 返回站点 origin（如 http://archery.example.com:9123），非 Archery 或探测失败返回 null。
 */
async function detectArcheryOnCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let u;
  try {
    u = new URL(tab?.url || '');
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null; // chrome:// / 扩展页 / 本地文件等无法探测
  const origin = `${u.protocol}//${u.host}`;
  try {
    const resp = await fetch(`${origin}/login/`, {
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    });
    const doc = new DOMParser().parseFromString(await resp.text(), 'text/html');
    const title = (doc.title || '').trim().toLowerCase();
    if (title === 'archery') return origin;
    if (title.includes('archery') && doc.querySelector('.navbar-brand[href="/index/"]')) return origin;
  } catch {
    /* 站点不可达、证书错误等：视为非 Archery，走手动填写 */
  }
  return null;
}

/**
 * 候选地址列表：让用户点选采用（可能不止一个 Archery），点击后保存并返回所选地址。
 * 无候选时隐藏列表并返回 null。
 */
async function renderCandidates() {
  const box = $('#popup-candidates');
  const { archeryCandidates } = await chrome.storage.local.get({ archeryCandidates: [] });
  if (!archeryCandidates.length) {
    box.hidden = true;
    box.replaceChildren();
    return null;
  }
  box.hidden = false;
  box.replaceChildren();
  const title = document.createElement('div');
  title.className = 'cand-title';
  title.textContent = `检测到 ${archeryCandidates.length} 个 Archery 地址，点选使用：`;
  box.appendChild(title);
  return new Promise((resolve) => {
    for (const c of archeryCandidates) {
      const btn = document.createElement('button');
      btn.className = 'cand-btn';
      btn.innerHTML = `<span>${c.origin.replace(/^https?:\/\//, '')}</span><span class="cand-tag">${c.source === 'manual' ? '手动添加' : '自动发现'}</span>`;
      btn.addEventListener('click', async () => {
        await saveConfig({ baseUrl: c.origin });
        box.hidden = true;
        box.replaceChildren();
        resolve(c.origin);
      });
      box.appendChild(btn);
    }
  });
}

/**
 * 打开弹窗即自动检测：
 * 1. 未配置地址 → 探测当前标签页是否为 Archery，是则自动采用该地址；
 * 2. 读浏览器 cookie jar 里的 sessionid（用户在浏览器登录过 Archery 即存在）；
 * 3. 有会话 → 调一次轻量接口验证并取用户显示名；
 * 4. 无会话但有保存的凭证 → 自动登录。
 */
async function detect() {
  const cfg = await loadConfig();
  $('#server-url').value = cfg.baseUrl;
  $('#username').value = cfg.username;
  $('#password').value = cfg.password;
  $('#totp-secret').value = cfg.totpSecret || '';

  // 首次使用（未配置地址）：先看当前标签页是不是 Archery，是则自动采用
  if (!cfg.baseUrl) {
    $('#popup-name').textContent = '未配置';
    $('#popup-code').textContent = '正在检测当前页是否为 Archery…';
    setStatus(false, '检测中');
    const origin = await detectArcheryOnCurrentTab();
    if (origin) {
      await saveConfig({ baseUrl: origin });
      message(`检测到当前页是 Archery（${origin}），已自动采用该地址。`);
      return detect(); // 地址就位，重走完整检测流程
    }
    // 当前页不是：列出后台发现并验证过的候选地址，让用户点选采用
    const picked = await renderCandidates();
    if (picked) {
      message(`已选择 ${picked}，正在检测连接…`);
      return detect();
    }
    $('#popup-code').textContent = '首次使用：填写你的 Archery 地址';
    setStatus(false, '未配置');
    message('当前页不是 Archery。展开「自动重登凭证」填写 Archery 地址（如 http://archery.example.com:9123）保存，或先在浏览器打开 Archery 页面再点开本弹窗自动识别。', true);
    return;
  }

  const api = new ArcheryApi(cfg);
  $('#popup-name').textContent = cfg.baseUrl.replace(/^https?:\/\//, '');
  $('#popup-code').textContent = '正在获取登录状态';
  setStatus(false, '检测中');
  $('#open-assistant').disabled = true;

  // 未授权该地址时提示（查询不带端口的 host 模式，与 manifest 声明一致）
  const u = new URL(cfg.baseUrl);
  const originPattern = `${u.protocol}//${u.host}/*`;
  const hostPattern = `${u.protocol}//${u.hostname}/*`;
  let granted = await chrome.permissions.contains({ origins: [originPattern] });
  if (!granted) granted = await chrome.permissions.contains({ origins: [hostPattern] });
  if (!granted) {
    $('#popup-name').textContent = '未授权访问';
    $('#popup-code').textContent = '请在下方填写地址并保存，授权后使用';
    setStatus(false, '未授权');
    message('插件还没有访问该 Archery 地址的权限，展开「自动重登凭证」保存一次即可授权。');
    return;
  }

  try {
    if (!(await api.hasSession())) {
      if (cfg.username && cfg.password) {
        setStatus(false, '登录中');
        await api.login();
      } else {
        $('#popup-name').textContent = 'Archery 未登录';
        $('#popup-code').textContent = '在浏览器打开 Archery 登录一次，或填写下方凭证';
        setStatus(false, '未登录');
        message('未检测到 Archery 登录会话：在浏览器登录 Archery 后重新打开本弹窗，或展开下方填写凭证。', true);
        return;
      }
    }
    // 验证会话有效并取实例数
    const res = await api.userInstances();
    if (res.status !== 0) throw new Error(res.msg || '会话校验失败');
    setStatus(true, '已连接');
    $('#popup-name').textContent = cfg.username || '浏览器会话';
    $('#popup-code').textContent = `可访问 ${res.data.length} 个实例`;
    $('#popup-avatar').innerHTML = icon('user');
    $('#open-assistant').disabled = false;
    // 无保存凭证时，从最近一条查询日志取真实用户显示名
    if (!cfg.username) {
      api
        .queryLog({ limit: 1, offset: 0 })
        .then((r) => {
          const name = r.rows?.[0]?.user_display;
          if (name) $('#popup-name').textContent = name;
        })
        .catch(() => {});
    }
  } catch (e) {
    setStatus(false, '连接失败');
    $('#popup-name').textContent = '连接失败';
    $('#popup-code').textContent = e.message || '请检查地址与账号';
    message(e.message, true);
  }
}

/** 确保扩展拥有目标地址的 host 权限（改地址后需要） */
async function ensureHostPermission(baseUrl) {
  const u = new URL(baseUrl);
  const patterns = [`${u.protocol}//${u.host}/*`, `${u.protocol}//${u.hostname}/*`];
  for (const p of patterns) {
    if (await chrome.permissions.contains({ origins: [p] })) return true;
  }
  return chrome.permissions.request({ origins: [hostPatternAll(patterns)] });
}
function hostPatternAll(patterns) {
  // 请求不带端口的模式，一次覆盖所有端口
  return patterns[1];
}

async function doSaveAndLogin() {
  const btn = $('#save-login');
  const baseUrl = normalizeBase($('#server-url').value);
  const username = $('#username').value.trim();
  const password = $('#password').value;
  if (!/^https?:\/\/.+/i.test(baseUrl)) {
    message('服务器地址需以 http:// 或 https:// 开头', true);
    return;
  }
  if (!username || !password) {
    message('请填写用户名和密码', true);
    return;
  }
  btn.disabled = true;
  btn.lastElementChild.textContent = '正在连接…';
  message('正在连接…');
  try {
    const ok = await ensureHostPermission(baseUrl);
    if (!ok) {
      message('未授权访问该地址，插件无法连接', true);
      return;
    }
    const cfg = await saveConfig({
      baseUrl,
      username,
      password,
      totpSecret: $('#totp-secret').value.trim(),
    });
    const api = new ArcheryApi(cfg);
    await api.login();
    const who = await api.userInstances();
    message(`登录成功，可访问 ${who.status === 0 ? who.data.length : '?'} 个实例`);
    await detect();
  } catch (e) {
    if (e.sessionKey) {
      message('该实例要求两步验证：请点击下方「打开 SQL 工作台」，在登录框中输入当前动态验证码完成登录');
    } else {
      message(e.message || '登录失败，请检查地址与账号', true);
    }
  } finally {
    btn.disabled = false;
    btn.lastElementChild.textContent = '保存凭证并登录';
  }
}

async function openWorkspace() {
  const url = chrome.runtime.getURL('main.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

$('#save-login').addEventListener('click', doSaveAndLogin);
$('#password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSaveAndLogin();
});
$('#open-assistant').addEventListener('click', openWorkspace);

detect();
