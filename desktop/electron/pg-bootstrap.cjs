'use strict';

/**
 * Embedded PostgreSQL lifecycle for the K9 desktop server. Adapted from
 * KobeOS's electron/pg-bootstrap.cjs: binaries come from the packaged
 * resources/postgres folder (copied from @embedded-postgres at build time),
 * never from inside the asar archive.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const BIN_EXT = process.platform === 'win32' ? '.exe' : '';

// Cap first-launch cluster creation so a blocked initdb (antivirus, no write
// access) fails loudly instead of hanging the splash screen.
const INITDB_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

class PostgresManager {
  /**
   * @param {object} opts
   * @param {string} opts.binDir    folder containing initdb / postgres / pg_ctl
   * @param {string} opts.dataDir   cluster data directory
   * @param {number} opts.port
   * @param {string} opts.user
   * @param {string} opts.password
   * @param {string} opts.database
   * @param {(line: string) => void} [opts.log]
   */
  constructor(opts) {
    this.binDir = opts.binDir;
    this.dataDir = opts.dataDir;
    this.port = opts.port;
    this.user = opts.user;
    this.password = opts.password;
    this.database = opts.database;
    this.log = opts.log || ((line) => console.log(line));
    this._process = null;
  }

  bin(name) {
    return path.join(this.binDir, `${name}${BIN_EXT}`);
  }

  validate() {
    const missing = ['initdb', 'postgres', 'pg_ctl'].filter((name) => !fs.existsSync(this.bin(name)));
    if (missing.length > 0) {
      throw new Error(
        `Embedded PostgreSQL is incomplete (missing: ${missing.join(', ')}) in ${this.binDir}.\n` +
        'Reinstall K9 School Server. School data in the K9 data folder is preserved.',
      );
    }
  }

  async initialise() {
    if (fs.existsSync(path.join(this.dataDir, 'PG_VERSION'))) return;

    fs.mkdirSync(this.dataDir, { recursive: true });
    const pwFile = path.join(path.dirname(this.dataDir), '.pgpass_init');
    fs.writeFileSync(pwFile, `${this.password}\n`, { mode: 0o600 });

    this.log('[postgres] creating database cluster (first launch)…');
    try {
      await this._run(
        this.bin('initdb'),
        [
          `--pgdata=${this.dataDir}`,
          '--auth=scram-sha-256',
          `--username=${this.user}`,
          `--pwfile=${pwFile}`,
          '--encoding=UTF8',
          '--locale=C',
          // Nothing durable exists yet, so skip fsync for a faster first launch.
          '--no-sync',
        ],
        INITDB_TIMEOUT_MS,
        'initdb',
      );
    } finally {
      try { fs.unlinkSync(pwFile); } catch { /* ignore */ }
    }
  }

  async start() {
    const pidFile = path.join(this.dataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    }

    if (!(await isPortFree(this.port))) {
      throw new Error(
        `Port ${this.port} is already in use, so the K9 database cannot start.\n` +
        'Close the program using it, or set K9_PG_PORT to a free port.',
      );
    }

    this.log(`[postgres] starting on 127.0.0.1:${this.port}…`);
    await new Promise((resolve, reject) => {
      const proc = spawn(
        this.bin('postgres'),
        ['-D', this.dataDir, '-p', String(this.port), '-c', 'listen_addresses=127.0.0.1', '-c', 'logging_collector=off'],
        { env: { ...process.env, LC_MESSAGES: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      this._process = proc;

      let started = false;
      const timer = setTimeout(() => {
        if (started) return;
        started = true;
        reject(new Error('PostgreSQL did not report ready within 60s — check antivirus quarantine or write access to the K9 data folder.'));
      }, START_TIMEOUT_MS);

      const onData = (chunk) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.log(`[postgres] ${line}`);
        if (!started && text.includes('ready to accept connections')) {
          started = true;
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (err) => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        this._process = null;
        if (started) return;
        started = true;
        clearTimeout(timer);
        reject(new Error(`PostgreSQL exited during startup (code ${code})`));
      });
    });

    await this._waitForReady();
  }

  async createDatabase() {
    const { Client } = require('pg');
    const client = new Client({ ...this._adminConfig(), database: 'postgres' });
    await client.connect();
    try {
      const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [this.database]);
      if (res.rowCount === 0) {
        await client.query(`CREATE DATABASE "${this.database}"`);
        this.log(`[postgres] database "${this.database}" created`);
      }
    } finally {
      await client.end();
    }
  }

  connectionString() {
    return `postgres://${encodeURIComponent(this.user)}:${encodeURIComponent(this.password)}` +
      `@127.0.0.1:${this.port}/${encodeURIComponent(this.database)}`;
  }

  async stop() {
    const proc = this._process;
    if (!proc) return;
    const exited = new Promise((resolve) => {
      proc.once('close', resolve);
      setTimeout(resolve, 15_000);
    });
    if (process.platform === 'win32') {
      // SIGTERM is a hard kill on Windows; ask pg_ctl for a clean fast shutdown.
      spawn(this.bin('pg_ctl'), ['stop', '-D', this.dataDir, '-m', 'fast'], { stdio: 'ignore', windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
    await exited;
    if (this._process) {
      try { this._process.kill(); } catch { /* ignore */ }
      this._process = null;
    }
    this.log('[postgres] stopped');
  }

  _adminConfig() {
    return {
      host: '127.0.0.1',
      port: this.port,
      user: this.user,
      password: this.password,
      connectionTimeoutMillis: 2_000,
    };
  }

  // "ready to accept connections" can precede the moment queries succeed
  // (57P03 "the database system is starting up"), so probe with SELECT 1.
  async _waitForReady(timeoutMs = 30_000) {
    const { Client } = require('pg');
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      const client = new Client({ ...this._adminConfig(), database: 'postgres' });
      try {
        await client.connect();
        await client.query('SELECT 1');
        await client.end();
        return;
      } catch (err) {
        lastErr = err;
        try { await client.end(); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`PostgreSQL never became ready (${lastErr ? lastErr.message : 'unknown error'})`);
  }

  _run(command, args, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { env: { ...process.env, LC_MESSAGES: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let lastErr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        try { proc.kill(); } catch { /* ignore */ }
        finish(reject, new Error(
          `${label} timed out after ${timeoutMs / 1000}s. This is usually antivirus blocking the bundled ` +
          `PostgreSQL or no write access to ${this.dataDir}.${lastErr ? `\nLast output: ${lastErr}` : ''}`,
        ));
      }, timeoutMs);
      proc.stdout.on('data', (d) => this.log(`[${label}] ${d.toString().trim()}`));
      proc.stderr.on('data', (d) => {
        lastErr = d.toString().trim();
        this.log(`[${label}] ${lastErr}`);
      });
      proc.on('error', (err) => finish(reject, err));
      proc.on('close', (code) => {
        if (code === 0) finish(resolve);
        else finish(reject, new Error(`${label} exited with code ${code}${lastErr ? ` — ${lastErr}` : ''}`));
      });
    });
  }
}

module.exports = PostgresManager;
