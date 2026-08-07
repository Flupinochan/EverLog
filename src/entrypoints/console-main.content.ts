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
 *
 * ## この層はページから隔離されていない
 *
 * MAIN world はページ自身の世界であり、ページは以下をすべて行える。
 *
 * - `everlog:capture-state` を偽装して、自分のページの記録だけを止める
 * - `everlog:bridge-ready` を偽装して、溜めていた分を受け手のいない window へ流させる
 * - こちらが差し替えた `console` をさらに差し替える
 *
 * これは MAIN world で `console` を包むという方式そのものに付いてくる制約で、
 * この層のなかでは塞げない（合図に nonce を混ぜても、その nonce 自体がページから
 * 読める）。塞ぐには `chrome.debugger` が要るが、DevTools を開くとデタッチされる
 * ため本拡張機能では使えない（`wxt.config.ts` の注記を参照）。
 *
 * したがって**この層から届く値は信頼しない**。保存経路の入口である background で
 * `normalizeCapturedEntry()` を通し、形の壊れた値でバッチ全体を失わないようにしている。
 * 記録が止められる可能性については、popup の表示と実際の記録がずれうるという形で
 * 利用者に影響する。調査対象のページが敵対的な場合はこの方式では検知できない。
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
  /** バッファから溢れて捨てた件数。ブリッジが繋がったときに 1 件のログとして残す */
  let pendingDropped = 0;
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

  function send(payload: string): void {
    dispatch(new CustomEvent(CONSOLE_ENTRY_EVENT, { detail: payload }));
  }

  function emit(entry: CapturedConsoleEntry): void {
    const payload = stringify(entry);
    if (!bridgeReady) {
      // 古いものから捨てる。溢れているのは大量に出ている最中であり、
      // 直近のほうが原因に近い。捨てた件数は数えておき、繋がったときに報告する
      if (pending.length >= PENDING_LIMIT) {
        pending.shift();
        pendingDropped += 1;
      }
      pending.push(payload);
      return;
    }
    send(payload);
  }

  /**
   * 値から `stack` を読む。読めなければ null。
   *
   * getter が例外を投げることがあるため、素で読まない。ここで漏らすと、直列化まで
   * 成功していたエントリが最後の 1 手で丸ごと落ちる（`previewValue()` が
   * プロパティを読むときに try/catch しているのと同じ理由）。
   */
  function readStack(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    try {
      const stack = (value as { stack?: unknown }).stack;
      return typeof stack === 'string' ? stack : null;
    } catch {
      return null;
    }
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

    let fromArg: string | null = null;
    for (const arg of args) {
      fromArg = readStack(arg);
      if (fromArg !== null) break;
    }

    const stack = fromArg ?? (STACK_LEVELS.has(level) ? (callSite ?? null) : null);
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

  /**
   * レートリミッタを通す。通れば true。
   *
   * 記録の入口はここ 1 つに揃える。`console.*` だけを通して未捕捉例外を素通しに
   * すると、例外を投げ続けるページで上限が効かない。
   */
  function admit(at: number): boolean {
    if (!limiter.allow(at)) {
      scheduleDropNotice();
      return false;
    }
    reportDropped(at);
    return true;
  }

  function capture(level: ConsoleLevel, args: readonly unknown[]): void {
    if (!enabled || capturing) return;

    capturing = true;
    try {
      const at = now();
      // 上限の判定は直列化より先に行う。抑えたいのは大量発生時の負荷そのものであり、
      // 作ってから捨てるのでは払う手間が変わらない
      if (!admit(at)) return;

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
    if (!enabled || capturing) return;

    capturing = true;
    try {
      const at = now();
      if (!admit(at)) return;

      const source =
        typeof event.filename === 'string' && event.filename !== ''
          ? `${event.filename}:${event.lineno}:${event.colno}`
          : null;

      emit({
        ts: at,
        pageUrl: location.href,
        level: 'uncaught',
        text: event.message,
        args: [],
        source,
        stack: readStack(event.error),
        argsStatus: 'stored',
      });
    } catch {
      // 記録の失敗でページのエラー処理を巻き込まない
    } finally {
      capturing = false;
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (!enabled || capturing) return;

    capturing = true;
    try {
      const at = now();
      if (!admit(at)) return;

      const { text, args, argsStatus } = formatConsoleArgs([event.reason]);
      const stack = readStack(event.reason);

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
    } catch {
      // 同上
    } finally {
      capturing = false;
    }
  });

  window.addEventListener(BRIDGE_READY_EVENT, () => {
    bridgeReady = true;

    // 溢れて捨てた分を先に報告する。件数だけでも残さないと、ページ読み込み直後の
    // ログが「元から出ていなかった」のか「捨てられた」のか区別できない
    if (pendingDropped > 0) {
      send(
        stringify({
          ts: now(),
          pageUrl: location.href,
          level: 'warn',
          text: describeDroppedEntries(pendingDropped),
          args: [],
          source: null,
          stack: null,
          argsStatus: 'stored',
        } satisfies CapturedConsoleEntry),
      );
      pendingDropped = 0;
    }

    for (const payload of pending.splice(0)) send(payload);
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
