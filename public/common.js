/* Shared helpers (plain ES2017, no build step, works on old browsers). */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }

  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function showMsg(el, kind, text) {
    el.className = 'msg show ' + kind;
    el.textContent = text;
  }

  function hideMsg(el) {
    el.className = 'msg';
    el.textContent = '';
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    return Promise.resolve();
  }

  function logout() {
    return api('POST', '/api/logout').then(function () { location.href = '/login'; });
  }

  window.WIC = { $: $, api: api, showMsg: showMsg, hideMsg: hideMsg, copyText: copyText, logout: logout };
})();
