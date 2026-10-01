const url = process.argv[2];
const ws = new WebSocket(url);
const t = setTimeout(() => { console.log('WS_RESULT=TIMEOUT'); process.exit(0); }, 8000);
ws.addEventListener('open', () => { console.log('WS_RESULT=OPEN'); clearTimeout(t); ws.close(); process.exit(0); });
ws.addEventListener('error', (e) => { console.log('WS_RESULT=ERROR ' + (e.message || '')); clearTimeout(t); process.exit(0); });
ws.addEventListener('close', (e) => { console.log('WS_RESULT=CLOSE code=' + e.code + ' reason=' + (e.reason||'')); clearTimeout(t); process.exit(0); });
