/**
 * 后台 service worker：
 * 注册 declarativeNetRequest 会话规则，把本扩展发往 Archery 的请求的
 * Origin 改写为同源值，绕过 Django 4.x CSRF 的 Origin 校验。
 * 规则通过 initiatorDomains 限定，只影响本扩展发起的请求。
 */

const DNR_RULE_ID = 1;

async function setupOriginRule(baseUrl) {
  if (!baseUrl) return;
  let host;
  try {
    host = new URL(baseUrl).host; // 例如 archery.example.com:9123
  } catch {
    return;
  }
  const rule = {
    id: DNR_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Origin', operation: 'set', value: baseUrl }],
    },
    condition: {
      urlFilter: `||${host}`,
      resourceTypes: ['xmlhttprequest'],
      initiatorDomains: [chrome.runtime.id],
    },
  };
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [rule],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'setup-dnr' && msg.baseUrl) {
    setupOriginRule(msg.baseUrl)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // async
  }
  if (msg?.type === 'archery-detected' && msg.origin) {
    // content script 发现疑似 Archery：后台验证 /login/ 页面特征后存为候选地址（只存 origin）
    verifyArcheryOrigin(msg.origin).catch(() => {});
    sendResponse({ ok: true });
  }
});

/** GET {origin}/login/ 验证是否 Archery 登录页（Django csrf 表单 + archery 静态资源特征） */
async function verifyArcheryOrigin(origin) {
  const { archeryCandidates } = await chrome.storage.local.get({ archeryCandidates: [] });
  if (archeryCandidates.some((c) => c.origin === origin)) return; // 已有
  let ok = false;
  try {
    const resp = await fetch(origin + '/login/', { credentials: 'include', signal: AbortSignal.timeout(10000) });
    if (resp.ok) {
      const html = (await resp.text()).slice(0, 20000);
      ok =
        /archery/i.test(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '') ||
        /\/static\/[^"']*archery/i.test(html) ||
        (html.includes('csrfmiddlewaretoken') && /\/login\/?/i.test(html.match(/action="([^"]*)"/i)?.[1] || ''));
    }
  } catch {
    return; // 网络不可达/证书问题：不存
  }
  if (!ok) return;
  const list = [{ origin, at: Date.now() }, ...archeryCandidates.filter((c) => c.origin !== origin)].slice(0, 5);
  await chrome.storage.local.set({ archeryCandidates: list });
}

/* ---------- 推测通道：观察浏览器请求，按 Archery 独有接口路径特征识别 origin ----------
 * 覆盖「其他网页 iframe 嵌入 Archery、错过页面特征检测」的场景——接口请求本身就能暴露 origin。
 * 只匹配路径特征，不写死任何域名；每个 origin 只验证一次。 */
const ARCHERY_PATH_RE = /\/(authenticate|instance_resource|user_all_instances|sqlworkflow|data_dictionary|2fa\/verify|sqlquery|querylog)\/?/;
const probedOrigins = new Set(); // 已触发验证的 origin（sw 生命周期内去重）

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const u = new URL(details.url);
      if (!/^https?:$/.test(u.protocol)) return;
      const origin = u.origin;
      if (probedOrigins.has(origin)) return;
      if (!ARCHERY_PATH_RE.test(u.pathname)) return;
      probedOrigins.add(origin);
      verifyArcheryOrigin(origin).catch(() => {});
    } catch {
      /* 非法 URL 忽略 */
    }
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

// 安装/启动时若已有配置则先注册一次
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ welcomeChangelog: true });
  }
  const { archeryConfig } = await chrome.storage.local.get('archeryConfig');
  if (archeryConfig?.baseUrl) setupOriginRule(archeryConfig.baseUrl);
});
chrome.runtime.onStartup.addListener(async () => {
  const { archeryConfig } = await chrome.storage.local.get('archeryConfig');
  if (archeryConfig?.baseUrl) setupOriginRule(archeryConfig.baseUrl);
});
