'use strict';

// K9 School Server — Electron shell. Boots embedded PostgreSQL, applies the
// schema, runs the KobeAI api-server (which also serves the dashboards) as a
// child process, and keeps it running from the system tray so classroom TVs,
// Teacher Lens phones and parents on the school LAN can reach it.

const { app, BrowserWindow, Menu, Tray, clipboard, dialog, ipcMain, nativeImage, shell } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const PostgresManager = require('./pg-bootstrap.cjs');

const APP_NAME = 'K9 School Server';
const IS_PACKAGED = app.isPackaged;
const RESOURCES = IS_PACKAGED ? process.resourcesPath : path.join(__dirname, '..', 'build');
// IT can keep school data somewhere else (e.g. a D: drive) with K9_DATA_DIR.
if (process.env.K9_DATA_DIR) app.setPath('userData', path.resolve(process.env.K9_DATA_DIR));
const USER_DATA = app.getPath('userData');
const LOG_DIR = path.join(USER_DATA, 'logs');
const K9_PORT = Number(process.env.K9_PORT || 8088);
const PG_PORT = Number(process.env.K9_PG_PORT || 5434);
const OLLAMA_HOST_PORT = 11434;
// Model locations come only from the K9 registry (config/k9-models.json).
const K9_MODELS_CONFIG = IS_PACKAGED
  ? path.join(process.resourcesPath, 'config', 'k9-models.json')
  : path.join(__dirname, '..', '..', 'config', 'k9-models.json');
const K9_MODELS_CLI = IS_PACKAGED
  ? path.join(process.resourcesPath, 'server', 'k9-models.mjs')
  : path.join(__dirname, '..', '..', 'scripts', 'k9-models.mjs');
const ollamaBaseUrl = () => process.env.OLLAMA_BASE_URL || `http://127.0.0.1:${OLLAMA_HOST_PORT}`;
// The Python model runtime and the vision-queue worker (see services/k9-runtime).
const K9_RUNTIME_DIR = IS_PACKAGED
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(__dirname, '..', '..', 'services', 'k9-runtime');
const K9_WORKER = IS_PACKAGED
  ? path.join(process.resourcesPath, 'server', 'k9-worker.mjs')
  : path.join(__dirname, '..', '..', 'scripts', 'k9-worker.mjs');
const LENS_FRAMES_DIR = path.join(USER_DATA, 'lens-frames');

function registryRuntime() {
  try {
    return JSON.parse(fs.readFileSync(K9_MODELS_CONFIG, 'utf8')).runtime || {};
  } catch {
    return {};
  }
}
const runtimePort = () => Number(process.env.K9_RUNTIME_PORT || (registryRuntime().k9_runtime || {}).port || 8766);
const runtimeUrl = () => `http://127.0.0.1:${runtimePort()}`;
function runtimePython() {
  const python = registryRuntime().python || {};
  return (python.env && process.env[python.env]) || python.executable || null;
}
const START_HIDDEN = process.argv.includes('--hidden');

let mainWindow = null;
let splashWindow = null;
let tray = null;
let postgres = null;
let backend = null;
let ollama = null;
let modelRuntime = null;
let worker = null;
let secrets = null;
let admin = null;
let databaseUrl = null;
let quitting = false;
let cleanedUp = false;
const backendRestarts = [];

// ── Logging ───────────────────────────────────────────────────────────────────

fs.mkdirSync(LOG_DIR, { recursive: true });
const logStreams = {};

function logTo(name, line) {
  if (!logStreams[name]) {
    logStreams[name] = fs.createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: 'a' });
  }
  logStreams[name].write(`[${new Date().toISOString()}] ${line}\n`);
}

function log(message) {
  console.log(message);
  logTo('main', message);
}

function pipeLines(stream, name) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) if (line.trim()) logTo(name, line);
  });
}

// ── Secrets and first administrator ───────────────────────────────────────────

function loadSecrets() {
  const file = path.join(USER_DATA, 'k9-secrets.json');
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first launch */ }
  let changed = false;
  for (const key of ['jwtSecret', 'tapBoxSecret', 'kioskSecret', 'dbPassword', 'visionSecret', 'runtimeSecret']) {
    if (!stored[key]) {
      stored[key] = crypto.randomBytes(32).toString('hex');
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
  return stored;
}

function loadAdminLogin() {
  const file = path.join(USER_DATA, 'k9-admin-login.txt');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    const email = (text.match(/^Email:\s*(\S+)/m) || [])[1];
    const password = (text.match(/^Password:\s*(\S+)/m) || [])[1];
    if (email && password) return { email, password, file, firstRun: false };
  }
  const login = { email: 'admin@k9.school', password: crypto.randomBytes(9).toString('base64url') };
  fs.writeFileSync(
    file,
    `${APP_NAME} — first administrator login\n\n` +
    `Email:    ${login.email}\n` +
    `Password: ${login.password}\n\n` +
    'Sign in to the Teacher Dashboard with these details. Keep this file private.\n',
    { mode: 0o600 },
  );
  return { ...login, file, firstRun: true };
}

