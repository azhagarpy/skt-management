/**
 * Sends a PDF to the printer: the file is loaded into a hidden frame and the
 * browser's print dialog opened on it, with nothing saved first. A web page
 * cannot print without that dialog - the browser always asks which printer -
 * so this is as direct as printing from the site gets.
 */
export function printPdf(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'

  frame.onload = () => {
    // The PDF viewer inside the frame needs a moment after load before it can print.
    window.setTimeout(() => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
      } catch {
        // A browser that will not print a PDF from a frame: open it to print from its own viewer.
        window.open(url, '_blank', 'noopener')
      }
    }, 300)
    // Kept until the print dialog has long since taken its copy.
    window.setTimeout(() => {
      frame.remove()
      URL.revokeObjectURL(url)
    }, 120_000)
  }

  frame.src = url
  document.body.appendChild(frame)
}
