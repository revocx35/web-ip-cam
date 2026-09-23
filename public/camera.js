(function () {
  'use strict';
  var $ = WIC.$;
  var msg = $('#msg');
  var video = $('#preview');
  var connBadge = $('#conn-badge');
  var viewerBadge = $('#viewer-badge');
  var toggleBtn = $('#btn-toggle');

  var SETTINGS_KEY = 'wic-camera-settings';
  // ?embed=1: compact view for iframes (e.g. a Home Assistant Webpage card)
  var embedded = new URLSearchParams(location.search).get('embed') === '1';
  if (embedded) document.body.classList.add('embed');
  var settings = loadSettings();

  var wanted = false;       // user wants to be streaming
  var mediaStream = null;
  var pc = null;
  var whipLocation = null;
  var reconnectTimer = null;
  var disconnectTimer = null;
  var retryDelay = 2000;
  var wakeLock = null;
  var generation = 0;       // bumps on every (re)start so stale callbacks are ignored

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    var s = { camera: '', res: '1280x720', fps: '15', bitrate: '2000000', codec: 'h264', audio: true, mirror: false };
    try {
      var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      for (var k in saved) if (Object.prototype.hasOwnProperty.call(s, k)) s[k] = saved[k];
    } catch (e) { /* ignore */ }
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function applySettingsToForm() {
    $('#sel-res').value = settings.res;
    $('#sel-fps').value = settings.fps;
    $('#sel-bitrate').value = settings.bitrate;
    $('#sel-codec').value = settings.codec;
    $('#chk-audio').checked = !!settings.audio;
    $('#chk-mirror').checked = !!settings.mirror;
    video.classList.toggle('mirror', !!settings.mirror);
  }

  function bindSetting(id, key, prop, restart) {
    $(id).addEventListener('change', function (e) {
      settings[key] = e.target[prop];
      saveSettings();
      if (key === 'mirror') video.classList.toggle('mirror', !!settings.mirror);
      if (restart && wanted) restartAll();
    });
  }

  // ------------------------------------------------------------------ status

  function setStatus(kind, text) {
    connBadge.className = 'badge ' + kind;
    connBadge.textContent = text;
    toggleBtn.textContent = wanted ? 'Stop streaming' : 'Start streaming';
    toggleBtn.className = wanted ? 'danger' : '';
    // In embedded mode only show the button when the camera is not running.
    if (embedded) toggleBtn.classList.toggle('hidden', wanted);
  }

  function pollStatus() {
    WIC.api('GET', '/api/camera/status').then(function (s) {
      $('#stream-name').textContent = s.name;
      document.title = 'Web IP Cam - ' + s.name;
      if (s.live) {
        viewerBadge.classList.remove('hidden');
        viewerBadge.textContent = s.viewers + (s.viewers === 1 ? ' viewer' : ' viewers');
      } else {
        viewerBadge.classList.add('hidden');
      }
    }).catch(function (err) {
      if (err.status === 401) location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    });
  }

  // ------------------------------------------------------------------- media

  function constraints() {
    var parts = settings.res.split('x');
    var v = {
      width: { ideal: parseInt(parts[0], 10) },
      height: { ideal: parseInt(parts[1], 10) },
      frameRate: { ideal: parseInt(settings.fps, 10) },
    };
    if (settings.camera) v.deviceId = { exact: settings.camera };
    else v.facingMode = { ideal: 'environment' };
    var a = settings.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: true } : false;
    return { video: v, audio: a };
  }

  function getMedia() {
    return navigator.mediaDevices.getUserMedia(constraints()).catch(function (err) {
      // The saved camera may no longer exist - fall back to the default.
      if (settings.camera && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) {
        settings.camera = '';
        saveSettings();
        return navigator.mediaDevices.getUserMedia(constraints());
      }
      throw err;
    });
  }

  function listCameras() {
    if (!navigator.mediaDevices.enumerateDevices) return Promise.resolve();
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var sel = $('#sel-camera');
      var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
      sel.textContent = '';
      var def = document.createElement('option');
      def.value = '';
      def.textContent = 'Default (back camera)';
      sel.appendChild(def);
      cams.forEach(function (d, i) {
        var o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || ('Camera ' + (i + 1));
        sel.appendChild(o);
      });
      sel.value = settings.camera;
      if (sel.value !== settings.camera) sel.value = '';
      $('#btn-switch').disabled = cams.length < 2;
      return cams;
    });
  }

  function stopMedia() {
    if (mediaStream) mediaStream.getTracks().forEach(function (t) { t.stop(); });
    mediaStream = null;
    video.srcObject = null;
  }

  // -------------------------------------------------------------------- WHIP

  function preferCodec(transceiver) {
    if (!transceiver.setCodecPreferences || !window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
    var caps = RTCRtpSender.getCapabilities('video');
    if (!caps || !caps.codecs) return;
    var want = settings.codec === 'vp8' ? /vp8/i : /h264/i;
    var first = [];
    var rest = [];
    caps.codecs.forEach(function (c) { (want.test(c.mimeType) ? first : rest).push(c); });
    if (!first.length) return;
    // Prefer H.264 constrained baseline with packetization-mode=1: widest NVR support.
    first.sort(function (a, b) { return score(b) - score(a); });
    function score(c) {
      var f = c.sdpFmtpLine || '';
      return (/packetization-mode=1/.test(f) ? 2 : 0) + (/profile-level-id=42e0/i.test(f) ? 1 : 0);
    }
    try { transceiver.setCodecPreferences(first.concat(rest)); } catch (e) { /* keep browser default */ }
  }

  function waitIceGathering(peer, timeoutMs) {
    return new Promise(function (resolve) {
      if (peer.iceGatheringState === 'complete') return resolve();
      var done = function () { clearTimeout(t); peer.removeEventListener('icegatheringstatechange', check); resolve(); };
      var check = function () { if (peer.iceGatheringState === 'complete') done(); };
      var t = setTimeout(done, timeoutMs);
      peer.addEventListener('icegatheringstatechange', check);
    });
  }

  function applyBitrate(peer) {
    peer.getSenders().forEach(function (sender) {
      if (!sender.track || sender.track.kind !== 'video' || !sender.getParameters) return;
      try {
        var p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = parseInt(settings.bitrate, 10);
        sender.setParameters(p).catch(function () {});
      } catch (e) { /* not supported on this browser */ }
    });
  }

  function publish(gen) {
    var peer = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    pc = peer;

    mediaStream.getTracks().forEach(function (track) {
      var tr;
      if (peer.addTransceiver) {
        tr = peer.addTransceiver(track, { direction: 'sendonly', streams: [mediaStream] });
        if (track.kind === 'video') preferCodec(tr);
      } else {
        peer.addTrack(track, mediaStream);
      }
    });

    var onState = function () {
      if (gen !== generation) return;
      var state = peer.connectionState || peer.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        clearTimeout(disconnectTimer);
        retryDelay = 2000;
        setStatus('live', 'LIVE');
        WIC.hideMsg(msg);
        applyBitrate(peer);
        pollStatus();
      } else if (state === 'disconnected') {
        setStatus('warn', 'unstable');
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(function () { if (gen === generation) scheduleReconnect('Connection lost'); }, 6000);
      } else if (state === 'failed' || state === 'closed') {
        scheduleReconnect(state === 'failed' ? 'Could not reach the media server (WebRTC port 8189 blocked?)' : 'Connection closed');
      }
    };
    if ('onconnectionstatechange' in peer) peer.addEventListener('connectionstatechange', onState);
    else peer.addEventListener('iceconnectionstatechange', onState);

    setStatus('warn', 'connecting');
    return peer.createOffer()
      .then(function (offer) { return peer.setLocalDescription(offer); })
      .then(function () { return waitIceGathering(peer, 2500); })
      .then(function () {
        return fetch('/api/whip', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/sdp' },
          body: peer.localDescription.sdp,
        });
      })
      .then(function (res) {
        if (res.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); throw new Error('Session expired'); }
        return res.text().then(function (text) {
          if (res.status !== 201) {
            var m = 'Server error ' + res.status;
            try { m = JSON.parse(text).error || m; } catch (e) { /* ignore */ }
            throw new Error(m);
          }
          if (gen !== generation) return;
          whipLocation = res.headers.get('Location');
          return peer.setRemoteDescription({ type: 'answer', sdp: text });
        });
      });
  }

  function closePeer() {
    clearTimeout(disconnectTimer);
    if (whipLocation) {
      fetch(whipLocation, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(function () {});
      whipLocation = null;
    }
    if (pc) { try { pc.close(); } catch (e) { /* ignore */ } }
    pc = null;
  }

  // --------------------------------------------------------------- lifecycle

  function start() {
    var gen = ++generation;
    clearTimeout(reconnectTimer);
    setStatus('warn', 'starting');
    var p = mediaStream ? Promise.resolve() : getMedia().then(function (s) {
      if (gen !== generation) { s.getTracks().forEach(function (t) { t.stop(); }); throw new Error('stale'); }
      mediaStream = s;
      video.srcObject = s;
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () {});
      s.getTracks().forEach(function (t) {
        t.addEventListener('ended', function () {
          if (gen === generation && wanted) { stopMedia(); scheduleReconnect('Camera or microphone stopped'); }
        });
      });
      return listCameras();
    });
    return p
      .then(function () { return publish(gen); })
      .then(function () { requestWakeLock(); })
      .catch(function (err) {
        if (err && err.message === 'stale') return;
        handleError(err);
      });
  }

  function handleError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      wanted = false;
      closePeer();
      stopMedia();
      setStatus('err', 'blocked');
      WIC.showMsg(msg, 'error', 'Camera/microphone access was denied. Allow it in the browser settings for this site and press "Start streaming".');
      return;
    }
    if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError') {
      stopMedia();
    }
    scheduleReconnect((err && err.message) || String(err));
  }

  function scheduleReconnect(reason) {
    if (!wanted) return;
    generation++;
    closePeer();
    clearTimeout(reconnectTimer);
    setStatus('err', 'reconnecting');
    WIC.showMsg(msg, 'warn', reason + ' - retrying in ' + Math.round(retryDelay / 1000) + 's...');
    reconnectTimer = setTimeout(function () { if (wanted) start(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  }

  function restartAll() {
    generation++;
    closePeer();
    stopMedia();
    retryDelay = 2000;
    start();
  }

  function stopAll() {
    wanted = false;
    generation++;
    clearTimeout(reconnectTimer);
    closePeer();
    stopMedia();
    releaseWakeLock();
    viewerBadge.classList.add('hidden');
    WIC.hideMsg(msg);
    setStatus('off', 'stopped');
  }

  // --------------------------------------------------------------- wake lock

  function requestWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () {});
  }

  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(function () {});
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && wanted) {
      requestWakeLock();
      // Some mobile browsers stop the camera in the background - recover.
      if (!pc || (pc.connectionState && pc.connectionState !== 'connected')) {
        if (mediaStream && mediaStream.getVideoTracks().some(function (t) { return t.readyState === 'ended'; })) stopMedia();
        if (!pc) start();
      }
    }
  });

  // ---------------------------------------------------------------- blackout

  var blackout = $('#blackout');
  var lastTap = 0;
  $('#btn-blackout').addEventListener('click', function () {
    blackout.classList.add('show');
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  });
  blackout.addEventListener('click', function () {
    var now = Date.now();
    if (now - lastTap < 400) {
      blackout.classList.remove('show');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
    }
    lastTap = now;
  });

  // ------------------------------------------------------------------ wiring

  toggleBtn.addEventListener('click', function () {
    if (wanted) { stopAll(); return; }
    wanted = true;
    retryDelay = 2000;
    start();
  });

  $('#btn-switch').addEventListener('click', function () {
    var sel = $('#sel-camera');
    var opts = Array.prototype.slice.call(sel.options).filter(function (o) { return o.value; });
    if (opts.length < 2) return;
    var current = mediaStream && mediaStream.getVideoTracks()[0];
    var curId = settings.camera || (current && current.getSettings ? current.getSettings().deviceId : '');
    var idx = opts.findIndex(function (o) { return o.value === curId; });
    settings.camera = opts[(idx + 1) % opts.length].value;
    sel.value = settings.camera;
    saveSettings();
    if (wanted) restartAll();
  });

  bindSetting('#sel-camera', 'camera', 'value', true);
  bindSetting('#sel-res', 'res', 'value', true);
  bindSetting('#sel-fps', 'fps', 'value', true);
  bindSetting('#sel-codec', 'codec', 'value', true);
  bindSetting('#chk-audio', 'audio', 'checked', true);
  bindSetting('#chk-mirror', 'mirror', 'checked', false);
  $('#sel-bitrate').addEventListener('change', function (e) {
    settings.bitrate = e.target.value;
    saveSettings();
    if (pc) applyBitrate(pc);
  });

  $('#btn-logout').addEventListener('click', function () { stopAll(); WIC.logout(); });
  window.addEventListener('pagehide', function () { closePeer(); });

  applySettingsToForm();
  pollStatus();
  setInterval(function () { if (wanted) pollStatus(); }, 5000);

  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('err', 'unsupported');
    toggleBtn.disabled = true;
    WIC.showMsg(msg, 'error', window.isSecureContext
      ? 'This browser does not support camera access (getUserMedia).'
      : 'Camera access requires HTTPS. Open https://' + location.hostname + ':8443' + location.pathname + ' instead.');
    return;
  }
  if (!window.RTCPeerConnection) {
    setStatus('err', 'unsupported');
    toggleBtn.disabled = true;
    WIC.showMsg(msg, 'error', 'This browser does not support WebRTC, which is required for streaming.');
    return;
  }

  // Start right away: the browser shows its camera/microphone permission prompt.
  wanted = true;
  start();
})();