// ── Networking helpers ────────────────────────────────────────────────────────

function lanAddress() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

const localUrl = (p) => `http://127.0.0.1:${K9_PORT}${p}`;
const lanUrl = (p) => `http://${lanAddress()}:${K9_PORT}${p}`;

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(localUrl('/api/healthz'), (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(attempt, 500);
    };
    attempt();
  });
}

// ── Child processes ───────────────────────────────────────────────────────────

/** Runs a bundled Node script with Electron-as-Node; resolves with its exit status. */
function runNodeScript(script, env, logName, timeoutMs, args = []) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    pipeLines(proc.stdout, logName);
    pipeLines(proc.stderr, logName);
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* ignore */ }
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

async function startDatabase() {
  postgres = new PostgresManager({
    binDir: path.join(RESOURCES, 'postgres', 'bin'),
    dataDir: path.join(USER_DATA, 'pgdata'),
    port: PG_PORT,
    user: 'k9',
    password: secrets.dbPassword,
    database: 'k9',
    log: (line) => logTo('postgres', line),
  });
  postgres.validate();
  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase();
  return postgres.connectionString();
}

async function applySchema() {
  const script = path.join(RESOURCES, 'server', 'migrate.cjs');
  const { code, timedOut } = await runNodeScript(script, { DATABASE_URL: databaseUrl }, 'migrate', 180_000);
  if (timedOut) {
    log('[k9] schema sync timed out — continuing with the existing schema');
  } else if (code !== 0) {
    throw new Error(`The database schema could not be applied (exit ${code}).\nDetails: ${path.join(LOG_DIR, 'migrate.log')}`);
  }
}

