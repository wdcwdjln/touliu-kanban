import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 把内容里内嵌的 base64 图片原样（逐字节不变）拆成 assets/<hash>.<ext>，
// content.html 只留相对地址。内容从 80MB 降到几百 KB，图片走 Pages CDN、按需加载。
const DATA_IMG = /data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)/g;
const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' };

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function externalizeImages(content, repo) {
  const assetsDir = path.join(repo, 'assets');
  const jobs = new Map();
  const out = content.replace(DATA_IMG, (_, type, b64) => {
    const bytes = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}.${EXT[type]}`;
    jobs.set(name, bytes);
    return `assets/${name}`;
  });
  if (!jobs.size) return { content, written: 0 };
  await mkdir(assetsDir, { recursive: true });
  let written = 0;
  for (const [name, bytes] of jobs) {
    const file = path.join(assetsDir, name);
    if (await exists(file)) continue;
    await writeFile(file + '.tmp', bytes);
    await rename(file + '.tmp', file);
    written += 1;
  }
  // 拆出来的图懒加载，打开看板不再等全部图片
  const lazy = out.replace(/<img(?![^>]*\bloading=)([^>]*\bsrc="assets\/)/g, '<img loading="lazy"$1');
  return { content: lazy, written };
}

// 命令行：node tools/externalize-images.mjs  → 就地迁移 content.html
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const file = path.join(repo, 'content.html');
  const before = await readFile(file, 'utf8');
  const { content, written } = await externalizeImages(before, repo);
  await writeFile(file + '.tmp', content, 'utf8');
  await rename(file + '.tmp', file);
  process.stdout.write(`content.html ${before.length} → ${content.length} 字符，新写入图片 ${written} 张\n`);
}
