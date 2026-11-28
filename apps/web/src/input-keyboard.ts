export interface EnterKeyState {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/**
 * Enter は送信、Shift+Enter は改行、IME 変換確定の Enter は送信しない。
 * keyCode 229 は一部環境で composing 中に返される後方互換の判定。
 */
export function shouldSubmitOnEnter(event: EnterKeyState): boolean {
  return (
    event.key === "Enter" && !event.shiftKey && event.isComposing !== true && event.keyCode !== 229
  );
}
