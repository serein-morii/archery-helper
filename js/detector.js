/**
 * Archery 自动探测（content script，注入所有页面与 iframe）：
 * 页面呈现 Archery 登录页特征时，把 origin 上报给 service worker 验证；
 * 用户随后在该域登录，cookie 落地即可被扩展直接复用。
 * 只上报 origin，不收集任何页面内容。
 */
(function () {
  try {
    // 任意页面（含根路径主页、IP 部署、iframe 嵌入）都用页面特征判断；
    // 误报由后台 GET /login/ 验证兜底过滤，这里宽松无妨
    const isArchery =
      /archery/i.test(document.title || '') ||
      /archery/i.test(location.hostname) ||
      !!document.querySelector(
        'script[src*="archery"], link[href*="archery"], img[src*="archery"], a[href*="/sqlquery"], a[href*="/sqlworkflow"]'
      ) ||
      (location.pathname.startsWith('/login') && !!document.querySelector('form input[name="csrfmiddlewaretoken"]'));
    if (isArchery) {
      chrome.runtime.sendMessage({ type: 'archery-detected', origin: location.origin }).catch(() => {});
    }
  } catch {
    /* 页面环境受限时静默 */
  }
})();
