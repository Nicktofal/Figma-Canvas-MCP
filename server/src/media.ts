import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** Finds an ffmpeg binary: FFMPEG_PATH, the optional ffmpeg-static package, then PATH. */
export async function findFfmpeg(): Promise<string | null> {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const mod: any = await import("ffmpeg-static");
    const p: string | null = mod.default ?? mod;
    if (p && existsSync(p)) return p;
  } catch {
    /* optional dependency not installed */
  }
  return "ffmpeg"; // hope it is on PATH; run() reports a clear error otherwise
}

export function run(bin: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(new Error(`Could not start ffmpeg (${bin}): ${e.message}. Install ffmpeg or set FFMPEG_PATH.`)));
    p.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export type VideoFormat = "mp4" | "webm" | "gif";

export function ffmpegArgs(format: VideoFormat, fps: number, pattern: string, out: string): string[] {
  const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  if (format === "gif") {
    return ["-y", "-framerate", String(fps), "-i", pattern, "-vf", `fps=${Math.min(fps, 30)},split[a][b];[a]palettegen[p];[b][p]paletteuse`, out];
  }
  if (format === "webm") {
    return ["-y", "-framerate", String(fps), "-i", pattern, "-vf", even, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-b:v", "0", "-crf", "30", out];
  }
  return ["-y", "-framerate", String(fps), "-i", pattern, "-vf", even, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", out];
}
