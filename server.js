/**
 * GPT-Image-2 测试台 · 本地静态托管 + API 反向代理
 * ----------------------------------------------------------
 * · 同时承担 HTML 静态托管 与 /v1/* API 反代
 * · 避免浏览器 CORS / file:// 协议问题
 * · 零依赖（仅 Node 内置模块）
 *
 * 用法：
 *   node server.js          # 默认 3000 端口
 *   node server.js 8080     # 自定义端口
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

// ========== 配置 ==========
const PORT = parseInt(process.argv[2]) || 3000;
const TARGETS = {
  // API 网关真实 host（new-api 风格）
  // 注意：gpt-image-2.deepkey.top 只是测试页前端 host，不挂 API
  default: 'https://deepkey.top',
};
const ROOT = __dirname;
const HIST_DIR = path.join(ROOT, 'history');
const HIST_IMG_DIR = path.join(HIST_DIR, 'images');
const HIST_META = path.join(HIST_DIR, 'meta.json');
try { fs.mkdirSync(HIST_IMG_DIR, { recursive: true }); } catch {}
function loadMeta() {
  try { return JSON.parse(fs.readFileSync(HIST_META, 'utf8')); } catch { return { items: [], nextId: 1 }; }
}
function saveMeta(m) { fs.writeFileSync(HIST_META, JSON.stringify(m, null, 0)); }

// ========== MIME ==========
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.bat':  'text/plain; charset=utf-8',
};

// ========== 工具：写 CORS 头（本机用，宽松） ==========
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ========== 静态文件 ==========
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // 防止目录穿越
  const safe = path.normalize(urlPath).replace(/^[\\/]+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + urlPath);
    }
    const ext = path.extname(filePath).toLowerCase();
    // HTML/JS/CSS 强制不缓存，避免改动后浏览器还用旧版
    const noCache = ['.html', '.htm', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-store, no-cache, must-revalidate' : 'no-cache',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ========== 反向代理 ==========
function proxyApi(req, res) {
  const target = TARGETS.default;
  const upstream = new URL(req.url, target);

  // 收集请求体
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    // 复制请求头，剥掉会让上游困惑的字段
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['origin'];
    delete headers['referer'];
    delete headers['connection'];
    headers['host'] = upstream.host;

    const lib = upstream.protocol === 'https:' ? https : http;
    const options = {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      path: upstream.pathname + upstream.search,
      method: req.method,
      headers,
      timeout: 600000, // 10 分钟，给 4K 大图留余量
    };

    const startTime = Date.now();
    const proxyReq = lib.request(options, (proxyRes) => {
      const respHeaders = { ...proxyRes.headers };
      // 强制覆盖 CORS（避免上游错误的 CORS 设置）
      respHeaders['access-control-allow-origin'] = '*';
      respHeaders['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      respHeaders['access-control-allow-headers'] = '*';
      // 防止上游试图压缩后让我们的客户端解码失败
      delete respHeaders['content-encoding'];
      delete respHeaders['transfer-encoding'];

      console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url} → ${proxyRes.statusCode} (${Date.now() - startTime}ms)`);
      res.writeHead(proxyRes.statusCode, respHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('timeout', () => {
      console.error('[proxy] TIMEOUT', req.url);
      proxyReq.destroy(new Error('Upstream timeout'));
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy] ERROR', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({
        error: {
          message: '代理失败：' + err.message,
          type: 'proxy_error',
          code: err.code || 'unknown',
          target,
        }
      }));
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

// ========== 历史记录 API ==========
function readJson(req) {
  return new Promise((ok, no) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { no(e); }
    });
    req.on('error', no);
  });
}
function jsonRes(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function handleHistory(req, res) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const route = u.pathname; // /__history , /__history/save , /__history/:id , /__history/clear
    // GET /__history → 列出全部
    if (route === '/__history' && req.method === 'GET') {
      const m = loadMeta();
      // 按 ts 倒序
      const items = m.items.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return jsonRes(res, 200, { items });
    }
    // POST /__history/save  body: { src(dataURL或URL), prompt, mode, group, model, size, quality, ts, session, nodeId, parentId, fav }
    if (route === '/__history/save' && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.src) return jsonRes(res, 400, { error: 'src required' });
      const m = loadMeta();
      const id = m.nextId++;
      // 把 base64 落盘
      let storedSrc = body.src;
      const match = /^data:image\/(\w+);base64,(.+)$/.exec(body.src);
      if (match) {
        const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
        const buf = Buffer.from(match[2], 'base64');
        const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
        const fname = `${Date.now()}_${id}_${hash}.${ext}`;
        const fpath = path.join(HIST_IMG_DIR, fname);
        fs.writeFileSync(fpath, buf);
        storedSrc = '/history/images/' + fname;
      }
      const rec = {
        id, src: storedSrc,
        prompt: body.prompt || '', mode: body.mode || '',
        group: body.group || '', model: body.model || '',
        size: body.size || '', quality: body.quality || '',
        ts: body.ts || Date.now(),
        session: body.session || null,
        nodeId: body.nodeId || null,
        parentId: body.parentId || null,
        fav: !!body.fav,
      };
      m.items.push(rec);
      saveMeta(m);
      return jsonRes(res, 200, { ok: true, item: rec });
    }
    // PATCH /__history/:id  body: { fav?, prompt? }
    const idMatch = /^\/__history\/(\d+)$/.exec(route);
    if (idMatch && req.method === 'PATCH') {
      const id = parseInt(idMatch[1]);
      const body = await readJson(req);
      const m = loadMeta();
      const item = m.items.find(x => x.id === id);
      if (!item) return jsonRes(res, 404, { error: 'not found' });
      if (typeof body.fav === 'boolean') item.fav = body.fav;
      if (typeof body.prompt === 'string') item.prompt = body.prompt;
      saveMeta(m);
      return jsonRes(res, 200, { ok: true, item });
    }
    // DELETE /__history/:id
    if (idMatch && req.method === 'DELETE') {
      const id = parseInt(idMatch[1]);
      const m = loadMeta();
      const idx = m.items.findIndex(x => x.id === id);
      if (idx < 0) return jsonRes(res, 404, { error: 'not found' });
      const item = m.items[idx];
      m.items.splice(idx, 1);
      saveMeta(m);
      // 删图片文件
      if (item.src && item.src.startsWith('/history/images/')) {
        const fpath = path.join(ROOT, item.src.replace(/^\//, ''));
        try { fs.unlinkSync(fpath); } catch {}
      }
      return jsonRes(res, 200, { ok: true });
    }
    // POST /__history/clear  body: { session? }  指定 session 则只清那个会话
    if (route === '/__history/clear' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const m = loadMeta();
      const keep = [];
      const remove = [];
      m.items.forEach(it => { if (body.session && it.session !== body.session) keep.push(it); else remove.push(it); });
      m.items = keep;
      saveMeta(m);
      remove.forEach(it => {
        if (it.src && it.src.startsWith('/history/images/')) {
          const fpath = path.join(ROOT, it.src.replace(/^\//, ''));
          try { fs.unlinkSync(fpath); } catch {}
        }
      });
      return jsonRes(res, 200, { ok: true, removed: remove.length });
    }
    // POST /__history/import  body: { items: [...] }  一次性导入（用于从浏览器 IndexedDB 迁移）
    if (route === '/__history/import' && req.method === 'POST') {
      const body = await readJson(req);
      if (!Array.isArray(body.items)) return jsonRes(res, 400, { error: 'items array required' });
      const m = loadMeta();
      let imported = 0;
      for (const it of body.items) {
        if (!it.src) continue;
        const id = m.nextId++;
        let storedSrc = it.src;
        const match = /^data:image\/(\w+);base64,(.+)$/.exec(it.src);
        if (match) {
          const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
          const buf = Buffer.from(match[2], 'base64');
          const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
          const fname = `${it.ts || Date.now()}_${id}_${hash}.${ext}`;
          fs.writeFileSync(path.join(HIST_IMG_DIR, fname), buf);
          storedSrc = '/history/images/' + fname;
        }
        m.items.push({
          id, src: storedSrc,
          prompt: it.prompt || '', mode: it.mode || '',
          group: it.group || '', model: it.model || '',
          size: it.size || '', quality: it.quality || '',
          ts: it.ts || Date.now(),
          session: it.session || null,
          nodeId: it.nodeId || null,
          parentId: it.parentId || null,
          fav: !!it.fav,
        });
        imported++;
      }
      saveMeta(m);
      return jsonRes(res, 200, { ok: true, imported });
    }
    return jsonRes(res, 404, { error: 'unknown history route', path: route, method: req.method });
  } catch (e) {
    return jsonRes(res, 500, { error: e.message });
  }
}

// ========== HTTP 入口 ==========
const server = http.createServer((req, res) => {
  setCors(res);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 健康检查（HTML 启动时用来判断代理是否在线）
  if (req.url === '/__proxy_health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, target: TARGETS.default, hasServerHistory: true }));
  }

  // 历史 API ==================================================
  if (req.url.startsWith('/__history')) {
    return handleHistory(req, res);
  }
  // 历史图片静态访问 /history/images/xxx.png
  if (req.url.startsWith('/history/images/')) {
    return serveStatic(req, res);
  }

  // /v1/* 走代理
  if (req.url.startsWith('/v1/')) {
    return proxyApi(req, res);
  }

  // 其它走静态托管
  return serveStatic(req, res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 端口被占：自动尝试下一个端口（最多 +20）
    if (currentPort < PORT + 20) {
      const next = currentPort + 1;
      console.warn(`⚠️  端口 ${currentPort} 已被占用，尝试 ${next} ...`);
      currentPort = next;
      setTimeout(() => server.listen(currentPort), 100);
      return;
    }
    console.error(`\n❌ 端口 ${PORT}~${currentPort} 全被占用。请手动指定端口：`);
    console.error(`   node server.js 8080\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n❌ 权限不足，无法监听端口 ${currentPort}。`);
    console.error(`   小于 1024 的端口需要管理员权限，请改用 1024 以上的端口。\n`);
  } else {
    console.error('\n❌ Server error:', err);
  }
  process.exit(1);
});

let currentPort = PORT;
server.listen(currentPort, () => {
  const url = `http://localhost:${currentPort}`;
  // 写 PID 文件，供 stop.bat 精准定位
  try {
    fs.writeFileSync(path.join(ROOT, '.server.pid'), String(process.pid));
  } catch (e) {
    console.warn('[warn] 写入 PID 文件失败:', e.message);
  }
  console.log('');
  console.log('============================================');
  console.log('  GPT-Image-2 测试台 · 本地服务已启动');
  console.log('============================================');
  console.log('');
  console.log(`  📂 静态目录: ${ROOT}`);
  console.log(`  🔁 反代目标: ${TARGETS.default}`);
  console.log(`  🌐 访问地址: ${url}`);
  console.log(`  🆔 进程 PID: ${process.pid}`);
  if (currentPort !== PORT) {
    console.log(`  ⚠️  原端口 ${PORT} 被占用，已自动改用 ${currentPort}`);
  }
  console.log('');
  console.log('  停止：Ctrl+C  或  双击 stop.bat（精准杀本进程）');
  console.log('');
  console.log('  💡 浏览器若仍显示旧错误，按 Ctrl+Shift+R 强制刷新');
  console.log('     页面顶部应显示版本标记: v4');
  console.log('');
});

// ---------- 优雅退出：清理 PID 文件 ----------
function cleanup() {
  try { fs.unlinkSync(path.join(ROOT, '.server.pid')); } catch {}
}
process.on('SIGINT',  () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
// Windows 下关闭 CMD 窗口触发的事件
process.on('SIGHUP',  () => { cleanup(); process.exit(0); });
process.on('SIGBREAK',() => { cleanup(); process.exit(0); });
