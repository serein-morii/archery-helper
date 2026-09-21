/**
 * Archery 自动探测（content script，注入所有页面与 iframe）：
 * 页面呈现 Archery 登录页特征时，把 origin 上报给 service worker 验证；
 * 用户随后在该域登录，cookie 落地即可被扩展直接复用。
 * 只上报 origin，不收集任何页面内容。
 */
(function () {
  try {
    if (window.top === window && !/\/login\/?$/i.test(location.pathname)) {
      // 顶层页面仅关注 /login 类地址；iframe（门户嵌入）不限路径
      if (!/archery/i.test(location.hostname)) return;
    }
    const isArchery =
      /archery/i.test(document.title || '') ||
      /archery/i.test(location.hostname) ||
      !!document.querySelector('script[src*="archery"], link[href*="archery"], img[src*="archery"]') ||
      (location.pathname.startsWith('/login') && !!document.querySelector('form input[name="csrfmiddlewaretoken"]'));
    if (isArchery) {
      chrome.runtime.sendMessage({ type: 'archery-detected', origin: location.origin }).catch(() => {});
    }
  } catch {
    /* 页面环境受限时静默 */
  }
})();
