async function loadStats() {
  const error = $('statsError');
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' });
    const stats = await response.json();
    if (!response.ok) throw new Error(stats.error || '统计服务不可用');
    $('dauToday').textContent = String(stats.appDauToday ?? 0);
    $('dau7d').textContent = String(stats.appUnique7d ?? 0);
    $('dauTotal').textContent = String(stats.appDailyStartsTotal ?? 0);
    $('dauAverage').textContent = `${stats.appDau30dAverage ?? 0} / ${stats.appDau30dPeak ?? 0}`;
    const days = Array.isArray(stats.appDau30d) ? stats.appDau30d : [];
    const max = Math.max(1, ...days.map((item) => Number(item.count) || 0));
    $('dauTrend').innerHTML = days.map((item) => {
      const count = Number(item.count) || 0;
      const height = Math.max(2, Math.round((count / max) * 100));
      return `<span class="trend-bar" style="height:${height}%" title="${esc(item.date)}：${count}"></span>`;
    }).join('');
    error.style.display = 'none';
  } catch (cause) {
    error.textContent = '活跃统计加载失败：' + cause.message;
    error.style.display = 'block';
  }
}
