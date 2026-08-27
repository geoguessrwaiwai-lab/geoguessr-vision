import { pathToFileURL } from 'node:url';

/**
 * 「このファイルが `node xxx.ts` として直接実行されたか、それとも他のファイルからimportされただけか」を判定するヘルパー。
 *
 * 元の実装は `import.meta.url === \`file://${process.argv[1]}\`` という比較をpano-meta.ts / render-pano.ts の2箇所に直接書いていたが、
 * この文字列連結はWindows のパス(バックスラッシュや大文字小文字の扱い)で崩れやすい。
 * `pathToFileURL` はプラットフォームごとのURLエンコーディング差を吸収してくれるため、より頑健な比較になる。
 */
export function isMainModule(moduleUrl: string): boolean {
  if (!process.argv[1]) return false;
  return moduleUrl === pathToFileURL(process.argv[1]).href;
}
