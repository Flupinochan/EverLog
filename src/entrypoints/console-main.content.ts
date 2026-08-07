/**
 * ページの `console.*` を差し替えて記録するコンテントスクリプト（MAIN world）。
 *
 * MAIN world で動かす必要がある。ページの script が呼ぶのはページ自身の `console` で
 * あり、ISOLATED world の `console` とは別物のため、ISOLATED 側でいくら包んでも
 * ページの出力は拾えない。
 *
 * MAIN world からは `chrome.runtime` に触れないため、保存層へは直接送れない。
 * CustomEvent で ISOLATED world のブリッジ（`console-bridge.content.ts`）へ渡し、
 * そこから background へ送る。
 *
 * ここでの役割は「拾う・整える・渡す」まで。記録の可否と URL フィルタの判定は
 * 設定を読めるブリッジ側にあり、この層は渡されたフラグに従うだけにする。
 */

import {
  CAPTURE_STATE_EVENT,
  CONSOLE_ENTRY_EVENT,
  CONSOLE_METHODS,
  BRIDGE_READY_EVENT,
  DEFAULT_RATE_LIMIT,
  MAIN_READY_EVENT,
  createRateLimiter,
  describeDroppedEntries,
  formatConsoleArgs,
  parseStackTop,
  type CapturedConsoleEntry,
  type ConsoleLevel,
} from '@/lib/console-log';

/**
 * ブリッジが繋がるまで溜めておける件数。
 *
 * 2 つのコンテントスクリプトはどちらも `document_start` で走るが、注入順は保証されない。
 * ブリッジが後になった場合にここで溜めておかないと、ページ読み込み直後の出力
 * （まさに調査したい部分）を落とす。溢れた分は捨て、件数だけ後から伝える。
 */
const PENDING_LIMIT = 200;

/** スタックを残すレベル。それ以外は発生元（`source`）だけで足りる。 */
const STACK_LEVELS: ReadonlySet<ConsoleLevel> = new Set<ConsoleLevel>([
  'error',
  'assert',
  'trace',
  'uncaught',
  'unhandledrejection',
]);

