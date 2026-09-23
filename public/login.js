(function () {
  'use strict';
  var $ = WIC.$;
  var msg = $('#msg');

  function select(which) {
    var isAdmin = which === 'admin';
    $('#tab-admin').classList.toggle('active', isAdmin);
    $('#tab-stream').classList.toggle('active', !isAdmin);
    $('#admin-form').classList.toggle('hidden', !isAdmin);
    $('#stream-form').classList.toggle('hidden', isAdmin);
    WIC.hideMsg(msg);
    try { localStorage.setItem('wic-login-tab', which); } catch (e) { /* ignore */ }
  }

  $('#tab-admin').addEventListener('click', function () { select('admin'); });
  $('#tab-stream').addEventListener('click', function () { select('stream'); });
  try { if (localStorage.getItem('wic-login-tab') === 'admin') select('admin'); } catch (e) { /* ignore */ }

  function submit(form, url, body, next) {
    var btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    WIC.hideMsg(msg);
    WIC.api('POST', url, body)
      .then(function () { location.href = next; })
      .catch(function (err) {
        btn.disabled = false;
        WIC.showMsg(msg, 'error', err.message);
      });
  }

  $('#stream-form').addEventListener('submit', function (e) {
    e.preventDefault();
    submit(e.target, '/api/login/stream', { name: $('#stream-name').value.trim(), password: $('#stream-password').value }, '/camera');
  });

  $('#admin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    submit(e.target, '/api/login/admin', { username: $('#admin-username').value.trim(), password: $('#admin-password').value }, '/admin');
  });

  if (!window.isSecureContext) {
    WIC.showMsg(msg, 'warn',
      'This page is not opened over HTTPS. Browsers only allow camera access over HTTPS - ' +
      'open https://' + location.hostname + ':8443 instead (or whatever HTTPS port you configured).');
  }
})();
