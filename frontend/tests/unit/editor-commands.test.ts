// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  extractMentions,
  parseEditorCommand,
  resolveMentionTargets,
} from '../../src/commands/parser';
import {
  resolveCommandTargetIds,
  selectMentionedClips,
} from '../../src/commands/editorCommands';
import { selectedClipIds } from '../../src/ui/dragDrop';

const tracks = [
  {
    id: 1,
    track_type: 'video',
    clips: [
      { id: 11, source_id: 'intro.mp4', timeline_start_us: 0, timeline_end_us: 2_000_000 },
      { id: 12, source_id: 'city.mp4', timeline_start_us: 2_000_000, timeline_end_us: 5_000_000 },
    ],
  },
  {
    id: 2,
    track_type: 'audio',
    clips: [
      { id: 21, source_id: 'music.mp3', timeline_start_us: 0, timeline_end_us: 5_000_000 },
    ],
  },
];

describe('editor commands', () => {
  beforeEach(() => {
    selectedClipIds.clear();
    (window as any).S = { time: 2.5 };
    (window as any).IKState = {
      isReady: () => true,
      getTracks: () => tracks,
      getClipMeta: (id: number) => ({
        name: id === 11 ? 'Opening Shot' : id === 12 ? 'Jozi City' : 'Amapiano Bed',
      }),
    };
  });

  it('parses command arguments separately from clip mentions', () => {
    const parsed = parseEditorCommand('/auto-broll @Jozi-City street fashion');

    expect(parsed).toMatchObject({
      name: 'auto-broll',
      query: 'street fashion',
      mentions: ['jozi_city'],
    });
    expect(extractMentions('@Opening_Shot and @opening-shot')).toEqual(['opening_shot']);
  });

  it('resolves names and clip ids against current timeline metadata', () => {
    expect(resolveMentionTargets({ mentions: ['opening_shot', 'clip_12'] })).toEqual([
      { id: 11, name: 'Opening Shot', trackType: 'video' },
      { id: 12, name: 'Jozi City', trackType: 'video' },
    ]);
  });

  it('targets explicit mentions before selection and playhead', () => {
    selectedClipIds.add(12);
    const explicit = parseEditorCommand('/trim-silence @Opening_Shot')!;
    expect(resolveCommandTargetIds(explicit)).toEqual([11]);

    const selected = parseEditorCommand('/trim-silence')!;
    expect(resolveCommandTargetIds(selected)).toEqual([12]);

    selectedClipIds.clear();
    expect(resolveCommandTargetIds(selected)).toEqual([12]);
  });

  it('selects and highlights mentioned clips for Granite context', () => {
    const events: number[][] = [];
    window.addEventListener('ikl:reRender', ((event: CustomEvent) => {
      events.push(event.detail.selectedClipIds);
    }) as EventListener, { once: true });

    expect(selectMentionedClips({ mentions: ['opening_shot'] })).toEqual([11]);
    expect([...selectedClipIds]).toEqual([11]);
    expect(events).toEqual([[11]]);
  });
});

