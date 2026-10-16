import { useEffect, useState } from "react";
export const en = {
  title: "Repo Pulse",
  attention: "Need attention",
  refresh: "Check now",
  batch: "Process all new",
  settings: "Settings",
  save: "Save settings",
  scan: "Scan checkouts",
  open: "Open on GitHub",
  run: "Run agent",
  thread: "Open thread",
  done: "Mark resolved",
  mute: "Mute",
  restore: "Mark new",
  new: "New",
  running: "Agent running",
  waiting: "Waiting for you",
  muted: "Muted",
  resolved: "Done",
  all: "All",
  active: "Needs attention",
  empty:
    "No items need attention. Check GitHub or change the repository list in settings.",
  loading: "Loading…",
  auth: "Authenticated GitHub polling",
  anonymous:
    "Anonymous GitHub access: 60 requests/hour; this plugin reserves a budget of 45. Configure GH_TOKEN in Env Catalog or a secret plugin setting.",
  last: "Last checked",
  errors: "Polling errors",
  owner: "GitHub owner",
  repositories:
    "Repositories (one owner/repo per line; empty = discover bb-plugin-* and claude-lane-stack)",
  projectId: "BB project ID",
  hostId: "Machine ID",
  scanRoot: "Folder to scan",
  checkouts: "Repository → checkout map (JSON)",
  provider: "Provider",
  model: "Model",
  reasoning: "Reasoning",
  permission: "Permissions",
  intervalMinutes: "Poll interval (minutes)",
  automatic: "Automatically prepare reports and local branches",
  marketplace: "Watch marketplace submissions",
  prompt: "Agent contract template",
  preview: "Preview agent prompt",
  previewReady: "Launch validated; no thread or writer was started.",
  saved: "Settings saved",
  scanned: "Checkouts scanned",
  notification: "New GitHub items",
  error: "Action failed",
  configureHost: "Choose a machine and a scan folder in settings.",
  configureCheckout: "Set a project, machine and checkout path in settings.",
  itemMissing: "This item no longer exists.",
  itemResolved: "This item is already resolved or muted.",
  repoBusy: "An agent is already working on this repository.",
  anonymousLimit:
    "Anonymous request budget exhausted; retry after the hourly reset.",
  rateLimit: "GitHub rate limit exhausted.",
  launchFailed: "Agent launch failed.",
  pollFailed: "GitHub polling failed.",
  paginationLimit: "GitHub pagination limit reached; list is incomplete.",
  kindIssue: "Issue",
  kindPr: "Pull request",
  kindComment: "Comment",
  kindReview: "Review",
  kindCi: "CI failure",
  kindMarketplace: "Marketplace",
  remaining: "API requests remaining",
  showMore: "Open GitHub to see the full discussion",
  tokenHint:
    "GitHub token: set GH_TOKEN in Env Catalog, or use the secret field on this plugin’s BB settings page.",
  dryMode: "Preview launches (no agent starts)",
  unconfigured:
    "Choose a BB project, machine and scan folder before launching agents.",
};
export const ru: Record<keyof typeof en, string> = {
  title: "Пульс плагинов",
  attention: "Требуют внимания",
  refresh: "Проверить сейчас",
  batch: "Разобрать всё новое",
  settings: "Настройки",
  save: "Сохранить настройки",
  scan: "Найти checkout",
  open: "Открыть на GitHub",
  run: "Запустить агента",
  thread: "Открыть тред",
  done: "Отметить решённым",
  mute: "Заглушить",
  restore: "Отметить новым",
  new: "Новое",
  running: "Агент работает",
  waiting: "Ждёт вас",
  muted: "Заглушено",
  resolved: "Решено",
  all: "Все",
  active: "Требуют внимания",
  empty:
    "Нет пунктов, требующих внимания. Проверьте GitHub или измените список репозиториев в настройках.",
  loading: "Загрузка…",
  auth: "GitHub: авторизованный опрос",
  anonymous:
    "GitHub без токена: 60 запросов в час; плагин оставляет себе бюджет 45. Добавьте GH_TOKEN в Env Catalog или секретную настройку плагина.",
  last: "Последняя проверка",
  errors: "Ошибки опроса",
  owner: "Владелец GitHub",
  repositories:
    "Репозитории (owner/repo по одному в строке; пусто = найти bb-plugin-* и claude-lane-stack)",
  projectId: "ID проекта BB",
  hostId: "ID машины",
  scanRoot: "Папка для поиска",
  checkouts: "Репозиторий → путь checkout (JSON)",
  provider: "Провайдер",
  model: "Модель",
  reasoning: "Глубина рассуждения",
  permission: "Разрешения",
  intervalMinutes: "Интервал опроса (минуты)",
  automatic: "Автоматически готовить отчёты и локальные ветки",
  marketplace: "Следить за заявками маркетплейса",
  prompt: "Шаблон контракта агента",
  preview: "Предпросмотр промпта",
  previewReady: "Запуск проверен; тред и агент не запускались.",
  saved: "Настройки сохранены",
  scanned: "Checkout найдены",
  notification: "Новые пункты GitHub",
  error: "Действие не выполнено",
  configureHost: "Укажите машину и папку поиска в настройках.",
  configureCheckout: "Укажите проект, машину и путь checkout в настройках.",
  itemMissing: "Пункт больше не существует.",
  itemResolved: "Пункт уже решён или заглушён.",
  repoBusy: "В этом репозитории уже работает агент.",
  anonymousLimit: "Часовой бюджет анонимных запросов исчерпан.",
  rateLimit: "Лимит запросов GitHub исчерпан.",
  launchFailed: "Не удалось запустить агента.",
  pollFailed: "Ошибка опроса GitHub.",
  paginationLimit: "Достигнут предел страниц GitHub; список неполон.",
  kindIssue: "Issue",
  kindPr: "PR",
  kindComment: "Комментарий",
  kindReview: "Ревью",
  kindCi: "Ошибка CI",
  kindMarketplace: "Маркетплейс",
  remaining: "Осталось запросов API",
  showMore: "Полное обсуждение доступно на GitHub",
  tokenHint:
    "Токен GitHub: GH_TOKEN в Env Catalog или секретное поле на странице настроек плагина в BB.",
  dryMode: "Проверять запуск без старта агента",
  unconfigured:
    "Перед запуском агентов выберите проект BB, машину и папку поиска.",
};
export function strings() {
  return document.documentElement.lang.toLowerCase().startsWith("ru") ? ru : en;
}
export function useStrings() {
  const [value, setValue] = useState(strings);
  useEffect(() => {
    const observer = new MutationObserver(() => setValue(strings()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["lang"],
    });
    return () => observer.disconnect();
  }, []);
  return value;
}
export function errorText(error: unknown, t: typeof en) {
  const raw = error instanceof Error ? error.message : String(error);
  const key = Object.keys(en).find((k) => raw === k || raw.endsWith(": " + k));
  return key
    ? t[key as keyof typeof en]
    : `${t.error}: ${raw.replace(/GitHub HTTP/g, "GitHub HTTP")}`;
}
