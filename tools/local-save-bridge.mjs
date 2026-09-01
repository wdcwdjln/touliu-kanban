import http from 'node:http';
import { access, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 18765;
const REPO = '/Users/ma/投流系统/touliu-kanban';
const CONTENT_FILE = path.join(REPO, 'content.html');
const TEMP_FILE = path.join(REPO, '.content.html.bridge-tmp');
const PENDING_FILE = path.join(REPO, '.content.html.pending');
const PENDING_TEMP_FILE = path.join(REPO, '.content.html.pending-tmp');
const ALLOWED_ORIGIN = 'https://wdcwdjln.github.io';
const MAX_BODY = 90 * 1024 * 1024;

let saveQueue = Promise.resolve();
let pendingVersion = 0;
let syncWorker = null;
const syncState = {
  pending: false,
  syncing: false,
  lastError: '',
  commit: '',
};

function runGit(args, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`git ${args[0]} 超时`));
    }, timeout);
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8').trim();
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) resolve(out);
      else reject(new Error(err || out || `git ${args[0]} 失败（${code}）`));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTemporaryNetworkError(error) {
  return /SSL_ERROR_SYSCALL|Could not resolve host|Failed to connect|Connection reset|Connection timed out|HTTP\/2 stream|remote end hung up|TLS|network/i.test(error?.message || '');
}

async function runGitNetwork(args) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await runGit(['-c', 'http.version=HTTP/1.1', ...args], 20_000);
    } catch (error) {
      lastError = error;
      if (!isTemporaryNetworkError(error) || attempt === 3) throw error;
      await delay(attempt * 800);
    }
  }
  throw lastError;
}

function validateContent(content) {
  if (typeof content !== 'string' || content.length < 10_000 || !content.includes('千川全域投流')) {
    throw new Error('看板内容校验失败，已拒绝覆盖');
  }
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function stagePendingContent(content) {
  validateContent(content);
  await writeFile(PENDING_TEMP_FILE, content, 'utf8');
  await rename(PENDING_TEMP_FILE, PENDING_FILE);
  pendingVersion += 1;
  syncState.pending = true;
  syncState.lastError = '';
  return { saved: true, queued: true };
}

async function publishToGitHub(content) {
  validateContent(content);

  const dirty = await runGit(['status', '--porcelain']);
  const unrelatedDirty = dirty.split('\n').filter(Boolean).filter(line => !line.endsWith(' content.html'));
  if (unrelatedDirty.length) throw new Error('看板程序存在未处理修改，已暂停云端覆盖');

  await runGitNetwork(['fetch', 'origin', 'main']);
  await runGit(['merge', '--ff-only', 'origin/main']);
  await writeFile(TEMP_FILE, content, 'utf8');
  await rename(TEMP_FILE, CONTENT_FILE);
  await runGit(['add', 'content.html']);

  try {
    await runGit(['diff', '--cached', '--quiet']);
    await runGitNetwork(['push', 'origin', 'main']);
    const commit = await runGit(['rev-parse', '--short', 'HEAD']);
    return { saved: true, unchanged: true, commit };
  } catch {
    // 有变更时，git diff --quiet 返回 1，继续提交。
  }

  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date());
  await runGit(['commit', '-m', `更新看板内容 ${stamp}`]);

  try {
    await runGitNetwork(['push', 'origin', 'main']);
  } catch (firstError) {
    await runGitNetwork(['fetch', 'origin', 'main']);
    try {
      await runGit(['rebase', 'origin/main']);
    } catch (rebaseError) {
      await runGit(['rebase', '--abort']).catch(() => {});
      throw new Error(`云端有冲突：${rebaseError.message}`);
    }
    await runGitNetwork(['push', 'origin', 'main']).catch(() => {
      throw firstError;
    });
  }

  const commit = await runGit(['rev-parse', '--short', 'HEAD']);
  return { saved: true, commit };
}

function requestSync() {
  if (syncWorker) return syncWorker;
  syncWorker = (async () => {
    syncState.syncing = true;
    let retryDelay = 2_000;
    while (await fileExists(PENDING_FILE)) {
      const version = pendingVersion;
      try {
        const content = await readFile(PENDING_FILE, 'utf8');
        const task = () => publishToGitHub(content);
        saveQueue = saveQueue.then(task, task);
        const result = await saveQueue;
        syncState.commit = result.commit || syncState.commit;
        syncState.lastError = '';
        retryDelay = 2_000;
        if (version === pendingVersion) {
          await unlink(PENDING_FILE).catch(() => {});
        }
      } catch (error) {
        syncState.lastError = error.message || String(error);
        await delay(retryDelay);
        retryDelay = Math.min(retryDelay * 2, 60_000);
      }
    }
    syncState.pending = false;
    syncState.syncing = false;
  })().finally(() => {
    syncWorker = null;
    setTimeout(async () => {
      if (await fileExists(PENDING_FILE)) requestSync();
    }, 100);
  });
  return syncWorker;
}

async function loadFromGitHub() {
  if (await fileExists(PENDING_FILE)) {
    syncState.pending = true;
    requestSync();
    const content = await readFile(PENDING_FILE, 'utf8');
    return { content, commit: syncState.commit, pending: true };
  }
  const dirty = await runGit(['status', '--porcelain']);
  if (dirty) throw new Error('本地仓库存在未处理修改，暂时无法载入云端版本');
  await runGitNetwork(['fetch', 'origin', 'main']);
  await runGit(['merge', '--ff-only', 'origin/main']);
  const content = await readFile(CONTENT_FILE, 'utf8');
  const commit = await runGit(['rev-parse', '--short', 'HEAD']);
  return { content, commit };
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, ...syncState });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/sync-status')) {
    if (req.headers.origin !== ALLOWED_ORIGIN) {
      sendJson(res, 403, { ok: false, error: '来源不允许' });
      return;
    }
    sendJson(res, 200, { ok: true, ...syncState });
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/content')) {
    if (req.headers.origin !== ALLOWED_ORIGIN) {
      sendJson(res, 403, { ok: false, error: '来源不允许' });
      return;
    }
    const task = () => loadFromGitHub();
    saveQueue = saveQueue.then(task, task);
    saveQueue.then(
      result => {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Kanban-Commit': result.commit,
        });
        res.end(result.content);
      },
      error => sendJson(res, 500, { ok: false, error: error.message || String(error) }),
    );
    return;
  }
  if (req.method !== 'POST' || req.url !== '/save') {
    sendJson(res, 404, { ok: false, error: 'Not found' });
    return;
  }
  if (req.headers.origin !== ALLOWED_ORIGIN) {
    sendJson(res, 403, { ok: false, error: '来源不允许' });
    return;
  }

  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY) {
      req.destroy(new Error('请求内容过大'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      sendJson(res, 400, { ok: false, error: '保存数据格式错误' });
      return;
    }
    const task = () => stagePendingContent(body.content);
    saveQueue = saveQueue.then(task, task);
    saveQueue.then(
      result => {
        requestSync();
        sendJson(res, 200, { ok: true, ...result });
      },
      error => sendJson(res, 500, { ok: false, error: error.message || String(error) }),
    );
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`touliu-kanban save bridge listening on http://${HOST}:${PORT}\n`);
  fileExists(PENDING_FILE).then(exists => {
    if (exists) {
      syncState.pending = true;
      requestSync();
    }
  });
});
