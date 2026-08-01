// フロントエンドのエラーをサーバへ転送する。
// 開発マシンがヘッドレスでユーザーはスマホから触るため、
// ブラウザのdevtoolsが見られない前提の運用（サーバログを監視する）。

let reported = 0;
const MAX_REPORTS = 30; // 無限ループ対策

function report(level: 'error' | 'warn', message: string, stack?: string): void {
  if (reported >= MAX_REPORTS) return;
  reported++;
  fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level,
      message: String(message).slice(0, 2000),
      stack: stack?.slice(0, 4000),
      url: location.href,
      ua: navigator.userAgent,
    }),
  }).catch(() => {});
}

export function installErrorReporter(): void {
  window.addEventListener('error', (ev) => {
    report('error', ev.message, ev.error instanceof Error ? ev.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r: unknown = ev.reason;
    report('error', r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
  });
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args);
    report('error', args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
  };
}
