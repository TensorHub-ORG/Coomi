// Mount before express.static(coomiDir). Requires `db`, `fs`, `path`, `app`, `coomiDir`.
db.exec(`CREATE TABLE IF NOT EXISTS coomi_download_stats (
  file TEXT PRIMARY KEY,
  downloads INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
)`);
app.get('/coomi/download-stats', (req, res) => {
  const file = String(req.query.file || '').replace(/[^A-Za-z0-9._-]/g, '');
  const row = file ? db.prepare('SELECT downloads, updated_at FROM coomi_download_stats WHERE file = ?').get(file) : null;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ file, downloads: Number(row?.downloads || 0), updatedAt: Number(row?.updated_at || 0) });
});
app.get('/coomi/download/:file', (req, res, next) => {
  const file = String(req.params.file || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!/^Cubee-[A-Za-z0-9._-]+\.apk$/.test(file)) return res.status(400).json({ error: 'invalid download file' });
  const target = path.join(coomiDir, file);
  if (!fs.existsSync(target)) return next();
  if (req.method === 'HEAD') return res.sendFile(target);
  const countThisRequest = !req.headers.range;
  res.download(target, file, error => {
    if (error) { if (!res.headersSent) next(error); return; }
    if (!countThisRequest) return;
    db.prepare(`INSERT INTO coomi_download_stats(file, downloads, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(file) DO UPDATE SET downloads = downloads + 1, updated_at = excluded.updated_at`).run(file, Date.now());
  });
});
