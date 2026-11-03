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
  if (others.length > 0) return undefined;
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

/** The chart a data request names, when its words pick two columns: "distance" and "duration". */
export function instantChartsForRequest(text: string, header: string) {
  const columns = header
    .split(/[,\t]/)
    .map((column) => column.trim().replace(/^"|"$/g, ""))
    .filter((column) => column !== "");
  const picked: Array<string> = [];
  for (const word of text.toLowerCase().match(/[a-z_]+/g) ?? []) {
    if (word.length < COLUMN_WORD_MIN_LENGTH) continue;
    const column = columns.find((candidate) => candidate.toLowerCase().includes(word));
    if (column !== undefined && !picked.includes(column)) picked.push(column);
  }
  const [x, y] = picked;
  return x === undefined || y === undefined
    ? undefined
    : [
        { type: "scatter", x, y },
        { type: "histogram", x: y },
      ];
}