function startBackend() {
  const script = path.join(RESOURCES, 'server', 'api', 'index.mjs');
  const env = {
    NODE_ENV: 'production',
    PORT: String(K9_PORT),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: secrets.jwtSecret,
    SESSION_SECRET: secrets.jwtSecret,
    TAP_BOX_SECRET: secrets.tapBoxSecret,
    CLASSROOM_KIOSK_SECRET: secrets.kioskSecret,
    OBJECT_STORAGE_DIR: path.join(USER_DATA, 'objects'),
    K9_DESKTOP: '1',
    K9_WEB_ROOT: path.join(RESOURCES, 'web'),
    K9_MODELS_CONFIG,
    KOBEVISION_SHARED_SECRET: secrets.visionSecret,
    K9_RUNTIME_URL: runtimeUrl(),
    K9_RUNTIME_SECRET: secrets.runtimeSecret,
    KOBEAI_LENS_FRAMES_DIR: LENS_FRAMES_DIR,
    K9_ADMIN_EMAIL: admin.email,
    K9_ADMIN_PASSWORD: admin.password,
    AI_PROVIDER: process.env.AI_PROVIDER || 'ollama',
    OLLAMA_BASE_URL: ollamaBaseUrl(),
    // The first question after start loads a 6 GB brain into memory, and a
    // CPU-only school PC answers in minutes rather than seconds.
    OLLAMA_TIMEOUT_MS: process.env.OLLAMA_TIMEOUT_MS || '300000',
  };
  backend = spawn(process.execPath, [script], {
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipeLines(backend.stdout, 'backend');
  pipeLines(backend.stderr, 'backend');
  log(`[k9] api-server started (pid ${backend.pid}) on port ${K9_PORT}`);

  backend.on('exit', (code, signal) => {
    backend = null;
    if (quitting) return;
    log(`[k9] api-server exited (code ${code}, signal ${signal})`);
    // Restart a crashed server, but give up on a crash loop (5 in 5 minutes).
    const now = Date.now();
    while (backendRestarts.length && now - backendRestarts[0] > 5 * 60_000) backendRestarts.shift();
    if (backendRestarts.length >= 5) {
      dialog.showErrorBox(APP_NAME, `The K9 service keeps stopping.\n\nDetails: ${path.join(LOG_DIR, 'backend.log')}`);
      return;
    }
    backendRestarts.push(now);
    setTimeout(startBackend, 3000);
  });
}

async function startBundledOllama() {
  const bin = path.join(RESOURCES, 'ollama', 'ollama.exe');
  if (process.env.OLLAMA_BASE_URL || !fs.existsSync(bin)) return;
  if (!(await isPortFree(OLLAMA_HOST_PORT))) {
    log(`[k9] an Ollama server is already running on :${OLLAMA_HOST_PORT} — using it`);
    return;
  }
  ollama = spawn(bin, ['serve'], {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_HOST_PORT}`, OLLAMA_MODELS: path.join(USER_DATA, 'ollama-models') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipeLines(ollama.stdout, 'ollama');
  pipeLines(ollama.stderr, 'ollama');
  ollama.on('exit', () => { ollama = null; });
  log('[k9] bundled Ollama started');
}

// Builds K9's Ollama text models (k9-qwen, k9-mistral, …) from the GGUF files
// in the model registry, so the classroom assistant and Teacher Lens answer
// with them. Runs in the background: hashing a GGUF the first time takes a while.
let ollamaSyncRunning = false;
async function syncOllamaModels(interactive = false) {
  if (ollamaSyncRunning || !fs.existsSync(K9_MODELS_CLI)) return;
  ollamaSyncRunning = true;
  try {
    const { code, timedOut } = await runNodeScript(
      K9_MODELS_CLI,
      { K9_MODELS_CONFIG, OLLAMA_BASE_URL: ollamaBaseUrl() },
      'models',
      // Importing and quantizing the Qwen3-VL-8B brain the first time takes a long while on a CPU-only PC.
      3 * 60 * 60_000,
      ['ollama-sync'],
    );
    const outcome = timedOut ? 'timed out' : code === 0 ? 'finished' : `failed (exit ${code})`;
    log(`[k9] Ollama model sync ${outcome}`);
    if (interactive) {
      dialog.showMessageBox({
        type: code === 0 ? 'info' : 'warning',
        title: APP_NAME,
        message: code === 0 ? 'K9 AI models are connected to Ollama' : 'Some K9 AI models could not be connected',
        detail: `Details: ${path.join(LOG_DIR, 'models.log')}\nOllama: ${ollamaBaseUrl()}`,
      });
    }
  } finally {
    ollamaSyncRunning = false;
  }
}

// The local model runtime: detection, tracking, faces, ReID and voice activity,
// run by the Python named in the model registry.
function startModelRuntime() {
  const python = runtimePython();
  const server = path.join(K9_RUNTIME_DIR, 'server.py');
  if (!python || !fs.existsSync(python) || !fs.existsSync(server)) {
    log(`[k9] model runtime not started (python: ${python || 'not configured in the model registry'})`);
    return;
  }
  modelRuntime = spawn(python, [server], {
    env: {
      ...process.env,
      K9_MODELS_CONFIG,
      K9_RUNTIME_SECRET: secrets.runtimeSecret,
      K9_RUNTIME_HOST: '127.0.0.1',
      K9_RUNTIME_PORT: String(runtimePort()),
      PYTHONUNBUFFERED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipeLines(modelRuntime.stdout, 'runtime');
  pipeLines(modelRuntime.stderr, 'runtime');
  modelRuntime.on('exit', (code) => {
    log(`[k9] model runtime exited (code ${code})`);
    modelRuntime = null;
  });
  log(`[k9] model runtime started (pid ${modelRuntime.pid}) on ${runtimeUrl()}`);
}

// Drains the vision-analysis queue with the connected models (runtime + Ollama).
function startWorker() {
  if (!fs.existsSync(K9_WORKER)) return;
  worker = spawn(process.execPath, [K9_WORKER], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      KOBEAI_API_BASE: localUrl(''),
      KOBEVISION_SHARED_SECRET: secrets.visionSecret,
      K9_RUNTIME_URL: runtimeUrl(),
      K9_RUNTIME_SECRET: secrets.runtimeSecret,
      OLLAMA_BASE_URL: ollamaBaseUrl(),
      KOBEAI_LENS_FRAMES_DIR: LENS_FRAMES_DIR,
      K9_MODELS_CONFIG,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  pipeLines(worker.stdout, 'worker');
  pipeLines(worker.stderr, 'worker');
  worker.on('exit', (code) => {
    worker = null;
    if (quitting) return;
    log(`[k9] vision worker exited (code ${code}); restarting in 10s`);
    setTimeout(startWorker, 10_000);
  });
}

async function shutdown() {
  quitting = true;
  if (backend) {
    try { backend.kill(); } catch { /* ignore */ }
    backend = null;
  }
  if (ollama) {
    try { ollama.kill(); } catch { /* ignore */ }
    ollama = null;
  }
  for (const child of [worker, modelRuntime]) {
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
  }
  worker = null;
  modelRuntime = null;
  if (postgres) {
    try { await postgres.stop(); } catch (err) { log(`[k9] postgres stop failed: ${err.message}`); }
    postgres = null;
  }
}

// ── Windows, tray and menu ────────────────────────────────────────────────────

const iconPath = () => path.join(__dirname, 'assets', 'icon.png');

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 560,
    height: 360,
    frame: false,
    resizable: false,
    center: true,
    show: !START_HIDDEN,
    backgroundColor: '#06261a',
    icon: iconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'splash-preload.cjs') },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'), { query: { version: app.getVersion() } });
  splashWindow.on('closed', () => { splashWindow = null; });
}

function progress(pct, msg) {
  log(`[k9] ${pct}% ${msg}`);
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send('boot-progress', { pct, msg });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    icon: iconPath(),
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.loadURL(localUrl('/teacher/'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('page-title-updated', (event) => event.preventDefault());
  // Closing the window only hides it — the school server keeps running.
  let trayHintShown = false;
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: APP_NAME,
        content: 'K9 is still running for the school. Use the tray icon to open it or quit.',
      });
    }
  });
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function copyLink(url, label) {
  clipboard.writeText(url);
  dialog.showMessageBox({ type: 'info', title: APP_NAME, message: `${label} copied`, detail: url });
}

async function showAdminLogin() {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: APP_NAME,
    message: admin.firstRun ? 'K9 is ready — first administrator login' : 'Administrator login',
    detail:
      `Email:     ${admin.email}\nPassword:  ${admin.password}\n\n` +
      `Teacher Dashboard on this network: ${lanUrl('/teacher/')}\n\n` +
      `These details are saved in:\n${admin.file}`,
    buttons: ['Copy password', 'OK'],
    defaultId: 1,
  });
  if (response === 0) clipboard.writeText(admin.password);
}

function k9MenuItems() {
  return [
    { label: 'Open Teacher Dashboard', click: showMainWindow },
    { label: 'Open Parent Portal in Browser', click: () => shell.openExternal(lanUrl('/parent/')) },
    { type: 'separator' },
    { label: 'Copy Classroom TV Link', click: () => copyLink(lanUrl(`/tv/?key=${secrets.kioskSecret}`), 'Classroom TV link') },
    { label: 'Copy Teacher Lens Link', click: () => copyLink(lanUrl('/lens/'), 'Teacher Lens link') },
    { label: 'Copy Parent Portal Link', click: () => copyLink(lanUrl('/parent/'), 'Parent portal link') },
    { type: 'separator' },
    { label: 'Connect AI Models to Ollama', click: () => syncOllamaModels(true) },
    { label: 'Show Administrator Login', click: showAdminLogin },
    {
      label: 'Start K9 When Windows Starts',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { label: 'Open Data Folder', click: () => shell.openPath(USER_DATA) },
    { label: 'Open Logs Folder', click: () => shell.openPath(LOG_DIR) },
    { type: 'separator' },
    { label: 'Quit K9', click: () => app.quit() },
  ];
}

function buildMenus() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'K9', submenu: k9MenuItems() },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
  ]));
  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.setToolTip(`${APP_NAME} — ${lanUrl('/')}`);
  tray.setContextMenu(Menu.buildFromTemplate(k9MenuItems()));
  tray.on('double-click', showMainWindow);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  progress(5, 'Starting K9…');
  secrets = loadSecrets();
  admin = loadAdminLogin();

  progress(15, 'Starting the school database…');
  databaseUrl = await startDatabase();

  progress(40, 'Updating the database schema…');
  await applySchema();

  progress(60, 'Starting K9 services…');
  startBackend();

  progress(75, 'Waiting for K9 services…');
  if (!(await waitForHealth(90_000))) {
    throw new Error(`K9 services did not start.\nDetails: ${path.join(LOG_DIR, 'backend.log')}`);
  }

  progress(90, 'Starting local AI…');
  await startBundledOllama();
  startModelRuntime();
  startWorker();

  progress(100, 'Ready');
}

ipcMain.handle('k9:version', () => app.getVersion());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.kobepaytech.k9');
    log(`[k9] ${APP_NAME} ${app.getVersion()} starting (data: ${USER_DATA})`);
    createSplash();
    try {
      await boot();
    } catch (err) {
      log(`[k9] boot failed: ${err && err.stack ? err.stack : err}`);
      dialog.showErrorBox(
        `${APP_NAME} could not start`,
        `${err && err.message ? err.message : err}\n\n` +
        'If this keeps happening, add the K9 install folder to your antivirus exclusions and ' +
        `do not run K9 as Administrator.\n\nLogs: ${LOG_DIR}`,
      );
      await shutdown();
      app.exit(1);
      return;
    }

    buildMenus();
    createMainWindow();
    syncOllamaModels().catch((err) => log(`[k9] Ollama model sync crashed: ${err && err.message}`));
    mainWindow.once('ready-to-show', () => {
      if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
      if (!START_HIDDEN) mainWindow.show();
      if (admin.firstRun) {
        showMainWindow();
        showAdminLogin();
      }
    });
  });

  // Keep serving the school from the tray when every window is closed.
  app.on('window-all-closed', () => {});

  app.on('before-quit', (event) => {
    quitting = true;
    if (cleanedUp) return;
    event.preventDefault();
    shutdown().finally(() => {
      cleanedUp = true;
      app.quit();
    });
  });
}
