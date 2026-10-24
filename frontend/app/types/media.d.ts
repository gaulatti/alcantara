// Browser support varies, so callers must check this capability before use.
interface HTMLMediaElement {
  captureStream?(): MediaStream;
}
