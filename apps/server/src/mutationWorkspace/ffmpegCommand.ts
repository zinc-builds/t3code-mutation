/**
 * How a template's exported ffmpeg command becomes a short, contained dry run:
 * the shell text is split into arguments (never run through a shell), checked
 * so it can only read the workspace's assets and write into its own scratch
 * folder, and limited to a fraction of a second of output.
 */
import { parse } from "shell-quote";

/** Seconds of output each dry run renders: enough to build and run every filter graph. */
export const FFMPEG_DRY_RUN_SECONDS = 0.5;

/** Options whose value names a file ffmpeg writes or reads beyond its inputs. */
const FILE_OPTIONS = new Set([
  "-attach",
  "-dump_attachment",
  "-filter_complex_script",
  "-filter_script",
  "-passlogfile",
  "-progress",
  "-report",
  "-sdp_file",
  "-stats_enc_post",
  "-stats_enc_pre",
  "-stats_mux_pre",
  "-vstats",
  "-vstats_file",
]);

const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;
// A path that leaves the scratch folder: absolute (POSIX or Windows), home-relative,
// or climbing out with `..`, whether a whole argument or a filter option's value.
const ESCAPING_PATH_PATTERN =
  /(?:^|[=:'",;|[\s])(?:\/|~|[a-z]:[\\/])|(?:^|[\\/=:'",;|[\s])\.\.(?:[\\/]|$)/i;

export type FfmpegDryRunPlan =
  | {
      readonly ok: true;
      /** Arguments after the executable, rewritten for the dry run. */
      readonly args: ReadonlyArray<string>;
      /** The file it writes, a relative name inside the scratch folder. */
      readonly output: string;
    }
  | { readonly ok: false; readonly reason: string };

const notRun = (reason: string): FfmpegDryRunPlan => ({ ok: false, reason });

const clipArg = (arg: string) => (arg.length > 80 ? `${arg.slice(0, 80)}…` : arg);

/**
 * Plans the dry run of one exported ffmpeg command. It must be a single
 * `ffmpeg …` invocation whose last argument is its output; `allowedPaths` are
 * the absolute paths it may name (the workspace's assets). Everything else it
 * names must be a plain relative name, which the dry run resolves in a
 * scratch folder holding the assets and the export's own files.
 */
export function planFfmpegDryRun(
  command: string,
  allowedPaths: ReadonlySet<string>,
): FfmpegDryRunPlan {
  // Shell line continuations; `$NAME` stays literal, as no shell expands it here.
  const tokens = parse(command.replace(/\\\r?\n/g, " "), (name) => `$${name}`);
  const words: Array<string> = [];
  for (const token of tokens) {
    if (typeof token !== "string") {
      const syntax =
        "comment" in token ? "#" : token.op === "glob" ? "an unquoted *" : String(token.op);
      return notRun(`it uses shell syntax (${syntax}) that the dry run does not run`);
    }
    if (token !== "") words.push(token);
  }
  const [program, ...args] = words;
  if (program === undefined || !/^ffmpeg(?:\.exe)?$/i.test(program.replace(/^.*[\\/]/, ""))) {
    return notRun("it is not an ffmpeg command");
  }
  const output = args.at(-1);
  if (output === undefined || output.startsWith("-") || args.length < 3) {
    return notRun("its last argument is not an output file");
  }
  if (allowedPaths.has(output)) return notRun("it writes over one of its own assets");
  for (const arg of args) {
    if (allowedPaths.has(arg)) continue;
    const option = arg.split("=", 1)[0]!;
    if (FILE_OPTIONS.has(option) || arg.startsWith("-/")) {
      return notRun(`it uses ${option}, which names files outside the export`);
    }
    if (URL_PATTERN.test(arg)) return notRun(`it names a URL (${clipArg(arg)})`);
    if (ESCAPING_PATH_PATTERN.test(arg)) {
      return notRun(`it names a path outside the workspace's assets (${clipArg(arg)})`);
    }
  }
  return {
    ok: true,
    args: [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      ...args.slice(0, -1),
      "-t",
      String(FFMPEG_DRY_RUN_SECONDS),
      output,
    ],
    output,
  };
}

/** The end of ffmpeg's error output, which names the failing filter or option. */
export function stderrTail(stderr: string, maxChars = 1_200): string {
  const text = stderr.trim();
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}
