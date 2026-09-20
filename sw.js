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
});

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
