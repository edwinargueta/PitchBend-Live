import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputScreen } from "./InputScreen";
import type { UploadHandle } from "./UploadDropzone";

vi.mock(
  "../../lib/youtube",
  async () => (await import("../__tests__/fakeLib")).fakeYoutube,
);
vi.mock(
  "../../lib/errors",
  async () => (await import("../__tests__/fakeLib")).fakeErrors,
);

const VALID = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const onSubmitUrl = vi.fn();
const onSubmitFile = vi.fn();

function setup(props: { highlightUpload?: boolean; busy?: boolean } = {}) {
  const ref = createRef<UploadHandle>();
  render(
    <InputScreen
      uploadRef={ref}
      onSubmitUrl={onSubmitUrl}
      onSubmitFile={onSubmitFile}
      busy={props.busy ?? false}
      highlightUpload={props.highlightUpload ?? false}
    />,
  );
  return { ref, input: screen.getByLabelText("YouTube link") };
}

function paste(el: HTMLElement, text: string) {
  const event = createEvent.paste(el, {
    clipboardData: { getData: () => text },
  });
  fireEvent(el, event);
  return event;
}

function dropEvent(files: File[], types = ["Files"]) {
  return { dataTransfer: { files, types, dropEffect: "none" } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("URL field", () => {
  it("submits a valid URL (trimmed) with the Load button", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: `  ${VALID}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(onSubmitUrl).toHaveBeenCalledWith(VALID);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an inline error for an invalid URL and doesn't submit", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "https://vimeo.com/123" } });
    fireEvent.submit(input);
    expect(onSubmitUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "doesn't look like a YouTube",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.getAttribute("aria-describedby")).toContain(
      screen.getByRole("alert").id,
    );
    // Editing clears the error.
    fireEvent.change(input, { target: { value: "h" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("asks for a link when submitted empty", () => {
    const { input } = setup();
    fireEvent.submit(input);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Paste a YouTube link first.",
    );
  });

  it("pasting a valid URL auto-submits", () => {
    const { input } = setup();
    const event = paste(input, ` ${VALID} `);
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmitUrl).toHaveBeenCalledWith(VALID);
    expect(input).toHaveValue(VALID);
  });

  it("pasting anything else is a normal paste", () => {
    const { input } = setup();
    const event = paste(input, "not a link");
    expect(event.defaultPrevented).toBe(false);
    paste(input, "   ");
    expect(onSubmitUrl).not.toHaveBeenCalled();
  });

  it("marks the button busy while working", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Load" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("upload", () => {
  const file = new File(["abc"], "song.mp3", { type: "audio/mpeg" });

  it("shows the limits from lib", () => {
    setup();
    expect(screen.getByText(/up to 50 MB and 12 minutes/)).toBeInTheDocument();
  });

  it("the button opens the file picker and a chosen file is submitted", () => {
    setup();
    const picker = screen.getByLabelText<HTMLInputElement>("Audio file");
    const click = vi.spyOn(picker, "click");
    fireEvent.click(screen.getByRole("button", { name: "Choose audio file" }));
    expect(click).toHaveBeenCalled();
    fireEvent.change(picker, { target: { files: [file] } });
    expect(onSubmitFile).toHaveBeenCalledWith(file);
  });

  it("ignores an empty selection", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Audio file"), {
      target: { files: [] },
    });
    expect(onSubmitFile).not.toHaveBeenCalled();
  });

  it("accepts a dropped file and highlights while dragging", () => {
    setup();
    const zone = screen.getByText("Have the audio file?").closest(".dropzone");
    if (!(zone instanceof HTMLElement)) throw new Error("no dropzone");
    fireEvent.dragEnter(zone, dropEvent([file]));
    expect(zone).toHaveClass("dropzone--dragging");
    fireEvent.dragOver(zone, dropEvent([file]));
    fireEvent.dragLeave(zone, { relatedTarget: null });
    expect(zone).not.toHaveClass("dropzone--dragging");
    fireEvent.dragEnter(zone, dropEvent([file]));
    fireEvent.drop(zone, dropEvent([file]));
    expect(zone).not.toHaveClass("dropzone--dragging");
    expect(onSubmitFile).toHaveBeenCalledTimes(1);
    expect(onSubmitFile).toHaveBeenCalledWith(file);
  });

  it("ignores drags that carry no files, and moves within the zone", () => {
    setup();
    const zone = screen.getByText("Have the audio file?").closest(".dropzone");
    if (!(zone instanceof HTMLElement)) throw new Error("no dropzone");
    fireEvent.dragEnter(zone, dropEvent([], ["text/plain"]));
    expect(zone).not.toHaveClass("dropzone--dragging");
    fireEvent.dragEnter(zone, dropEvent([file]));
    const leave = createEvent.dragLeave(zone);
    Object.defineProperty(leave, "relatedTarget", {
      value: screen.getByRole("button", { name: "Choose audio file" }),
    });
    fireEvent(zone, leave);
    expect(zone).toHaveClass("dropzone--dragging");
  });

  it("a file dropped anywhere on the page is taken instead of navigating away", () => {
    setup();
    const over = new Event("dragover", { cancelable: true });
    Object.assign(over, dropEvent([file]));
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const drop = new Event("drop", { cancelable: true });
    Object.assign(drop, dropEvent([file]));
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(onSubmitFile).toHaveBeenCalledWith(file);

    const textDrop = new Event("drop", { cancelable: true });
    Object.assign(textDrop, dropEvent([], ["text/plain"]));
    window.dispatchEvent(textDrop);
    expect(textDrop.defaultPrevented).toBe(false);
    expect(onSubmitFile).toHaveBeenCalledTimes(1);
  });

  it("exposes open/focus so errors can point at the upload control", () => {
    const { ref } = setup();
    const picker = screen.getByLabelText<HTMLInputElement>("Audio file");
    const click = vi.spyOn(picker, "click");
    act(() => {
      ref.current?.focus();
    });
    expect(
      screen.getByRole("button", { name: "Choose audio file" }),
    ).toHaveFocus();
    act(() => {
      ref.current?.open();
    });
    expect(click).toHaveBeenCalled();
  });

  it("is prominent when uploading is the way forward", () => {
    setup({ highlightUpload: true });
    expect(
      screen.getByText("Upload the audio file instead"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Choose audio file" }),
    ).toHaveClass("btn--primary");
  });
});
