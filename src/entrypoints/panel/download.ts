/**
 * 組み立てた文字列をファイルとして落とす。
 *
 * `chrome.downloads` は使わない。あれには `downloads` 権限が必要で、`wxt.config.ts` が
 * 権限を `storage` だけに絞っている方針から外れる。Blob URL とアンカーの `download`
 * 属性なら追加権限なしで同じことができる。
 *
 * DOM と Blob の副作用しか無いためユニットテストは書かない。だからこそ、テスト可能な
 * 変換ロジック（`@/lib/har`）とはファイルを分けている。
 */

/**
 * Blob URL を解放するまでの猶予。
 *
 * Chrome の「ダウンロード前に各ファイルの保存場所を確認する」設定では、利用者が保存先を
 * 選ぶまでブラウザが Blob を読みに来ない。クリック直後に解放すると、その前に URL が
 * 無効になってダウンロードが黙って失敗する（この関数は正常に返るため、呼び出し側は
 * 成功したと思い込む）。ダイアログを操作する時間を見込んで待つ。
 */
const REVOKE_DELAY_MS = 60_000;

/**
 * @param text 書き出す内容
 * @param fileName 保存名。ユーザーの既定ダウンロード先に落ちる
 * @param mimeType Blob の型
 */
export function downloadText(text: string, fileName: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  // クリックさせるだけなので画面には出さない。document に挿す必要があるのは、
  // 切り離された要素の click() を無視するブラウザがあるため。
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
