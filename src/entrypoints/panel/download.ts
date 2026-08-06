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

  // 解放が早すぎるとダウンロードが始まる前に URL が無効になる。次のタスクまで待つ。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
