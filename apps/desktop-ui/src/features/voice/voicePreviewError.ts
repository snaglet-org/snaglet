/** Keep the server's actionable failure instead of replacing it with HTTP 503. */
export async function voicePreviewError(response: Response, voiceId: string): Promise<string> {
  let message = '';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // A proxy may return HTML or an empty response.
  }
  if (/voice (model|engine) unavailable/i.test(message)) {
    if (voiceId.startsWith('apple:')) {
      return 'Apple voice unavailable. Install the selected voice in macOS System Settings > Accessibility > Spoken Content, then try Preview again.';
    }
    return 'Voice models are missing. Download them in Settings → Storage, then try Preview again.';
  }
  return (
    message || `Preview failed (${response.status}). Try again when the voice server is ready.`
  );
}
