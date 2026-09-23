(function () {
  'use strict';
  var $ = WIC.$;
  var listEl = $('#streams');
  var createMsg = $('#create-msg');
  var dialog = $('#pw-dialog');
  var pwMsg = $('#pw-msg');
  var dialogTarget = null; // null = admin account, otherwise stream name

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(label, cls, onClick) {
    var b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function since(iso) {
    if (!iso) return '';
    var s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    return Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
  }

  function withPlaceholderCreds(url, name) {
    return url.replace('rtsp://', 'rtsp://' + encodeURIComponent(name) + ':PASSWORD@');
  }

  function render(data) {
    $('#mtx-warning').className = data.mediaServer ? 'msg' : 'msg show warn';
    listEl.textContent = '';
    if (!data.streams.length) {
      listEl.appendChild(el('div', 'empty', 'No streams yet. Create one above.'));
      return;
    }
    data.streams.forEach(function (s) {
      var card = el('div', 'stream');
      var head = el('div', 'head');
      var left = el('div');
      var title = el('div');
      title.appendChild(el('span', 'name', s.name + ' '));
      var badge = !data.mediaServer ? el('span', 'badge warn', 'unknown') :
        s.live ? el('span', 'badge live', 'LIVE') : el('span', 'badge off', 'offline');
      title.appendChild(badge);
      left.appendChild(title);
      var meta = [];
      if (s.live) {
        meta.push('live for ' + since(s.liveSince));
        meta.push(s.viewers + (s.viewers === 1 ? ' viewer' : ' viewers'));
        if (s.tracks && s.tracks.length) meta.push(s.tracks.join(' + '));
      } else {
        meta.push('no camera connected');
      }
      left.appendChild(el('div', 'meta', meta.join(' · ')));
      head.appendChild(left);

      var actions = el('div', 'actions');
      actions.appendChild(button('Change password', 'secondary small', function () { openDialog(s.name); }));
      actions.appendChild(button('Delete', 'danger small', function () {
        if (!confirm('Delete stream "' + s.name + '"? Connected cameras and viewers will be disconnected.')) return;
        WIC.api('DELETE', '/api/streams/' + encodeURIComponent(s.name)).then(refresh).catch(function (err) { alert(err.message); });
      }));
      head.appendChild(actions);
      card.appendChild(head);

      var url = el('div', 'url');
      var full = withPlaceholderCreds(s.rtsp.url, s.name);
      url.appendChild(el('code', null, full));
      var copy = button('Copy', 'secondary small', function () {
        WIC.copyText(full).then(function () {
          copy.textContent = 'Copied';
          setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
        });
      });
      url.appendChild(copy);
      card.appendChild(url);
      listEl.appendChild(card);
    });
  }

  var refreshing = false;
  function refresh() {
    if (refreshing) return Promise.resolve();
    refreshing = true;
    return WIC.api('GET', '/api/streams')
      .then(render)
      .catch(function (err) {
        if (err.status === 401) location.href = '/login';
      })
      .then(function () { refreshing = false; });
  }

  $('#create-form').addEventListener('submit', function (e) {
    e.preventDefault();
    WIC.hideMsg(createMsg);
    var btn = e.target.querySelector('button');
    btn.disabled = true;
    WIC.api('POST', '/api/streams', { name: $('#new-name').value.trim(), password: $('#new-password').value })
      .then(function (res) {
        WIC.showMsg(createMsg, 'ok', 'Stream created. RTSP URL (store it, the password is not shown again): ' + res.rtspUrlWithCredentials);
        $('#new-name').value = '';
        $('#new-password').value = '';
        return refresh();
      })
      .catch(function (err) { WIC.showMsg(createMsg, 'error', err.message); })
      .then(function () { btn.disabled = false; });
  });

  function openDialog(streamName) {
    dialogTarget = streamName || null;
    $('#pw-title').textContent = streamName ? 'New password for "' + streamName + '"' : 'Change admin password';
    $('#pw-current-wrap').classList.toggle('hidden', !!streamName);
    $('#pw-current').required = !streamName;
    $('#pw-new').type = streamName ? 'text' : 'password';
    $('#pw-new').minLength = streamName ? 4 : 8;
    $('#pw-current').value = '';
    $('#pw-new').value = '';
    WIC.hideMsg(pwMsg);
    dialog.classList.add('show');
    (streamName ? $('#pw-new') : $('#pw-current')).focus();
  }

  function closeDialog() { dialog.classList.remove('show'); }

  $('#pw-cancel').addEventListener('click', closeDialog);
  dialog.addEventListener('click', function (e) { if (e.target === dialog) closeDialog(); });

  $('#pw-form').addEventListener('submit', function (e) {
    e.preventDefault();
    WIC.hideMsg(pwMsg);
    var req = dialogTarget
      ? WIC.api('PUT', '/api/streams/' + encodeURIComponent(dialogTarget) + '/password', { password: $('#pw-new').value })
      : WIC.api('PUT', '/api/admin/password', { current: $('#pw-current').value, password: $('#pw-new').value });
    req.then(function (res) {
      if (dialogTarget) {
        WIC.showMsg(createMsg, 'ok', 'Password changed for "' + dialogTarget + '". The camera must log in again. New RTSP URL: ' + res.rtspUrlWithCredentials);
      } else {
        WIC.showMsg(createMsg, 'ok', 'Admin password changed.');
      }
      closeDialog();
      refresh();
    }).catch(function (err) { WIC.showMsg(pwMsg, 'error', err.message); });
  });

  $('#btn-account').addEventListener('click', function () { openDialog(null); });
  $('#btn-logout').addEventListener('click', WIC.logout);

  refresh();
  setInterval(refresh, 5000);
})();
