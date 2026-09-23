(function () {
  'use strict';
  var $ = WIC.$;
  var msg = $('#msg');

  $('#setup-form').addEventListener('submit', function (e) {
    e.preventDefault();
    WIC.hideMsg(msg);
    var password = $('#password').value;
    if (password !== $('#password2').value) return WIC.showMsg(msg, 'error', 'Passwords do not match');
    var btn = e.target.querySelector('button');
    btn.disabled = true;
    WIC.api('POST', '/api/setup', { username: $('#username').value, password: password })
      .then(function () { location.href = '/admin'; })
      .catch(function (err) {
        btn.disabled = false;
        if (err.status === 409) { location.href = '/login'; return; }
        WIC.showMsg(msg, 'error', err.message);
      });
  });
})();
