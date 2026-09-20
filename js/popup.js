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
 * 打开弹窗即自动检测：
 * 1. 读浏览器 cookie jar 里的 sessionid（用户在浏览器登录过 Archery 即存在）；
 * 2. 有会话 → 调一次轻量接口验证并取用户显示名；
 * 3. 无会话但有保存的凭证 → 自动登录。
 */
async function detect() {
  const cfg = await loadConfig();
  $('#server-url').value = cfg.baseUrl;
  $('#username').value = cfg.username;
  $('#password').value = cfg.password;
  $('#totp-secret').value = cfg.totpSecret || '';

  // 首次使用（未配置地址）：直接引导填写，不做任何请求
  if (!cfg.baseUrl) {
    $('#popup-name').textContent = '未配置';
    $('#popup-code').textContent = '首次使用：填写你的 Archery 地址';
    setStatus(false, '未配置');
    message('展开「自动重登凭证」，填写 Archery 地址（如 http://archery.example.com:9123）、账号密码并保存。', true);
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
