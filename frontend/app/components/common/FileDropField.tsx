import { useRef, useState } from "react";
import { uploadFileToMediaBucket, type UploadKind } from "../../services/uploads";

/**
 * Click-or-drop file uploader that sends the file to the media bucket and
 * reports the resulting public URL. Enforces the client-side size limit so the
 * operator gets feedback before a large body hits the network.
 */
export function FileDropField({
  kind,
  accept,
  maxBytes,
  label,
  onUploaded,
  disabled = false,
}: {
  kind: UploadKind;
  accept: string;
  maxBytes: number;
  label: string;
  onUploaded: (url: string, file: File) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file || disabled || isUploading) return;
    if (file.size > maxBytes) {
      setError(
        `File too large. Max size is ${Math.floor(maxBytes / (1024 * 1024))}MB`,
      );
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const upload = await uploadFileToMediaBucket(kind, file);
      onUploaded(upload.url, file);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error && uploadError.message
          ? uploadError.message
          : "Upload failed",
      );
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-1">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || isUploading}
        aria-label={label}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          void handleFile(event.dataTransfer.files?.[0]);
        }}
        className={`cursor-pointer rounded border border-dashed px-3 py-3 text-center text-xs transition-colors ${
          isDragging
            ? "border-sea bg-sea/10 text-text-primary"
            : "border-sand/40 text-text-secondary hover:border-sea/60"
        } ${disabled || isUploading ? "pointer-events-none opacity-60" : ""}`}
      >
        {isUploading ? "Uploading…" : label}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        data-testid="file-drop-input"
        disabled={disabled || isUploading}
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      {error ? (
        <p role="alert" className="text-xs text-terracotta">
          {error}
        </p>
      ) : null}
    </div>
  );
}
