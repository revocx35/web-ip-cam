'use strict';

// Tiny JSON-file store. The data set is small (one admin, a handful of
// streams), so we keep everything in memory and persist atomically on change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this._load();
    let dirty = false;
    if (!this.data.secret) {
      // Used to sign session cookies and to authenticate the app to MediaMTX.
      this.data.secret = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }
    if (!this.data.streams) {
      this.data.streams = {};
      dirty = true;
    }
    if (dirty) this.save();
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get secret() {
    return this.data.secret;
  }

  getAdmin() {
    return this.data.admin || null;
  }

  setAdmin(admin) {
    this.data.admin = admin;
    this.save();
  }

  listStreams() {
    return Object.entries(this.data.streams)
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getStream(name) {
    if (!Object.prototype.hasOwnProperty.call(this.data.streams, name)) return null;
    return { name, ...this.data.streams[name] };
  }

  putStream(name, fields) {
    this.data.streams[name] = { ...(this.data.streams[name] || {}), ...fields };
    this.save();
  }

  deleteStream(name) {
    delete this.data.streams[name];
    this.save();
  }
}

module.exports = { Store };
