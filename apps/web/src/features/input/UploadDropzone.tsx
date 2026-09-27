import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type Ref,
} from "react";
import { Icon } from "../../components/Icon";
import { LIMITS } from "../../lib/errors";

/** Lets other parts of the UI (e.g. the SOURCE_BLOCKED error) open the picker. */
export interface UploadHandle {
  open: () => void;
  focus: () => void;
}

interface UploadDropzoneProps {
  onFile: (file: File) => void;
  /** Draw attention to uploading (e.g. YouTube blocked the server). */
  highlight: boolean;
  ref?: Ref<UploadHandle>;
}

const ACCEPT = "audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.oga,.opus";

function hasFiles(dt: DataTransfer | null): boolean {
  return dt !== null && Array.from(dt.types).includes("Files");
}

/** Upload is a first-class input (D10): a button plus drag-and-drop anywhere on the page. */
export function UploadDropzone({
  onFile,
  highlight,
  ref,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dragging, setDragging] = useState(false);
  const onFileRef = useRef(onFile);
  useEffect(() => {
    onFileRef.current = onFile;
  });

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        buttonRef.current?.focus();
        inputRef.current?.click();
      },
      focus: () => {
        buttonRef.current?.focus();
      },
    }),
    [],
  );

  // A file dropped outside the zone would otherwise make the browser navigate away.
  useEffect(() => {
    const onDragOver = (e: globalThis.DragEvent) => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    };
    const onDrop = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) onFileRef.current(file);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const take = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  const onZoneDrag = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const className = [
    "dropzone",
    dragging ? "dropzone--dragging" : "",
    highlight ? "dropzone--highlight" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onDragEnter={onZoneDrag}
      onDragOver={onZoneDrag}
      onDragLeave={(e) => {
        const next = e.relatedTarget;
        if (!(next instanceof Node) || !e.currentTarget.contains(next)) {
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        take(e.dataTransfer.files);
      }}
    >
      <Icon name="upload" size={28} />
      <p className="dropzone__title">
        {highlight ? "Upload the audio file instead" : "Have the audio file?"}
      </p>
      <p className="dropzone__text">Drop it anywhere on this page, or</p>
      <button
        ref={buttonRef}
        type="button"
        className={highlight ? "btn btn--primary" : "btn"}
        onClick={() => inputRef.current?.click()}
      >
        Choose audio file
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label="Audio file"
        onChange={(e) => {
          take(e.currentTarget.files);
          e.currentTarget.value = ""; // choosing the same file again still fires
        }}
      />
      <p className="hint">
        MP3, M4A, WAV, FLAC or OGG, up to {LIMITS.maxUploadMb} MB and{" "}
        {Math.floor(LIMITS.maxDurationS / 60)} minutes.
      </p>
    </div>
  );
}
