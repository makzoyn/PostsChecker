// Всплывающее окно для браузеров, где клик по значку расширения не открывает страницу сам (например Orion на iOS).
const dashboardUrl = chrome.runtime.getURL('dashboard.html');

document.getElementById('open-tab').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: dashboardUrl });
    window.close();
  } catch (error) {
    const message = document.getElementById('error');
    message.textContent = `Не удалось открыть вкладку: ${error.message}. Нажмите «Открыть в этом окне».`;
    message.hidden = false;
  }
});

// Запасной путь: если вкладки недоступны, показываем статистику прямо в окне расширения.
document.getElementById('open-here').addEventListener('click', () => {
  location.href = dashboardUrl;
});
