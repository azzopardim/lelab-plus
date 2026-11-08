// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SelectedCameraPreview from "./SelectedCameraPreview";

const stream = vi.fn((_deviceId: string, _paused: boolean) => ({
  videoRef: React.createRef<HTMLVideoElement>(),
  hasError: false,
}));
vi.mock("@/hooks/useCameraStream", () => ({
  useCameraStream: (deviceId: string, paused: boolean) => stream(deviceId, paused),
}));

let root: Root;
let container: HTMLDivElement;
const usbCam = { index: 1, name: "USB Camera", available: true, deviceId: "dev-usb" };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  root = createRoot(container);
  stream.mockClear();
});
afterEach(() => act(() => root.unmount()));

test("nothing is shown before a camera is picked", () => {
  act(() => root.render(<SelectedCameraPreview camera={null} />));
  expect(container.innerHTML).toBe("");
  expect(stream).not.toHaveBeenCalled();
});

test("picking a camera opens a live preview of that device", () => {
  act(() => root.render(<SelectedCameraPreview camera={usbCam} />));
  expect(container.querySelector("video")).not.toBeNull();
  expect(container.textContent).toContain("USB Camera");
  expect(stream).toHaveBeenLastCalledWith("dev-usb", false);
});

test("switching the pick switches the previewed device", () => {
  act(() => root.render(<SelectedCameraPreview camera={usbCam} />));
  act(() => root.render(<SelectedCameraPreview camera={{ ...usbCam, index: 2, deviceId: "dev-other" }} />));
  expect(stream).toHaveBeenLastCalledWith("dev-other", false);
});

test("a camera the browser can't match explains why there is no picture", () => {
  act(() => root.render(<SelectedCameraPreview camera={{ ...usbCam, deviceId: "" }} />));
  expect(container.querySelector("video")).toBeNull();
  expect(container.textContent).toContain("can't be previewed");
});

test("the preview pauses while a recording holds the cameras", () => {
  act(() => root.render(<SelectedCameraPreview camera={usbCam} paused />));
  expect(container.querySelector("video")).toBeNull();
  expect(container.textContent).toContain("Preview paused");
  expect(stream).toHaveBeenLastCalledWith("dev-usb", true);
});
