import type { Ref } from "react";
import { UploadDropzone, type UploadHandle } from "./UploadDropzone";
import { UrlForm } from "./UrlForm";
import "./input.css";

interface InputScreenProps {
  onSubmitUrl: (url: string) => void;
  onSubmitFile: (file: File) => void;
  busy: boolean;
  highlightUpload: boolean;
  uploadRef?: Ref<UploadHandle>;
}

/** §10 C1: paste a YouTube link, or upload/drop an audio file. */
export function InputScreen({
  onSubmitUrl,
  onSubmitFile,
  busy,
  highlightUpload,
  uploadRef,
}: InputScreenProps) {
  return (
    <section className="input-screen card" aria-labelledby="input-heading">
      <h2 id="input-heading" className="sr-only">
        Choose a song
      </h2>
      <UrlForm onSubmit={onSubmitUrl} busy={busy} />
      <div className="divider" aria-hidden="true">
        <span>or</span>
      </div>
      <UploadDropzone
        ref={uploadRef}
        onFile={onSubmitFile}
        highlight={highlightUpload}
      />
    </section>
  );
}
