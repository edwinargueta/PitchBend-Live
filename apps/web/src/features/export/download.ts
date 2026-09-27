/** Save a Blob under `filename` via a temporary object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Some browsers read the URL asynchronously after click(); revoke later.
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}
