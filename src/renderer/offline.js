const reason = new URLSearchParams(location.search).get('reason');
if (reason) document.getElementById('reason').textContent = reason;
document.getElementById('retry').addEventListener('click', () => window.wwLocal.retry());
window.addEventListener('online', () => window.wwLocal.retry());
