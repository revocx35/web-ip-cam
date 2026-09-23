'use strict';

// Helpers for talking to the MediaMTX sidecar: control API, WHIP proxying and
// SDP candidate rewriting.

const dns = require('dns').promises;
const net = require('net');

const APP_USER = '__webipcam__';

class MediaMTX {
  constructor({ apiUrl, webrtcUrl, secret }) {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.webrtcUrl = webrtcUrl.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${APP_USER}:${secret}`).toString('base64');
  }

  async _api(method, path) {
    const res = await fetch(this.apiUrl + path, {
      method,
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`MediaMTX API ${method} ${path}: HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Returns a Map of path name -> { ready, readers, tracks, source }
  async pathStatus() {
    const out = new Map();
    let page = 0;
    for (;;) {
      const data = await this._api('GET', `/v3/paths/list?itemsPerPage=100&page=${page}`);
      for (const item of data.items || []) {
        out.set(item.name, {
          ready: !!item.ready,
          readyTime: item.readyTime || null,
          readers: Array.isArray(item.readers) ? item.readers.length : 0,
          tracks: Array.isArray(item.tracks) ? item.tracks : [],
          source: item.source || null,
        });
      }
      page++;
      if (!data.pageCount || page >= data.pageCount) break;
    }
    return out;
  }

  // Disconnect whoever is publishing `name` (used when a stream is deleted or
  // its password is changed).
  async kickPublisher(name) {
    let status;
    try {
      status = (await this.pathStatus()).get(name);
    } catch {
      return;
    }
    const src = status && status.source;
    if (!src || !src.id) return;
    const endpoint = {
      webRTCSession: 'webrtcsessions',
      rtspSession: 'rtspsessions',
      rtspsSession: 'rtspssessions',
    }[src.type];
    if (!endpoint) return;
    await this._api('POST', `/v3/${endpoint}/kick/${encodeURIComponent(src.id)}`).catch(() => {});
  }

  whipPost(name, sdpOffer) {
    return fetch(`${this.webrtcUrl}/${encodeURIComponent(name)}/whip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: this.authHeader },
      body: sdpOffer,
      signal: AbortSignal.timeout(15000),
    });
  }

  whipDelete(location) {
    return fetch(this.webrtcUrl + location, {
      method: 'DELETE',
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(5000),
    });
  }
}

// Resolve the address(es) the browser used to reach us, so we can advertise
// them as ICE candidates. Inside Docker, MediaMTX only knows its container
// IP, which is unreachable from the LAN; the host the browser typed into the
// address bar almost always is reachable.
async function resolveHostIPs(hostname) {
  if (!hostname) return [];
  const h = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return [h];
  try {
    const results = await dns.lookup(h, { all: true });
    return results.map((r) => r.address).filter((a) => !a.startsWith('fe80:'));
  } catch {
    return [];
  }
}

// Add host candidates (UDP and TCP-passive) for each IP to every media section
// of the SDP answer. MediaMTX multiplexes all WebRTC sessions on one port and
// demuxes by ICE ufrag, so any address that reaches that port works.
function injectCandidates(sdp, ips, port) {
  if (!ips.length) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  const existing = new Set();
  for (const l of lines) {
    const m = /^a=candidate:\S+ \d+ (\S+) \d+ (\S+) (\d+) typ/i.exec(l);
    if (m) existing.add(`${m[1].toLowerCase()} ${m[2]} ${m[3]}`);
  }

  const extra = [];
  let foundation = 9000;
  ips.forEach((ip, i) => {
    if (!existing.has(`udp ${ip} ${port}`)) {
      extra.push(`a=candidate:${foundation++} 1 udp ${2130706431 - i} ${ip} ${port} typ host`);
    }
    if (!existing.has(`tcp ${ip} ${port}`)) {
      extra.push(`a=candidate:${foundation++} 1 tcp ${1671430143 - i} ${ip} ${port} typ host tcptype passive`);
    }
  });
  if (!extra.length) return sdp;

  const out = [];
  let inMedia = false;
  let inserted = false;
  const flush = () => {
    if (inMedia && !inserted) out.push(...extra);
    inserted = false;
  };
  for (const l of lines) {
    if (l.startsWith('m=')) {
      flush();
      inMedia = true;
    } else if (inMedia && l === 'a=end-of-candidates' && !inserted) {
      out.push(...extra);
      inserted = true;
    }
    out.push(l);
  }
  flush();
  return out.join(eol) + eol;
}

module.exports = { MediaMTX, APP_USER, resolveHostIPs, injectCandidates };
