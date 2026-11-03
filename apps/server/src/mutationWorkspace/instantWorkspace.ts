/**
 * The requests T3 answers before any model runs: one named file (or an attached image) and a clear
 * ask to work on it by hand. A wrong match takes over the user's screen, so anything else waits for
 * the agent, and this errs towards no match.
 */
export interface InstantWorkspaceMatch {
  readonly templateId: string;
  /** The named file as written, or undefined for an image attached to the message. */
  readonly file: string | undefined;
}

const TEMPLATES: ReadonlyArray<{
  readonly templateId: string;
  readonly extensions: RegExp;
  readonly verbs: RegExp;
}> = [
  {
    templateId: "photo-develop",
    extensions: /^(?:jpe?g|png|webp|avif|heic|tiff?)$/,
    verbs: /\b(?:edit|editor|grade|grading|retouch|adjust|tweak|develop)\b/,
  },
  {
    templateId: "video-edit",
    extensions: /^(?:mp4|mov|webm|mkv|m4v)$/,
    verbs: /\b(?:edit|editor|cut|trim|splice)\b/,
  },
  {
    templateId: "audio-edit",
    extensions: /^(?:mp3|wav|flac|m4a|aac|ogg)$/,
    verbs: /\b(?:edit|editor|cut|trim|mix|fade)\b/,
  },
  {
    templateId: "data-explore",
    extensions: /^(?:csv|tsv)$/,
    verbs: /\b(?:explore|slice|play with|dig into)\b/,
  },
];

// Someone else does the work unless they say they will: "edit sunset.jpg" is a job for the agent.
const BY_HAND =
  /\b(?:myself|by hand|in an editor|let me|so i can|interactive(?:ly)?|hands[- ]on|with me)\b/;
const OTHER_EDITOR = /\b(?:vim|neovim|emacs|vs ?code|cursor|zed|sublime|nano|photoshop|gimp)\b/;
const FILE = /(?:^|[\s"'`(])((?:[\w.\-/]*\/)?[\w.-]+\.([a-z0-9]{2,5}))(?=$|[\s"'`),.:;!?])/gi;

export function matchInstantWorkspace(input: {
  readonly text: string;
  readonly hasImageAttachment: boolean;
}): InstantWorkspaceMatch | undefined {
  const text = input.text.toLowerCase();
  if (text.trimStart().startsWith("/") || !BY_HAND.test(text) || OTHER_EDITOR.test(text)) {
    return undefined;
  }
  const named = new Map<string, string>();
  for (const [, file, extension] of input.text.matchAll(FILE)) {
    if (file !== undefined && extension !== undefined) named.set(file, extension.toLowerCase());
  }
  const [only, ...others] = named;
  // A named file and an attached image leave which one they mean unclear.
  if (others.length > 0 || (only !== undefined && input.hasImageAttachment)) return undefined;
  const extension = only?.[1];
  if (only === undefined && !input.hasImageAttachment) return undefined;
  const template =
    extension === undefined
      ? TEMPLATES[0]
      : TEMPLATES.find((candidate) => candidate.extensions.test(extension));
  if (template === undefined || !template.verbs.test(text)) return undefined;
  return { templateId: template.templateId, file: only?.[0] };
}

const COLUMN_WORD_MIN_LENGTH = 4;
const SAMPLE_ROWS = 20;

/**
 * The chart a data request names, when its words pick two number columns: "distance" and
 * "duration". `sample` is the start of the file. Anything unclear keeps the template's own charts.
 */
export function instantChartsForRequest(input: {
  readonly text: string;
  readonly file: string;
  readonly sample: string;
}) {
  const lines = input.sample.split(/\r?\n/);
  // The sample stops mid-file, so its last line may be cut short.
  const rows = lines.slice(1, -1).slice(0, SAMPLE_ROWS);
  const columns = (lines[0] ?? "").split(/[,\t]/).map((column) => column.trim());
  const isNumberColumn = (index: number) =>
    rows.length > 0 &&
    rows.every((row) => {
      const value = row.split(/[,\t]/)[index]?.trim();
      return value !== undefined && value !== "" && Number.isFinite(Number(value));
    });
  const isIdColumn = (column: string) => /(?:^|[_-])id$/i.test(column);
  const candidates = columns.filter(
    (column, index) => !isIdColumn(column) && isNumberColumn(index),
  );
  const words = input.text.toLowerCase().replaceAll(input.file.toLowerCase(), " ");
  const picked: Array<string> = [];
  for (const word of words.match(/[a-z_]+/g) ?? []) {
    if (word.length < COLUMN_WORD_MIN_LENGTH) continue;
    const named = candidates.filter((column) => column.toLowerCase().includes(word));
    const [column, ...others] = named;
    if (column !== undefined && others.length === 0 && !picked.includes(column)) {
      picked.push(column);
    }
  }
  const [x, y] = picked;
  return x === undefined || y === undefined
    ? undefined
    : [
        { type: "scatter", x, y },
        { type: "histogram", x: y },
      ];
}
