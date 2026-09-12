// Lua the Frame runs on-device. Brilliant's BLE transport takes Lua strings
// (brilliant-ble `sendLua`), so K9's display and camera calls become these
// snippets. Kept in one place so the wire format is reviewable.

/** Clears the display and shows wrapped text. Frame's screen is 640x400. */
export function displayText(text: string): string {
  const lines = wrap(text, 36).slice(0, 6);
  const draws = lines
    .map((line, index) => `frame.display.text(${quote(line)}, 1, ${1 + index * 60})`)
    .join("; ");
  return `frame.display.clear(); ${draws}; frame.display.show()`;
}

export const CLEAR_DISPLAY = "frame.display.clear(); frame.display.show()";

/** Wakes the camera and captures a frame; the photo arrives on the data channel. */
export const CAPTURE_PHOTO = "frame.camera.capture()";

export const BATTERY_LEVEL = "print(frame.battery_level())";

export const IMU_DIRECTION = "local d = frame.imu.direction(); print(d.pitch .. ',' .. d.roll .. ',' .. d.heading)";

export const MICROPHONE_START = "frame.microphone.start{sample_rate=8000, bit_depth=8}";
export const MICROPHONE_STOP = "frame.microphone.stop()";

function quote(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length === 0) line = word;
    else if (`${line} ${word}`.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
