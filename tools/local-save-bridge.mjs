import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 18765;
const REPO = '/Users/ma/投流系统/touliu-kanban';
const CONTENT_FILE = path.join(REPO, 'content.html');
const TEMP_FILE = path.join(REPO, '.content.html.bridge-tmp');
const ALLOWED_ORIGIN = 'https://wdcwdjln.github.io';
const MAX_BODY = 90 * 1024 * 1024;

let saveQueue = Promise.resolve();

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

async function saveToGitHub(content) {
  if (typeof content !== 'string' || content.length < 10_000 || !content.includes('千川全域投流')) {
    throw new Error('看板内容校验失败，已拒绝覆盖');
  }

  const dirty = await runGit(['status', '--porcelain']);
  if (dirty) throw new Error('本地仓库存在未处理修改，请先处理后再保存');

  await runGit(['fetch', 'origin', 'main']);
  await runGit(['merge', '--ff-only', 'origin/main']);
  await writeFile(TEMP_FILE, content, 'utf8');
  await rename(TEMP_FILE, CONTENT_FILE);
  await runGit(['add', 'content.html']);

  try {
    await runGit(['diff', '--cached', '--quiet']);
    return { saved: true, unchanged: true };
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
    await runGit(['push', 'origin', 'main']);
  } catch (firstError) {
    await runGit(['fetch', 'origin', 'main']);
    try {
      await runGit(['rebase', 'origin/main']);
    } catch (rebaseError) {
      await runGit(['rebase', '--abort']).catch(() => {});
      throw new Error(`云端有冲突：${rebaseError.message}`);
    }
    await runGit(['push', 'origin', 'main']).catch(() => {
      throw firstError;
    });
  }

  const commit = await runGit(['rev-parse', '--short', 'HEAD']);
  return { saved: true, commit };
}

async function loadFromGitHub() {
  const dirty = await runGit(['status', '--porcelain']);
  if (dirty) throw new Error('本地仓库存在未处理修改，暂时无法载入云端版本');
  await runGit(['fetch', 'origin', 'main']);
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
    sendJson(res, 200, { ok: true });
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
    const task = () => saveToGitHub(body.content);
    saveQueue = saveQueue.then(task, task);
    saveQueue.then(
      result => sendJson(res, 200, { ok: true, ...result }),
      error => sendJson(res, 500, { ok: false, error: error.message || String(error) }),
    );
  });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`touliu-kanban save bridge listening on http://${HOST}:${PORT}\n`);
});
