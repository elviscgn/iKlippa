// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetGraniteConversation,
  sendOnlineGranitePrompt,
} from '../../src/ai/granite';

describe('online Granite transport', () => {
  beforeEach(() => {
    resetGraniteConversation();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends current edit context to the backend without creating the local worker', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ response: 'Tighten the opening cut.' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const onChunk = vi.fn();

    const response = await sendOnlineGranitePrompt('How is my pacing?', { onChunk });

    expect(response).toBe('Tighten the opening cut.');
    expect(onChunk).toHaveBeenCalledWith('Tighten the opening cut.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/director/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as { prompt: string };
    expect(body.prompt).toContain('Project context:');
    expect(body.prompt).toContain('How is my pacing?');
  });

  it('reports an invalid backend response without falling back to a local download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      '<!doctype html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    )));

    await expect(sendOnlineGranitePrompt('Hello')).rejects.toThrow(
      'Online Granite returned an invalid response',
    );
  });
});
