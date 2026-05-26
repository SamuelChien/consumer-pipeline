import { createServer } from 'http';

export function startHealthServer(port, checks = {}) {
  const server = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    if (req.url === '/readyz') {
      const results = {};
      let healthy = true;

      for (const [name, check] of Object.entries(checks)) {
        try {
          await check();
          results[name] = 'ok';
        } catch (err) {
          results[name] = err.message;
          healthy = false;
        }
      }

      const status = healthy ? 200 : 503;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: healthy ? 'ready' : 'not_ready', checks: results }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        pid: process.pid,
      }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, () => {});
  return server;
}
