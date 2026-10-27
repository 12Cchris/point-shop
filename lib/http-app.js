// Small HTTP router for this app, implemented with Node.js built-ins.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2'
};

function send(req, res, body, type, status = 200, cache = 'no-store', etag = false) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (etag) {
    const tag = 'W/"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 20) + '"';
    res.setHeader('ETag', tag);
    if (req.headers['if-none-match'] === tag) { res.statusCode = 304; return res.end(); }
  }
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && raw.length >= 1024 && status !== 304 && !req.headers.range) {
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('Content-Encoding', 'gzip');
    return zlib.gzip(raw, (err, compressed) => {
      if (err) { res.statusCode = 500; return res.end(); }
      if (req.method === 'HEAD') return res.end();
      res.end(compressed);
    });
  }
  if (req.method === 'HEAD' || status === 304) return res.end();
  res.end(raw);
}

function express() {
  const routes = [];
  const middlewares = [];
  const app = (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => send(req, res, JSON.stringify(value), 'application/json; charset=utf-8', res.statusCode || 200);
    req.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    let i = 0;
    const nextMiddleware = err => {
      if (res.writableEnded) return;
      if (err) return send(req, res, JSON.stringify({ error: '요청을 처리하지 못했습니다.' }), 'application/json; charset=utf-8', 500);
      const mw = middlewares[i++];
      if (mw) return mw(req, res, nextMiddleware);
      dispatch();
    };
    const dispatch = () => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      for (const route of routes) {
        if (route.method !== req.method && !(req.method === 'HEAD' && route.method === 'GET')) continue;
        const names = [];
        const pattern = route.path.split('/').map(part => {
          if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('/');
        const match = pathname.match(new RegExp('^' + pattern + '/?$'));
        if (!match) continue;
        try { req.params = Object.fromEntries(names.map((n, x) => [n, decodeURIComponent(match[x + 1])])); }
        catch (_) { return send(req, res, JSON.stringify({ error: '잘못된 요청입니다.' }), 'application/json; charset=utf-8', 400); }
        try { route.handler(req, res); }
        catch (e) { console.error(e); send(req, res, JSON.stringify({ error: '요청을 처리하지 못했습니다.' }), 'application/json; charset=utf-8', 500); }
        return;
      }
      send(req, res, JSON.stringify({ error: '요청을 찾을 수 없습니다.' }), 'application/json; charset=utf-8', 404);
    };
    nextMiddleware();
  };
  app.set = () => app;
  app.use = middleware => { middlewares.push(middleware); return app; };
  for (const method of ['get', 'post', 'put', 'delete']) app[method] = (route, handler) => { routes.push({ method: method.toUpperCase(), path: route, handler }); return app; };
  app.listen = (port, callback) => http.createServer(app).listen(port, callback);
  return app;
}

express.json = ({ limit = '100kb' } = {}) => {
  const max = typeof limit === 'number' ? limit : parseInt(limit, 10) * (String(limit).toLowerCase().endsWith('mb') ? 1024 * 1024 : 1024);
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !/\bapplication\/json\b/i.test(req.headers['content-type'] || '')) { req.body = {}; return next(); }
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > max) { send(req, res, JSON.stringify({ error: '요청 내용이 너무 큽니다.' }), 'application/json; charset=utf-8', 413); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try { req.body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; next(); }
      catch (_) { send(req, res, JSON.stringify({ error: 'JSON 형식이 올바르지 않습니다.' }), 'application/json; charset=utf-8', 400); }
    });
    req.on('error', next);
  };
};

express.static = (root, { maxAge = 0, etag = true } = {}) => (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch (_) { return next(); }
  const filename = path.resolve(root, '.' + pathname);
  if (filename !== path.resolve(root) && !filename.startsWith(path.resolve(root) + path.sep)) return next();
  fs.stat(filename, (err, stat) => {
    if (err || !stat.isFile()) return next();
    fs.readFile(filename, (readErr, data) => {
      if (readErr) return next(readErr);
      const age = typeof maxAge === 'number' ? maxAge / 1000 : parseInt(maxAge, 10) * (String(maxAge).includes('h') ? 3600 : 1);
      send(req, res, data, MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream', 200, `public, max-age=${age}`, etag);
    });
  });
};

module.exports = express;
