const [port, token] = [process.argv[2], process.argv[3]];
const paths = ['/api/runtime/health', '/api/agent/preferences', '/api/sessions', '/api/settings'];
(async () => {
  for (const p of paths) {
    const started = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch('http://127.0.0.1:' + port + p, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
      clearTimeout(timer);
      const text = await res.text();
      console.log(p + ' -> HTTP ' + res.status + ' ' + (Date.now() - started) + 'ms len=' + text.length);
    } catch (e) {
      console.log(p + ' -> ERR ' + (Date.now() - started) + 'ms ' + (e.name || '') + ' ' + String(e.message).slice(0, 80));
    }
  }
})();
