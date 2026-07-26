export type EditorCommandName =
  | 'trim-silence'
  | 'sync-audio'
  | 'auto-broll'
  | 'add-captions'
  | 'unknown';

export interface ParsedEditorCommand {
  name: EditorCommandName;
  raw: string;
  args: string;
  query: string;
  mentions: string[];
}

export interface CommandTarget {
  id: number;
  name: string;
  trackType: string;
}

const COMMAND_NAMES = new Set<EditorCommandName>([
  'trim-silence',
  'sync-audio',
  'auto-broll',
  'add-captions',
]);

export function normalizeMention(value: string): string {
  return value
    .trim()
    .replace(/^@/, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function extractMentions(input: string): string[] {
  const mentions: string[] = [];
  const mentionPattern = /@([a-z0-9_.-]+)/gi;
  let mentionMatch: RegExpExecArray | null;
  while ((mentionMatch = mentionPattern.exec(input)) !== null) {
    const normalized = normalizeMention(mentionMatch[1] ?? '');
    if (normalized && !mentions.includes(normalized)) mentions.push(normalized);
  }
  return mentions;
}

export function parseEditorCommand(input: string): ParsedEditorCommand | null {
  const raw = input.trim();
  const match = raw.match(/^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const requestedName = match[1]!.toLowerCase() as EditorCommandName;
  const name = COMMAND_NAMES.has(requestedName) ? requestedName : 'unknown';
  const args = (match[2] ?? '').trim();
  const mentions = extractMentions(args);
  const mentionPattern = /@([a-z0-9_.-]+)/gi;
  const query = args.replace(mentionPattern, ' ').replace(/\s+/g, ' ').trim();

  return { name, raw, args, query, mentions };
}

function allClipTargets(): CommandTarget[] {
  const state = typeof window !== 'undefined' ? (window as any).IKState : null;
  if (!state?.isReady?.()) return [];
  const targets: CommandTarget[] = [];
  for (const track of state.getTracks?.() ?? []) {
    for (const clip of track.clips ?? []) {
      const meta = state.getClipMeta?.(clip.id);
      targets.push({
        id: Number(clip.id),
        name: String(meta?.name || clip.caption_text || clip.source_id || `Clip ${clip.id}`),
        trackType: String(track.track_type || ''),
      });
    }
  }
  return targets;
}

export function resolveMentionTargets(
  parsed: Pick<ParsedEditorCommand, 'mentions'>,
): CommandTarget[] {
  if (parsed.mentions.length === 0) return [];
  const targets = allClipTargets();
  const resolved: CommandTarget[] = [];
  for (const mention of parsed.mentions) {
    const match = targets.find((target) => {
      return normalizeMention(target.name) === mention ||
        normalizeMention(`clip_${target.id}`) === mention ||
        String(target.id) === mention;
    });
    if (match && !resolved.some((target) => target.id === match.id)) resolved.push(match);
  }
  return resolved;
}