function install(): void {
  // ページが後から差し替えても影響を受けないよう、使う関数はすべて今のものを掴んでおく。
  // 特に `dispatchEvent` を奪われると記録が黙って止まる
  const originalConsole = globalThis.console;
  const dispatch = window.dispatchEvent.bind(window);
  const now = Date.now.bind(Date);
  const stringify = JSON.stringify.bind(JSON);
  const defer = globalThis.setTimeout.bind(globalThis);

  const limiter = createRateLimiter();
  const pending: string[] = [];
  let bridgeReady = false;

  /**
   * 記録してよいか。ブリッジが設定を読み終えるまでは true で始める。
   *
   * `devtools/main.ts` が設定の読み込みを待たずに購読を張るのと同じ判断で、
   * 読み込みの往復より早く出た分を捨てるほうが損失が大きい。記録が OFF だった場合は
   * ブリッジが後から false を伝え、それまでに拾った分もブリッジ側で捨てる。
   */
  let enabled = true;

  /**
   * 直列化のさなかにページの getter が `console` を呼ぶことがある。
   * その呼び出しまで捕まえると再帰するため、この間は素通しにする。
   */
  let capturing = false;

  function emit(entry: CapturedConsoleEntry): void {
    const payload = stringify(entry);
    if (!bridgeReady) {
      // 古いものから捨てる。溢れているのは大量に出ている最中であり、
      // 直近のほうが原因に近い
      if (pending.length >= PENDING_LIMIT) pending.shift();
      pending.push(payload);
      return;
    }
    dispatch(new CustomEvent(CONSOLE_ENTRY_EVENT, { detail: payload }));
  }

  /**
   * 発生元とスタックを決める。
   *
   * `source` は必ず呼び出し位置から取る。`console.error(err)` のとき、`err` の
   * スタックの先頭は「エラーを作った場所」であって「ログに出した場所」ではない。
   * 一方 `stack` は `err` のものを優先する。調査で読みたいのはそちらのため。
   */
  function resolveOrigin(
    level: ConsoleLevel,
    args: readonly unknown[],
  ): { source: string | null; stack: string | null } {
    let callSite: string | undefined;
    try {
      callSite = new Error().stack ?? undefined;
    } catch {
      callSite = undefined;
    }

    const errorArg = args.find(
      (arg): arg is { stack: string } =>
        typeof arg === 'object' &&
        arg !== null &&
        typeof (arg as { stack?: unknown }).stack === 'string',
    );

    const stack = errorArg?.stack ?? (STACK_LEVELS.has(level) ? (callSite ?? null) : null);
    return { source: parseStackTop(callSite), stack };
  }

  /** 捨てた件数を 1 件のログとして残す。無ければ何もしない。 */
  function reportDropped(at: number): void {
    const dropped = limiter.takeDropped();
    if (dropped === 0) return;
    emit({
      ts: at,
      pageUrl: location.href,
      level: 'warn',
      text: describeDroppedEntries(dropped),
      args: [],
      source: null,
      stack: null,
      argsStatus: 'stored',
    });
  }

  /** 捨てた件数を伝えるための予約。窓が明けたら 1 度だけ報告する。 */
  let dropNotice: ReturnType<typeof setTimeout> | null = null;

  /**
   * 次に通る 1 件を待たずに報告できるようにする。
   *
   * 報告を「次の許可時」だけに任せると、大量出力のあと静かになったページでは
   * 捨てた事実がどこにも残らない。ログが途切れて見えるのに理由が分からない状態を作らない。
   */
  function scheduleDropNotice(): void {
    if (dropNotice !== null) return;
    dropNotice = defer(() => {
      dropNotice = null;
      reportDropped(now());
    }, DEFAULT_RATE_LIMIT.windowMs);
  }

  function capture(level: ConsoleLevel, args: readonly unknown[]): void {
    if (!enabled || capturing) return;

    capturing = true;
    try {
      const at = now();
      // 上限の判定は直列化より先に行う。抑えたいのは大量発生時の負荷そのものであり、
      // 作ってから捨てるのでは払う手間が変わらない
      if (!limiter.allow(at)) {
        scheduleDropNotice();
        return;
      }

      reportDropped(at);

      const { text, args: preview, argsStatus } = formatConsoleArgs(args);
      const { source, stack } = resolveOrigin(level, args);

      emit({ ts: at, pageUrl: location.href, level, text, args: preview, source, stack, argsStatus });
    } catch {
      // 記録の失敗でページの `console` を壊さない。元の呼び出しは呼び出し側で必ず行う
    } finally {
      capturing = false;
    }
  }

  for (const method of CONSOLE_METHODS) {
    const original = originalConsole[method] as ((...args: unknown[]) => void) | undefined;
    if (typeof original !== 'function') continue;

    originalConsole[method] = function (this: unknown, ...args: unknown[]): void {
      // 元の出力を先に行う。記録側が何をしようと、DevTools の Console から
      // ログが消えたように見えることは避ける
      original.apply(this, args);
      // `console.assert` は第 1 引数が偽のときだけ出力する。真のときまで記録すると、
      // 出ていないログが残ることになる
      if (method === 'assert' && args[0]) return;
      capture(method, method === 'assert' ? args.slice(1) : args);
    };
  }

  window.addEventListener('error', (event) => {
    if (!enabled) return;
    const at = now();
    const source =
      typeof event.filename === 'string' && event.filename !== ''
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : null;
    const stack = event.error instanceof Error ? event.error.stack : null;

    emit({
      ts: at,
      pageUrl: location.href,
      level: 'uncaught',
      text: event.message,
      args: [],
      source,
      stack: stack ?? null,
      argsStatus: 'stored',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (!enabled) return;
    const at = now();
    const { text, args, argsStatus } = formatConsoleArgs([event.reason]);
    const stack =
      typeof (event.reason as { stack?: unknown })?.stack === 'string'
        ? ((event.reason as { stack: string }).stack)
        : null;

    emit({
      ts: at,
      pageUrl: location.href,
      level: 'unhandledrejection',
      text,
      args,
      source: parseStackTop(stack),
      stack,
      argsStatus,
    });
  });

  window.addEventListener(BRIDGE_READY_EVENT, () => {
    bridgeReady = true;
    for (const payload of pending.splice(0)) {
      dispatch(new CustomEvent(CONSOLE_ENTRY_EVENT, { detail: payload }));
    }
  });

  window.addEventListener(CAPTURE_STATE_EVENT, (event) => {
    const detail = (event as CustomEvent<string>).detail;
    try {
      enabled = (JSON.parse(detail) as { enabled?: unknown }).enabled === true;
    } catch {
      // 壊れた通知で記録を止めない。ブリッジ側が保存の直前にもう一度判定する
    }
  });

  // ブリッジが先に走っていた場合、その `bridge-ready` はもう流れ終わっている。
  // こちらの合図に応答してもらうことで、どちらの順で注入されても繋がる
  dispatch(new CustomEvent(MAIN_READY_EVENT));
}

export default defineContentScript({
  matches: ['*://*/*'],
  world: 'MAIN',
  // ページの script より先に `console` を差し替える。1 件目から取りこぼさないため
  runAt: 'document_start',
  // iframe の出力も対象にする。フレーム内のエラーは親からは見えない
  allFrames: true,
  main: install,
});
